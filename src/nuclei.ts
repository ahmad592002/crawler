/**
 * Nuclei command recommendations, built from what the crawl already found.
 *
 * This NEVER runs nuclei. It reads the inventory, the tech profile and the config and
 * prints the command you would run yourself - scoped to allowedOrigins, paced to the same
 * rate the crawler used, and split by the kind of endpoint so each group gets the template
 * set that actually applies to it. "Here is the best command for your login pages" beats
 * "here is one giant scan", because the giant scan wastes requests and buries the signal.
 *
 * Every recommendation stays inside the guardrails: only in-scope, non-denied URLs are ever
 * put in a target list, and the active (intrusive) scans are flagged so you opt into them.
 */
import type { PageRecord, FormInfo } from "./crawl.js";
import type { TechProfile } from "./techprofile.js";
import type { QaConfig } from "./config.js";
import { isAllowedUrl, isDeniedUrl } from "./config.js";

export type NucleiCategory =
  | "baseline"
  | "headers"
  | "cookies"
  | "auth"
  | "forms"
  | "upload"
  | "api";

export interface NucleiRec {
  id: NucleiCategory;
  title: string;
  /** Why this scan is worth running against these endpoints. */
  why: string;
  /** The remediation the category points at, in one line. */
  fix: string;
  /** In-scope, non-denied URLs this command should target. Empty for whole-site scans. */
  endpoints: string[];
  /** The recommended command. `{list}` is a placeholder a caller may replace with a file. */
  command: string;
  templates: string;
  severity: string;
  /** Active/fuzzing scan that sends crafted payloads. Opt-in; never part of a quick pass. */
  intrusive: boolean;
}

/** Requests per second that matches the crawler's own pacing (nuclei -rate-limit is rps). */
export function rpsFromConfig(cfg: QaConfig): number {
  const delay = cfg.requestDelayMs ?? 0;
  if (delay <= 0) return 10; // no pacing configured; still stay modest
  return Math.max(1, Math.floor(1000 / delay));
}

/** Tech-profile names → nuclei template tags, for the baseline scan. */
export function techTags(tech: TechProfile | null): string[] {
  if (!tech) return [];
  const names = [...(tech.server ?? []), ...(tech.frameworks ?? []), ...(tech.cms ?? []), ...(tech.languages ?? [])]
    .map((d) => d.name.toLowerCase());
  const map: Array<[RegExp, string]> = [
    [/jquery/, "jquery"],
    [/wordpress/, "wordpress"],
    [/drupal/, "drupal"],
    [/joomla/, "joomla"],
    [/apache/, "apache"],
    [/nginx/, "nginx"],
    [/tomcat/, "tomcat"],
    [/iis/, "iis"],
    [/php/, "php"],
    [/laravel/, "laravel"],
    [/django/, "django"],
    [/express/, "nodejs"],
    [/spring/, "spring"],
    [/graphql/, "graphql"],
  ];
  const tags = new Set<string>();
  for (const n of names) for (const [re, tag] of map) if (re.test(n)) tags.add(tag);
  return [...tags];
}

const AUTH_PATH = /\/(login|log-?in|sign-?in|sign-?on|signin|auth|authenticate|secure|account|forgot|reset|register|sign-?up|signup)(\/|$|\?)/i;
const API_PATH = /\/(api|graphql|rest|v\d+)(\/|$)|\.json($|\?)/i;
const INJECTABLE = new Set(["text", "search", "email", "password", "url", "tel", "number", "textarea", "", "input"]);

/**
 * Wrap a value as a single POSIX shell argument. Inside single quotes nothing is special
 * except a single quote itself, which is closed, escaped and reopened: ' -> '\'' . Without
 * this a baseUrl like https://t.test/'; rm -rf / # breaks out of the bare '...' wrap and
 * the printed command runs whatever the target put after the quote.
 */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Is `base` a real, in-scope http(s) URL we can safely put in a whole-site `-u` command?
 * An unparseable, non-http(s) or off-scope base must never reach the shell line a human
 * copy-pastes - that is both a broken command and a scope escape.
 */
function usableBase(base: string, cfg: QaConfig): boolean {
  try {
    const u = new URL(base);
    return (u.protocol === "http:" || u.protocol === "https:") && isAllowedUrl(base, cfg);
  } catch {
    return false;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname + (new URL(url).search || "");
  } catch {
    return url;
  }
}

