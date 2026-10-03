/**
 * The twenty-red-tests case.
 *
 * A full suite run failed twenty tests across eight unrelated spec files. Nothing was wrong
 * with the suite: the target's HTML served 200 in under a second while every subresource -
 * jquery.min.js, jquery-ui.js, foundation.js, the stylesheets, the images - answered 503.
 * Pages loaded and then did nothing.
 *
 * I checked "is the target up?" by fetching the home page, twice, and concluded it was
 * healthy both times. These tests pin the thing I got wrong: the document is cheap to serve
 * and comes back fine while the box refuses everything else.
 *
 * Offline: judgeHealth and subresources take their input directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeHealth, subresources } from "./preflight.js";

const ok = (url: string, ms = 500) => ({ url, status: 200, ms });

test("a healthy set of probes is healthy", () => {
  const h = judgeHealth([ok("https://t.test/"), ok("https://t.test/a.js"), ok("https://t.test/a.css")]);
  assert.equal(h.healthy, true);
  assert.equal(h.reason, "");
});

test("the real case: the document is fine and every asset 503s", () => {
  const h = judgeHealth([
    ok("https://t.test/", 588),
    { url: "https://t.test/js/jquery.min.js", status: 503, ms: 120 },
    { url: "https://t.test/js/jquery-ui.js", status: 503, ms: 110 },
    { url: "https://t.test/css/app.css", status: 503, ms: 90 },
  ]);
  assert.equal(h.healthy, false, "a 200 on the HTML is not a healthy target");
  assert.match(h.reason, /3 of 4/);
  assert.match(h.reason, /load pages that then do nothing/);
});

test("ONE bad asset among many is still unhealthy", () => {
  // The bar is deliberately low. A single missing script makes pages render and then sit
  // there, and the suite fails in ways that read as code defects.
  const h = judgeHealth([
    ok("https://t.test/"),
    ok("https://t.test/a.js"),
    ok("https://t.test/b.js"),
    { url: "https://t.test/c.js", status: 503, ms: 50 },
  ]);
  assert.equal(h.healthy, false);
});

test("a connection failure counts as badly as a 5xx", () => {
  const h = judgeHealth([ok("https://t.test/"), { url: "https://t.test/a.js", status: "TimeoutError", ms: 30000 }]);
  assert.equal(h.healthy, false);
  assert.match(h.reason, /1 of 2/);
});

test("a 404 asset is NOT a health problem", () => {
  // A missing favicon or an optional file is a site issue, not a reason to refuse to run
  // the suite. Only 5xx and transport failures mean the box is refusing work.
  const h = judgeHealth([ok("https://t.test/"), { url: "https://t.test/missing.png", status: 404, ms: 80 }]);
  assert.equal(h.healthy, true);
});

test("everything answering but crawling slowly is called out separately", () => {
  const h = judgeHealth([ok("https://t.test/"), ok("https://t.test/a.js", 14_000)]);
  assert.equal(h.healthy, false);
  assert.match(h.reason, /over 10s/);
  assert.match(h.reason, /timeouts, not failures/, "the distinction is what makes this useful");
});

test("an empty probe set is not quietly healthy", () => {
  const h = judgeHealth([]);
  assert.equal(h.healthy, false);
  assert.match(h.reason, /nothing could be probed/);
});

test("subresources finds scripts and stylesheets and resolves them", () => {
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="/css/app.css">
    <link rel="icon" href="/favicon.ico">
    <script src="/js/vendor/jquery.min.js"></script>
    <script src="http://ajax.googleapis.com/ajax/libs/jquery/1.9.1/jquery.min.js"></script>
    <script>inline(); // no src, must be ignored</script>
    </head><body></body></html>`;

  const found = subresources(html, "https://t.test/page");
  assert.deepEqual(found, [
    "https://t.test/js/vendor/jquery.min.js",
    "http://ajax.googleapis.com/ajax/libs/jquery/1.9.1/jquery.min.js",
    "https://t.test/css/app.css",
  ]);
  // rel="icon" is not a stylesheet, and an inline script has no src.
  assert.ok(!found.some((u) => u.includes("favicon")));
});

test("subresources is bounded and does not repeat itself", () => {
  const many = Array.from({ length: 40 }, (_, i) => `<script src="/s${i}.js"></script>`).join("");
  assert.equal(subresources(many, "https://t.test/").length, 10);

  const dupes = '<script src="/a.js"></script><script src="/a.js"></script>';
  assert.deepEqual(subresources(dupes, "https://t.test/"), ["https://t.test/a.js"]);
});
