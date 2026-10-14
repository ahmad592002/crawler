/**
 * Extra tests for bareCrawledPaths, which decides which query-string variants may fold
 * into a page underneath them. Offline, pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bareCrawledPaths, coverageKey } from "./coverage.js";

test("only query-less templates count as bare crawled paths", () => {
  const got = bareCrawledPaths([
    "https://example.test/shop",
    "https://example.test/index.php?page=billing",
    "https://example.test/item/{id}",
  ]);
  // URL() percent-encodes the braces; coverageKey parses the same way, so the two agree.
  assert.deepEqual([...got].sort(), ["https://example.test/item/%7Bid%7D", "https://example.test/shop"]);
});

test("bareCrawledPaths and coverageKey agree, so a ?knob variant folds into its page", () => {
  const bare = bareCrawledPaths(["https://example.test/item/{id}", "https://example.test/shop"]);
  assert.equal(coverageKey("https://example.test/item/{id}?tab=reviews", bare), "https://example.test/item/%7Bid%7D");
  assert.equal(coverageKey("https://example.test/shop?sort=price", bare), "https://example.test/shop");
  // No page underneath: the query is routing and must stay distinct.
  assert.equal(
    coverageKey("https://example.test/index.php?page=billing", bare),
    "https://example.test/index.php?page=billing",
  );
});

test("a fragment does not make a path non-bare, and is dropped from the key", () => {
  const got = bareCrawledPaths(["https://example.test/docs#intro"]);
  assert.deepEqual([...got], ["https://example.test/docs"]);
});

test("strings that are not URLs are ignored rather than thrown on", () => {
  const got = bareCrawledPaths(["not a url", "", "/relative/path"]);
  assert.equal(got.size, 0);
});

test("the key keeps the origin, so the same path on two hosts stays two units", () => {
  const got = bareCrawledPaths(["https://a.example.test/x", "https://b.example.test/x", "http://a.example.test/x"]);
  assert.equal(got.size, 3);
});

test("accepts any iterable, including a Set and a generator", () => {
  function* gen() {
    yield "https://example.test/a";
    yield "https://example.test/a";
  }
  assert.equal(bareCrawledPaths(new Set(["https://example.test/a"])).size, 1);
  assert.equal(bareCrawledPaths(gen()).size, 1, "duplicates collapse");
});
