/**
 * Summary tests. computeSummary reads a throwaway output dir, so the real output/ is never
 * touched and the test has no network. Covers the robustness rules (missing file, junk line)
 * and that the markdown has every section.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { computeSummary, renderSummaryMarkdown, materializeNuclei } from "./summary.js";
import { buildRecommendations } from "./nuclei.js";
import type { QaConfig } from "./config.js";

const cfg = {
  baseUrl: "https://t.test",
  allowedOrigins: ["https://t.test"],
  denyList: ["delete"],
  denyUrlExceptions: [],
  requestDelayMs: 400,
} as unknown as QaConfig;

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "qa-summary-"));
  writeFileSync(resolve(dir, "pages.jsonl"), [
    JSON.stringify({ url: "https://t.test/", template: "https://t.test/", ok: true, loadMs: 100, forms: [], deniedButtons: ["Delete"], deniedLinks: [] }),
    JSON.stringify({ url: "https://t.test/login", template: "https://t.test/login", ok: true, loadMs: 300, authRequired: true, forms: [], deniedButtons: [], deniedLinks: [] }),
    "this is not json", // must be skipped, not throw
  ].join("\n") + "\n");
  writeFileSync(resolve(dir, "findings.jsonl"), [
    JSON.stringify({ id: "F-1", severity: "critical", url: "https://t.test/x", feature: "Boom" }),
    JSON.stringify({ id: "F-2", severity: "weird", url: "https://t.test/y" }), // unknown sev -> medium
  ].join("\n") + "\n");
  writeFileSync(resolve(dir, "techprofile.json"), JSON.stringify({
    server: [{ name: "nginx", confidence: "confirmed", evidence: "" }],
    securityHeaders: [{ name: "content-security-policy", present: false }],
    cookies: [{ name: "s", secure: false, httpOnly: true, sameSite: null }],
  }));
  writeFileSync(resolve(dir, "coverage.json"), JSON.stringify({ templates: { covered: 1, total: 2 }, forms: {}, controls: {} }));
  writeFileSync(resolve(dir, "authz-status.json"), JSON.stringify({ verdict: "clean" }));
  return dir;
}

test("computeSummary tolerates junk and a missing file, and counts correctly", () => {
  const dir = fixture();
  const d = computeSummary(dir, cfg);
  assert.equal(d.pages.crawled, 2, "the non-json line is skipped");
  assert.equal(d.findings.total, 2);
  assert.equal(d.findings.bySeverity.critical, 1);
  assert.equal(d.findings.bySeverity.medium, 1, "unknown severity renders as medium");
  assert.equal(d.findings.blocking, 1);
  assert.equal(d.features, 0, "features.jsonl absent -> 0, no throw");
});

test("computeSummary reads coverage, posture and the authz verdict", () => {
  const d = computeSummary(fixture(), cfg);
  assert.equal(d.coverage.find((c) => c.label === "Templates")?.pct, 50);
  assert.deepEqual(d.security.missingHeaders, ["content-security-policy"]);
  assert.deepEqual(d.security.insecureCookies, ["s"]);
  assert.equal(d.scans.find((s) => s.name === "Authorization scan")?.verdict, "clean");
  assert.equal(d.skipped.deniedButtons, 1);
});

test("the markdown has every section and a fenced nuclei command", () => {
  const md = renderSummaryMarkdown(computeSummary(fixture(), cfg));
  for (const h of ["# QA summary", "## Findings", "## Coverage", "## Scans", "## Security posture", "## Recommended nuclei commands"]) {
    assert.ok(md.includes(h), `missing section: ${h}`);
  }
  assert.ok(/```bash\nnuclei /.test(md), "a runnable nuclei command block");
  assert.ok(md.includes("critical"));
});

test("materializeNuclei writes the target lists when asked", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-nuclei-"));
  const recs = buildRecommendations([
    { url: "https://t.test/login", template: "https://t.test/login", ok: true, authRequired: true, forms: [], deniedButtons: [], deniedLinks: [] } as never,
  ], null, cfg);
  const out = materializeNuclei(recs, dir, true);
  const auth = out.find((r) => r.id === "auth");
  assert.ok(auth, "auth rec exists");
  assert.ok(existsSync(resolve(dir, "nuclei", "auth.txt")), "target list written");
  assert.ok(auth.command.includes("output/nuclei/auth.txt"));
});

test("materializeNuclei with write=false substitutes the path but writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-nuclei-ro-"));
  const recs = buildRecommendations([
    { url: "https://t.test/login", template: "https://t.test/login", ok: true, authRequired: true, forms: [], deniedButtons: [], deniedLinks: [] } as never,
  ], null, cfg);
  const out = materializeNuclei(recs, dir, false);
  assert.ok(!out.some((r) => r.command.includes("{list}")));
  assert.ok(!existsSync(resolve(dir, "nuclei")), "write=false creates no files");
});
