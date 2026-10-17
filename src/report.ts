/**
 * Builds output/report.html - one self-contained file, no external assets.
 *
 * Screenshots are embedded as small JPEG thumbnails (via Playwright's image decoding is
 * overkill, so this resizes with sharp-free canvas-less scaling: the thumbnail is just the
 * original JPEG, size-capped, and links to the full file on disk).
 */
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { ROOT, loadConfig, OUT as CONFIG_OUT } from "./config.js";
import type { PageRecord } from "./crawl.js";
import type { TechProfile } from "./techprofile.js";

const DEFAULT_OUT = CONFIG_OUT;

/**
 * The directory this render reads from and writes to.
 *
 * Parameterised so a test can render into a throwaway directory by CALLING the renderer.
 * The alternative the tests used to take - copy src/, junction the real node_modules into
 * a temp box, spawn three subprocess renders, then remove the box recursively - was slow
 * (13 of the suite's 8 seconds) and sat one filesystem behaviour change away from deleting
 * the real node_modules through that junction.
 */
let OUT = DEFAULT_OUT;

/**
 * Where the specs live: the checkout's tests/, whatever OUT is. It used to be OUT/../tests,
 * which is output/tests under QA_OUT=output/shop - absent, so the stale-results warning
 * silently vanished for every non-default target. Parameterised like OUT, for the tests.
 */
const DEFAULT_TESTS_DIR = resolve(ROOT, "tests");
let TESTS_DIR = DEFAULT_TESTS_DIR;

type Severity = "critical" | "high" | "medium" | "low";

interface Finding {
  id: string;
  template?: string;
  url: string;
  feature?: string;
  severity: Severity;
  steps?: string[];
  expected?: string;
  actual?: string;
  evidence?: string;
  details?: string;
}

interface AuthzStatus {
  verdict?: string;
  templates?: number;
  compared?: number;
  baselineUnreachable?: number;
  classifiedLogin?: number;
  probesAttempted?: number;
  probesFailed?: number;
  personas?: string[];
  sharedIdentity?: string[];
}

interface CoverageBucket {
  total?: number;
  covered?: number;
}

interface CoverageSummary {
  templates?: CoverageBucket;
  forms?: CoverageBucket;
  controls?: CoverageBucket;
  /**
   * Why these numbers may be worthless: one entry per crawl that went nowhere.
   *
   * Typed as unknown and read through strArr, like every other field here. A JSONL or JSON
   * file on disk is untrusted input - a non-array `personas` once took the whole report
   * down because the code used `?? []`, which guards null but not a string.
   */
  crawlWarnings?: unknown;
  inconclusive?: unknown;
}

/** A single JSON file, or null. Absence is a state the report renders, not an error. */
function readJson<T>(name: string): T | null {
  const file = resolve(OUT, name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

interface Feature {
  feature: string;
  template?: string;
  url?: string;
  description?: string;
  casesPassed?: string[];
}

interface PwSuite {
  title: string;
  specs?: {
    title: string;
    ok: boolean;
    tests?: { status?: string; results?: { status: string }[] }[];
  }[];
  suites?: PwSuite[];
}

/**
 * Fill in the array fields a PageRecord is expected to have. crawl.ts always writes them,
 * but a hand-edited or externally-produced jsonl would otherwise crash the whole report
 * on the first `.length`.
 */
/** Coerce to a finite number. Numeric fields are rendered into HTML without escaping. */
function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : []);

/**
 * A list of strings from a value that MIGHT be a bare string.
 *
 * A hand-written or truncated status file can carry "personas": "alice". strArr() returns
 * [] for that, which is safe but silently loses the value; the previous code used ?? [],
 * which crashed the entire report. Coerce instead.
 */
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str) : typeof v === "string" && v ? [v] : [];

