/**
 * Extra summary edges (round 3). Covers materializeNuclei's path handling (no-endpoint recs
 * left untouched, no directory created, single {list} substitution) and computeSummary over
 * odd/partial inputs: auth-page merge, deploy+authz findings folded into the totals, the
 * "ran" vs "not run" deploy verdict, slowest-page ordering/cap, and cookie/destructive
 * counting. Offline, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { computeSummary, materializeNuclei } from "./summary.js";
import type { NucleiRec } from "./nuclei.js";
import type { QaConfig } from "./config.js";

const cfg = {
  baseUrl: "https://t.test",
  allowedOrigins: ["https://t.test"],
  denyList: ["delete"],
  denyUrlExceptions: [],
  requestDelayMs: 400,
} as unknown as QaConfig;

const rec = (over: Partial<NucleiRec>): NucleiRec =>
  ({ id: "baseline", title: "", why: "", fix: "", endpoints: [], command: "nuclei {list}", templates: "", severity: "", intrusive: false, ...over }) as NucleiRec;

test("materializeNuclei leaves an endpoint-less rec untouched and creates no directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-mat-"));
  const out = materializeNuclei([rec({ id: "baseline", endpoints: [], command: "nuclei -u x {list}" })], dir, true);
  assert.equal(out[0]?.command, "nuclei -u x {list}", "{list} stays — there is no list to point at");
  assert.equal(existsSync(resolve(dir, "nuclei")), false, "no nuclei/ dir when nothing has endpoints");
});

test("materializeNuclei substitutes only the first {list} and writes the target file", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-mat-"));
  const out = materializeNuclei([rec({ id: "auth", endpoints: ["https://t.test/login"], command: "a {list} b {list}" })], dir, true);
  assert.equal(out[0]?.command, "a output/nuclei/auth.txt b {list}", "replace hits the first {list} only");
  assert.ok(existsSync(resolve(dir, "nuclei", "auth.txt")), "the target list is written");
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "qa-summ-x-"));
  writeFileSync(
    resolve(dir, "pages.jsonl"),
    [
      JSON.stringify({ url: "https://t.test/a", template: "https://t.test/a", ok: true, loadMs: 50, forms: [{ destructive: true }], deniedButtons: [], deniedLinks: ["x"] }),
      JSON.stringify({ url: "https://t.test/slow", template: "https://t.test/slow", ok: true, loadMs: 900, forms: [], deniedButtons: [], deniedLinks: [] }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    resolve(dir, "pages.auth.jsonl"),
    JSON.stringify({ url: "https://t.test/acct", template: "https://t.test/acct", ok: true, loadMs: 120, authRequired: true, forms: [], deniedButtons: ["Delete"], deniedLinks: [] }) + "\n",
  );
  writeFileSync(resolve(dir, "deploy-findings.jsonl"), JSON.stringify({ id: "D-1", severity: "high", url: "https://t.test/d" }) + "\n");
  writeFileSync(resolve(dir, "authz-findings.jsonl"), JSON.stringify({ id: "A-1", severity: "critical", url: "https://t.test/z" }) + "\n");
  writeFileSync(
    resolve(dir, "techprofile.json"),
    JSON.stringify({ cookies: [{ name: "a", secure: false, httpOnly: true }, { name: "b", secure: true, httpOnly: false }, { name: "c", secure: true, httpOnly: true }] }),
  );
  return dir;
}

test("computeSummary merges auth pages and folds deploy+authz findings into the totals", () => {
  const d = computeSummary(fixture(), cfg);
  assert.equal(d.pages.crawled, 2, "pages.jsonl only");
  assert.equal(d.pages.auth, 1, "pages.auth.jsonl counted separately");
  assert.equal(d.findings.total, 2, "deploy + authz findings");
  assert.equal(d.findings.bySeverity.critical, 1);
  assert.equal(d.findings.bySeverity.high, 1);
  assert.equal(d.findings.blocking, 2, "critical + high are blocking");
});

test("computeSummary: deploy verdict is 'ran' from findings alone, and posture/skip counts are right", () => {
  const d = computeSummary(fixture(), cfg);
  const deploy = d.scans.find((s) => s.name === "Pre-deploy scan");
  assert.equal(deploy?.ran, true);
  assert.equal(deploy?.verdict, "ran", "findings present but no status file -> 'ran'");
  assert.deepEqual(d.security.insecureCookies.sort(), ["a", "b"], "a cookie missing EITHER flag is insecure; the clean one is omitted");
  assert.equal(d.skipped.destructiveForms, 1);
  assert.equal(d.skipped.deniedButtons, 1, "the auth page's denied Delete button");
  assert.equal(d.skipped.deniedLinks, 1);
});

test("computeSummary orders slowest pages descending", () => {
  const d = computeSummary(fixture(), cfg);
  assert.equal(d.slowest[0]?.url, "https://t.test/slow", "900ms page is first");
  assert.ok((d.slowest[0]?.loadMs ?? 0) >= (d.slowest[1]?.loadMs ?? 0));
  assert.ok(d.slowest.length <= 5);
});