function hasInjectableForm(forms: FormInfo[] | undefined): boolean {
  return !!forms?.some((f) => !f.destructive && (f.fields ?? []).some((fd) => INJECTABLE.has((fd.type || "").toLowerCase())));
}
function hasUpload(forms: FormInfo[] | undefined): boolean {
  return !!forms?.some((f) => (f.fields ?? []).some((fd) => (fd.type || "").toLowerCase() === "file"));
}

/**
 * Sort every crawled, in-scope, non-denied page into exactly one category, most specific
 * first (upload > auth > api > forms > static). Static pages carry no extra scan beyond the
 * baseline, so they are counted but not listed.
 */
export function categorize(
  pages: PageRecord[],
  cfg: QaConfig,
): { auth: string[]; forms: string[]; upload: string[]; api: string[]; static: string[] } {
  const out = { auth: [] as string[], forms: [] as string[], upload: [] as string[], api: [] as string[], static: [] as string[] };
  const seen = new Set<string>();
  for (const p of pages) {
    if (!p.url || p.ok === false) continue;
    if (!isAllowedUrl(p.url, cfg) || isDeniedUrl(p.url, cfg)) continue;
    if (seen.has(p.template || p.url)) continue;
    seen.add(p.template || p.url);
    const path = pathOf(p.url);
    if (hasUpload(p.forms)) out.upload.push(p.url);
    else if (AUTH_PATH.test(path) || p.authRequired) out.auth.push(p.url);
    else if (API_PATH.test(path)) out.api.push(p.url);
    else if (hasInjectableForm(p.forms)) out.forms.push(p.url);
    else out.static.push(p.url);
  }
  return out;
}

function missingHeaders(tech: TechProfile | null): string[] {
  return (tech?.securityHeaders ?? []).filter((h) => !h.present).map((h) => h.name);
}
function insecureCookies(tech: TechProfile | null): string[] {
  return (tech?.cookies ?? []).filter((c) => !c.secure || !c.httpOnly).map((c) => c.name);
}

/**
 * The ranked list of nuclei commands for this target. Always starts with a safe baseline;
 * the intrusive ones come last and are flagged. Commands use `{list}` where a target file
 * would go, so a caller that writes the file can substitute its path.
 */
