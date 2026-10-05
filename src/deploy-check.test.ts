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
import {
  scanContent,
  auditHeaders,
  collectHtml,
  CONTENT_PATTERNS,
  MAX_CONTENT_FETCH,
} from "./deploy-check.js";
import type { PageRecord } from "./crawl.js";
import type { HttpExchange } from "./http-history.js";
import {
  createPoliteClient,
  setPoliteClient,
  resetPoliteClient,
  DEFAULT_POLITE,
} from "./polite.js";

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

// ------------------------------------------------- what the content scan actually reads

/**
 * collectHtml used to be either/or: `if (html.size > 0) return html`. Because
 * captureHttpHistory is off by default, the capture on disk is whatever an earlier run
 * left behind - 14 documents against a 124-page crawl - and a non-empty capture
 * short-circuited the fetch fallback, so 110 pages were never scanned and the run still
 * printed "0 finding(s)". These tests exist so that cannot come back quietly.
 */

/** A capture entry whose base64 response carries `body` after the header block. */
const exchangeFor = (url: string, body: string): HttpExchange =>
  ({
    url,
    mimeType: "HTML",
    response: Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n${body}`).toString(
      "base64",
    ),
  }) as unknown as HttpExchange;

const CFG = {
  baseUrl: "https://target.test",
  allowedOrigins: ["https://target.test"],
  denyList: [],
  denyUrlExceptions: [],
  exclude: [],
  include: [],
} as unknown as import("./config.js").QaConfig;

/** Run collectHtml with fetch stubbed, and report which URLs it asked for. */
async function collectWithStub(
  pages: PageRecord[],
  history: HttpExchange[],
  responder: (url: string) => { ok: boolean; status?: number; body: string } = () => ({
    ok: true,
    body: "<html/>",
  }),
): Promise<{ html: Map<string, string>; requested: string[] }> {
  const requested: string[] = [];

  // Install a politeness client whose fetch is the stub, rather than monkeypatching
  // globalThis. Two reasons: requests now go through that client, and its spacing comes
  // from the config - so driving 150 requests through the real one would genuinely wait
  // 150 x 250ms. delayMs 0 keeps this suite offline AND instant while still exercising the
  // same code path the crawler uses.
  setPoliteClient(
    createPoliteClient(
      { ...DEFAULT_POLITE, delayMs: 0, budget: 0 },
      {
        fetchImpl: (async (input: unknown) => {
          const url = String(input);
          requested.push(url);
          const r = responder(url);
          return {
            ok: r.ok,
            status: r.status ?? (r.ok ? 200 : 500),
            text: async () => r.body,
          } as unknown as Response;
        }) as unknown as typeof fetch,
      },
    ),
  );

  try {
    const html = await collectHtml(pages, history, CFG, 5_000);
    return { html, requested };
  } finally {
    resetPoliteClient();
  }
}

test("a partial capture does not suppress scanning the rest of the crawl", async () => {
  // One captured document, three crawled pages. The old code returned the one and called
  // it a day, leaving two pages unexamined while reporting success.
  const captured = "https://target.test/captured";
  const { html, requested } = await collectWithStub(
    [page(captured), page("https://target.test/b"), page("https://target.test/c")],
    [exchangeFor(captured, "<html>from capture</html>")],
  );

  assert.deepEqual(requested.sort(), ["https://target.test/b", "https://target.test/c"]);
  assert.equal(html.size, 3, "every crawled page must be available to the content scan");
  assert.match(html.get(captured) ?? "", /from capture/, "the captured body is kept as-is");
});

test("a page already in the capture is not fetched again", async () => {
  const url = "https://target.test/a";
  const { requested } = await collectWithStub([page(url)], [exchangeFor(url, "<html>x</html>")]);
  assert.deepEqual(requested, [], "re-fetching what the capture already holds wastes requests");
});

test("an off-origin or failed page is never fetched", async () => {
  const off = page("https://evil.test/x");
  const failed = page("https://target.test/dead");
  (failed as { ok: boolean }).ok = false;

  const { requested } = await collectWithStub([off, failed, page("https://target.test/ok")], []);
  assert.deepEqual(
    requested,
    ["https://target.test/ok"],
    "the allowedOrigins guard and the ok flag both still apply here",
  );
});

test("an unreachable page is skipped without taking the scan down", async () => {
  const { html } = await collectWithStub(
    [page("https://target.test/up"), page("https://target.test/down")],
    [],
    (url) => ({ ok: !url.endsWith("/down"), body: "<html/>" }),
  );
  assert.equal(html.size, 1);
  assert.ok(html.has("https://target.test/up"));
});

test("a page the crawl already recorded as 404 is not fetched again", async () => {
  // coverage.ts drops 404/410 from its denominator; the content scan must agree about what
  // exists, or it burns a request per dead page and then calls the result "unreachable".
  const dead = page("https://target.test/gone");
  (dead as { status: number }).status = 404;
  const alive = page("https://target.test/here");

  const { html, requested } = await collectWithStub([dead, alive], []);
  assert.deepEqual(requested, ["https://target.test/here"]);
  assert.equal(html.size, 1);
});

test("a protected page is counted apart from a broken one", async () => {
  // 401 from /basic_auth is the correct answer, not breakage. Both are excluded from the
  // scanned set - there is no body to scan - but only one of them is a problem.
  const { html, requested } = await collectWithStub(
    [page("https://target.test/basic_auth"), page("https://target.test/ok")],
    [],
    (url) => (url.endsWith("/basic_auth") ? { ok: false, status: 401, body: "" } : { ok: true, body: "<html/>" }),
  );
  assert.deepEqual(requested.sort(), ["https://target.test/basic_auth", "https://target.test/ok"]);
  assert.equal(html.size, 1, "a 401 serves no document to scan");
});

test("the fetch bound is respected and the excess is not silently dropped", async () => {
  const many = Array.from({ length: MAX_CONTENT_FETCH + 5 }, (_, i) =>
    page(`https://target.test/p${i}`),
  );
  const { requested } = await collectWithStub(many, []);
  assert.equal(requested.length, MAX_CONTENT_FETCH, "the bound is a bound");
  // The remainder is reported on stdout rather than dropped in silence; the count below is
  // what the operator needs in order to notice the scan is narrower than the crawl.
  assert.equal(many.length - requested.length, 5);
});