function normalizePage(p: Partial<PageRecord>): PageRecord {
  // Every field is coerced to its declared type, not merely defaulted. `?? 0` on a value
  // that is a string leaves the string in place, and the templates below interpolate
  // status/loadMs without escaping - a JSONL carrying
  // `"loadMs": "0</td><td><img src=x onerror=...>"` was live HTML injection.
  return {
    url: str(p.url),
    template: str(p.template) || str(p.url),
    depth: num(p.depth),
    status: p.status === null || p.status === undefined ? null : num(p.status, 0),
    title: str(p.title),
    loadMs: num(p.loadMs),
    screenshot: typeof p.screenshot === "string" ? p.screenshot : null,
    consoleErrors: strArr(p.consoleErrors),
    failedRequests: Array.isArray(p.failedRequests) ? p.failedRequests : [],
    pageErrors: strArr(p.pageErrors),
    forms: Array.isArray(p.forms) ? p.forms : [],
    buttons: strArr(p.buttons),
    deniedButtons: strArr(p.deniedButtons),
    deniedLinks: strArr(p.deniedLinks),
    links: num(p.links),
    authRequired: p.authRequired === true,
    // Absent in records written before the field existed; false is the safe reading,
    // since it only ever widens what coverage treats as a real page.
    redirected: p.redirected === true,
    // Coerced through a guard like every other array here: a hand-edited jsonl with a
    // non-array captcha field would otherwise crash the report on .length.
    captcha: Array.isArray(p.captcha) ? p.captcha : [],
    ok: p.ok ?? p.status !== null,
    mode: p.mode === "auth" ? "auth" : "anon",
    crawledAt: str(p.crawledAt),
  };
}

function readJsonl<T>(name: string): T[] {
  const file = resolve(OUT, name);
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Skip a partial line left by an interrupted writer.
    }
  }
  return out;
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Escape a value for use in an href.
 *
 * esc() is not enough: it leaves "javascript:alert(1)" completely intact, and every URL
 * in this report comes from somewhere untrusted - findings.jsonl is written from what a
 * model read off the target site. Only http/https and same-report relative paths are
 * allowed through; anything else renders as inert text.
 */