export function buildRecommendations(pages: PageRecord[], tech: TechProfile | null, cfg: QaConfig): NucleiRec[] {
  const base = cfg.baseUrl;
  const rps = rpsFromConfig(cfg);
  const pace = `-rate-limit ${rps} -c 10`;
  const cat = categorize(pages, cfg);
  const recs: NucleiRec[] = [];

  // The whole-site scans target baseUrl directly. Only emit a runnable command when the
  // base is a real, in-scope http(s) URL, shell-escaped; otherwise print a note so a bad
  // baseUrl can never become a broken or off-scope command. The -l {list} commands below
  // use a file of already-vetted, in-scope URLs and need no base.
  const baseOk = usableBase(base, cfg);
  const baseArg = shellSingleQuote(base);
  const baseNote = `# set baseUrl to a valid in-scope http(s) URL to run this scan (got ${JSON.stringify(base)})`;
  const uCommand = (rest: string): string => (baseOk ? `nuclei -u ${baseArg} ${rest}` : baseNote);

  // 1. Baseline: passive-leaning templates over the whole site, tuned by the stack.
  // Canonical nuclei tag names (verified against the v3.11.1 library — the plural/
  // variant forms "cves"/"exposures"/"misconfiguration"/"default-logins"/"exposed-panels"
  // match almost nothing; "cve"/"exposure"/"misconfig"/"default-login"/"panel" are the real ones).
  const tags = ["cve", "exposure", "misconfig", "default-login", "panel", "tech", ...techTags(tech)];
  recs.push({
    id: "baseline",
    title: "Baseline scan (whole site)",
    why: "CVEs, exposed files and panels, and known misconfigurations for the detected stack. Safe to run first; it reports, it does not exploit.",
    fix: "Patch or remove anything it reports; most hits are a known-vulnerable component or a file that should not be served.",
    endpoints: [],
    command: uCommand(`-tags ${tags.join(",")} -severity low,medium,high,critical ${pace} -stats`),
    templates: tags.join(", "),
    severity: "low–critical",
    intrusive: false,
  });

  // 2. Security headers, when the profiler found any missing.
  const miss = missingHeaders(tech);
  if (miss.length) {
    recs.push({
      id: "headers",
      title: "Missing security headers",
      why: `The profiler saw these response headers absent: ${miss.join(", ")}.`,
      fix: `Set ${miss.join(", ")} at the edge or in the app. CSP and HSTS are the two that matter most here.`,
      endpoints: [],
      command: uCommand(`-id http-missing-security-headers -severity info,low ${pace}`),
      templates: "http-missing-security-headers",
      severity: "info–low",
      intrusive: false,
    });
  }

  // 3. Cookie flags, when a session cookie is missing Secure or HttpOnly.
  const cookies = insecureCookies(tech);
  if (cookies.length) {
    recs.push({
      id: "cookies",
      title: "Cookie flags",
      why: `Cookie(s) missing Secure/HttpOnly: ${cookies.join(", ")}. A session cookie without them is exposed to theft.`,
      fix: "Set Secure and HttpOnly on every session cookie, and SameSite=Lax or Strict.",
      endpoints: [],
      command: uCommand(`-tags misconfig -id cookies-without-secure,cookies-without-httponly ${pace}`),
      templates: "cookies-without-secure, cookies-without-httponly",
      severity: "info–low",
      intrusive: false,
    });
  }

  // 4. Auth endpoints.
  if (cat.auth.length) {
    recs.push({
      id: "auth",
      title: `Authentication endpoints (${cat.auth.length})`,
      why: "Login, registration and account pages: default credentials, exposed admin panels and auth-bypass templates concentrate here.",
      fix: "Remove default/weak logins, lock down exposed panels, and rate-limit the login route.",
      endpoints: cat.auth,
      command: `nuclei -l {list} -tags default-login,panel,auth-bypass -severity medium,high,critical ${pace}`,
      templates: "default-login, panel, auth-bypass",
      severity: "medium–critical",
      intrusive: false,
    });
  }

  // 5. Input forms: active fuzzing. Intrusive - opt in.
  if (cat.forms.length) {
    recs.push({
      id: "forms",
      title: `Input forms — active fuzzing (${cat.forms.length})`,
      why: "Pages with text inputs are the injection surface: reflected XSS, SQLi, SSRF, LFI. This sends crafted payloads, so run it only against a target you own or have written permission to test.",
      fix: "Validate and encode every input server-side; use parameterised queries; allow-list any URL or path a form accepts.",
      endpoints: cat.forms,
      command: `nuclei -l {list} -dast -tags xss,sqli,ssrf,lfi,cmdi,ssti -fuzz-aggression low -severity medium,high,critical ${pace}`,
      templates: "xss, sqli, ssrf, lfi, cmdi, ssti (DAST fuzzing; -fuzz-aggression low)",
      severity: "medium–critical",
      intrusive: true,
    });
  }

  // 6. Upload endpoints.
  if (cat.upload.length) {
    recs.push({
      id: "upload",
      title: `File upload endpoints (${cat.upload.length})`,
      why: "Upload forms can allow unrestricted file upload leading to code execution.",
      fix: "Allow-list extensions and content types, store outside the web root, and never execute uploaded files.",
      endpoints: cat.upload,
      command: `nuclei -l {list} -tags file-upload,rce -severity high,critical ${pace}`,
      templates: "file-upload, rce",
      severity: "high–critical",
      intrusive: true,
    });
  }

  // 7. API endpoints.
  if (cat.api.length) {
    recs.push({
      id: "api",
      title: `API endpoints (${cat.api.length})`,
      why: "JSON/GraphQL/REST routes: exposures, auth-bypass and injection templates aimed at APIs.",
      fix: "Require auth on every route, validate input, and never return more than the caller needs.",
      endpoints: cat.api,
      command: `nuclei -l {list} -tags exposure,auth-bypass,injection,graphql -severity medium,high,critical ${pace}`,
      templates: "exposure, auth-bypass, injection, graphql",
      severity: "medium–critical",
      intrusive: true,
    });
  }

  return recs;
}
