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
process.env.QA_OUT = dir; // temp validation file lands here, not the real output/
process.env.QA_ENV = resolve(dir, ".env"); // login secrets write here, not the real .env

const { page, saveConfig, saveLogin, loginStatus, TASK_IDS } = await import("./control-panel.js");

test("the page renders a field for every config variable and the run buttons", () => {
  const html = page();
  assert.ok(html.includes('data-key="baseUrl"'), "baseUrl field");
  assert.ok(html.includes('data-key="allowedOrigins"'), "allowedOrigins field");
  assert.ok(html.includes('data-key="denyList"'), "denyList field");
  assert.ok(html.includes('data-task="crawl"') && html.includes('data-task="qa"'), "run buttons");
});

test("the run allow-list is exactly the known tasks - nothing arbitrary", () => {
  assert.deepEqual([...TASK_IDS].sort(), ["auth:setup", "coverage", "crawl", "crawl:auth", "preflight", "profile", "qa", "report", "summary"]);
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

test("the settings config form never carries a credential field", () => {
  // The password lives only on the Login tab; the config form (data-key fields) has none.
  assert.ok(!/data-key="password"/.test(page()), "no password among the config fields");
  assert.ok(!/data-key="login\.password"/.test(page()));
});

test("login: the password is saved to .env, never to qa.config.json, and never echoed back", () => {
  const res = saveLogin(JSON.stringify({ username: "alice@example.com", password: "s3cr3t-pw", path: "/signin", successUrl: "/home" }));
  assert.equal((res as { ok: boolean }).ok, true);
  // config gets the non-secret descriptors + username, NEVER the password
  const written = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(written.login.path, "/signin");
  assert.equal(written.login.successUrl, "/home");
  assert.equal(written.login.username, "alice@example.com");
  assert.ok(!("password" in written.login), "the password never reaches qa.config.json");
  assert.ok(!readFileSync(cfgPath, "utf8").includes("s3cr3t-pw"), "no password anywhere in the config file");
  // it went to .env (the temp QA_ENV)
  const env = readFileSync(resolve(dir, ".env"), "utf8");
  assert.match(env, /TEST_PASSWORD=s3cr3t-pw/);
  assert.match(env, /TEST_USERNAME=alice@example\.com/);
  // the status never leaks the value
  const st = loginStatus();
  assert.equal(st.passwordSet, true);
  assert.ok(!JSON.stringify(st).includes("s3cr3t-pw"), "loginStatus never returns the password");
});

test("login: a blank password keeps the existing one (edit without re-typing)", () => {
  const before = readFileSync(resolve(dir, ".env"), "utf8");
  saveLogin(JSON.stringify({ username: "bob@example.com", password: "", submitLabel: "Sign in" }));
  const env = readFileSync(resolve(dir, ".env"), "utf8");
  assert.match(env, /TEST_PASSWORD=s3cr3t-pw/, "the old password is untouched");
  assert.match(env, /TEST_USERNAME=bob@example\.com/, "username updated");
  assert.notEqual(env, before);
});
