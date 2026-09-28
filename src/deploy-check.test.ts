/**
 * Detection tests for the pre-deploy scan.
 *
 * A scanner that reports nothing on a clean site proves nothing. These feed it a page
 * built out of exactly the things you do not want to ship, and assert each one is caught -
 * then feed it an innocent page and assert it stays quiet.
 *
 * Offline: no browser, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanContent, auditHeaders, CONTENT_PATTERNS } from "./deploy-check.js";
import type { PageRecord } from "./crawl.js";
import type { HttpExchange } from "./http-history.js";

const page = (url: string): PageRecord =>
  ({
    url,
    template: url,
    depth: 0,
    status: 200,
    title: "t",
    loadMs: 1,
    screenshot: null,
    consoleErrors: [],
    failedRequests: [],
    pageErrors: [],
    forms: [],
    buttons: [],
    deniedButtons: [],
    deniedLinks: [],
    links: 0,
    authRequired: false,
    ok: true,
    mode: "anon",
    crawledAt: "",
  }) as unknown as PageRecord;

const URL_A = "https://target.test/a";

function scan(body: string): string[] {
  return scanContent([page(URL_A)], new Map([[URL_A, body]])).map((f) => f.feature);
}

// ---------------------------------------------------------------- the bad page

const DIRTY = `
<!doctype html><html><head><title>Checkout</title>
<!-- TODO: remove before launch, admin password is hunter2 -->
</head><body>
<p>Lorem ipsum dolor sit amet, placeholder copy.</p>
<p>Contact test@test.com</p>
<script>
  console.log("cart", cart);
  debugger;
  const API = "https://staging.internal.example/api";
  const DEV = "http://localhost:3000";
  const AWS = "AKIAIOSFODNN7EXAMPLE";
  const GK  = "AIzaSyD-1234567890abcdefghijklmnopqrstu";
  const SK  = "sk_live_51H8xQ2abcdefghijklmnop";
  const GH  = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
  const SL  = "xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx";
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
</script>
<pre>Traceback (most recent call last):
  File "/app/views.py", line 42, in get</pre>
<p>-----BEGIN RSA PRIVATE KEY-----</p>
<p>You're seeing this error because you have <code>DEBUG = True</code></p>
//# sourceMappingURL=/static/app.js.map
</body></html>`;

test("catches every category of leftover on a deliberately dirty page", () => {
  const hits = scan(DIRTY);

  const mustFind = [
    "Source map reference",
    "Staging or localhost reference",
    "Debug statement in inline script",
    "TODO / FIXME left in served markup",
    "HTML comment mentioning a secret",
    "AWS access key id",
    "Google API key",
    "Stripe live secret key",
    "GitHub token",
    "Slack token",
    "JWT in page content",
    "Private key block",
    "Server stack trace",
    "Framework debug page",
    "Placeholder or lorem content",
  ];

  const missed = mustFind.filter((m) => !hits.includes(m));
  assert.deepEqual(missed, [], `missed: ${missed.join(", ")}`);
});

test("every content pattern has at least one test case exercising it", () => {
  const hits = new Set(scan(DIRTY));
  // Directory listing is the one shape that cannot coexist with the page above.
  hits.add("Directory listing");
  const untested = CONTENT_PATTERNS.map((p) => p.name).filter((n) => !hits.has(n));
  assert.deepEqual(untested, [], `patterns with no coverage: ${untested.join(", ")}`);
});

test("catches a directory listing", () => {
  assert.ok(scan("<title>Index of /uploads</title>").includes("Directory listing"));
});

// ---------------------------------------------------------------- the good page

const CLEAN = `
<!doctype html><html><head><title>Sign in</title></head><body>
<h1>Welcome back</h1>
<form action="/session" method="post">
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <button type="submit">Sign in</button>
</form>
<p>Read our <a href="https://example.com/privacy">privacy policy</a>.</p>
<script src="/static/app.4f2c1a.js"></script>
</body></html>`;

test("stays silent on a clean production page", () => {
  assert.deepEqual(scan(CLEAN), []);
});

test("does not flag example.com or w3.org as staging hosts", () => {
  const hits = scan(`<a href="https://example.com/x">x</a><html xmlns="http://www.w3.org/1999/xhtml">`);
  assert.ok(!hits.includes("Staging or localhost reference"));
});

test("reports one finding per URL per pattern, not one per page record", () => {
  // The same URL appears in both the anon and the authenticated crawl.
  const found = scanContent([page(URL_A), page(URL_A)], new Map([[URL_A, "debugger;"]]));
  assert.equal(found.length, 1);
});

// ---------------------------------------------------------------- headers

function exchange(over: Partial<HttpExchange> & { headers: string }): HttpExchange {
  const raw = `HTTP/1.1 200 OK\r\n${over.headers}\r\n\r\n<html></html>`;
  return {
    time: "",
    url: "https://target.test/x",
    host: "target.test",
    ip: "",
    port: 443,
    protocol: "https",
    method: "GET",
    path: "/x",
    extension: "null",
    request: "",
    status: 200,
    responseLength: raw.length,
    mimeType: "HTML",
    response: Buffer.from(raw, "utf8").toString("base64"),
    ...over,
  } as HttpExchange;
}

test("flags missing security headers on an HTML response", () => {
  const names = auditHeaders([exchange({ headers: "content-type: text/html" })]).map((f) => f.feature);
  for (const want of [
    "Missing Content-Security-Policy",
    "Missing X-Content-Type-Options",
    "Missing HSTS on an HTTPS response",
    "Missing clickjacking protection",
    "Missing Referrer-Policy",
  ]) {
    assert.ok(names.includes(want), `expected ${want}, got ${names.join(", ")}`);
  }
});

test("a fully hardened response produces no header findings", () => {
  const hardened = exchange({
    headers: [
      "content-type: text/html",
      "content-security-policy: default-src 'self'; frame-ancestors 'none'",
      "x-content-type-options: nosniff",
      "strict-transport-security: max-age=31536000",
      "referrer-policy: strict-origin-when-cross-origin",
    ].join("\r\n"),
  });
  assert.deepEqual(auditHeaders([hardened]), []);
});

test("flags version disclosure and insecure cookies", () => {
  const names = auditHeaders([
    exchange({
      headers: [
        "content-type: text/html",
        "content-security-policy: default-src 'self'; frame-ancestors 'none'",
        "x-content-type-options: nosniff",
        "strict-transport-security: max-age=1",
        "referrer-policy: no-referrer",
        "server: nginx/1.25.3",
        "x-powered-by: Express",
        "set-cookie: sid=abc; Path=/",
      ].join("\r\n"),
    }),
  ]).map((f) => f.feature);

  assert.ok(names.includes("Server version disclosed"));
  assert.ok(names.includes("X-Powered-By disclosed"));
  assert.ok(names.some((n) => n.startsWith('Cookie "sid" missing')));
});

test("flags wildcard CORS combined with credentials", () => {
  const names = auditHeaders([
    exchange({
      headers: [
        "content-type: application/json",
        "x-content-type-options: nosniff",
        "strict-transport-security: max-age=1",
        "access-control-allow-origin: *",
        "access-control-allow-credentials: true",
      ].join("\r\n"),
    }),
  ]).map((f) => f.feature);
  assert.ok(names.includes("CORS allows any origin with credentials"));
});

test("header findings are deduplicated across many exchanges", () => {
  const many = Array.from({ length: 50 }, () => exchange({ headers: "content-type: text/html" }));
  const csp = auditHeaders(many).filter((f) => f.feature === "Missing Content-Security-Policy");
  assert.equal(csp.length, 1);
});
