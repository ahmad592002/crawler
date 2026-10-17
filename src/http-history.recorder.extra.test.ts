/**
 * recordHistory / drainHistory / historyFiles, driven through a fake BrowserContext.
 *
 * The recorder only uses context.on("response") and a handful of Response methods, so a
 * small fake stands in for Playwright and the test stays offline. Covered: the capture
 * scope (isAllowedUrl unless includeOffOrigin), raw-message reconstruction edge cases
 * (pseudo-headers, Host, truncation, Content-Encoding, unreadable bodies), per-mode files,
 * and that drainHistory really waits for in-flight body reads.
 *
 * QA_OUT is a temp dir set BEFORE config.ts is evaluated, hence the dynamic import; the real
 * output/ (live session cookies) is never touched. Named *.recorder.extra.test.ts because
 * http-history.extra.test.ts already exists (round 1) and is not edited.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import type { QaConfig } from "./config.js";

const box = mkdtempSync(join(tmpdir(), "qa-recorder-"));
process.env.QA_OUT = box;
const h = await import("./http-history.js");

after(() => rmSync(box, { recursive: true, force: true }));
beforeEach(() => {
  for (const f of [h.historyJsonl("anon"), h.historyJsonl("auth")]) rmSync(f, { force: true });
});

const cfg = {
  allowedOrigins: ["https://target.test", "https://target.test:8443", "http://plain.test"],
} as unknown as QaConfig;

interface FakeResp {
  url: string;
  method?: string;
  status?: number;
  statusText?: string;
  reqHeaders?: { name: string; value: string }[] | "throw";
  resHeaders?: { name: string; value: string }[] | "throw";
  postData?: string;
  body?: string | "throw";
  bodyDelayMs?: number;
  ip?: string | "throw";
}

function fakeContext() {
  let handler: ((r: unknown) => void) | null = null;
  const ctx = {
    on(event: string, fn: (r: unknown) => void) {
      assert.equal(event, "response");
      handler = fn;
    },
  } as unknown as BrowserContext;

  const emit = (f: FakeResp): void => {
    const resHeaders = f.resHeaders ?? [{ name: "content-type", value: "text/html" }];
    const response = {
      url: () => f.url,
      status: () => f.status ?? 200,
      statusText: () => f.statusText ?? "OK",
      headers: () =>
        Object.fromEntries(resHeaders === "throw" ? [] : resHeaders.map((x) => [x.name.toLowerCase(), x.value])),
      headersArray: async () => {
        if (resHeaders === "throw") throw new Error("headers gone");
        return resHeaders;
      },
      body: async () => {
        if (f.bodyDelayMs) await new Promise((r) => setTimeout(r, f.bodyDelayMs));
        if (f.body === "throw") throw new Error("No resource with given identifier");
        return Buffer.from(f.body ?? "");
      },
      serverAddr: async () => {
        if (f.ip === "throw") throw new Error("n/a");
        return { ipAddress: f.ip ?? "10.0.0.1", port: 443 };
      },
      request: () => ({
        url: () => f.url,
        method: () => f.method ?? "GET",
        headersArray: async () => {
          if (f.reqHeaders === "throw") throw new Error("headers gone");
          return f.reqHeaders ?? [{ name: "host", value: new URL(f.url).host }];
        },
        postDataBuffer: () => (f.postData === undefined ? null : Buffer.from(f.postData)),
      }),
    };
    handler?.(response);
  };
  return { ctx, emit };
}

function captured(mode: "anon" | "auth" = "anon"): Record<string, unknown>[] {
  const f = h.historyJsonl(mode);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const raw = (b64: unknown) => Buffer.from(String(b64), "base64").toString("utf8");

test("capture is scoped to allowedOrigins: off-origin, lookalike and userinfo hosts are dropped", async () => {
  const { ctx, emit } = fakeContext();
  h.recordHistory(ctx, cfg);
  for (const url of [
    "https://target.test/a",
    "https://cdn.evil.test/x.js",
    "https://target.test.evil.test/",
    "https://user:pw@target.test/b",
    "http://target.test/downgrade",
  ]) {
    emit({ url });
  }
  await h.drainHistory();
  assert.deepEqual(captured().map((e) => e.url), ["https://target.test/a"]);
});

test("includeOffOrigin records third-party traffic too", async () => {
  const { ctx, emit } = fakeContext();
  h.recordHistory(ctx, cfg, { includeOffOrigin: true });
  emit({ url: "https://cdn.other.test/lib.js", resHeaders: [{ name: "content-type", value: "application/javascript" }] });
  await h.drainHistory();
  const [e] = captured();
  assert.equal(e?.host, "cdn.other.test");
  assert.equal(e?.mimeType, "script");
});

test("drainHistory waits for a slow body read before returning", async () => {
  const { ctx, emit } = fakeContext();
  h.recordHistory(ctx, cfg);
  emit({ url: "https://target.test/slow", body: "late", bodyDelayMs: 60 });
  assert.equal(captured().length, 0, "nothing is written synchronously");
  await h.drainHistory();
  assert.equal(captured().length, 1, "drain returned before the in-flight exchange was written");
  await h.drainHistory(); // idempotent once empty
});

test("an oversized body is truncated, Content-Length rewritten, and the cut is marked", async () => {
  const { ctx, emit } = fakeContext();
  h.recordHistory(ctx, cfg, { maxBodyBytes: 10 });
  const body = "x".repeat(25);
  emit({
    url: "https://target.test/big",
    body,
    resHeaders: [
      { name: "Content-Type", value: "text/plain" },
      { name: "Content-Length", value: "25" },
      { name: "Content-Encoding", value: "gzip" },
    ],
  });
  await h.drainHistory();
  const [e] = captured();
  assert.equal(e?.truncated, true);
  assert.equal(e?.fullBodyLength, 25);
  const res = raw(e?.response);
  assert.doesNotMatch(res, /Content-Length: 25/, "the original length promises bytes that are not there");
  assert.match(res, /Content-Length: 10\r\n/);
  assert.match(res, /X-QA-Agent-Truncated: original-body-25-bytes\r\n/);
  assert.doesNotMatch(res, /content-encoding/i, "the body is already decoded");
  assert.ok(res.endsWith("\r\n\r\n" + "x".repeat(10)));
  assert.equal(e?.responseLength, Buffer.from(String(e?.response), "base64").length);
});

test("a body at exactly the cap is not marked truncated", async () => {
  const { ctx, emit } = fakeContext();
  h.recordHistory(ctx, cfg, { maxBodyBytes: 5 });
  emit({ url: "https://target.test/exact", body: "12345" });
  await h.drainHistory();
  const [e] = captured();
  assert.equal(e?.truncated, undefined);
  assert.ok(raw(e?.response).endsWith("12345"));
});

test("HTTP/2 pseudo-headers are dropped and a Host header is always present, once", async () => {
  const { ctx, emit } = fakeContext();
  h.recordHistory(ctx, cfg);
  emit({
    url: "https://target.test/h2?q=1",
    reqHeaders: [
      { name: ":method", value: "GET" },
      { name: ":authority", value: "target.test" },
      { name: "accept", value: "*/*" },
    ],
    resHeaders: [
      { name: ":status", value: "200" },
      { name: "content-type", value: "application/json" },
    ],
  });
  emit({ url: "https://target.test/h1", reqHeaders: [{ name: "Host", value: "target.test" }] });
  await h.drainHistory();
  const [h2, h1] = captured();
  const req2 = raw(h2?.request);
  assert.ok(req2.startsWith("GET /h2?q=1 HTTP/1.1\r\nHost: target.test\r\n"), req2);
  assert.doesNotMatch(req2, /^:/m);
  assert.doesNotMatch(raw(h2?.response), /^:status/m);
  assert.equal(h2?.mimeType, "JSON");
  assert.equal((raw(h1?.request).match(/^host:/gim) ?? []).length, 1, "an existing Host is not duplicated");
});

