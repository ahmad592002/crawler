/**
 * HTTP exchange recorder + Burp Suite proxy-history XML exporter.
 *
 * Lets the crawl double as a capture: every request/response pair is reconstructed as a
 * raw HTTP message and written out in the same XML schema Burp's "Save items" produces,
 * so the result imports into Burp, ZAP, or any tool that reads that format.
 *
 * Exchanges are appended to output/http-history.jsonl as they happen - same reason the
 * page records are JSONL, an interrupted run still leaves a readable file. The XML is
 * serialized from that at the end, because XML needs a closing root tag to be parseable.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext, Response } from "playwright";
import { ROOT, isAllowedUrl, type QaConfig } from "./config.js";

const OUT = resolve(ROOT, "output");
export const HISTORY_JSONL = resolve(OUT, "http-history.jsonl");
export const HISTORY_XML = resolve(OUT, "http-history.xml");

/** One captured request/response pair, already reconstructed as raw HTTP. */
export interface HttpExchange {
  time: string;
  url: string;
  host: string;
  ip: string;
  port: number;
  protocol: string;
  method: string;
  path: string;
  extension: string;
  /** Raw request message, base64. */
  request: string;
  status: number;
  /**
   * Byte length of the raw response message that is actually stored in `response` -
   * status line + headers + body, exactly what Burp puts in <responselength>.
   *
   * This used to be the BODY length, which is wrong twice over: it disagrees with Burp's
   * own exports (verified against a real one: there responselength == full message
   * length), and when a body was truncated it described bytes that are not in the file.
   */
  responseLength: number;
  mimeType: string;
  /** Raw response message, base64. Empty when the body could not be read. */
  response: string;
  /** True when the body was cut at captureMaxBodyBytes. */
  truncated?: boolean;
  /** Body length as the server sent it, present only when `truncated`. */
  fullBodyLength?: number;
}

export interface RecorderOptions {
  /** Cap on a single captured body, in bytes. Larger bodies are truncated. */
  maxBodyBytes?: number;
  /** Capture third-party requests too. Off by default - keeps the capture on target. */
  includeOffOrigin?: boolean;
}

const DEFAULT_MAX_BODY = 2_000_000;

/** Written into the items element. Importers read it to decide how to parse the file. */
const BURP_VERSION = "2026.3.2";

/**
 * Burp labels the body type with a short token rather than the raw content-type.
 * These are the values Burp itself emits, so imported items group the way a user expects.
 */
function burpMimeType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("html")) return "HTML";
  if (ct.includes("json")) return "JSON";
  if (ct.includes("javascript") || ct.includes("ecmascript")) return "script";
  if (ct.includes("css")) return "CSS";
  if (ct.includes("xml")) return "XML";
  if (ct.startsWith("image/")) return "IMG";
  if (ct.includes("text/")) return "text";
  if (ct.includes("font")) return "font";
  if (!ct) return "";
  return "app";
}

function extensionOf(pathname: string): string {
  const last = pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  // Burp writes the literal string "null" when there is no extension. A path ending in a
  // bare dot ("/report.") has a dot but no extension - that is "null" too, not "".
  if (dot <= 0 || dot === last.length - 1) return "null";
  return last.slice(dot + 1);
}

/** Rebuild the request as it went on the wire: request line, headers, blank line, body. */
async function rawRequest(response: Response): Promise<Buffer> {
  const req = response.request();
  const url = new URL(req.url());
  const target = `${url.pathname}${url.search}`;

  let headerLines = "";
  try {
    // headersArray preserves order and repeated headers; allHeaders would collapse them.
    for (const { name, value } of await req.headersArray()) {
      // HTTP/2 pseudo-headers are not part of an HTTP/1.1 message.
      if (name.startsWith(":")) continue;
      headerLines += `${name}: ${value}\r\n`;
    }
  } catch {
    headerLines = `Host: ${url.host}\r\n`;
  }
  if (!/^host:/im.test(headerLines)) headerLines = `Host: ${url.host}\r\n${headerLines}`;

  const head = `${req.method()} ${target} HTTP/1.1\r\n${headerLines}\r\n`;
  const body = req.postDataBuffer();
  return body ? Buffer.concat([Buffer.from(head, "utf8"), body]) : Buffer.from(head, "utf8");
}

