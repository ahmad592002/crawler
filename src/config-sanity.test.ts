/**
 * The committed config must not carry debug values.
 *
 * This test exists because of a real mistake, and an embarrassing one: while testing the
 * per-mode capture split I set maxPages to 4, turned captureHttpHistory on and dropped the
 * body cap tenfold - then committed all three inside a fix commit that documented ten other
 * changes and mentioned none of these. Every subsequent crawl, and the coverage,
 * authorization and pre-deploy scans that read its output, would have reported on FOUR
 * pages while reading as a full run. That is the false-clean outcome this project treats as
 * its worst, produced by the tool on itself.
 *
 * It is exactly what `npm run predeploy` looks for in someone else's code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const cfg = loadConfig();

test("maxPages is not a debugging value", () => {
  assert.ok(
    cfg.maxPages >= 20,
    `maxPages is ${cfg.maxPages}. A crawl that small makes every downstream scan report ` +
      `"clean" over almost nothing. Raise it, or say explicitly why this target is tiny.`,
  );
});

test("captureHttpHistory is off by default", () => {
  // The capture records full request bodies including Cookie and Authorization headers.
  // Committing it as on means every crawl writes credentials to disk unasked.
  assert.equal(
    cfg.captureHttpHistory,
    false,
    "captureHttpHistory is committed as true - every crawl will write session cookies to disk",
  );
});

test("the capture body cap is not a debugging value", () => {
  assert.ok(
    cfg.captureMaxBodyBytes >= 1_000_000,
    `captureMaxBodyBytes is ${cfg.captureMaxBodyBytes}; large responses would be silently truncated`,
  );
});

test("the deny-list and origin allow-list are populated", () => {
  // An empty denyList disables the destructive-control guard entirely, and an empty
  // allowedOrigins makes isAllowedUrl reject everything, which reads as "site unreachable".
  assert.ok(cfg.denyList.length > 0, "denyList is empty - the destructive guard does nothing");
  assert.ok(cfg.allowedOrigins.length > 0, "allowedOrigins is empty - nothing can be crawled");
});

test("baseUrl is inside allowedOrigins", () => {
  // Otherwise the very first request is refused by the scope gate and the run looks dead.
  assert.ok(
    cfg.allowedOrigins.includes(new URL(cfg.baseUrl).origin),
    `baseUrl ${cfg.baseUrl} is not in allowedOrigins ${JSON.stringify(cfg.allowedOrigins)}`,
  );
});
