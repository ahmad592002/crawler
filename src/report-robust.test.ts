/**
 * The report must survive a malformed status file.
 *
 * A non-array `personas` crashed the whole report - not just that section - because the
 * code used `?? []`, which guards null and undefined but not a string. strArr() had been
 * written for exactly this and was sitting three hundred lines above, unused.
 *
 * These call buildReport() directly. The previous version copied src/, junctioned the real
 * node_modules into a temp box, spawned a subprocess render per test and then removed the
 * box recursively - 13 seconds of an 8 second suite, and one filesystem behaviour change
 * away from deleting node_modules through that junction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport } from "./report.js";

/** Render into a throwaway output directory and return the HTML. */
function renderWith(files: Record<string, string>): string {
  const box = mkdtempSync(join(tmpdir(), "qa-report-"));
  mkdirSync(join(box, "screenshots"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(box, name), body);
  }
  try {
    return buildReport(box);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

const MINIMAL_PAGE = JSON.stringify({
  url: "https://t.test/a",
  template: "https://t.test/a",
  status: 200,
  title: "a",
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
  depth: 0,
});

test("a non-array personas does not take the report down", () => {
  const html = renderWith({
    "pages.jsonl": MINIMAL_PAGE + "\n",
    "authz-status.json": JSON.stringify({ verdict: "clean", personas: "alice", sharedIdentity: "ab" }),
  });
  assert.match(html, /Authorization scan/);
  assert.match(html, /alice/, "a lone string persona should be shown, not silently dropped");
});

test("a corrupt status file renders the empty state, never a clean verdict", () => {
  const html = renderWith({
    "pages.jsonl": MINIMAL_PAGE + "\n",
    "authz-status.json": "{ not json",
  });
  assert.match(html, /No authorization scan in this run/);
  assert.doesNotMatch(html, /sev low">clean/);
});

test("markup in a verdict is escaped, not rendered", () => {
  const html = renderWith({
    "pages.jsonl": MINIMAL_PAGE + "\n",
    "authz-status.json": JSON.stringify({ verdict: "<img src=x onerror=alert(1)>", personas: [] }),
  });
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img src=x/);
});

test("a missing coverage bucket produces 0%, not NaN", () => {
  const html = renderWith({
    "pages.jsonl": MINIMAL_PAGE + "\n",
    "coverage.json": JSON.stringify({ templates: {}, forms: null }),
  });
  assert.doesNotMatch(html, /NaN/);
  assert.match(html, /Test coverage/);
});

test("an inconclusive verdict says so plainly", () => {
  // A scan that compared nothing must not look like a clean one.
  const html = renderWith({
    "pages.jsonl": MINIMAL_PAGE + "\n",
    "authz-status.json": JSON.stringify({ verdict: "inconclusive", compared: 0, templates: 48 }),
  });
  assert.match(html, /This scan proved nothing/);
});

test("rendering into a temp directory leaves the real output untouched", () => {
  // buildReport mutates a module-level OUT; if it did not reset, the next caller would
  // write into a directory that has just been deleted.
  renderWith({ "pages.jsonl": MINIMAL_PAGE + "\n" });
  const html = buildReport();
  assert.match(html, /QA report/);
});