/** Rebuild the response: status line, headers, blank line, body. */
async function rawResponse(
  response: Response,
  maxBody: number,
): Promise<{ raw: Buffer; truncated: boolean; fullBodyLength: number }> {
  let body: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  try {
    body = await response.body();
  } catch {
    // Redirects, 204s and aborted requests have no retrievable body. Headers still count.
  }
  const fullBodyLength = body.length;
  const truncated = body.length > maxBody;
  if (truncated) body = body.subarray(0, maxBody);

  let headerLines = "";
  try {
    for (const { name, value } of await response.headersArray()) {
      if (name.startsWith(":")) continue;
      // A truncated body with the original Content-Length is a message that no HTTP
      // parser can read: it promises megabytes and delivers what fits. Rewrite the
      // header to describe what is actually here, and say so in a marker header.
      if (truncated && name.toLowerCase() === "content-length") continue;
      // The body Playwright hands back is already decoded; a Content-Encoding header
      // would tell an importer to inflate plain bytes.
      if (name.toLowerCase() === "content-encoding") continue;
      headerLines += `${name}: ${value}\r\n`;
    }
  } catch {
    // Headers unavailable (aborted, or served from a cache Playwright cannot replay).
  }
  if (truncated) {
    headerLines += `Content-Length: ${body.length}\r\n`;
    headerLines += `X-QA-Agent-Truncated: original-body-${fullBodyLength}-bytes\r\n`;
  }

  // Keep the space after the code even when there is no reason phrase - that is what goes
  // over the wire, and what Burp's own exports contain ("HTTP/1.1 404 \r\n").
  const head = `HTTP/1.1 ${response.status()} ${response.statusText()}\r\n${headerLines}\r\n`;

  return { raw: Buffer.concat([Buffer.from(head, "utf8"), body]), truncated, fullBodyLength };
}

/**
 * Attach a recorder to a context. Every completed response appends one line to
 * output/http-history.jsonl.
 *
 * Capture is scoped to allowedOrigins by default: a proxy history of the target is the
 * point, and recording every CDN and tracker just bloats the file.
 */
/**
 * In-flight recorder tasks. Reading a body is async, but the crawler closes pages and the
 * context as soon as it is done - and response.body() throws once they are gone, which
 * the catch below swallows. Awaiting these before teardown is the difference between a
 * complete capture and one that quietly drops its last exchanges.
 */
const pending = new Set<Promise<void>>();

/** Wait for every in-flight capture to finish. Call before closing the context. */
export async function drainHistory(): Promise<void> {
  // Handlers can register more work while we wait, so loop until the set stays empty.
  while (pending.size) await Promise.allSettled([...pending]);
}

