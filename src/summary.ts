/**
 * The full run summary: one place that reads everything in output/ and says, in order,
 * what was found, how much was covered, which scans actually ran, how the target's security
 * posture looks, and - from all of that - the best nuclei command to run next for each kind
 * of endpoint.
 *
 *   npm run summary        -> output/summary.md (+ output/nuclei/<category>.txt target lists)
 *
 * It is also the data source for the executive summary at the top of output/report.html, so
 * the two never drift. Everything read off disk is untrusted: every reader tolerates a
 * missing file, a non-array, and a half-written last line.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, OUT as CONFIG_OUT, type QaConfig } from "./config.js";
import type { PageRecord } from "./crawl.js";
import type { TechProfile } from "./techprofile.js";
import { buildRecommendations, type NucleiRec } from "./nuclei.js";

type Severity = "critical" | "high" | "medium" | "low";
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

interface Finding {
  id?: string;
  severity?: string;
  url?: string;
  feature?: string;
  template?: string;
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
      /* skip a truncated or malformed line */
    }
  }
  return out;
}

export interface ScanStatus {
  name: string;
  ran: boolean;
  verdict: string;
}
export interface SummaryData {
  generatedAt: string;
  baseUrl: string;
  pages: { crawled: number; auth: number; templates: number; ok: number; failed: number; authRequired: number };
  findings: { total: number; bySeverity: Record<Severity, number>; blocking: number; top: Finding[] };
  features: number;
  coverage: Array<{ label: string; covered: number; total: number; pct: number }>;
  scans: ScanStatus[];
  security: { missingHeaders: string[]; insecureCookies: string[]; stack: string[] };
  skipped: { deniedButtons: number; deniedLinks: number; destructiveForms: number };
  slowest: Array<{ url: string; loadMs: number }>;
  nuclei: NucleiRec[];
}

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
function bucket(b: { covered?: number; total?: number } | undefined, label: string) {
  const total = num(b?.total);
  const covered = num(b?.covered);
  return { label, covered, total, pct: total ? Math.round((covered / total) * 100) : 0 };
}

export function computeSummary(outDir: string = CONFIG_OUT, cfg: QaConfig = loadConfig()): SummaryData {
  const anon = readJsonl<PageRecord>(outDir, "pages.jsonl");
  const auth = readJsonl<PageRecord>(outDir, "pages.auth.jsonl");
  const pages = [...anon, ...auth];
  const templates = new Set(pages.map((p) => p.template || p.url)).size;

  const findings = readJsonl<Finding>(outDir, "findings.jsonl");
  const deployFindings = readJsonl<Finding>(outDir, "deploy-findings.jsonl");
  const authzFindings = readJsonl<Finding>(outDir, "authz-findings.jsonl");
  const allFindings = [...findings, ...deployFindings, ...authzFindings];
  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of allFindings) {
    const s = (SEVERITIES as string[]).includes(String(f.severity)) ? (f.severity as Severity) : "medium";
    bySeverity[s]++;
  }
  const rank = (f: Finding) => SEVERITIES.indexOf((SEVERITIES as string[]).includes(String(f.severity)) ? (f.severity as Severity) : "medium");
  const top = [...allFindings].sort((a, b) => rank(a) - rank(b)).slice(0, 8);

  const tech = readJson<TechProfile>(outDir, "techprofile.json");
  const cov = readJson<{ templates?: unknown; forms?: unknown; controls?: unknown }>(outDir, "coverage.json");
  const coverage = [
    bucket(cov?.templates as { covered?: number; total?: number }, "Templates"),
    bucket(cov?.forms as { covered?: number; total?: number }, "Forms"),
    bucket(cov?.controls as { covered?: number; total?: number }, "Controls"),
  ];

  const statusVerdict = (name: string): string => {
    const j = readJson<{ verdict?: string }>(outDir, name);
    return j?.verdict ?? "";
  };
  const scans: ScanStatus[] = [
    { name: "Anonymous crawl", ran: existsSync(resolve(outDir, "pages.jsonl")), verdict: statusVerdict("crawl-status.anon.json") || (anon.length ? "ok" : "") },
    { name: "Authenticated crawl", ran: auth.length > 0, verdict: statusVerdict("crawl-status.auth.json") || (auth.length ? "ok" : "not run") },
    { name: "Authorization scan", ran: existsSync(resolve(outDir, "authz-status.json")), verdict: statusVerdict("authz-status.json") || "not run" },
    { name: "Pre-deploy scan", ran: existsSync(resolve(outDir, "deploy-findings.jsonl")) || existsSync(resolve(outDir, "deploy-status.json")), verdict: statusVerdict("deploy-status.json") || (deployFindings.length || existsSync(resolve(outDir, "deploy-findings.jsonl")) ? "ran" : "not run") },
    { name: "Tech profile", ran: !!tech, verdict: tech ? "ok" : "not run" },
    { name: "Coverage", ran: !!cov, verdict: cov ? "ok" : "not run" },
  ];

  const stack = [...(tech?.server ?? []), ...(tech?.frameworks ?? []), ...(tech?.cms ?? [])].map((d) => d.name);
  const security = {
    missingHeaders: (tech?.securityHeaders ?? []).filter((h) => !h.present).map((h) => h.name),
    insecureCookies: (tech?.cookies ?? []).filter((c) => !c.secure || !c.httpOnly).map((c) => c.name),
    stack,
  };

  const skipped = {
    deniedButtons: pages.reduce((n, p) => n + (p.deniedButtons?.length ?? 0), 0),
    deniedLinks: pages.reduce((n, p) => n + (p.deniedLinks?.length ?? 0), 0),
    destructiveForms: pages.reduce((n, p) => n + (p.forms?.filter((f) => f.destructive).length ?? 0), 0),
  };

  const slowest = [...pages]
    .filter((p) => typeof p.loadMs === "number")
    .sort((a, b) => num(b.loadMs) - num(a.loadMs))
    .slice(0, 5)
    .map((p) => ({ url: p.url, loadMs: num(p.loadMs) }));

  return {
    generatedAt: new Date().toISOString(),
    baseUrl: cfg.baseUrl,
    pages: {
      crawled: anon.length,
      auth: auth.length,
      templates,
      ok: pages.filter((p) => p.ok !== false).length,
      failed: pages.filter((p) => p.ok === false).length,
      authRequired: pages.filter((p) => p.authRequired).length,
    },
    findings: { total: allFindings.length, bySeverity, blocking: bySeverity.critical + bySeverity.high, top },
    features: readJsonl(outDir, "features.jsonl").length,
    coverage,
    scans,
    security,
    skipped,
    slowest,
    nuclei: buildRecommendations(pages, tech, cfg),
  };
}

