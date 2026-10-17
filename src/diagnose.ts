/**
 * Read a finished run and say what to do next.
 *
 *   npm run diagnose        -> prints the diagnosis for the current output dir
 *
 * This is the deterministic half of the autopilot loop: it reads crawl-status, the page
 * inventory and the status files, judges whether the run actually learned anything, and
 * returns ranked, concrete retry actions. The agent reads this and decides which to apply -
 * the judgment stays with the agent, but the facts and the menu come from here, tested.
 *
 * It never changes anything and it never proposes loosening a safety guard. Every action is
 * either a safe config nudge (raise a budget, widen include, add sitemap seeds) or "run this
 * next step" (auth setup, the scanners). Narrowing scope or tightening the deny-list is fine;
 * widening allowedOrigins or editing denyList is never suggested.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUT as CONFIG_OUT, loadConfig, type QaConfig } from "./config.js";
import type { PageRecord } from "./crawl.js";
import type { CrawlStatus } from "./crawl-verdict.js";

export type ActionKind =
  | "setup-auth"
  | "raise-budget"
  | "raise-timeout"
  | "slow-down"
  | "widen-include"
  | "seed-sitemap"
  | "run-scanners"
  | "run-exploration"
  | "none";

export interface RetryAction {
  kind: ActionKind;
  /** Lower number = try first. */
  priority: number;
  why: string;
  /** A concrete, safe change or command. Never widens scope or the deny-list. */
  how: string;
}

export interface Diagnosis {
  outDir: string;
  verdict: CrawlStatus["verdict"] | "no-crawl";
  complete: boolean;
  reason: string;
  counts: { pages: number; templates: number; loginPages: number; linksFound: number; findings: number; failed: number };
  rateLimited: boolean;
  scannersRun: { authz: boolean; deploy: boolean; coverage: boolean };
  /** True when the run is as good as it will get and no retry is worth it. */
  settled: boolean;
  actions: RetryAction[];
}

function readJson<T>(dir: string, name: string): T | null {
  const file = resolve(dir, name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}
function readJsonl<T>(dir: string, name: string): T[] {
  const file = resolve(dir, name);
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip a half-written line */
    }
  }
  return out;
}

interface LoadStat {
  rateLimited?: number;
  throttledOrigins?: unknown[];
}

/**
 * Judge a run and rank the retries. `cfg` lets the thresholds compare against the budget the
 * run actually used, so "hit the ceiling" is distinguished from "the site is just small".
 */