export function recordHistory(context: BrowserContext, cfg: QaConfig, opts: RecorderOptions = {}): void {
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

  context.on("response", (response) => {
    const task = (async () => {
      const url = response.url();
      if (!opts.includeOffOrigin && !isAllowedUrl(url, cfg)) return;

      try {
        const u = new URL(url);
        const [req, res] = await Promise.all([rawRequest(response), rawResponse(response, maxBody)]);

        let ip = "";
        try {
          ip = (await response.serverAddr())?.ipAddress ?? "";
        } catch {
          // Not available for cached or intercepted responses.
        }

        const exchange: HttpExchange = {
          time: new Date().toISOString(),
          url,
          host: u.hostname,
          ip,
          port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
          protocol: u.protocol.replace(":", ""),
          method: response.request().method(),
          path: `${u.pathname}${u.search}`,
          extension: extensionOf(u.pathname),
          request: req.toString("base64"),
          status: response.status(),
          // Full raw message length - Burp's semantics, and always the length of what is
          // really in <response>.
          responseLength: res.raw.length,
          mimeType: burpMimeType(response.headers()["content-type"] ?? ""),
          response: res.raw.toString("base64"),
          ...(res.truncated ? { truncated: true, fullBodyLength: res.fullBodyLength } : {}),
        };

        appendFileSync(HISTORY_JSONL, `${JSON.stringify(exchange)}\n`);
      } catch {
        // A single unreadable exchange must never interrupt the crawl.
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Burp writes timestamps in Java's Date.toString() form - "Thu May 14 14:15:07 EEST 2026",
 * local time with a zone abbreviation - not ISO 8601. Importers parse this field, so the
 * shape has to match.
 */
export function burpTime(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");

  // en-GB resolves real zone abbreviations ("EEST"); en-US falls back to "GMT+3" for
  // most non-US zones, which is not what a JVM - and therefore Burp - writes.
  let zone = "";
  for (const locale of ["en-GB", "en-US"]) {
    try {
      const parts = new Intl.DateTimeFormat(locale, { timeZoneName: "short" }).formatToParts(date);
      const found = parts.find((x) => x.type === "timeZoneName")?.value ?? "";
      if (found && !/^GMT[+-]?/.test(found)) {
        zone = found;
        break;
      }
      zone ||= found;
    } catch {
      // Fall through to a numeric offset below.
    }
  }
  if (zone === "" || /^GMT$/.test(zone)) {
    const off = -date.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    zone = `GMT${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  }

  return (
    `${DAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())} ${zone} ${date.getFullYear()}`
  );
}

/**
 * Remove characters XML 1.0 forbids ANYWHERE in a document - inside CDATA included.
 *
 * One 0x01 byte in one URL makes the whole export unparseable: System.Xml rejects the
 * entire file with "hexadecimal value 0x01, is an invalid character" and there is no
 * partial recovery, so a single odd request destroys a 70 MB capture at import time.
 * Lone surrogates are dropped for the same reason.
 */
function stripInvalidXml(value: string): string {
  return value
    .replace(/[ --￾￿]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, "")
    .replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
}

/** CDATA cannot contain "]]>"; split the sequence across two sections. */
function cdata(value: string): string {
  return `<![CDATA[${stripInvalidXml(value).replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

/**
 * Plain escaped ELEMENT text. Burp wraps only url, method, path, request and response in
 * CDATA - time, host, protocol, extension and mimetype are written as ordinary text, so
 * matching its output means not over-applying CDATA.
 */
function xmlText(value: string): string {
  return stripInvalidXml(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * ATTRIBUTE value escaping. Separate from xmlText on purpose: xmlText does not escape
 * quotes, and using it for ip="..." meant an ip of `1" evil="y` silently produced a
 * second, attacker-chosen attribute on the <host> element.
 */
function xmlAttr(value: string): string {
  return xmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Numeric fields are interpolated bare, so they must actually be numbers. */
function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function readHistory(file = HISTORY_JSONL): HttpExchange[] {
  if (!existsSync(file)) return [];
  const out: HttpExchange[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const x = JSON.parse(line) as HttpExchange;
      // Older files stored the BODY length here. Recompute from the message that is
      // actually present so an existing capture exports with Burp's semantics without
      // having to be re-recorded.
      const actual = Buffer.from(String(x.response ?? ""), "base64").length;
      if (actual > 0 && x.responseLength !== actual) x.responseLength = actual;
      out.push(x);
    } catch {
      // Skip a partial line from an interrupted writer.
    }
  }
  return out;
}

/**
 * Serialize to Burp's proxy-history schema. The DOCTYPE and element order match what
 * Burp writes, because some importers are strict about both.
 */
export function toBurpXml(items: HttpExchange[]): string {
  const head =
    `<?xml version="1.0"?>\n` +
    `<!DOCTYPE items [\n` +
    `<!ELEMENT items (item*)>\n` +
    `<!ATTLIST items burpVersion CDATA "">\n` +
    `<!ATTLIST items exportTime CDATA "">\n` +
    `<!ELEMENT item (time, url, host, port, protocol, method, path, extension, request, status, responselength, mimetype, response, comment)>\n` +
    `<!ELEMENT time (#PCDATA)>\n` +
    `<!ELEMENT url (#PCDATA)>\n` +
    `<!ELEMENT host (#PCDATA)>\n` +
    `<!ATTLIST host ip CDATA "">\n` +
    `<!ELEMENT port (#PCDATA)>\n` +
    `<!ELEMENT protocol (#PCDATA)>\n` +
    `<!ELEMENT method (#PCDATA)>\n` +
    `<!ELEMENT path (#PCDATA)>\n` +
    `<!ELEMENT extension (#PCDATA)>\n` +
    `<!ELEMENT request (#PCDATA)>\n` +
    `<!ATTLIST request base64 (true|false) "false">\n` +
    `<!ELEMENT status (#PCDATA)>\n` +
    `<!ELEMENT responselength (#PCDATA)>\n` +
    `<!ELEMENT mimetype (#PCDATA)>\n` +
    `<!ELEMENT response (#PCDATA)>\n` +
    `<!ATTLIST response base64 (true|false) "false">\n` +
    `<!ELEMENT comment (#PCDATA)>\n` +
    `]>\n` +
    // burpVersion is a format-compatibility field that importers parse; it has to look
    // like a Burp version string rather than a tool name.
    `<items burpVersion="${xmlAttr(BURP_VERSION)}" exportTime="${xmlAttr(burpTime(new Date()))}">\n`;

  const body = items
    .map((x) => {
      // Every field is coerced and escaped here rather than trusted. readHistory() parses
      // an on-disk JSONL, so `npm run export:burp` can be pointed at a file this process
      // did not write - a status of "200</status><x>" used to land in the document raw.
      const when = new Date(x.time);
      const time = Number.isNaN(when.getTime()) ? burpTime(new Date(0)) : burpTime(when);
      return (
        `  <item>\n` +
        `    <time>${xmlText(time)}</time>\n` +
        `    <url>${cdata(String(x.url ?? ""))}</url>\n` +
        `    <host ip="${xmlAttr(String(x.ip ?? ""))}">${xmlText(String(x.host ?? ""))}</host>\n` +
        `    <port>${num(x.port)}</port>\n` +
        `    <protocol>${xmlText(String(x.protocol ?? ""))}</protocol>\n` +
        `    <method>${cdata(String(x.method ?? ""))}</method>\n` +
        `    <path>${cdata(String(x.path ?? ""))}</path>\n` +
        `    <extension>${xmlText(String(x.extension ?? "null"))}</extension>\n` +
        `    <request base64="true">${cdata(String(x.request ?? ""))}</request>\n` +
        `    <status>${num(x.status)}</status>\n` +
        `    <responselength>${num(x.responseLength)}</responselength>\n` +
        `    <mimetype>${xmlText(String(x.mimeType ?? ""))}</mimetype>\n` +
        `    <response base64="true">${cdata(String(x.response ?? ""))}</response>\n` +
        `    <comment></comment>\n` +
        `  </item>\n`
      );
    })
    .join("");

  // Burp writes the file with CRLF line endings. Every value we emit is single-line
  // (base64 payloads included), so normalising the whole document is safe.
  return `${head}${body}</items>\n`.replace(/\r?\n/g, "\r\n");
}

export function writeBurpXml(file = HISTORY_XML): number {
  const items = readHistory();
  writeFileSync(file, toBurpXml(items));
  return items.length;
}