test("unreadable request headers fall back to Host only; unreadable bodies keep the headers", async () => {
  const { ctx, emit } = fakeContext();
  h.recordHistory(ctx, cfg);
  emit({ url: "https://target.test/r", status: 302, statusText: "", reqHeaders: "throw", body: "throw",
    resHeaders: [{ name: "location", value: "/login" }], ip: "throw" });
  await h.drainHistory();
  const [e] = captured();
  assert.equal(raw(e?.request), "GET /r HTTP/1.1\r\nHost: target.test\r\n\r\n");
  assert.equal(raw(e?.response), "HTTP/1.1 302 \r\nlocation: /login\r\n\r\n", "space kept after the code");
  assert.equal(e?.ip, "");
});

test("unreadable response headers still record the exchange", async () => {
  const { ctx, emit } = fakeContext();
  h.recordHistory(ctx, cfg);
  emit({ url: "https://target.test/x", resHeaders: "throw", body: "b" });
  await h.drainHistory();
  const [e] = captured();
  assert.equal(raw(e?.response), "HTTP/1.1 200 OK\r\n\r\nb");
  assert.equal(e?.mimeType, "");
});

test("a POST body is appended to the raw request", async () => {
  const { ctx, emit } = fakeContext();
  h.recordHistory(ctx, cfg);
  emit({ url: "https://target.test/login", method: "POST", postData: "u=a&p=b" });
  await h.drainHistory();
  const [e] = captured();
  assert.equal(e?.method, "POST");
  assert.ok(raw(e?.request).endsWith("\r\n\r\nu=a&p=b"));
});

test("port, protocol and Burp's extension field", async () => {
  const { ctx, emit } = fakeContext();
  h.recordHistory(ctx, cfg);
  for (const url of [
    "https://target.test/a/b.js?v=1",
    "https://target.test:8443/report.",
    "http://plain.test/.htaccess",
    "https://target.test/",
  ]) {
    emit({ url });
  }
  await h.drainHistory();
  const rows = captured().map((e) => [e.port, e.protocol, e.extension]);
  assert.deepEqual(rows, [
    [443, "https", "js"],
    [8443, "https", "null"],
    [80, "http", "null"],
    [443, "https", "null"],
  ]);
});

test("mode auth writes to its own file and historyFiles lists only what exists", async () => {
  assert.deepEqual(h.historyFiles(), []);
  const anon = fakeContext();
  const auth = fakeContext();
  h.recordHistory(auth.ctx, cfg, { mode: "auth" });
  auth.emit({ url: "https://target.test/secure", reqHeaders: [{ name: "cookie", value: "session=FAKE" }] });
  await h.drainHistory();
  assert.equal(captured("anon").length, 0, "authenticated traffic must not land in the anonymous capture");
  assert.equal(captured("auth").length, 1);
  assert.deepEqual(h.historyFiles(), [h.historyJsonl("auth")]);

  h.recordHistory(anon.ctx, cfg, { mode: "anon" });
  anon.emit({ url: "https://target.test/public" });
  await h.drainHistory();
  assert.deepEqual(h.historyFiles(), [h.historyJsonl("anon"), h.historyJsonl("auth")]);
});

test("a response whose URL cannot be parsed is skipped without breaking the drain", async () => {
  const { ctx, emit } = fakeContext();
  h.recordHistory(ctx, cfg, { includeOffOrigin: true });
  emit({ url: "not a url" });
  emit({ url: "https://target.test/after" });
  await h.drainHistory();
  assert.deepEqual(captured().map((e) => e.url), ["https://target.test/after"]);
});
