/**
 * Pre-deploy hygiene scan: what did you forget to take out before shipping?
 *
 *   npm run predeploy
 *
 * Three passes, all read-only and all scoped to allowedOrigins:
 *
 *   1. Probe well-known paths that should not exist in production (/.env, /.git/HEAD,
 *      /actuator, /swagger-ui.html, backups, dumps).
 *   2. Scan the HTML already captured by the crawl for leftovers - source maps, debug
 *      statements, staging hostnames, credential-shaped strings, stack traces, TODOs.
 *   3. If an HTTP capture exists, audit response headers for the security headers a
 *      production deploy is expected to set, and for version disclosure.
 *
 * Findings go to output/deploy-findings.jsonl in the same shape as findings.jsonl, so the
 * report and the qa gate pick them up without special-casing.
 */
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, isAllowedUrl, isDeniedUrl, ROOT, type QaConfig, OUT } from "./config.js";
import { slugify as contentSlug, type PageRecord } from "./crawl.js";
import { readHistory, type HttpExchange } from "./http-history.js";
import { fingerprint, overlap, SAME_PAGE, looksLikeHtml, htmlIsWrongFor } from "./fingerprint.js";
import { polite } from "./polite.js";
import { detectCaptcha, unprotectedSensitiveForm } from "./captcha.js";

const FINDINGS = resolve(OUT, "deploy-findings.jsonl");

export type Severity = "critical" | "high" | "medium" | "low";

export interface DeployFinding {
  id: string;
  url: string;
  feature: string;
  severity: Severity;
  steps: string[];
  expected: string;
  actual: string;
  evidence?: string;
  source: "probe" | "content" | "headers";
}

// ---------------------------------------------------------------- path probes

interface Probe {
  path: string;
  label: string;
  severity: Severity;
  /** Extra confirmation that the body really is the thing, not a SPA catch-all 200. */
  confirm?: (body: string, contentType: string) => boolean;
}

