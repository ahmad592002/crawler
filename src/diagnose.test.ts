/**
 * Diagnose tests. Build throwaway output dirs for each verdict and assert the right retry is
 * ranked first, that a login-wall is never "settled" (auth is the retry), and - the safety
 * one - that no suggested action ever touches allowedOrigins or the deny-list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { diagnose } from "./diagnose.js";
import type { QaConfig } from "./config.js";

const cfg = (over: Partial<QaConfig> = {}): QaConfig =>
  ({ baseUrl: "https://t.test", allowedOrigins: ["https://t.test"], maxPages: 60, maxDepth: 6, navTimeoutMs: 30000, requestDelayMs: 400, concurrency: 2, ...over }) as unknown as QaConfig;

function run(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "qa-diag-"));
  for (const [name, body] of Object.entries(files)) {
    if (name.includes("/")) mkdirSync(resolve(dir, name, ".."), { recursive: true });
    writeFileSync(resolve(dir, name), body);
  }
  return dir;
}
const status = (o: Record<string, unknown>) => JSON.stringify({ pages: 0, templates: 0, loginPages: 0, linksFound: 0, mode: "anon", ranAt: "", reason: "", ...o });
const pageLine = (o: Record<string, unknown>) => JSON.stringify({ url: "https://t.test/x", ok: true, forms: [], deniedButtons: [], deniedLinks: [], pageErrors: [], ...o });

test("no crawl yet → the only action is to crawl, not settled", () => {
  const d = diagnose(run({}), cfg());
  assert.equal(d.verdict, "no-crawl");
  assert.equal(d.settled, false);
  assert.equal(d.actions[0]?.kind, "none");
});

test("login-wall → setup-auth first, and never settled (auth is the retry)", () => {
  const dir = run({ "crawl-status.anon.json": status({ verdict: "login-wall", pages: 8, loginPages: 7, reason: "sign-in" }), "pages.jsonl": pageLine({}) });
  const d = diagnose(dir, cfg());
  assert.equal(d.actions[0]?.kind, "setup-auth");
  assert.equal(d.settled, false);
});

test("rate-limited → slow-down is ranked above everything", () => {
  const dir = run({ "crawl-status.anon.json": status({ verdict: "ok", pages: 20, load: { rateLimited: 5, throttledOrigins: ["https://t.test"] } }) });
  const d = diagnose(dir, cfg());
  assert.equal(d.actions[0]?.kind, "slow-down");
  assert.equal(d.rateLimited, true);
  assert.equal(d.complete, false);
});

test("hit the page ceiling on an ok run → raise-budget", () => {
  const dir = run({ "crawl-status.anon.json": status({ verdict: "ok", pages: 60, templates: 60 }) });
  const d = diagnose(dir, cfg({ maxPages: 60 }));
  assert.ok(d.actions.some((a) => a.kind === "raise-budget"));
  assert.equal(d.complete, false);
});

test("too-few-pages → widen-include then seed-sitemap", () => {
  const dir = run({ "crawl-status.anon.json": status({ verdict: "too-few-pages", pages: 2 }) });
  const kinds = diagnose(dir, cfg()).actions.map((a) => a.kind);
  assert.ok(kinds.indexOf("widen-include") >= 0 && kinds.indexOf("seed-sitemap") > kinds.indexOf("widen-include"));
});

test("a clean, complete run with scanners done is settled → run the report", () => {
  const dir = run({
    "crawl-status.anon.json": status({ verdict: "ok", pages: 20, templates: 18, loginPages: 0 }),
    "pages.jsonl": Array.from({ length: 20 }, () => pageLine({})).join("\n"),
    "deploy-status.json": JSON.stringify({ verdict: "clean" }),
    "coverage.json": JSON.stringify({ templates: { covered: 18, total: 18 } }),
    "findings.jsonl": JSON.stringify({ id: "F-1", severity: "low" }),
  });
  const d = diagnose(dir, cfg({ maxPages: 60 }));
  assert.equal(d.settled, true);
  assert.equal(d.complete, true);
});

test("usable inventory but scanners not run → run-scanners is suggested", () => {
  const dir = run({ "crawl-status.anon.json": status({ verdict: "ok", pages: 30, templates: 25, loginPages: 2 }), "pages.jsonl": Array.from({ length: 30 }, () => pageLine({})).join("\n") });
  const d = diagnose(dir, cfg());
  assert.ok(d.actions.some((a) => a.kind === "run-scanners"));
});

test("high failure rate → raise-timeout", () => {
  const pages = [...Array(10)].map((_, i) => pageLine({ ok: i < 5 })).join("\n");
  const dir = run({ "crawl-status.anon.json": status({ verdict: "ok", pages: 10, templates: 10 }), "pages.jsonl": pages });
  assert.ok(diagnose(dir, cfg()).actions.some((a) => a.kind === "raise-timeout"));
});

test("SAFETY: no action ever mentions allowedOrigins or editing the deny-list", () => {
  const scenarios = [
    { "crawl-status.anon.json": status({ verdict: "login-wall", pages: 5, loginPages: 5 }) },
    { "crawl-status.anon.json": status({ verdict: "too-few-pages", pages: 1 }) },
    { "crawl-status.anon.json": status({ verdict: "no-links", pages: 1, linksFound: 0 }) },
    { "crawl-status.anon.json": status({ verdict: "ok", pages: 60, load: { rateLimited: 3 } }) },
  ];
  for (const s of scenarios) {
    for (const a of diagnose(run(s), cfg()).actions) {
      const text = (a.why + " " + a.how).toLowerCase();
      assert.ok(!text.includes("allowedorigins"), `action must not touch allowedOrigins: ${a.how}`);
      assert.ok(!/add .*denylist|widen .*deny|remove .*deny|edit .*denylist/.test(text), `action must not weaken the deny-list: ${a.how}`);
    }
  }
});
