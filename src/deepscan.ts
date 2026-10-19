/**
 * deepscan — bridge the QA crawl to the CyberSecurity nuclei-template engine.
 *
 * Three engines, chosen with `--engine`:
 *   official (default) — ONLY the official nuclei template library, via the built-in
 *                        scoped per-category plan (nuclei.ts). Touches no other project.
 *                        This is the "just nuclei templates, not my own" option, kept intact.
 *   custom             — feed THIS run's Burp capture (output/http-history.xml) to the
 *                        CyberSecurity project to GENERATE target-specific attack templates,
 *                        then scan with ONLY those.
 *   both               — custom + official together.
 *
 * custom/both delegate to <customEngine.projectPath>/bridge_scan.sh, which runs the
 * generate → nuclei scan → multi-layer triage (confidence-scored) flow and writes its
 * report under the CyberSecurity project. deepscan itself never runs nuclei.
 *
 * Safety: only cfg.baseUrl (which must be in allowedOrigins) is ever handed to the scanner,
 * and the Burp capture is passed by PATH — its contents (live cookies) are never printed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, OUT, isAllowedUrl, type QaConfig } from "./config.js";
import { buildRecommendations, type NucleiRec } from "./nuclei.js";
import { historyXml, writeBurpXml } from "./http-history.js";
import type { PageRecord } from "./crawl.js";
import type { TechProfile } from "./techprofile.js";

export type Engine = "official" | "custom" | "both";
export const ENGINES: Engine[] = ["official", "custom", "both"];

export interface DeepScanOptions {
  engine: Engine;
  target: string;
  cfg: QaConfig;
  /** Absolute path to the exported Burp capture (output/http-history.xml). */
  captureXml: string;
  /** Does the capture file exist right now? (custom/both need it.) */
  captureExists: boolean;
  outLabel: string;
  severity: string;
  dryRun: boolean;
  /** Opt-in: also run an active nuclei -dast fuzzing pass (orthogonal to engine). */
  dast?: boolean;
}

export interface DeepScanPlan {
  engine: Engine;
  /** "official-plan" → print nuclei.ts recs here; "bridge" → spawn bridge_scan.sh. */
  action: "official-plan" | "bridge";
  /** For action==="bridge": the argv to spawn (bash + script + flags). */
  bridgeArgv?: string[];
  /** A fatal problem that stops the run, with user guidance. */
  error?: string;
}

/** Convert a Windows path (C:\a\b) to the git-bash form (/c/a/b) bridge_scan.sh expects. */
export function winToBash(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, "/");
  const drive = (m[1] ?? "").toLowerCase();
  const rest = (m[2] ?? "").replace(/\\/g, "/");
  return `/${drive}/${rest}`;
}

/**
 * Decide what a deepscan run should do — pure, so it is unit-testable without
 * spawning anything. Enforces scope and the custom-engine preconditions.
 */
export function planDeepScan(
  opts: DeepScanOptions,
  exists: (p: string) => boolean = existsSync,
): DeepScanPlan {
  const { engine } = opts;
  if (!ENGINES.includes(engine)) {
    return { engine, action: "official-plan", error: `unknown --engine '${engine}' (use: ${ENGINES.join(", ")})` };
  }
  // Scope guard: never hand an off-scope target to any scanner.
  if (!isAllowedUrl(opts.target, opts.cfg)) {
    return { engine, action: engine === "official" ? "official-plan" : "bridge",
      error: `target ${opts.target} is not in allowedOrigins — refusing (edit qa.config.json)` };
  }
  if (engine === "official") {
    return { engine, action: "official-plan" };
  }
  // custom / both need the CyberSecurity project and a capture to generate from.
  const ce = opts.cfg.customEngine;
  if (!ce?.projectPath) {
    return { engine, action: "bridge",
      error: `--engine ${engine} needs config.customEngine.projectPath (path to the CyberSecurity project). Use --engine official for official templates only.` };
  }
  const script = resolve(ce.projectPath, "bridge_scan.sh");
  if (!exists(script)) {
    return { engine, action: "bridge", error: `bridge_scan.sh not found at ${script}` };
  }
  if (!opts.captureExists) {
    return { engine, action: "bridge",
      error: `no Burp capture at ${opts.captureXml}. Run 'npm run crawl' (with captureHttpHistory:true) then 'npm run export:burp' first.` };
  }
  const argv = [
    "bash", winToBash(script),
    "--engine", engine,
    "--target", opts.target,
    "--xml", winToBash(opts.captureXml),
    "--out", opts.outLabel,
    "--severity", opts.severity,
    "--official-tags", ce.officialTags,
  ];
  if (opts.dast) argv.push("--dast");
  if (opts.dryRun) argv.push("--dry-run");
  return { engine, action: "bridge", bridgeArgv: argv };
}