/** Replace `{list}` in each command with its target-list path; write the files when asked. */
export function materializeNuclei(recs: NucleiRec[], outDir: string, write: boolean): NucleiRec[] {
  const dir = resolve(outDir, "nuclei");
  if (write && recs.some((r) => r.endpoints.length)) mkdirSync(dir, { recursive: true });
  return recs.map((r) => {
    if (!r.endpoints.length) return r;
    const rel = `output/nuclei/${r.id}.txt`;
    if (write) writeFileSync(resolve(dir, `${r.id}.txt`), r.endpoints.join("\n") + "\n");
    return { ...r, command: r.command.replace("{list}", rel) };
  });
}

function md(data: SummaryData): string {
  const f = data.findings;
  const L: string[] = [];
  L.push(`# QA summary — ${data.baseUrl}`);
  L.push("");
  L.push(`_Generated ${data.generatedAt.replace(/\.\d+Z$/, "Z")}_`);
  L.push("");
  const verdict = f.blocking > 0 ? `**${f.blocking} blocking finding(s)** (critical/high)` : f.total > 0 ? `${f.total} finding(s), none blocking` : "no findings recorded";
  L.push(`**TL;DR** — crawled ${data.pages.crawled} page(s) across ${data.pages.templates} template(s); ${verdict}. Stack: ${data.security.stack.join(", ") || "unknown"}.`);
  L.push("");

  L.push("## Findings");
  L.push("");
  L.push("| Severity | Count |");
  L.push("|---|---|");
  for (const s of SEVERITIES) L.push(`| ${s} | ${f.bySeverity[s]} |`);
  L.push(`| **total** | **${f.total}** |`);
  if (f.top.length) {
    L.push("");
    L.push("Top findings:");
    L.push("");
    for (const t of f.top) L.push(`- \`${t.severity ?? "?"}\` ${t.feature ? t.feature + " — " : ""}${t.url ?? ""}${t.id ? ` (${t.id})` : ""}`);
  }
  L.push("");

  L.push("## Coverage");
  L.push("");
  L.push("| What | Covered | Total | % |");
  L.push("|---|--:|--:|--:|");
  for (const c of data.coverage) L.push(`| ${c.label} | ${c.covered} | ${c.total} | ${c.pct}% |`);
  L.push("");

  L.push("## Scans");
  L.push("");
  L.push("| Scan | Verdict |");
  L.push("|---|---|");
  for (const s of data.scans) L.push(`| ${s.name} | ${s.ran ? s.verdict || "ran" : "not run"} |`);
  L.push("");

  L.push("## Security posture");
  L.push("");
  L.push(`- Missing headers: ${data.security.missingHeaders.join(", ") || "none"}`);
  L.push(`- Insecure cookies: ${data.security.insecureCookies.join(", ") || "none"}`);
  L.push(`- Skipped as destructive: ${data.skipped.deniedButtons} button(s), ${data.skipped.deniedLinks} link(s), ${data.skipped.destructiveForms} form(s)`);
  L.push("");

  L.push("## Recommended nuclei commands");
  L.push("");
  L.push("Only against a target you own or are authorized to test. Commands are scoped to `allowedOrigins` and paced to the crawler's rate. Scans marked **active** send crafted payloads — opt into those deliberately.");
  L.push("");
  for (const r of data.nuclei) {
    L.push(`### ${r.title}${r.intrusive ? " — active" : ""}`);
    L.push("");
    L.push(`- **Why:** ${r.why}`);
    L.push(`- **Fix:** ${r.fix}`);
    L.push(`- **Templates:** ${r.templates} · **Severity:** ${r.severity}`);
    if (r.endpoints.length) L.push(`- **Targets:** ${r.endpoints.length} endpoint(s), listed in \`output/nuclei/${r.id}.txt\``);
    L.push("");
    L.push("```bash");
    L.push(r.command);
    L.push("```");
    L.push("");
  }
  return L.join("\n");
}

function main(): void {
  const data = computeSummary();
  data.nuclei = materializeNuclei(data.nuclei, CONFIG_OUT, true);
  const file = resolve(CONFIG_OUT, "summary.md");
  writeFileSync(file, md(data));
  const f = data.findings;
  console.log(
    `summary: ${data.pages.crawled} pages · ${f.total} findings (${f.blocking} blocking) · ` +
      `${data.nuclei.length} nuclei recommendation(s) -> ${file}`,
  );
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("summary.ts")) main();

export { md as renderSummaryMarkdown };
