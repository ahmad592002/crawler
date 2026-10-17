/**
 * Extra diagnose edges (round 3). Covers branches the base diagnose.test.ts leaves alone:
 * the no-links verdict, the "usable via (pages - loginPages >= 3)" OR-branch for a non-ok
 * verdict, the authz/exploration follow-ups, the throttledOrigins-only rate-limit signal,
 * and the strict > 20% failure threshold. Offline, no network. No action may widen scope.
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
  const dir = mkdtempSync(join(tmpdir(), "qa-diag-x-"));
  for (const [name, body] of Object.entries(files)) {
    if (name.includes("/")) mkdirSync(resolve(dir, name, ".."), { recursive: true });
    writeFileSync(resolve(dir, name), body);
  }
  return dir;
}
const status = (o: Record<string, unknown>) => JSON.stringify({ pages: 0, templates: 0, loginPages: 0, linksFound: 0, mode: "anon", ranAt: "", reason: "", ...o });
const pageLine = (o: Record<string, unknown>) => JSON.stringify({ url: "https://t.test/x", ok: true, forms: [], deniedButtons: [], deniedLinks: [], pageErrors: [], ...o });

test("no-links verdict -> seed-sitemap at priority 3, not settled", () => {
  const d = diagnose(run({ "crawl-status.anon.json": status({ verdict: "no-links", pages: 1, linksFound: 0 }) }), cfg());
  const seed = d.actions.find((a) => a.kind === "seed-sitemap");
  assert.equal(seed?.priority, 3);
  assert.equal(d.settled, false, "a retry (sitemap) is still worthwhile");
});

test("usable via pages-minus-login even when the verdict is not 'ok' -> scanners suggested", () => {
  // no-links, but five non-login pages landed: pages - loginPages = 5 >= 3 => usable.
  const d = diagnose(run({ "crawl-status.anon.json": status({ verdict: "no-links", pages: 5, loginPages: 0 }) }), cfg());
  assert.ok(d.actions.some((a) => a.kind === "run-scanners"), "the OR-branch of `usable` fires");
});

test("a saved session plus a usable crawl but no authz scan -> an authorization follow-up", () => {
  const d = diagnose(
    run({
      "crawl-status.anon.json": status({ verdict: "ok", pages: 20, templates: 18, loginPages: 0 }),
      "pages.jsonl": Array.from({ length: 20 }, () => pageLine({})).join("\n"),
      "deploy-status.json": JSON.stringify({ verdict: "clean" }),
      "coverage.json": JSON.stringify({ templates: { covered: 1, total: 1 } }),
      "auth/state.json": JSON.stringify({ cookies: [] }),
    }),
    cfg(),
  );
  assert.ok(d.scannersRun.authz === false);
  assert.ok(d.actions.some((a) => a.why.toLowerCase().includes("authorization")), "authz follow-up is offered when a session exists");
});

test("scanners ran, zero findings -> run-exploration is offered", () => {
  const d = diagnose(
    run({
      "crawl-status.anon.json": status({ verdict: "ok", pages: 20, templates: 18, loginPages: 0 }),
      "pages.jsonl": Array.from({ length: 20 }, () => pageLine({})).join("\n"),
      "deploy-status.json": JSON.stringify({ verdict: "clean" }),
      "coverage.json": JSON.stringify({ templates: { covered: 1, total: 1 } }),
    }),
    cfg(),
  );
  assert.equal(d.counts.findings, 0);
  assert.ok(d.actions.some((a) => a.kind === "run-exploration"));
});

test("exactly 20% of pages failing does NOT trip raise-timeout (threshold is strictly >)", () => {
  const pages = Array.from({ length: 10 }, (_, i) => pageLine({ ok: i >= 2 })).join("\n"); // 2/10 = 0.2
  const d = diagnose(run({ "crawl-status.anon.json": status({ verdict: "ok", pages: 10, templates: 10 }), "pages.jsonl": pages }), cfg());
  assert.ok(!d.actions.some((a) => a.kind === "raise-timeout"), "0.2 is not greater than 0.2");
});

test("throttledOrigins alone (rateLimited count 0) still reads as rate-limited", () => {
  const d = diagnose(run({ "crawl-status.anon.json": status({ verdict: "ok", pages: 20, load: { rateLimited: 0, throttledOrigins: ["https://t.test"] } }) }), cfg());
  assert.equal(d.rateLimited, true);
  assert.equal(d.actions[0]?.kind, "slow-down");
});

test("counts fall back to the inventory when no crawl-status is written", () => {
  const d = diagnose(run({ "pages.jsonl": Array.from({ length: 4 }, () => pageLine({})).join("\n") }), cfg());
  assert.equal(d.counts.pages, 4, "status absent -> count the pages.jsonl lines");
  assert.equal(d.verdict, "ok", "pages present with no status -> ok");
});