function safeHref(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  // Reject control characters and any scheme that is not http/https. A bare relative
  // path (screenshots/..., pw-report/index.html) has no scheme and is fine.
  if (/[\u0000-\u001f]/.test(raw)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (scheme && !/^https?$/i.test(scheme[1] ?? "")) return null;
  if (raw.startsWith("//")) return null;
  return esc(raw);
}

/** Resolved per call, because OUT is no longer fixed at module load. */
const shotsDir = (): string => resolve(OUT, "screenshots");

/**
 * Inline a screenshot as a data URI, skipping anything too large to embed sensibly.
 *
 * The path is confined to output/screenshots. Without that check a record carrying
 * `"screenshot": "../.env"` made this function base64 the .env file into report.html -
 * which CI then uploads as a 30-day artifact.
 */
function thumb(rel: string | null): string | null {
  if (!rel) return null;
  const file = resolve(OUT, rel);
  const shots = shotsDir();
  const inside = file === shots || file.startsWith(shots + sep);
  if (!inside) return null;
  if (!/\.(jpe?g|png|webp)$/i.test(file)) return null;
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  // Cap per-image bytes so a 60-page report stays openable.
  if (statSync(file).size > 400_000) return null;
  const mime = /\.png$/i.test(file) ? "image/png" : /\.webp$/i.test(file) ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

/**
 * Is the results file actually describing the specs that are on disk now?
 *
 * The report quoted "72 tests" from a file written nine hours earlier, before three spec
 * files existed - and said nothing. The cause is easy to hit and easy to miss: passing
 * `--reporter=line` on the command line REPLACES the reporters configured in
 * playwright.config.ts, so the json reporter never runs and pw-results.json keeps whatever
 * an older invocation left there. A filtered run (`-g`, or one spec file) does the same
 * thing from the other direction - it overwrites the file with a subset.
 *
 * Either way the published report describes a different suite from the repository, which
 * is worse than describing none. So it is checked and said out loud.
 */
/**
 * Every .spec.ts under the tests directory, at any depth, as a forward-slash relative path.
 *
 * Flat, it never saw tests/generated/ - which is where Phase 6 writes its specs, so the
 * files most likely to have changed since the last run were the ones it ignored.
 */
function specsUnder(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...specsUnder(dir, path));
    else if (/\.spec\.ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

function resultsProvenance(file: string): string[] {
  const warnings: string[] = [];
  const testsDir = TESTS_DIR;
  if (!existsSync(testsDir)) return warnings;

  const resultsMtime = statSync(file).mtimeMs;
  const specFiles = specsUnder(testsDir);

  const newer = specFiles.filter((f) => statSync(resolve(testsDir, f)).mtimeMs > resultsMtime);
  if (newer.length > 0) {
    warnings.push(
      `${newer.length} spec file(s) changed after this test run: ${newer.sort().join(", ")}`,
    );
  }
  return warnings;
}

function testResults(): {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  specs: { title: string; ok: boolean; flaky: boolean }[];
  ranAt: string | null;
  warnings: string[];
} {
  const empty = { total: 0, passed: 0, failed: 0, flaky: 0, specs: [], ranAt: null, warnings: [] };
  const file = resolve(OUT, "pw-results.json");
  if (!existsSync(file)) return empty;

  let root: { suites?: PwSuite[]; stats?: { startTime?: unknown } };
  try {
    root = JSON.parse(readFileSync(file, "utf8")) as {
      suites?: PwSuite[];
      stats?: { startTime?: unknown };
    };
  } catch {
    return empty;
  }

  const ranAt = typeof root.stats?.startTime === "string" ? root.stats.startTime : null;
  const warnings = resultsProvenance(file);

  // Files represented in the results, against the .spec.ts files that exist. A run filtered
  // to one file leaves the others absent, and the totals then understate the suite.
  const filesInResults = new Set<string>();
  const collect = (suites: PwSuite[] | undefined): void => {
    for (const s of suites ?? []) {
      const f = (s as { file?: unknown }).file;
      if (typeof f === "string") filesInResults.add(f.replace(/^.*[\\/]/, ""));
      collect(s.suites);
    }
  };
  collect(root.suites);

  const testsDir = TESTS_DIR;
  if (existsSync(testsDir)) {
    const onDisk = specsUnder(testsDir);
    // Results name a file by its basename here (see collect), so compare on that.
    const absent = onDisk.filter((f) => !filesInResults.has(f.replace(/^.*\//, "")));
    if (absent.length > 0) {
      warnings.push(
        `${absent.length} spec file(s) are not in this run at all: ${absent.sort().join(", ")}`,
      );
    }
  }

  const specs: { title: string; ok: boolean; flaky: boolean }[] = [];
  const walk = (suites: PwSuite[] | undefined, prefix: string): void => {
    for (const s of suites ?? []) {
      const name = [prefix, s.title].filter(Boolean).join(" › ");
      for (const spec of s.specs ?? []) {
        // A flaky test has ok: true - it passed on a retry - so a suite with ten of them
        // renders as entirely green. That is the same silence this report has been
        // taught to refuse everywhere else: ten tests that only pass on a second attempt
        // is a fact about the suite, not a detail to round away.
        const flaky = (spec.tests ?? []).some((t) => t.status === "flaky");
        specs.push({ title: `${name} › ${spec.title}`, ok: spec.ok, flaky });
      }
      walk(s.suites, name);
    }
  };
  walk(root.suites, "");

  return {
    total: specs.length,
    passed: specs.filter((s) => s.ok).length,
    failed: specs.filter((s) => !s.ok).length,
    flaky: specs.filter((s) => s.flaky).length,
    specs,
    ranAt,
    warnings,
  };
}

/** Build report.html. Exported so a test can render without spawning a process. */
export function buildReport(outDir: string = DEFAULT_OUT, testsDir: string = DEFAULT_TESTS_DIR): string {
  OUT = outDir;
  TESTS_DIR = testsDir;
  const cfg = loadConfig();
  // Keep the LAST record per URL. A crawl that retried a page after a failed first
  // attempt leaves both lines in the file; showing the stale failure would misreport it.
  const dedupe = (rows: PageRecord[]): PageRecord[] => {
    const byUrl = new Map<string, PageRecord>();
    for (const r of rows) byUrl.set(r.url, r);
    return [...byUrl.values()];
  };
  const anon = dedupe(readJsonl<Partial<PageRecord>>("pages.jsonl").map(normalizePage));
  const auth = dedupe(readJsonl<Partial<PageRecord>>("pages.auth.jsonl").map(normalizePage));
  const pages = [...anon, ...auth];
  // Phase 5's exploration findings and the pre-deploy scan's are the same shape and belong
  // in one table - a reader wants "what is wrong with this build", not two lists.
  const findings = [
    ...readJsonl<Finding>("findings.jsonl"),
    ...readJsonl<Finding>("deploy-findings.jsonl"),
    ...readJsonl<Finding>("authz-findings.jsonl"),
  ].map((f) => ({
    ...f,
    // An unrecognised severity used to match no bucket, so the finding silently vanished
    // from the report. Unknown severities are shown, not dropped.
    severity: (SEVERITY_ORDER as string[]).includes(f.severity) ? f.severity : ("medium" as Severity),
  }));
  const features = readJsonl<Feature>("features.jsonl");
  const tests = testResults();
  // Both are optional: a run without them shows an explicit empty state rather than nothing,
  // because a missing authorization verdict used to be indistinguishable from a clean one.
  const authz = readJson<AuthzStatus>("authz-status.json");
  const coverage = readJson<CoverageSummary>("coverage.json");
  const tech = readJson<TechProfile>("techprofile.json");

  const bySeverity = SEVERITY_ORDER.map((sev) => ({
    sev,
    items: findings.filter((f) => f.severity === sev),
  }));
  const slowest = [...pages].sort((a, b) => b.loadMs - a.loadMs).slice(0, 10);
  const broken = pages.filter((p) => (p.status ?? 0) >= 400 || p.pageErrors.length > 0);
  const avgMs = pages.length ? Math.round(pages.reduce((n, p) => n + p.loadMs, 0) / pages.length) : 0;

  // Buttons, links AND forms. The report used to list withheld buttons only, which made
  // the "nothing destructive here" conclusion look stronger than the data supported.
  const denied = [
    ...pages.flatMap((p) => p.deniedButtons.map((b) => ({ url: p.url, control: b, kind: "button" }))),
    ...pages.flatMap((p) => p.deniedLinks.map((l) => ({ url: p.url, control: l, kind: "link" }))),
    ...pages.flatMap((p) =>
      p.forms
        .filter((f) => f.destructive)
        .map((f) => ({ url: p.url, control: `${f.method.toUpperCase()} ${f.action || "(self)"}`, kind: "form" })),
    ),
  ];

  const stat = (label: string, value: string | number, tone = ""): string =>
    `<div class="stat ${tone}"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;

  const findingRows = bySeverity
    .flatMap(({ sev, items }) =>
      items.map(
        (f) => `<tr>
  <td><span class="sev ${sev}">${sev}</span></td>
  <td>
    <div class="ftitle">${esc(f.feature ?? f.template ?? "-")}</div>
    ${(() => {
      const href = safeHref(f.url);
      return href
        ? `<a class="url" href="${href}" rel="noreferrer noopener">${esc(f.url)}</a>`
        : `<span class="url">${esc(f.url)}</span>`;
    })()}
    ${Array.isArray(f.steps) && f.steps.length ? `<ol class="steps">${f.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
  </td>
  <td>${esc(f.expected ?? "")}</td>
  <td>${esc(f.actual ?? "")}</td>
  <td>${(() => {
    if (!f.evidence) return "";
    const href = safeHref(f.evidence);
    // Evidence is often a free-text note rather than a URL, and it is written from what
    // the target site said. Render it as a link only when it is a safe one.
    return href ? `<a href="${href}" rel="noreferrer noopener">evidence</a>` : esc(f.evidence);
  })()}</td>
</tr>`,
      ),
    )
    .join("");

  const gallery = pages
    .map((p) => {
      const src = thumb(p.screenshot);
      const badges = [
        p.mode === "auth" ? `<span class="badge auth">auth</span>` : "",
        (p.status ?? 0) >= 400 || p.status === null
          ? `<span class="badge bad">${esc(p.status ?? "ERR")}</span>`
          : `<span class="badge ok">${esc(p.status)}</span>`,
        p.loadMs > 3000 ? `<span class="badge warn">${esc((p.loadMs / 1000).toFixed(1))}s</span>` : `<span class="badge">${esc(p.loadMs)}ms</span>`,
        p.consoleErrors.length ? `<span class="badge warn">${esc(p.consoleErrors.length)} console</span>` : "",
        p.pageErrors.length ? `<span class="badge bad">${esc(p.pageErrors.length)} error</span>` : "",
        p.forms.length ? `<span class="badge">${esc(p.forms.length)} form</span>` : "",
      ]
        .filter(Boolean)
        .join("");
      const shotHref = safeHref(p.screenshot);
      const imgTag = `<img loading="lazy" src="${src}" alt="">`;
      const img = src
        ? shotHref
          ? `<a href="${shotHref}">${imgTag}</a>`
          : imgTag
        : `<div class="noshot">no screenshot</div>`;
      const pageHref = safeHref(p.url);
      const shortUrl = esc(p.url.replace(/^https?:\/\/[^/]+/, "") || "/");
      return `<figure class="card">
  ${img}
  <figcaption>
    <div class="t">${esc(p.title || "(untitled)")}</div>
    ${pageHref ? `<a class="url" href="${pageHref}" rel="noreferrer noopener">${shortUrl}</a>` : `<span class="url">${shortUrl}</span>`}
    <div class="badges">${badges}</div>
  </figcaption>
</figure>`;
    })
    .join("");

  const featureRows = features
    .map(
      (f) => `<tr><td>${esc(f.feature)}</td><td>${esc(f.description ?? "")}</td>
      <td>${f.casesPassed?.length ? `${f.casesPassed.length} case(s)` : "-"}</td></tr>`,
    )
    .join("");

  // Site analysis: the technology profile, rendered as chips. A confirmed signal (from a
  // header) is a solid pill; a markup guess is dashed, so the two are never conflated.
  const pill = (d: { name: string; confidence: string; evidence: string }): string =>
    `<span class="pill ${d.confidence === "likely" ? "likely" : ""}" title="${esc(d.evidence)}">${esc(
      d.name,
    )}${d.confidence === "likely" ? " <small>likely</small>" : ""}</span>`;
  const techCard = (title: string, items: TechProfile["server"]): string =>
    items.length
      ? `<div class="techcard"><h3>${esc(title)}</h3><div class="pills">${items.map(pill).join("")}</div></div>`
      : "";
  const siteAnalysis = tech
    ? `<h2>Site analysis</h2>
<div class="techgrid">
  ${techCard("Server", tech.server)}
  ${techCard("Framework", tech.frameworks)}
  ${techCard("CDN / host", tech.cdn)}
  ${techCard("CMS", tech.cms)}
  ${techCard("Language", tech.languages)}
  ${techCard("Analytics", tech.analytics)}
  <div class="techcard"><h3>Security headers</h3><div class="hdrs">${(tech.securityHeaders ?? [])
    .map(
      (h) =>
        `<span class="hdr ${h.present ? "ok" : "miss"}">${h.present ? "✓" : "✗"} ${esc(
          h.name,
        )}</span>`,
    )
    .join("")}</div></div>
  ${
    (tech.cookies ?? []).length
      ? `<div class="techcard"><h3>Cookies set</h3>${tech.cookies
          .map(
            (c) =>
              `<div class="kv"><b>${esc(c.name)}</b> &middot; ${c.secure ? "Secure" : "not Secure"}, ${
                c.httpOnly ? "HttpOnly" : "not HttpOnly"
              }, SameSite=${esc(c.sameSite ?? "none")}</div>`,
          )
          .join("")}</div>`
      : ""
  }
  ${
    (tech.notableHeaders ?? []).length
      ? `<div class="techcard"><h3>Headers</h3>${tech.notableHeaders
          .map((h) => `<div class="kv"><b>${esc(h.name)}</b>: ${esc(h.value)}</div>`)
          .join("")}</div>`
      : ""
  }
</div>
`
    : "";

  const specRows = tests.specs
    .map((s) => {
      // Three states, not two. A flaky test passed on a retry, so `ok` is true and it used
      // to render as an ordinary pass - which made a run with ten of them look perfectly
      // green. "Passed on retry" is what the reader needs to see.
      const [cls, word] = !s.ok
        ? ["critical", "fail"]
        : s.flaky
          ? ["high", "flaky"]
          : ["low", "pass"];
      return `<tr><td><span class="sev ${cls}">${word}</span></td><td>${esc(s.title)}</td></tr>`;
    })
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA report - ${esc(cfg.baseUrl)}</title>
<style>
:root{--bg:#f7f7f8;--panel:#fff;--ink:#16181d;--muted:#6b7280;--line:#e4e4e7;
--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--accent:#4338ca;}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--panel:#171a21;--ink:#e8eaed;--muted:#9aa1ad;
--line:#272b34;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--accent:#a5b4fc;}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:36px 0 12px;
text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
a{color:var(--accent)} .sub{color:var(--muted);margin:0 0 24px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.stat .v{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums}
.stat .l{color:var(--muted);font-size:12px;margin-top:2px}
.stat.bad .v{color:var(--bad)} .stat.warn .v{color:var(--warn)} .stat.ok .v{color:var(--ok)}
table{width:100%;border-collapse:collapse;background:var(--panel);
border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
tr:last-child td{border-bottom:0}
.tablewrap{overflow-x:auto}
.sev{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:650;text-transform:uppercase}
.sev.critical{background:rgba(185,28,28,.14);color:var(--bad)}
.sev.high{background:rgba(180,83,9,.14);color:var(--warn)}
.sev.medium{background:rgba(67,56,202,.14);color:var(--accent)}
.sev.low{background:rgba(21,128,61,.14);color:var(--ok)}
.ftitle{font-weight:600} .url{font-size:12px;word-break:break-all}
.steps{margin:6px 0 0 16px;padding:0;font-size:12px;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.card{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.card img{display:block;width:100%;height:150px;object-fit:cover;object-position:top;background:#0002}
.noshot{height:150px;display:grid;place-items:center;color:var(--muted);font-size:12px;background:#0001}
figcaption{padding:10px}
figcaption .t{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badges{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px}
.badge{font-size:11px;padding:1px 6px;border-radius:5px;background:#8881;border:1px solid var(--line)}
.badge.ok{color:var(--ok)} .badge.warn{color:var(--warn)} .badge.bad{color:var(--bad)}
.badge.auth{color:var(--accent)}
.techgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.techcard{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.techcard h3{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.pills{display:flex;flex-wrap:wrap;gap:6px}
.pill{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;
border:1px solid var(--line);border-radius:999px;padding:3px 10px;background:#8881}
.pill small{font-weight:400;color:var(--muted)}
.pill.likely{border-style:dashed}
.hdrs{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.hdr{font-size:11.5px;border-radius:5px;padding:2px 8px;border:1px solid var(--line)}
.hdr.ok{color:var(--ok)} .hdr.miss{color:var(--bad)}
.kv{font-size:12px;color:var(--muted);margin:2px 0}
.kv b{color:var(--ink);font-weight:600}
.empty{background:var(--panel);border:1px dashed var(--line);border-radius:10px;
padding:20px;color:var(--muted)}
</style></head><body><div class="wrap">

<h1>QA report</h1>
<p class="sub">${esc(cfg.baseUrl)} &middot; generated ${esc(new Date().toISOString().replace("T", " ").slice(0, 16))} UTC</p>

<div class="stats">
  ${stat("pages crawled", pages.length)}
  ${stat("anon / auth", `${anon.length} / ${auth.length}`)}
  ${stat("templates", new Set(pages.map((p) => p.template)).size)}
  ${stat("avg load", `${avgMs}ms`)}
  ${stat("pages with errors", broken.length, broken.length ? "warn" : "ok")}
  ${stat("findings", findings.length, findings.length ? "bad" : "ok")}
  ${stat("features tested", features.length)}
  ${stat("tests passed", tests.total ? `${tests.passed}/${tests.total}` : "-", tests.failed ? "bad" : "ok")}
</div>

${siteAnalysis}
<h2>Findings</h2>
${
  findings.length
    ? `<div class="tablewrap"><table><thead><tr><th>Severity</th><th>What &amp; where</th>
       <th>Expected</th><th>Actual</th><th></th></tr></thead><tbody>${findingRows}</tbody></table></div>`
    : `<div class="empty">No findings recorded yet. Phase 5 writes these to output/findings.jsonl.</div>`
}

<h2>Features</h2>
${
  features.length
    ? `<div class="tablewrap"><table><thead><tr><th>Feature</th><th>Description</th><th>Cases passed</th></tr></thead>
       <tbody>${featureRows}</tbody></table></div>`
    : `<div class="empty">No feature map yet. Phase 5 writes these to output/features.jsonl.</div>`
}

<h2>Test results</h2>
${
  tests.warnings.length
    ? `<div class="empty" style="border-color:#b45309;color:#92400e">
         <strong>These results do not describe the current suite.</strong>
         ${tests.warnings.map((w) => `<div>${esc(w)}</div>`).join("")}
         <div style="margin-top:6px">Re-run <code>npx playwright test</code> without
         <code>--reporter=line</code> and without a <code>-g</code> filter, then rebuild this
         report. A CLI reporter replaces the one configured in playwright.config.ts, so the
         json results file is left as an earlier run wrote it.</div>
       </div>`
    : ""
}
${
  tests.total
    ? `${
        tests.flaky
          ? `<div class="empty" style="border-color:#b45309;color:#92400e;margin-bottom:12px">
               <strong>${num(tests.flaky)} test(s) only passed on a retry.</strong>
               They are listed as "flaky" below. Either the suite is racing the
               application, or the target is too slow or overloaded to answer reliably -
               run <code>npm run preflight</code> to tell those apart before trusting a
               green run.
             </div>`
          : ""
      }<div class="tablewrap"><table><thead><tr><th>Status</th><th>Spec</th></tr></thead><tbody>${specRows}</tbody></table></div>
       <p class="sub" style="margin-top:10px">${
         tests.ranAt ? `Run started ${esc(tests.ranAt)}. ` : ""
       }Full Playwright report: <a href="pw-report/index.html">output/pw-report</a></p>`
    : `<div class="empty">No Playwright results. Run <code>npx playwright test</code> with the json reporter to populate this.</div>`
}

<h2>Authorization scan</h2>
${
  authz
    ? `<div class="tablewrap"><table><thead><tr><th>Verdict</th><th>Compared</th><th>Skipped</th><th>Probes</th><th>Personas</th></tr></thead><tbody>
       <tr>
         <td><span class="sev ${authz.verdict === "clean" ? "low" : authz.verdict === "findings" ? "high" : "critical"}">${esc(authz.verdict)}</span></td>
         <td>${num(authz.compared)} of ${num(authz.templates)}</td>
         <td>${num(authz.baselineUnreachable)} unreachable, ${num(authz.classifiedLogin)} login page</td>
         <td>${num(authz.probesFailed)} failed of ${num(authz.probesAttempted)}</td>
         <td>${esc(strList(authz.personas).join(", ") || "none")}</td>
       </tr></tbody></table></div>
       ${
         authz.verdict === "inconclusive"
           ? `<p class="sub" style="color:var(--bad);margin-top:10px"><strong>This scan proved nothing.</strong>
              Too few templates were compared, or too many probes failed. Do not read the findings
              above as a clean authorization result.</p>`
           : ""
       }
       ${
         strList(authz.sharedIdentity).length > 1
           ? `<p class="sub" style="margin-top:10px">${esc(strList(authz.sharedIdentity).join(" and "))}
              share one account, so the user-to-user comparison was skipped. Give each persona its
              own account on the target.</p>`
           : ""
       }`
    : `<div class="empty">No authorization scan in this run. <code>npm run authz</code> writes output/authz-status.json.</div>`
}

<h2>Test coverage</h2>
${
  strArr(coverage?.crawlWarnings).length
    ? `<div class="empty" style="border-color:#b45309;color:#92400e">
         <strong>These percentages are measured against a crawl that went nowhere.</strong>
         ${strArr(coverage?.crawlWarnings)
           .map((w) => `<div>${esc(w)}</div>`)
           .join("")}
         <div style="margin-top:6px">A crawl that never got past the sign-in screen scores
         100% of the one page it saw. Treat the figures below as arithmetic, not coverage.</div>
       </div>`
    : ""
}
${
  coverage
    ? `<div class="tablewrap"><table><thead><tr><th>What</th><th>Covered</th><th>Share</th></tr></thead><tbody>
       ${(
         [
           ["templates", coverage.templates],
           ["forms", coverage.forms],
           ["controls", coverage.controls],
         ] as const
       )
         .map(([label, c]) => {
           const total = num(c?.total);
           const covered = num(c?.covered);
           const pct = total === 0 ? 0 : Math.round((covered / total) * 100);
           const tone = pct >= 80 ? "low" : pct >= 50 ? "medium" : "high";
           return `<tr><td>${esc(label)}</td><td>${covered} / ${total}</td>
                   <td><span class="sev ${tone}">${pct}%</span></td></tr>`;
         })
         .join("")}
       </tbody></table></div>
       <p class="sub" style="margin-top:10px">Coverage counts a page as tested only when a spec
       navigates to it. 404 and 410 pages are excluded; a 5xx page is counted as a gap, because it
       exists and is broken. Run <code>npm run coverage</code> for the per-gap list.</p>`
    : `<div class="empty">No coverage data. <code>npm run coverage</code> writes output/coverage.json.</div>`
}

<h2>Skipped: destructive</h2>
${
  denied.length
    ? `<div class="tablewrap"><table><thead><tr><th>Kind</th><th>Control</th><th>Page</th></tr></thead><tbody>
       ${denied
         .map(
           (d) =>
             `<tr><td>${esc(d.kind)}</td><td><span class="sev high">${esc(d.control)}</span></td><td class="url">${esc(d.url)}</td></tr>`,
         )
         .join("")}
       </tbody></table></div>
       <p class="sub" style="margin-top:10px">These match <code>denyList</code> in qa.config.json.
       Withheld controls are absent from <code>buttons</code>, and withheld links were never
       queued or fetched. This is a label- and URL-level filter, not a hard interlock: see
       the Guardrails section of the README for exactly what it does and does not cover.</p>`
    : `<div class="empty">No controls matched the deny-list on the crawled pages.</div>`
}

<h2>Slowest pages</h2>
<div class="tablewrap"><table><thead><tr><th>Load</th><th>URL</th><th>Mode</th></tr></thead><tbody>
${slowest.map((p) => `<tr><td>${esc(p.loadMs)}ms</td><td class="url">${esc(p.url)}</td><td>${esc(p.mode)}</td></tr>`).join("")}
</tbody></table></div>

<h2>Page gallery (${pages.length})</h2>
<div class="grid">${gallery}</div>

</div></body></html>`;

  const out = resolve(OUT, "report.html");
  writeFileSync(out, html);

  // Quiet when rendering into a throwaway directory, so a test does not print over the
  // runner's output.
  if (OUT === DEFAULT_OUT) {
    const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
    console.log(`Wrote ${out} (${kb} KB)`);
    console.log(
      `  ${pages.length} pages, ${findings.length} findings, ${features.length} features, ${tests.total} tests`,
    );
  }

  // Reset, so one render cannot leave the module pointed at a temp directory that the
  // next caller then writes into.
  OUT = DEFAULT_OUT;
  TESTS_DIR = DEFAULT_TESTS_DIR;
  return html;
}

if (process.argv[1]?.endsWith("report.ts")) buildReport();
