/**
 * Extra tests for the authz scanner's body classifiers. Offline: no browser, no network.
 *
 * These pin the helpers classify() is built from - isDenyEnvelope, visibleTextLength,
 * hasRealContent, similarity - so a change to one of them shows up here directly rather
 * than as a fabricated (or missing) IDOR finding three layers up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NEAR_MISS_FLOOR,
  classify,
  hasRealContent,
  isDenyEnvelope,
  similarity,
  visibleTextLength,
} from "./authz-check.js";

// ------------------------------------------------------------------ isDenyEnvelope

test("flat auth-denial envelopes are recognised under every conventional key", () => {
  for (const body of [
    `{"error":"Unauthorized"}`,
    `{"message":"Forbidden"}`,
    `{"detail":"Authentication required"}`,
    `{"code":"TOKEN_EXPIRED"}`,
    `{"status":401,"reason":"not_logged_in"}`,
    `  {"errors":"session expired"}  `,
  ]) {
    assert.equal(isDenyEnvelope(body), true, body);
  }
});

test("a resource that merely mentions expiry or carries data is not a denial", () => {
  for (const body of [
    `{"code":"EXPIRED_COUPON"}`,
    `{"message":"user 44 hit login_required","entries":[1,2,3]}`,
    `{"balance":128455.12}`,
    `{"title":"Forbidden fruit"}`, // the wording is under a key no envelope uses
    `{}`,
    `[{"error":"unauthorized"}]`, // a top-level array is a list, not an envelope
    `{"a":1,"b":2,"c":3,"d":4,"e":5,"error":"unauthorized"}`, // too wide to be an envelope
  ]) {
    assert.equal(isDenyEnvelope(body), false, body);
  }
});

test("non-JSON bodies fall back to wording only when short", () => {
  assert.equal(isDenyEnvelope(`{"error":"unauthorized"`), true, "truncated short JSON");
  assert.equal(isDenyEnvelope("Unauthorized"), true);
  assert.equal(isDenyEnvelope(`Unauthorized ${"x".repeat(400)}`), false, "long body: wording alone is not enough");
  assert.equal(isDenyEnvelope("not json, nothing about auth"), false);
});

// T-01: these are the two most common real-world shapes for a 401/403 body. A non-empty
// nested object or array counted as "carries data", so the envelope was read as a resource -
// and a 200 carrying it was treated as having reached the page, fabricating IDOR findings.
test("a nested error object is still a denial (Google/JSON:API style envelopes)", () => {
  assert.equal(isDenyEnvelope(`{"error":{"code":401,"message":"Unauthenticated"}}`), true);
  assert.equal(isDenyEnvelope(`{"errors":[{"status":"401","title":"Unauthorized"}]}`), true);
  assert.equal(isDenyEnvelope(`{"errors":[{"detail":"Unauthorized"}]}`), true);
  // The exemption is for the error key only, and only when its leaves read as a denial.
  assert.equal(isDenyEnvelope(`{"error":{"code":422,"message":"Quantity must be positive"}}`), false);
  assert.equal(isDenyEnvelope(`{"error":{"message":"Unauthorized"},"data":{"balance":1}}`), false);
});

test("classify: a 200 with a flat JSON denial is login-like, not content that was reached", () => {
  const p = classify(200, `{"error":"unauthorized"}`);
  assert.equal(p.looksLikeLogin, true);
});

// ------------------------------------------------------------------ visibleTextLength

test("visibleTextLength ignores scripts, styles, tags, entities and collapses whitespace", () => {
  assert.equal(visibleTextLength(""), 0);
  assert.equal(visibleTextLength("<div>   </div>"), 0);
  assert.equal(visibleTextLength("<script>var x = 'a lot of code here';</script>"), 0);
  assert.equal(visibleTextLength("<STYLE>body{color:red}</STYLE>"), 0, "case-insensitive");
  assert.equal(visibleTextLength("<p>Hello</p>\n\n<p>World</p>"), "Hello World".length);
  assert.equal(visibleTextLength("a&nbsp;&amp;&#39;b"), "a b".length);
  assert.equal(
    visibleTextLength(`<script type="module">\n</script>\n<script>x</script>ok`),
    2,
    "several script blocks are each removed, not one greedy span",
  );
});

// ------------------------------------------------------------------ hasRealContent

test("hasRealContent: an un-hydrated SPA shell is not content", () => {
  const shell = `<!doctype html><html><head><title>App</title><script src="/app.js"></script></head>
<body><div id="root"></div></body></html>`;
  assert.equal(hasRealContent(shell), false);
});

test("hasRealContent: a static form shell without controls does not count, controls do", () => {
  assert.equal(hasRealContent(`<div id="root"><form action="/search"></form></div>`), false);
  assert.equal(hasRealContent(`<h1>Admin</h1><input name="a"><button>Go</button>`), true);
  assert.equal(hasRealContent(`<TABLE><tr><td>1</td></tr></TABLE>`), true);
});

test("hasRealContent: short JSON with a key or values is content; empty JSON is not", () => {
  assert.equal(hasRealContent(`{"balance":128455.12}`), true);
  assert.equal(hasRealContent(`[1,2,3]`), true);
  assert.equal(hasRealContent(`[{"id":1}]`), true);
  assert.equal(hasRealContent(`["a"]`), true);
  assert.equal(hasRealContent(`[]`), false);
  assert.equal(hasRealContent(`{}`), false);
});

test("hasRealContent: forty characters of visible prose is enough on its own", () => {
  assert.equal(hasRealContent(`<p>${"a".repeat(40)}</p>`), true);
  assert.equal(hasRealContent(`<p>${"a".repeat(39)}</p>`), false);
});

// ------------------------------------------------------------------ similarity

const page = (n: number) => `<h1>Record</h1><p>${"x".repeat(n)}</p>`;

test("similarity is 0 unless BOTH sides reached the resource", () => {
  const ok = classify(200, page(1000));
  for (const other of [classify(403, page(1000)), classify(302, ""), classify(200, `<div id="root"></div>`)]) {
    assert.equal(similarity(ok, other), 0);
    assert.equal(similarity(other, ok), 0, "symmetric");
  }
});

test("similarity is the length ratio, symmetric, and 1 for identical pages", () => {
  const a = classify(200, page(1000));
  const b = classify(200, page(500));
  assert.equal(similarity(a, a), 1);
  assert.equal(similarity(a, b), similarity(b, a));
  assert.equal(similarity(a, b), b.length / a.length);
  assert.ok(similarity(a, b) >= 0 && similarity(a, b) <= 1);
});

test("NEAR_MISS_FLOOR stays in the band where it filters size-coincidences", () => {
  // See the docstring: 0.5 flooded the report. Anything at or below that reintroduces it.
  assert.ok(NEAR_MISS_FLOOR > 0.5 && NEAR_MISS_FLOOR < 0.9, String(NEAR_MISS_FLOOR));
});
