import { test } from "node:test";
import assert from "node:assert/strict";
import { planDeepScan, winToBash, type DeepScanOptions } from "./deepscan.js";
import type { QaConfig } from "./config.js";

// Minimal config — planDeepScan only reads allowedOrigins (via isAllowedUrl) and customEngine.
function cfg(over: Partial<QaConfig> = {}): QaConfig {
  return {
    allowedOrigins: ["https://staging.example.com"],
    ...over,
  } as unknown as QaConfig;
}

function opts(over: Partial<DeepScanOptions> = {}): DeepScanOptions {
  return {
    engine: "official",
    target: "https://staging.example.com",
    cfg: cfg(),
    captureXml: "C:\\proj\\output\\http-history.xml",
    captureExists: true,
    outLabel: "qa_staging",
    severity: "critical,high,medium",
    dryRun: false,
    ...over,
  };
}

const yes = () => true;
const no = () => false;

test("winToBash converts Windows and already-forward paths", () => {
  assert.equal(winToBash("C:\\Users\\a\\bridge_scan.sh"), "/c/Users/a/bridge_scan.sh");
  assert.equal(winToBash("D:/x/y.sh"), "/d/x/y.sh");
  assert.equal(winToBash("/mnt/c/x"), "/mnt/c/x");
});

test("official engine → print the official plan, no custom project needed", () => {
  const p = planDeepScan(opts({ engine: "official" }), no);
  assert.equal(p.action, "official-plan");
  assert.equal(p.error, undefined);
});

test("off-scope target is refused for every engine", () => {
  const p = planDeepScan(opts({ target: "https://evil.com" }), yes);
  assert.match(p.error ?? "", /allowedOrigins/);
});

test("userinfo smuggled target is refused", () => {
  const p = planDeepScan(opts({ target: "https://staging.example.com@evil.com/" }), yes);
  assert.match(p.error ?? "", /allowedOrigins/);
});

test("custom engine without customEngine config errors with guidance", () => {
  const p = planDeepScan(opts({ engine: "custom" }), yes);
  assert.match(p.error ?? "", /customEngine\.projectPath/);
});

test("custom engine with config but missing capture errors clearly", () => {
  const c = cfg({ customEngine: { projectPath: "C:\\cyber", officialTags: "cve" } } as Partial<QaConfig>);
  const p = planDeepScan(opts({ engine: "custom", cfg: c, captureExists: false }), yes);
  assert.match(p.error ?? "", /Burp capture/);
});

test("both engine builds a bridge argv carrying engine, target, xml and tags", () => {
  const c = cfg({ customEngine: { projectPath: "C:\\cyber", officialTags: "exposure,cve" } } as Partial<QaConfig>);
  const p = planDeepScan(opts({ engine: "both", cfg: c }), yes);
  assert.equal(p.error, undefined);
  assert.equal(p.action, "bridge");
  const a = p.bridgeArgv!;
  assert.equal(a[0], "bash");
  assert.match(a[1] ?? "", /bridge_scan\.sh$/);
  const val = (flag: string): string => a[a.indexOf(flag) + 1] ?? "";
  assert.deepEqual(
    [val("--engine"), val("--target"), val("--official-tags")],
    ["both", "https://staging.example.com", "exposure,cve"],
  );
  assert.ok(a.includes("--xml"));
  assert.ok(a.includes("/c/cyber/bridge_scan.sh"));
});

test("dry-run adds --dry-run to the bridge argv", () => {
  const c = cfg({ customEngine: { projectPath: "C:\\cyber", officialTags: "cve" } } as Partial<QaConfig>);
  const p = planDeepScan(opts({ engine: "custom", cfg: c, dryRun: true }), yes);
  assert.ok(p.bridgeArgv!.includes("--dry-run"));
});

test("--dast reaches the bridge argv only when requested", () => {
  const c = cfg({ customEngine: { projectPath: "C:\\cyber", officialTags: "cve" } } as Partial<QaConfig>);
  const off = planDeepScan(opts({ engine: "both", cfg: c }), yes);
  assert.ok(!off.bridgeArgv!.includes("--dast"), "no --dast by default");
  const on = planDeepScan(opts({ engine: "both", cfg: c, dast: true }), yes);
  assert.ok(on.bridgeArgv!.includes("--dast"), "--dast passed through when requested");
});

test("bridge_scan.sh missing at projectPath errors", () => {
  const c = cfg({ customEngine: { projectPath: "C:\\cyber", officialTags: "cve" } } as Partial<QaConfig>);
  const p = planDeepScan(opts({ engine: "both", cfg: c }), no);
  assert.match(p.error ?? "", /bridge_scan\.sh not found/);
});
