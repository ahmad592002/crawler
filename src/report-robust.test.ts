/**
 * The report must survive a malformed status file.
 *
 * A non-array `personas` crashed the whole report - not just that section - because the new
 * code used `?? []`, which guards null and undefined but not a string. strArr() had been
 * written for exactly this and was sitting three hundred lines above, unused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROOT } from "./config.js";

/** Run report.ts against a throwaway output/ so the real one is untouched. */
function renderWith(files: Record<string, string>): string {
  const box = mkdtempSync(join(tmpdir(), "qa-report-"));
  mkdirSync(join(box, "output", "screenshots"), { recursive: true });
  for (const f of ["src", "qa.config.json", "package.json", "tsconfig.json"]) {
    cpSync(resolve(ROOT, f), join(box, f), { recursive: true });
  }
  try {
    execFileSync("cmd", ["/c", "mklink", "/J", join(box, "node_modules"), resolve(ROOT, "node_modules")], {
      stdio: "pipe",
    });
  } catch {
    // Junction may be unavailable; the run below will report the real reason.
  }
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(box, "output", name), body);
  }
  execFileSync("npx", ["tsx", "src/report.ts"], { cwd: box, stdio: "pipe", shell: process.platform === "win32" });
  const html = readFileSync(join(box, "output", "report.html"), "utf8");
  rmSync(box, { recursive: true, force: true });
  return html;
}

const MINIMAL_PAGE = JSON.stringify({
  url: "https://t.test/a", template: "https://t.test/a", status: 200, title: "a",
  loadMs: 1, screenshot: null, consoleErrors: [], failedRequests: [], pageErrors: [],
  forms: [], buttons: [], deniedButtons: [], deniedLinks: [], links: 0,
  authRequired: false, ok: true, mode: "anon", crawledAt: "", depth: 0,
});

test("a non-array personas does not take the report down", () => {
  const html = renderWith({
    "pages.jsonl": MINIMAL_PAGE + "\n",
    "authz-status.json": JSON.stringify({ verdict: "clean", personas: "alice", sharedIdentity: "ab" }),
  });
  assert.match(html, /Authorization scan/);
  assert.match(html, /alice/);
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