export function diagnose(outDir: string = CONFIG_OUT, cfg: QaConfig = loadConfig()): Diagnosis {
  const status = readJson<CrawlStatus & { load?: LoadStat }>(outDir, "crawl-status.anon.json");
  const pages = readJsonl<PageRecord>(outDir, "pages.jsonl");
  const findings = readJsonl(outDir, "findings.jsonl").length + readJsonl(outDir, "deploy-findings.jsonl").length + readJsonl(outDir, "authz-findings.jsonl").length;
  const failed = pages.filter((p) => p.ok === false).length;
  const hasAuth = existsSync(resolve(outDir, "auth", "state.json"));

  const scannersRun = {
    authz: existsSync(resolve(outDir, "authz-status.json")) || existsSync(resolve(outDir, "authz-findings.jsonl")),
    deploy: existsSync(resolve(outDir, "deploy-status.json")) || existsSync(resolve(outDir, "deploy-findings.jsonl")),
    coverage: existsSync(resolve(outDir, "coverage.json")),
  };

  const verdict = status?.verdict ?? (pages.length ? "ok" : "no-crawl");
  const load = status?.load;
  const rateLimited = (load?.rateLimited ?? 0) > 0 || (load?.throttledOrigins?.length ?? 0) > 0;
  const hitPageCeiling = status ? status.pages >= cfg.maxPages : false;

  const actions: RetryAction[] = [];
  const add = (a: RetryAction): void => void actions.push(a);

  if (verdict === "no-crawl") {
    add({ kind: "none", priority: 0, why: "No crawl has run yet.", how: "Run preflight, then crawl." });
  }
  if (rateLimited) {
    add({
      kind: "slow-down",
      priority: 1,
      why: "The target rate-limited the crawl, so the inventory may be partial.",
      how: `Raise requestDelayMs (currently ${cfg.requestDelayMs ?? "unset"}) and lower concurrency, then re-crawl.`,
    });
  }
  if (verdict === "login-wall") {
    add({
      kind: "setup-auth",
      priority: 2,
      why: status?.reason || "Most pages were the sign-in screen; the anonymous crawl did not get past authentication.",
      how: 'Fill the "login" block (and credentials in .env) for this target, run the setup project to save a session, then crawl in auth mode (npm run crawl:auth).',
    });
  }
  if (verdict === "too-few-pages") {
    add({
      kind: "widen-include",
      priority: 3,
      why: status?.reason || "The crawl found very few pages.",
      how: 'Check that include matches the site (["\\.*"] for everything) and that exclude is not too broad; then re-crawl.',
    });
    add({
      kind: "seed-sitemap",
      priority: 4,
      why: "A link-sparse or JS-routed site may hide most pages from link discovery.",
      how: "Confirm /sitemap.xml is reachable (it is used automatically), or raise maxDepth; then re-crawl.",
    });
  }
  if (verdict === "no-links") {
    add({
      kind: "seed-sitemap",
      priority: 3,
      why: status?.reason || "The start page exposed no followable links (often a client-rendered SPA).",
      how: "This site likely needs authenticated or sitemap-seeded crawling; verify /sitemap.xml and consider auth mode.",
    });
  }
  if (hitPageCeiling && verdict === "ok") {
    add({
      kind: "raise-budget",
      priority: 5,
      why: `The crawl stopped at maxPages (${cfg.maxPages}); the site is larger than the budget.`,
      how: `Raise maxPages / maxDepth to inventory more, then re-crawl.`,
    });
  }
  if (failed > 0 && pages.length > 0 && failed / pages.length > 0.2) {
    add({
      kind: "raise-timeout",
      priority: 6,
      why: `${failed} of ${pages.length} pages failed to load; the target may be slow.`,
      how: `Raise navTimeoutMs (currently ${cfg.navTimeoutMs}) and re-crawl the failed pages.`,
    });
  }

  // Once there is a usable inventory, the value is in the scanners that produce findings.
  const usable = verdict === "ok" || (status != null && status.pages - status.loginPages >= 3);
  if (usable) {
    if (!scannersRun.deploy) add({ kind: "run-scanners", priority: 7, why: "The pre-deploy hygiene scan has not run; it finds leftover files, headers and exposures.", how: "Run the pre-deploy scan (npm run predeploy)." });
    if (!scannersRun.coverage) add({ kind: "run-scanners", priority: 8, why: "Coverage has not run; it shows what nothing tests yet.", how: "Run coverage (npm run coverage)." });
    if (hasAuth && !scannersRun.authz) add({ kind: "run-scanners", priority: 7, why: "A session exists but the authorization (IDOR / signed-out) scan has not run.", how: "Run the authorization scan (npm run authz)." });
    if (findings === 0 && scannersRun.deploy) add({ kind: "run-exploration", priority: 9, why: "Scanners ran but recorded no findings; feature-level bugs need the exploration phase.", how: "Run the Phase 5 exploration (needs the Playwright + Email MCP servers connected)." });
  }

  actions.sort((a, b) => a.priority - b.priority);

  // Settled = nothing left that a retry would improve. A login-wall with no session is NOT
  // settled (auth is the retry); a clean 'ok' run with the scanners done IS.
  const retryable = actions.some((a) => ["slow-down", "setup-auth", "widen-include", "seed-sitemap", "raise-budget", "raise-timeout"].includes(a.kind));
  const settled = !retryable && verdict !== "no-crawl";

  return {
    outDir,
    verdict,
    complete: verdict === "ok" && !hitPageCeiling && !rateLimited,
    reason: status?.reason || (verdict === "ok" ? "The crawl produced a usable inventory." : "No crawl status found."),
    counts: { pages: status?.pages ?? pages.length, templates: status?.templates ?? 0, loginPages: status?.loginPages ?? 0, linksFound: status?.linksFound ?? 0, findings, failed },
    rateLimited,
    scannersRun,
    settled,
    actions: actions.length ? actions : [{ kind: "none", priority: 99, why: "Nothing to retry.", how: "Build the report and summary." }],
  };
}

function main(): void {
  const d = diagnose();
  console.log(`diagnose ${d.outDir}`);
  console.log(`  verdict: ${d.verdict} (${d.complete ? "complete" : "incomplete"}${d.settled ? ", settled" : ", retry worthwhile"})`);
  console.log(`  counts:  ${d.counts.pages} pages, ${d.counts.templates} templates, ${d.counts.loginPages} login, ${d.counts.findings} findings, ${d.counts.failed} failed`);
  console.log(`  scanners: authz ${d.scannersRun.authz ? "✓" : "–"} deploy ${d.scannersRun.deploy ? "✓" : "–"} coverage ${d.scannersRun.coverage ? "✓" : "–"}`);
  console.log(`  next actions:`);
  for (const a of d.actions) console.log(`    [${a.priority}] ${a.kind}: ${a.how}`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("diagnose.ts")) main();