const PROBES: Probe[] = [
  { path: "/.env", label: "Environment file", severity: "critical",
    confirm: (b) => /^[A-Z_][A-Z0-9_]*\s*=/m.test(b) },
  { path: "/.git/HEAD", label: "Git repository", severity: "critical",
    confirm: (b) => /^ref:\s+refs\//m.test(b) || /^[0-9a-f]{40}$/m.test(b.trim()) },
  { path: "/.git/config", label: "Git config", severity: "critical",
    confirm: (b) => /\[core\]|\[remote /.test(b) },
  { path: "/.svn/entries", label: "Subversion metadata", severity: "high" },
  { path: "/.DS_Store", label: "macOS directory index", severity: "low" },
  { path: "/phpinfo.php", label: "phpinfo()", severity: "critical",
    confirm: (b) => /phpinfo\(\)|PHP Version/i.test(b) },
  { path: "/server-status", label: "Apache server-status", severity: "high",
    confirm: (b) => /Apache Server Status|Server uptime/i.test(b) },
  { path: "/actuator", label: "Spring Actuator root", severity: "high",
    confirm: (b, ct) => ct.includes("json") && /_links|health/.test(b) },
  { path: "/actuator/env", label: "Spring Actuator env (leaks config)", severity: "critical",
    confirm: (b, ct) => ct.includes("json") },
  { path: "/actuator/heapdump", label: "Spring Actuator heapdump", severity: "critical" },
  { path: "/swagger-ui.html", label: "Swagger UI", severity: "medium" },
  { path: "/api-docs", label: "API docs endpoint", severity: "medium" },
  { path: "/v2/api-docs", label: "Swagger v2 spec", severity: "medium" },
  { path: "/openapi.json", label: "OpenAPI spec", severity: "medium" },
  { path: "/graphql", label: "GraphQL endpoint (check introspection)", severity: "medium" },
  { path: "/debug", label: "Debug endpoint", severity: "high" },
  { path: "/_debug", label: "Debug endpoint", severity: "high" },
  { path: "/debug/pprof/", label: "Go pprof profiler", severity: "critical" },
  { path: "/adminer.php", label: "Adminer DB console", severity: "critical" },
  { path: "/phpmyadmin/", label: "phpMyAdmin", severity: "critical" },
  { path: "/wp-config.php.bak", label: "WordPress config backup", severity: "critical" },
  { path: "/backup.zip", label: "Backup archive", severity: "critical" },
  { path: "/backup.sql", label: "Database dump", severity: "critical" },
  { path: "/dump.sql", label: "Database dump", severity: "critical" },
  { path: "/db.sqlite", label: "SQLite database", severity: "critical" },
  { path: "/docker-compose.yml", label: "docker-compose file", severity: "high",
    confirm: (b) => /^\s*(services|version)\s*:/m.test(b) },
  { path: "/Dockerfile", label: "Dockerfile", severity: "medium",
    confirm: (b) => /^\s*FROM\s+\S/mi.test(b) },
  { path: "/package.json", label: "package.json (dependency inventory)", severity: "low",
    confirm: (b) => /"(dependencies|devDependencies|name)"\s*:/.test(b) },
  { path: "/composer.lock", label: "composer.lock", severity: "low" },
  { path: "/yarn.lock", label: "yarn.lock", severity: "low" },
  { path: "/.htaccess", label: "Apache .htaccess", severity: "medium" },
  { path: "/web.config", label: "IIS web.config", severity: "medium",
    confirm: (b) => /<configuration/i.test(b) },
  { path: "/crossdomain.xml", label: "Flash crossdomain policy", severity: "low" },
  { path: "/.well-known/security.txt", label: "security.txt (informational - absence is fine)", severity: "low" },
];

/**
 * A site that answers 200 to everything makes every probe a false positive. Establish the
 * baseline first with a path that certainly does not exist.
 */
/**
 * Fetch two nonsense paths and decide whether this origin answers 200 to anything.
 *
 * Two, not one: a single sample cannot tell a catch-all shell from a genuine one-off
 * page, and comparing the two samples to each other is what proves the body is the same
 * regardless of the path asked for.
 */
async function catchAllBaseline(
  base: string,
  timeoutMs: number,
): Promise<{ print: Set<string>; length: number } | null> {
  const bodies: string[] = [];
  for (const tag of ["alpha", "beta"]) {
    // Retry: a single timed-out baseline fetch disables the catch-all guard for the whole
    // run, and then every probe that answers 200 is reported. That is not a hypothetical -
    // one flaky moment on a throttling target produced 10 "exposed" findings, 4 critical,
    // on a site where the guard works perfectly when the baseline is actually obtained.
    let body: string | null = null;
    for (let attempt = 0; attempt < 3 && body === null; attempt++) {
      const url = `${base}/__qa_agent_definitely_not_here_${tag}_${Date.now().toString(36)}`;
      try {
        const res = await polite().fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        // A non-200 is a definite answer, not a flake: this origin does not answer 200 to
        // everything, so the guard is genuinely not needed. Stop and say so.
        if (res.status !== 200) return null;
        body = await res.text();
      } catch {
        if (attempt === 2) return null;
      }
    }
    if (body === null) return null;
    bodies.push(body);
  }
  const [a, b] = bodies as [string, string];
  // If the two nonsense paths disagree, this is not a stable catch-all and a probe's own
  // 200 means something. Falling back to null is the safe direction: probes are reported.
  if (overlap(fingerprint(a), fingerprint(b)) < SAME_PAGE) return null;
  return { print: fingerprint(a), length: a.length };
}

async function runProbes(cfg: QaConfig, timeoutMs: number): Promise<DeployFinding[]> {
  const base = cfg.baseUrl.replace(/\/$/, "");
  const found: DeployFinding[] = [];
  const baseline = await catchAllBaseline(base, timeoutMs);

  if (baseline) {
    console.log(
      `  note: this origin answers 200 to any path (shell is ~${baseline.length} bytes) - ` +
        `probes are matched against that page's content, not its size.`,
    );
  } else {
    // Say this out loud. Either the origin 404s properly - the good case, and the guard is
    // not needed - or the baseline could not be fetched at all, in which case every probe
    // below is UNGUARDED and a soft-404 site will produce a page of invented criticals.
    // Silence here is how 19 false findings once looked like a clean, successful scan.
    console.log(
      `  note: no catch-all baseline (this origin did not answer 200 to a nonsense path, ` +
        `or could not be reached). Probe results are not filtered against a shell page.`,
    );
  }

  let n = 0;
  for (const probe of PROBES) {
    const url = `${base}${probe.path}`;
    if (!isAllowedUrl(url, cfg)) continue;
    // Never request something the deny-list considers destructive.
    if (isDeniedUrl(url, cfg)) continue;

    try {
      const res = await polite().fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 200) continue;

      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const body = (await res.text()).slice(0, 20000);

      // An HTML body is proof of nothing when the path names a .zip, .sql, .sqlite,
      // .lock or .bak - those cannot BE an html document, so what came back is the
      // server's error or index page. This needs no baseline and catches the most
      // common false positive in path probing on its own.
      if (htmlIsWrongFor(probe.path) && looksLikeHtml(contentType, body)) continue;

      // Otherwise compare CONTENT against the catch-all page. The old test was a
      // 64-byte length window, which missed a shell that varied 130 bytes across 19
      // probes and so reported all 19 as exposed, 7 of them critical.
      if (baseline && overlap(fingerprint(body), baseline.print) >= SAME_PAGE) continue;

      // The guard above runs BEFORE confirm, deliberately. A probe carrying a confirm
      // predicate used to skip the catch-all check altogether, so a loose predicate
      // satisfied by the shell would report a finding on every site that has one.
      if (probe.confirm && !probe.confirm(body, contentType)) continue;

      found.push({
        id: `D-P${String(++n).padStart(2, "0")}`,
        url,
        feature: `Exposed: ${probe.label}`,
        severity: probe.severity,
        steps: [`GET ${probe.path}`, "Observe HTTP 200 with real content"],
        expected: "404, or the path is not deployed at all",
        actual: `HTTP 200, ${body.length} bytes, content-type "${contentType || "none"}"`,
        evidence: body.slice(0, 200).replace(/\s+/g, " ").trim(),
        source: "probe",
      });
    } catch {
      // Timeouts and connection errors are not findings.
    }
  }
  return found;
}

// ---------------------------------------------------------------- content scan

interface Pattern {
  name: string;
  re: RegExp;
  severity: Severity;
  expected: string;
  /** Drop matches that are obviously not real (example keys, docs). */
  ignore?: RegExp;
}

const CONTENT_PATTERNS: Pattern[] = [
  {
    name: "Source map reference",
    re: /\/\/[#@]\s*sourceMappingURL=([^\s*]+)/g,
    severity: "medium",
    expected: "Source maps are not published, or are restricted to internal access",
  },
  {
    name: "Staging or localhost reference",
    re: /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal|[a-z0-9-]*(?:staging|dev|test|uat|qa|sandbox)\.[a-z0-9.-]+)(?::\d+)?\b/gi,
    severity: "medium",
    expected: "Production pages reference production hosts only",
    ignore: /schema|w3\.org|example\.(com|org)/i,
  },
  {
    name: "Debug statement in inline script",
    re: /\b(?:console\.(?:log|debug|warn|trace|table)|debugger)\s*[;(]/g,
    severity: "low",
    expected: "Debug statements are stripped from production bundles",
  },
  {
    name: "TODO / FIXME left in served markup",
    re: /\b(?:TODO|FIXME|XXX|HACK|TEMP HACK|REMOVE ME|DO NOT SHIP)\b[:\s][^\n<]{0,80}/g,
    severity: "low",
    expected: "Work-in-progress notes are not served to users",
  },
  {
    name: "HTML comment mentioning a secret",
    re: /<!--(?:(?!-->)[\s\S]){0,400}?\b(?:password|passwd|secret|api[_-]?key|token|credential)\b(?:(?!-->)[\s\S]){0,200}?-->/gi,
    severity: "high",
    expected: "No commented-out credentials or secret references in markup",
  },
  {
    name: "AWS access key id",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    severity: "critical",
    expected: "No cloud credentials in client-delivered content",
  },
  {
    name: "Google API key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    severity: "high",
    expected: "No unrestricted API keys in client-delivered content",
  },
  {
    name: "Stripe live secret key",
    re: /\bsk_live_[0-9A-Za-z]{16,}\b/g,
    severity: "critical",
    expected: "No live payment secret keys in client-delivered content",
  },
  {
    name: "GitHub token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[0-9A-Za-z_]{20,}\b/g,
    severity: "critical",
    expected: "No version-control tokens in client-delivered content",
  },
  {
    name: "Slack token",
    re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    severity: "critical",
    expected: "No chat tokens in client-delivered content",
  },
  {
    name: "Private key block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    severity: "critical",
    expected: "No private keys in client-delivered content",
  },
  {
    name: "JWT in page content",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    severity: "high",
    expected: "Tokens are not embedded in HTML delivered to the browser",
  },
  {
    name: "Server stack trace",
    re: /(?:Traceback \(most recent call last\)|\bat [\w.$]+\([^)]*:\d+:\d+\)|Exception in thread|java\.lang\.\w+Exception|Fatal error:.*on line \d+)/g,
    severity: "high",
    expected: "Users see a friendly error page, never a stack trace",
  },
  {
    name: "Framework debug page",
    re: /(?:Whoops, looks like something went wrong|DEBUG\s*=\s*True|Werkzeug Debugger|Rails\.application\.config|You're seeing this error because you have <code>DEBUG)/g,
    severity: "critical",
    expected: "Debug mode is off in production",
  },
  {
    name: "Placeholder or lorem content",
    re: /\b(?:lorem ipsum|dolor sit amet|Placeholder text|TBD|coming soon|test user|dummy data|foo@bar\.com|test@test\.com)\b/gi,
    severity: "low",
    expected: "Real copy and real data, not placeholders",
  },
  {
    name: "Directory listing",
    re: /<title>Index of \/|<h1>Index of \//g,
    severity: "high",
    expected: "Directory listing is disabled",
  },
];

function scanContent(pages: PageRecord[], html: Map<string, string>): DeployFinding[] {
  const found: DeployFinding[] = [];
  let n = 0;
  // A URL appears in both pages.jsonl and pages.auth.jsonl; report each leftover once.
  const reported = new Set<string>();

  for (const page of pages) {
    const body = html.get(page.url);
    if (!body) continue;

    // Bot protection, or the lack of it. A sensitive form with no CAPTCHA anywhere on its
    // page is a real defect this scan previously had no way to express: anyone can automate
    // account creation, password resets or a contact form that sends mail. The check is
    // deliberately narrow - a search box needs no CAPTCHA, and demanding one everywhere is
    // how a check gets switched off.
    const signals = detectCaptcha(body);
    for (const form of page.forms) {
      const identifiers = [form.action, ...form.fields.map((f) => f.name || "")];
      const gap = unprotectedSensitiveForm(identifiers, signals);
      if (!gap) continue;

      const key = `${page.url}::unprotected::${gap.what}`;
      if (reported.has(key)) continue;
      reported.add(key);

      found.push({
        id: `D-C${String(++n).padStart(2, "0")}`,
        url: page.url,
        feature: `No bot protection on ${gap.what}`,
        severity: "medium",
        steps: [`GET ${page.url}`, `Submit the form matching "${gap.matched}" repeatedly`],
        expected: "A CAPTCHA, a rate limit, or another bot check guards this form",
        actual: `the page carries no recognised CAPTCHA widget, and the form matches "${gap.matched}"`,
        evidence: `form action "${form.action || "(none)"}" with fields: ${form.fields
          .map((f) => f.name || f.type)
          .join(", ")
          .slice(0, 120)}`,
        source: "content",
      });
    }

    for (const pattern of CONTENT_PATTERNS) {
      const re = new RegExp(pattern.re.source, pattern.re.flags);
      const hits = new Set<string>();
      for (let m = re.exec(body); m !== null; m = re.exec(body)) {
        const hit = m[0].replace(/\s+/g, " ").trim().slice(0, 120);
        if (pattern.ignore?.test(hit)) continue;
        hits.add(hit);
        if (hits.size >= 5) break;
      }
      if (hits.size === 0) continue;

      const key = `${page.url}::${pattern.name}`;
      if (reported.has(key)) continue;
      reported.add(key);

      found.push({
        id: `D-C${String(++n).padStart(2, "0")}`,
        url: page.url,
        feature: pattern.name,
        severity: pattern.severity,
        steps: [`Open ${page.url}`, "View source", `Search for: ${pattern.name}`],
        expected: pattern.expected,
        actual: `${hits.size} match(es): ${[...hits].join(" | ").slice(0, 300)}`,
        source: "content",
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------- header audit

interface HeaderRule {
  header: string;
  name: string;
  severity: Severity;
  expected: string;
  /** Only applies when this returns true. */
  applies?: (x: HttpExchange, headers: Map<string, string>) => boolean;
  /** Present but wrong is worse than absent - flag the value too. */
  badValue?: RegExp;
}

const HEADER_RULES: HeaderRule[] = [
  { header: "content-security-policy", name: "Missing Content-Security-Policy", severity: "medium",
    expected: "A CSP restricting script sources",
    applies: (_x, h) => (h.get("content-type") ?? "").includes("html") },
  { header: "x-content-type-options", name: "Missing X-Content-Type-Options", severity: "low",
    expected: "nosniff" },
  { header: "strict-transport-security", name: "Missing HSTS on an HTTPS response", severity: "medium",
    expected: "Strict-Transport-Security with a max-age",
    applies: (x) => x.protocol === "https" },
  { header: "x-frame-options", name: "Missing clickjacking protection", severity: "low",
    expected: "X-Frame-Options, or frame-ancestors in the CSP",
    applies: (_x, h) => (h.get("content-type") ?? "").includes("html") && !(h.get("content-security-policy") ?? "").includes("frame-ancestors") },
  { header: "referrer-policy", name: "Missing Referrer-Policy", severity: "low",
    expected: "A Referrer-Policy such as strict-origin-when-cross-origin",
    applies: (_x, h) => (h.get("content-type") ?? "").includes("html") },
];

/** Headers that disclose software versions. */
const DISCLOSURE = [
  { header: "server", re: /\d+\.\d+/, name: "Server version disclosed" },
  { header: "x-powered-by", re: /./, name: "X-Powered-By disclosed" },
  { header: "x-aspnet-version", re: /./, name: "ASP.NET version disclosed" },
  { header: "x-generator", re: /./, name: "Generator disclosed" },
];

function parseHeaders(rawB64: string): Map<string, string> {
  const map = new Map<string, string>();
  const raw = Buffer.from(rawB64, "base64").toString("utf8");
  const head = raw.split("\r\n\r\n")[0] ?? "";
  for (const line of head.split("\r\n").slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) map.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return map;
}

function auditHeaders(history: HttpExchange[]): DeployFinding[] {
  const found: DeployFinding[] = [];
  // Report each problem once, against the first URL that shows it - not 469 times.
  const seen = new Set<string>();
  let n = 0;

  const add = (key: string, f: Omit<DeployFinding, "id" | "source">): void => {
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ ...f, id: `D-H${String(++n).padStart(2, "0")}`, source: "headers" });
  };

  for (const x of history) {
    if (x.status >= 300 && x.status < 400) continue;
    let headers: Map<string, string>;
    try {
      headers = parseHeaders(x.response);
    } catch {
      continue;
    }
    if (headers.size === 0) continue;

    for (const rule of HEADER_RULES) {
      if (rule.applies && !rule.applies(x, headers)) continue;
      if (headers.has(rule.header)) continue;
      add(rule.name, {
        url: x.url,
        feature: rule.name,
        severity: rule.severity,
        steps: [`GET ${x.path}`, `Inspect response headers for ${rule.header}`],
        expected: rule.expected,
        actual: `${rule.header} is absent`,
      });
    }

    for (const d of DISCLOSURE) {
      const v = headers.get(d.header);
      if (v && d.re.test(v)) {
        add(d.name, {
          url: x.url,
          feature: d.name,
          severity: "low",
          steps: [`GET ${x.path}`, `Inspect the ${d.header} response header`],
          expected: "Software versions are not advertised",
          actual: `${d.header}: ${v}`,
        });
      }
    }

    // Cookie flags
    for (const [k, v] of headers) {
      if (k !== "set-cookie") continue;
      const name = v.split("=")[0] ?? "cookie";
      const missing = [
        !/;\s*httponly/i.test(v) ? "HttpOnly" : "",
        !/;\s*secure/i.test(v) && x.protocol === "https" ? "Secure" : "",
        !/;\s*samesite/i.test(v) ? "SameSite" : "",
      ].filter(Boolean);
      if (missing.length) {
        add(`cookie:${name}:${missing.join(",")}`, {
          url: x.url,
          feature: `Cookie "${name}" missing ${missing.join(", ")}`,
          severity: missing.includes("HttpOnly") || missing.includes("Secure") ? "medium" : "low",
          steps: [`GET ${x.path}`, "Inspect the Set-Cookie header"],
          expected: "Session cookies set HttpOnly, Secure and SameSite",
          actual: v.slice(0, 160),
        });
      }
    }

    // Permissive CORS
    const acao = headers.get("access-control-allow-origin");
    if (acao === "*" && headers.get("access-control-allow-credentials") === "true") {
      add("cors", {
        url: x.url,
        feature: "CORS allows any origin with credentials",
        severity: "high",
        steps: [`GET ${x.path}`, "Inspect Access-Control-Allow-* headers"],
        expected: "A credentialed endpoint names its allowed origins explicitly",
        actual: "Access-Control-Allow-Origin: * with Allow-Credentials: true",
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------- driver

function readPages(): PageRecord[] {
  const out: PageRecord[] = [];
  for (const name of ["pages.jsonl", "pages.auth.jsonl"]) {
    const file = resolve(OUT, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as PageRecord);
      } catch {
        /* partial line */
      }
    }
  }
  return out;
}

/**
 * How many pages the content scan may fetch itself when the capture does not cover them.
 * A bound, not a target: this is one GET per page against someone's site.
 */
const MAX_CONTENT_FETCH = 150;

/**
 * The same slug the crawler writes its saved HTML under.
 *
 * Imported rather than re-implemented: two copies of a hashing slug that must agree is a
 * silent cache miss waiting to happen - the scan would simply re-fetch everything and
 * nobody would notice, because the only symptom is slowness.
 */
const slugifyForContent = contentSlug;

/**
 * Page HTML for the content scan: whatever the capture holds, PLUS a direct fetch of every
 * crawled page the capture does not cover.
 *
 * It used to be either/or - `if (html.size > 0) return html` - and that made the scan lie.
 * captureHttpHistory is off by default, so the capture on disk is whatever some earlier run
 * happened to leave behind: 14 documents against a 124-page crawl. A non-empty capture
 * short-circuited the fallback, so 110 pages were never examined for leftovers and the scan
 * printed "0 finding(s)" over 11% of the site. Finding what someone forgot to remove before
 * deploying is this tool's whole purpose; silently skipping seven eighths of the pages is
 * exactly the failure it exists to catch, in the tool itself.
 */
async function collectHtml(
  pages: PageRecord[],
  history: HttpExchange[],
  cfg: QaConfig,
  timeoutMs: number,
): Promise<Map<string, string>> {
  const html = new Map<string, string>();

  for (const x of history) {
    if (!x.mimeType.includes("HTML") && !x.mimeType.includes("script")) continue;
    try {
      const raw = Buffer.from(x.response, "base64").toString("utf8");
      const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
      if (body) html.set(x.url, body);
    } catch {
      /* skip */
    }
  }
  const fromCapture = html.size;

  // Only the pages the capture is missing. Deduplicated, because the crawl records one
  // entry per visited URL and the capture is keyed by URL too.
  const missing: string[] = [];
  const seen = new Set(html.keys());
  let gone = 0;
  for (const p of pages) {
    if (p.ok === false) continue;
    if (seen.has(p.url)) continue;
    if (!isAllowedUrl(p.url, cfg)) continue;
    // Same rule as runProbes: this scan is read-only, and a GET can still change state.
    if (isDeniedUrl(p.url, cfg)) continue;
    seen.add(p.url);
    // A page the crawl already recorded as absent has no content to scan, and fetching it
    // again only to discover the same 404 wastes a request and then reports it as
    // "unreachable", which reads as breakage. coverage.ts drops 404/410 from its
    // denominator on the same reasoning; the two should not disagree about what exists.
    const status = p.status ?? 0;
    if (status === 404 || status === 410) {
      gone++;
      continue;
    }
    missing.push(p.url);
  }

  // Before fetching anything: the crawler saves each page's RENDERED DOM under output/
  // content/, and that is both free and better input than the served bytes - a leftover
  // injected by script is invisible on the wire. The scan used to re-fetch all 51
  // reachable pages, so every run made two full passes over someone else's site to look at
  // the same content.
  let fromDisk = 0;
  const stillMissing: string[] = [];
  for (const url of missing) {
    const file = resolve(OUT, "content", `${slugifyForContent(url)}.html`);
    if (!existsSync(file)) {
      stillMissing.push(url);
      continue;
    }
    try {
      html.set(url, readFileSync(file, "utf8"));
      fromDisk++;
    } catch {
      stillMissing.push(url);
    }
  }

  const targets = stillMissing.slice(0, MAX_CONTENT_FETCH);
  const overBound = stillMissing.length - targets.length;

  let fetched = 0;
  let protectedPages = 0;
  let redirects = 0;
  for (const url of targets) {
    try {
      // Not followed: the redirect target was never scope- or deny-checked, and a page
      // that 302s to /logout would have had this scan sign the session out.
      const res = await polite().fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 300 && res.status < 400) {
        redirects++;
        continue;
      }
      if (res.ok) {
        html.set(url, (await res.text()).slice(0, 500_000));
        fetched++;
        continue;
      }
      // 401/403 serves no page to scan, but it is the correct answer from a protected
      // route - /basic_auth answers 401 by design. Reporting those as "unreachable"
      // reads as breakage and buries the count that actually matters.
      if (res.status === 401 || res.status === 403) protectedPages++;
    } catch {
      /* genuinely unreachable - timed out or refused */
    }
  }

  // Say what was actually examined. A count that does not add up is the signal that the
  // scan is narrower than the crawl, and it should be visible without reading the code.
  const unreachable = targets.length - fetched - protectedPages - redirects;
  const parts = [`${fromCapture} from capture`];
  if (fromDisk > 0) parts.push(`${fromDisk} reused from the crawl`);
  parts.push(`${fetched} fetched`);
  if (protectedPages > 0) parts.push(`${protectedPages} protected (401/403)`);
  if (redirects > 0) parts.push(`${redirects} redirect(s), not followed`);
  if (gone > 0) parts.push(`${gone} already 404/410 in the crawl`);
  if (unreachable > 0) parts.push(`${unreachable} unreachable`);
  if (overBound > 0) parts.push(`${overBound} NOT SCANNED - over the ${MAX_CONTENT_FETCH} cap`);
  console.log(`  content: ${html.size} document(s) (${parts.join(", ")})`);

  return html;
}

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.baseUrl) throw new Error("Set baseUrl in qa.config.json first.");
  const timeoutMs = Math.min(cfg.navTimeoutMs, 20000);

  console.log(`Pre-deploy scan of ${cfg.baseUrl}\n`);

  console.log(`probing ${PROBES.length} well-known path(s) ...`);
  const probeFindings = await runProbes(cfg, timeoutMs);
  console.log(`  ${probeFindings.length} exposed\n`);

  const pages = readPages();
  // readHistory() with no argument merges every capture that exists and returns [] when
  // none do, so it needs no guard. Asking existsSync about the ANONYMOUS path meant that
  // after `npm run crawl:auth` alone the header audit was skipped and the tool advised
  // "enable captureHttpHistory and re-crawl" - while the capture sat on disk.
  const history = readHistory();
  if (pages.length === 0 && history.length === 0) {
    console.log("No crawl data found - run `npm run crawl` first for the content scan.\n");
  }

  console.log("scanning page content for leftovers ...");
  const html = await collectHtml(pages, history, cfg, timeoutMs);
  const contentFindings = scanContent(pages, html);
  console.log(`  ${contentFindings.length} finding(s)\n`);

  let headerFindings: DeployFinding[] = [];
  if (history.length) {
    console.log(`auditing response headers across ${history.length} exchange(s) ...`);
    headerFindings = auditHeaders(history);
    console.log(`  ${headerFindings.length} finding(s)\n`);
  } else {
    console.log("header audit skipped - enable captureHttpHistory and re-crawl to include it.\n");
  }

  const all = [...probeFindings, ...contentFindings, ...headerFindings].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity],
  );

  rmSync(FINDINGS, { force: true });
  for (const f of all) appendFileSync(FINDINGS, `${JSON.stringify(f)}\n`);

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of all) bySeverity[f.severity]++;

  console.log("=".repeat(62));
  console.log(
    `critical ${bySeverity.critical}   high ${bySeverity.high}   ` +
      `medium ${bySeverity.medium}   low ${bySeverity.low}`,
  );
  for (const f of all.slice(0, 15)) {
    console.log(`  [${f.severity.padEnd(8)}] ${f.feature}`);
    console.log(`             ${f.url}`);
  }
  if (all.length > 15) console.log(`  ... and ${all.length - 15} more`);
  console.log(`\nwrote ${FINDINGS}`);

  const blocking = bySeverity.critical + bySeverity.high;
  if (blocking > 0) {
    console.error(`\nNOT READY TO DEPLOY: ${blocking} critical/high finding(s).`);
    process.exit(1);
  }
  console.log("\nNo critical or high findings.");
}

const isEntry = process.argv[1]
  ? resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\//, ""))
  : false;

if (isEntry || process.argv[1]?.endsWith("deploy-check.ts")) {
  main().catch((err: unknown) => {
    console.error(`Pre-deploy scan failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export { runProbes, scanContent, auditHeaders, collectHtml, CONTENT_PATTERNS, PROBES, MAX_CONTENT_FETCH };
