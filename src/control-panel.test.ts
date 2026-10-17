/**
 * Control-panel tests - the pure, safety-relevant parts, no server and no spawned process.
 *
 * QA_CONFIG is pointed at a throwaway file BEFORE control-panel (and the config module it
 * pulls in) is imported, so saveConfig writes there and the project's real qa.config.json is
 * never touched. That is why the import is dynamic and this file uses top-level await.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "qa-panel-"));
const cfgPath = resolve(dir, "qa.config.json");
writeFileSync(
  cfgPath,
  JSON.stringify({
    baseUrl: "https://t.test",
    allowedOrigins: ["https://t.test"],
    include: [".*"],
    exclude: ["/logout"],
    maxPages: 20,
    maxDepth: 4,
    concurrency: 2,
    navTimeoutMs: 30000,
    maxRuntimeMs: 600000,
    blockDomains: [],
    denyList: ["delete"],
    denyUrlExceptions: [],
    emailPattern: "{GMAIL_LOCAL}+{runId}-{n}@gmail.com",
    emailProvider: "mailtm",
  }),
);
process.env.QA_CONFIG = cfgPath;

const { page, saveConfig, TASK_IDS } = await import("./control-panel.js");

test("the page renders a field for every config variable and the run buttons", () => {
  const html = page();
  assert.ok(html.includes('data-key="baseUrl"'), "baseUrl field");
  assert.ok(html.includes('data-key="allowedOrigins"'), "allowedOrigins field");
  assert.ok(html.includes('data-key="denyList"'), "denyList field");
  assert.ok(html.includes('data-task="crawl"') && html.includes('data-task="qa"'), "run buttons");
});

test("the run allow-list is exactly the known tasks - nothing arbitrary", () => {
  assert.deepEqual([...TASK_IDS].sort(), ["coverage", "crawl", "crawl:auth", "preflight", "profile", "qa", "report", "summary"]);
});

test("a valid save writes qa.config.json and keeps keys the form never sent", () => {
  const res = saveConfig(JSON.stringify({ baseUrl: "https://t.test", allowedOrigins: ["https://t.test"], maxPages: 33 }));
  assert.equal(res.ok, true);
  const written = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(written.maxPages, 33);
  assert.equal(written.emailProvider, "mailtm", "an untouched key survives");
});

test("an invalid value is refused with a field-named message and writes nothing", () => {
  const before = readFileSync(cfgPath, "utf8");
  const res = saveConfig(JSON.stringify({ maxPages: -5 }));
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /maxPages/);
  assert.equal(readFileSync(cfgPath, "utf8"), before, "file unchanged after a rejected save");
});

test("a wrong-typed value is refused (schema gate), config untouched", () => {
  const before = readFileSync(cfgPath, "utf8");
  const res = saveConfig(JSON.stringify({ maxDepth: "not-a-number" }));
  assert.equal(res.ok, false);
  assert.equal(readFileSync(cfgPath, "utf8"), before);
});

test("the form never surfaces a password field", () => {
  assert.ok(!/data-key="password"/.test(page()) && !/type="password"/.test(page()));
});