function readJsonl<T>(dir: string, name: string): T[] {
  const file = resolve(dir, name);
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (t) try { out.push(JSON.parse(t) as T); } catch { /* skip */ }
  }
  return out;
}

function printOfficialPlan(cfg: QaConfig): void {
  const pages = [...readJsonl<PageRecord>(OUT, "pages.jsonl"), ...readJsonl<PageRecord>(OUT, "pages.auth.jsonl")];
  let tech: TechProfile | null = null;
  const tf = resolve(OUT, "techprofile.json");
  if (existsSync(tf)) try { tech = JSON.parse(readFileSync(tf, "utf8")) as TechProfile; } catch { /* ignore */ }
  const recs: NucleiRec[] = buildRecommendations(pages, tech, cfg);
  console.log("engine: official — official nuclei templates only (no custom generation)\n");
  for (const r of recs) {
    console.log(`## ${r.title}${r.intrusive ? "  [intrusive — opt-in]" : ""}`);
    console.log(`   ${r.why}`);
    console.log(`   ${r.command}\n`);
  }
  console.log("(These are the commands to run yourself — this mode never executes nuclei.)");
}

function main(): void {
  const argv = process.argv.slice(2);
  const getFlag = (name: string, def?: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  const engine = (getFlag("engine", "official") as Engine);
  const dryRun = argv.includes("--dry-run");
  const dast = argv.includes("--dast");
  const severity = getFlag("severity", "critical,high,medium")!;
  const cfg = loadConfig();
  const outLabel = getFlag("out", `qa_${new URL(cfg.baseUrl).hostname.replace(/[^a-z0-9]+/gi, "_")}`)!;
  const captureXml = historyXml("all");

  // For custom/both, make sure the capture exists — export it if the crawl recorded one.
  let captureExists = existsSync(captureXml);
  if (!captureExists && engine !== "official" && !dryRun) {
    try { if (writeBurpXml("all") > 0) captureExists = existsSync(captureXml); } catch { /* reported below */ }
  }

  const plan = planDeepScan({ engine, target: cfg.baseUrl, cfg, captureXml, captureExists, outLabel, severity, dryRun, dast });
  if (plan.error) { console.error(`deepscan: ${plan.error}`); process.exit(1); }

  if (plan.action === "official-plan") { printOfficialPlan(cfg); return; }

  // bridge (custom/both)
  console.log(`engine: ${engine} — delegating to CyberSecurity bridge (${dryRun ? "dry-run" : "live"})`);
  const argvBridge = plan.bridgeArgv!;
  const res = spawnSync(argvBridge[0]!, argvBridge.slice(1), { stdio: "inherit", encoding: "utf8" });
  if (res.status !== 0) { console.error(`deepscan: bridge exited ${res.status}`); process.exit(res.status ?? 1); }
  // Leave a pointer in output/ (never the capture contents).
  const ptr = resolve(OUT, "deepscan.md");
  const ce = cfg.customEngine!;
  writeFileSync(ptr,
    `# deepscan (${engine})\n\nTarget: ${cfg.baseUrl}\nLabel: ${outLabel}\n` +
    `Triage report: ${resolve(ce.projectPath, "resources/triage_reports", outLabel, "report.md")}\n`,
    "utf8");
  console.log(`deepscan: wrote ${ptr}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("deepscan.ts")) {
  main();
}
