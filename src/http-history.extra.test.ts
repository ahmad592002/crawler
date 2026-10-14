/**
 * Extra tests for the capture reader and Burp exporter's file handling. Offline: the
 * capture files are written to a temp QA_OUT, never the real output/ (which holds live
 * session cookies).
 *
 * QA_OUT has to be set BEFORE config.ts is evaluated, so the module is imported
 * dynamically. node:test runs each file in its own process, so this does not leak.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const box = mkdtempSync(join(tmpdir(), "qa-history-"));
process.env.QA_OUT = box;
const h = await import("./http-history.js");

after(() => rmSync(box, { recursive: true, force: true }));

const b64 = (s: string) => Buffer.from(s).toString("base64");

function exchange(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: "2026-01-01T00:00:00.000Z",
    url: "https://example.test/a",
    host: "example.test",
    ip: "127.0.0.1",
    port: 443,
    protocol: "https",
    method: "GET",
    path: "/a",
    extension: "null",
    request: b64("GET /a HTTP/1.1\r\n\r\n"),
    status: 200,
    responseLength: 0,
    mimeType: "HTML",
    response: b64("HTTP/1.1 200 OK\r\n\r\nhi"),
    ...over,
  };
}

// ------------------------------------------------------------------ paths

test("capture paths follow QA_OUT and are split per mode", () => {
  assert.equal(h.historyJsonl("anon"), resolve(box, "http-history.jsonl"));
  assert.equal(h.historyJsonl("auth"), resolve(box, "http-history.auth.jsonl"));
  assert.equal(h.historyJsonl(), h.historyJsonl("anon"));
  assert.equal(h.historyXml("all"), resolve(box, "http-history.xml"));
  assert.equal(h.historyXml("anon"), resolve(box, "http-history.anon.xml"));
  assert.equal(h.historyXml("auth"), resolve(box, "http-history.auth.xml"));
  assert.notEqual(h.historyXml("anon"), h.historyXml("auth"));
  assert.equal(h.HISTORY_JSONL, h.historyJsonl("anon"));
  assert.equal(h.HISTORY_XML, h.historyXml("all"));
});

// ------------------------------------------------------------------ burpTime

test("burpTime has Java Date.toString() shape, not ISO", () => {
  const s = h.burpTime(new Date(2026, 4, 3, 7, 8, 9));
  assert.match(s, /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) May 03 07:08:09 \S+ 2026$/, s);
  assert.doesNotMatch(s, /T\d\d:/, "must not be ISO 8601");
});

test("burpTime pads every field and never emits an empty zone", () => {
  const s = h.burpTime(new Date(2026, 0, 1, 0, 0, 0));
  assert.match(s, /^\w{3} Jan 01 00:00:00 (\S+) 2026$/, s);
  const zone = /00:00:00 (\S+) 2026$/.exec(s)?.[1] ?? "";
  assert.ok(zone.length > 0, s);
});

// ------------------------------------------------------------------ readHistory

test("readHistory skips blank and partial lines and tolerates CRLF", () => {
  const f = join(box, "mixed.jsonl");
  writeFileSync(
    f,
    `${JSON.stringify(exchange({ path: "/one" }))}\r\n\r\n` +
      `${JSON.stringify(exchange({ path: "/two" }))}\n` +
      `{"time":"2026-01-01T00:00:01.000Z","url":"https://exa`, // interrupted writer
  );
  const items = h.readHistory(f);
  assert.deepEqual(items.map((x) => x.path), ["/one", "/two"]);
});

test("readHistory recomputes responseLength from the stored raw message", () => {
  const f = join(box, "len.jsonl");
  const raw = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<p>body</p>";
  writeFileSync(f, `${JSON.stringify(exchange({ response: b64(raw), responseLength: 11 }))}\n`);
  const [x] = h.readHistory(f);
  assert.equal(x?.responseLength, Buffer.byteLength(raw));
});

test("readHistory keeps responseLength when no response body was stored", () => {
  const f = join(box, "nobody.jsonl");
  writeFileSync(f, `${JSON.stringify(exchange({ response: "", responseLength: 7 }))}\n`);
  assert.equal(h.readHistory(f)[0]?.responseLength, 7);
});

test("readHistory on a missing file is empty, not a throw", () => {
  assert.deepEqual(h.readHistory(join(box, "does-not-exist.jsonl")), []);
});

test(
  "readHistory drops lines that parse as JSON but are not exchange objects",
  { todo: "T-02: readHistory pushes JSON scalars/arrays (e.g. 123, \"x\", []) as exchanges" },
  () => {
    const f = join(box, "scalars.jsonl");
    writeFileSync(f, `123\n"x"\n[]\ntrue\n${JSON.stringify(exchange({ path: "/real" }))}\n`);
    const items = h.readHistory(f);
    assert.deepEqual(items.map((x) => x.path), ["/real"]);
  },
);

// ------------------------------------------------------------------ writeBurpXml

test("writeBurpXml(anon) exports ONLY the anonymous capture, never the auth one", () => {
  writeFileSync(h.historyJsonl("anon"), `${JSON.stringify(exchange({ path: "/anon-page" }))}\n`);
  writeFileSync(h.historyJsonl("auth"), `${JSON.stringify(exchange({ path: "/auth-secret" }))}\n`);
  const out = join(box, "anon.xml");
  const n = h.writeBurpXml("anon", out);
  const xml = readFileSync(out, "utf8");
  assert.equal(n, 1);
  assert.match(xml, /\/anon-page/);
  assert.doesNotMatch(xml, /auth-secret/, "anonymous export must not contain authenticated traffic");
});

test("writeBurpXml(all) merges both captures in chronological order", () => {
  writeFileSync(
    h.historyJsonl("auth"),
    `${JSON.stringify(exchange({ path: "/late", time: "2026-01-01T00:00:05.000Z" }))}\n` +
      `${JSON.stringify(exchange({ path: "/early", time: "2026-01-01T00:00:01.000Z" }))}\n`,
  );
  writeFileSync(
    h.historyJsonl("anon"),
    `${JSON.stringify(exchange({ path: "/middle", time: "2026-01-01T00:00:03.000Z" }))}\n`,
  );
  const out = join(box, "all.xml");
  assert.equal(h.writeBurpXml("all", out), 3);
  const xml = readFileSync(out, "utf8");
  const order = ["/early", "/middle", "/late"].map((p) => xml.indexOf(`<path><![CDATA[${p}]]></path>`));
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("writeBurpXml with no capture files writes a valid empty document", () => {
  rmSync(h.historyJsonl("anon"), { force: true });
  rmSync(h.historyJsonl("auth"), { force: true });
  const out = join(box, "empty.xml");
  assert.equal(h.writeBurpXml("all", out), 0);
  const xml = readFileSync(out, "utf8");
  assert.match(xml, /<items burpVersion="[^"]*" exportTime="[^"]*">\r\n<\/items>\r\n$/);
});
