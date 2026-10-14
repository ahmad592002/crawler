/**
 * Cross-user authorization scan: can one persona reach another persona's pages, and can a
 * stranger reach either?
 *
 *   npm run authz
 *
 * This is the class of bug a single-session suite structurally cannot find. The crawl as
 * persona A produces a list of URLs A could reach. Requesting each of them as persona B,
 * and again with no cookies at all, answers the two questions that matter:
 *
 *   - is a protected page reachable while signed out?          (worst case)
 *   - is A's resource reachable by another signed-in user?     (IDOR / BOLA)
 *
 * Read-only by construction: GET only, and any URL the deny-list considers destructive is
 * skipped rather than requested.
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { request, type APIRequestContext } from "playwright";
import { loadConfig, isAllowedUrl, isDeniedUrl, ROOT, type QaConfig, OUT } from "./config.js";
import { knownPersonas, type Persona } from "./personas.js";
import type { PageRecord } from "./crawl.js";
import { polite, PolitenessError } from "./polite.js";

const FINDINGS = resolve(OUT, "authz-findings.jsonl");

export interface AuthzFinding {
  id: string;
  url: string;
  feature: string;
  severity: "critical" | "high" | "medium" | "low";
  steps: string[];
  expected: string;
  actual: string;
  source: "authz";
}

export interface Probe {
  status: number;
  length: number;
  /** True when the body looks like a sign-in page rather than the resource. */
  looksLikeLogin: boolean;
  /** False for an empty SPA shell or a stub - a 200 that proves nothing. */
  hasContent: boolean;
}

/**
 * Does this body look like a sign-in page, as opposed to a page that merely LINKS to one?
 *
 * The first version matched `log ?in` and `name=password` anywhere in the first 40 KB. A
 * protected invoice page with `<a href="/login">Login</a>` in its footer therefore read as
 * a login page, `reachedResource` returned false, and the whole template was dropped from
 * the scan before either check ran - after which the run printed "No cross-user access
 * problems found". Nearly every authenticated page has a login or logout link somewhere,
 * so that suppressed most of the site and reported it as clean.
 *
 * The signal has to be a password INPUT, which a link cannot produce. A page offering a
 * change-password field is still a real resource, so a lone password input is not enough
 * either: it must sit in a form that also takes an identifier, and the page must be small
 * enough to plausibly BE a sign-in page rather than an application screen containing one.
 */
/**
 * Does this response deny access, rather than serve the resource?
 *
 * Third rewrite. The first suppressed most of a site; the second fabricated criticals on
 * any login page carrying a sign-up link; the third missed two-step and non-Latin login
 * pages because it keyed on SUBMIT-BUTTON WORDING. Each time the tests were green, because
 * the fixtures were written from the classifier's own vocabulary.
 *
 * So this version keys on STRUCTURE, which survives translation and rewording:
 *
 *   - a credential input (type=password, or an autocomplete token browsers only put on
 *     sign-in forms: current-password, one-time-code, username)
 *   - a form whose ACTION is an auth route
 *   - an explicit deny envelope (401-style prose, or a JSON error body)
 *
 * Wording is used only to break ties, never as the sole signal, and never to decide that
 * something is NOT a login page.
 */

/** Auth-ish form actions, in the spellings real frameworks use. */
/**
 * A form action that means "sign in", matched on a path SEGMENT rather than a substring.
 *
 * Substring matching made `/account/sessions` (the active-devices page) and `/auth/tokens`
 * (personal access tokens) read as login forms, because they contain "session" and "auth".
 * Both are authenticated pages, and suppressing them is the report-a-false-clean direction.
 * The segment must also be where the form POSTS TO - last, or followed by /new - which is
 * what separates `/session` (sign in) from `/account/sessions` (manage them).
 */
const AUTH_ACTION = new RegExp(
  // The token must be a WHOLE path segment: preceded by "/", and followed by "/", the end
  // of the attribute, or a query. That is what keeps "/account/sessions" (plural - manage
  // your devices) and "/auth/tokens" out, while "/signin/v1/lookup" and "/session" are in.
  'action=["\'][^"\']*?/' +
    "(?:log[-_]?in|sign[-_]?in|signin|signon|authenticate|session|sessions/new|sso|saml|" +
    "j_spring_security_check|wp-login\\.php|dukhul|vhod|ninshou|connexion|anmelden)" +
    '(?=[/?#"\'])',
  "i",
);

/** OAuth/OIDC endpoints are gates too, but only the authorize step. */
const OAUTH_ACTION = /action=["'][^"']*\/(?:oauth2?|oidc)\/(?:authorize|authenticate|token)\b/i;

/** An action that plainly performs an operation on an existing account, not a sign-in. */
const OPERATION_ACTION =
  /action=["'][^"']*(?:settings|preferences|profile|disable|enable|update|delete|remove|revoke|create|new|invite|webhook|billing|2fa|mfa)/i;

/** Inputs that only appear on a sign-in or verification step. */
/**
 * Inputs that only appear on a sign-in or verification step.
 *
 * `autocomplete="username"` was here and had to come out: modern profile and account forms
 * carry it too, so an edit-profile page with a name field classified as a login page. Only
 * current-password and one-time-code are specific to authenticating.
 */
const CREDENTIAL_INPUT =
  /<input[^>]+(?:type=["']?password|autocomplete=["'](?:current-password|one-time-code)["']|name=["']?(?:otp|passcode|one_?time|j_username|j_password)\b)/i;

/** An identifier field, in several languages and framework conventions. */
const IDENTIFIER_INPUT =
  /<input[^>]+(?:name|id)=["']?(?:j_)?(?:user(?:name|id)?|email|e?mail|login|account|identifier|benutzer|utilisateur|usuario|correo|kullanici|logowanie)/i;

/** Chrome that only an authenticated application page carries. */
const APP_CHROME = /(?:sign|log)\s?out\b|href=["'][^"']*logout|<nav[^>]*>[\s\S]{0,400}?<\/nav>/i;

/** A JSON body, as opposed to a document. */
function isJsonBody(body: string): boolean {
  const t = body.trim();
  return (t.startsWith("{") || t.startsWith("[")) && /["']\w+["']\s*:/.test(t.slice(0, 2000));
}

/** Auth-specific denial wording. Bare "expired" is absent on purpose - see below. */
const DENY_WORDS =
  /unauthori[sz]ed|unauthenticated|not[_\s-]?authenticated|forbidden|not[_\s-]?logged[_\s-]?in|login[_\s-]?required|authentication[_\s-]?required|invalid[_\s-]?token|token[_\s-]?expired|session[_\s-]?expired/i;

/**
 * Is this JSON body a denial, rather than a resource that happens to mention one?
 *
 * Three constraints, each from a false positive that suppressed a real resource:
 *   - the wording must be auth-specific. A bare "expired" matched
 *     {"code":"EXPIRED_COUPON"} - a cart, not a denial.
 *   - the envelope must be essentially the whole body. A log line
 *     {"message":"user 44 hit login_required","entries":[1,2,3]} carries real data.
 *   - a populated array or object means data was returned, so access was NOT denied.
 */
export function isDenyEnvelope(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    // Truncated or streaming JSON: fall back to the wording alone, on a short body only.
    return body.length < 300 && DENY_WORDS.test(body);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0 || keys.length > 5) return false;

  // An `error`/`errors` key is the envelope itself, not returned data. Google-style
  // {"error":{"message":"Unauthenticated"}} and JSON:API {"errors":[{"title":...}]} are the
  // most common 401 bodies, and counting their nesting as data read them as the resource.
  const isErrorKey = (k: string): boolean => /^errors?$/i.test(k);
  const carriesData = keys.some((k) => {
    if (isErrorKey(k)) return false;
    const v = obj[k];
    if (Array.isArray(v)) return v.length > 0;
    return typeof v === "object" && v !== null && Object.keys(v as object).length > 0;
  });
  if (carriesData) return false;

  return keys.some((k) => {
    if (!/^(?:error|errors|detail|message|code|status|reason)$/i.test(k)) return false;
    const v = obj[k];
    if (typeof v === "string") return DENY_WORDS.test(v);
    return isErrorKey(k) && stringLeaves(v, 3).some((s) => DENY_WORDS.test(s));
  });
}

/** Every string inside a small nested value, to a bounded depth. */
function stringLeaves(v: unknown, depth: number): string[] {
  if (typeof v === "string") return [v];
  if (depth === 0 || v === null || typeof v !== "object") return [];
  const children = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
  return children.flatMap((c) => stringLeaves(c, depth - 1));
}

export function looksLikeLoginPage(body: string): boolean {
  const head = body.slice(0, 60_000);

  // ---- 1. A machine-readable deny envelope. -----------------------------------------
  // A 200 carrying {"error":"unauthorized"} is a denial that happens to have the wrong
  // status code. Treating it as the resource made every URL compare equal and fabricated
  // criticals.
  if (isJsonBody(head)) return isDenyEnvelope(head);

  // ---- 2. An explicit interstitial, but only on a page that is ONLY that. -----------
  // "Sign in to continue using Acme Cloud after July 1" is an article headline. The rule
  // fired on prose because it never asked how much else was on the page.
  const textLen = visibleTextLength(head);
  // 150, measured, not guessed. A real deny interstitial is a sentence and a link: the
  // "You must log in to view this page" shape is 48 characters. An article whose HEADLINE
  // happens to read "Sign in to continue using Acme Cloud after July 1" came to 509, and a
  // 600 threshold classified it as a gate - dropping the page from the scan and reporting
  // the run as clean.
  const isTerse = textLen < 150;
  if (isTerse) {
    if (/you must (?:log\s?in|sign\s?in|be (?:logged|signed) in)/i.test(head)) return true;
    if (/(?:please\s+)?(?:log\s?in|sign\s?in) to (?:view|continue|access)/i.test(head)) return true;
    if (/your session has (?:expired|timed out)|session expired/i.test(head)) return true;
  }

  // A literal 401/403 status page is a denial at ANY length. Gating this behind the terse
  // threshold meant a stock Apache 401 body - which runs past 150 characters once it
  // explains itself and appends a server signature - was not recognised, and a proxy that
  // serves that body with a 200 would have manufactured a critical.
  if (/\b40[13]\b[\s\S]{0,80}?(?:unauthorized|unauthorised|authorization required|forbidden)/i.test(head)) {
    return true;
  }

  // ---- 3. Structure. ----------------------------------------------------------------
  const hasCredentialInput = CREDENTIAL_INPUT.test(head);
  const hasIdentifier = IDENTIFIER_INPUT.test(head);
  const authAction = AUTH_ACTION.test(head) || OAUTH_ACTION.test(head);
  const operationAction = OPERATION_ACTION.test(head);
  const appChrome = APP_CHROME.test(head);

  // A registration form has the same structure as a sign-in form - identifier plus
  // password, no app chrome - so structure alone cannot separate them. A second password
  // field, or wording that only a signup page carries, can.
  const isSignup =
    /<input[^>]+(?:name|id)=["']?(?:password_?confirmation|confirm_?password|password2)/i.test(head) ||
    /autocomplete=["']new-password["']/i.test(head) ||
    /(?:create|register)\s+(?:your\s+)?(?:a\s+|an\s+)?(?:new\s+)?account|already have an account|sign\s?up\s+(?:for|to)\b/i.test(
      head,
    );

  // A form posting to an auth route is a gate in any language, whatever the button says.
  // This is what catches a two-step identifier page (Next) and an OTP step (Verify).
  // The negatives apply HERE too. This rule used to run before them, so any form action
  // containing an auth-ish substring won outright - which is how the active-sessions page
  // and the access-tokens page became "login pages" and were dropped from the scan.
  if (authAction && (hasCredentialInput || hasIdentifier) && !operationAction && !isSignup) {
    return true;
  }

  // A credential input with an identifier and no application furniture around it. Covers a
  // login page in a script none of the vocabulary knows.
  if (hasCredentialInput && hasIdentifier && !appChrome && !operationAction && !isSignup) return true;

  // A lone credential input - a PIN pad, an OTP step - on a page that is nothing else.
  if (hasCredentialInput && !operationAction && !appChrome && !isSignup && isTerse) return true;

  // ---- 4. Passwordless gates. --------------------------------------------------------
  const saysSignIn =
    /(?:sign\s?in|log\s?in|log\s?on|sign\s?on|anmelden|connexion|iniciar sesi|entrar)/i.test(head);
  const passwordless =
    /magic link|email me a (?:login )?link|(?:login|sign-?in) link|one-?time (?:code|password|link)|continue with (?:google|github|apple|microsoft|sso)|single sign-?on|\bsso\b/i.test(
      head,
    );
  if (saysSignIn && passwordless && /<form|<input/i.test(head)) {
    // A docs page describing SSO is not a gate.
    if (!/documentation|integration guide|how to|tutorial|\bdocs\b/i.test(head)) return true;
  }

  return false;
}

export function classify(status: number, body: string): Probe {
  return {
    status,
    length: body.length,
    looksLikeLogin: looksLikeLoginPage(body),
    hasContent: hasRealContent(body),
  };
}

/**
 * Did this request actually get the resource?
 *
 * A 200 is not enough on its own: plenty of apps answer 200 and render a login form, and
 * an SPA shell answers 200 for everything. Both are "denied" for our purposes.
 */
export function reachedResource(p: Probe): boolean {
  if (p.status < 200 || p.status >= 300) return false;
  if (p.looksLikeLogin) return false;
  // An un-hydrated SPA shell answers 200 with no content for every URL, authorised or not,
  // so it is evidence of nothing. Treating it as "reached" made every page compare equal
  // for the owner and a stranger and fabricated critical findings. This is the case the
  // docstring above has always claimed to cover.
  return p.hasContent;
}

/** Visible text, tags and scripts removed. Used to tell a real page from an empty shell. */
export function visibleTextLength(body: string): number {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/** Below this, a 200 is a shell or a stub rather than a page someone could read. */
const MIN_CONTENT_CHARS = 40;

/**
 * Is there anything here at all?
 *
 * Visible text alone is the wrong measure: a real admin form - a heading, three inputs and
 * a button - can carry under 40 characters of prose while being exactly the resource this
 * scanner most wants to report as reachable. Interactive controls count as content; an
 * un-hydrated SPA shell has neither text nor controls, which is what distinguishes it.
 */
export function hasRealContent(body: string): boolean {
  if (visibleTextLength(body) >= MIN_CONTENT_CHARS) return true;

  // A JSON API response is content no matter how short. `{"balance":128455.12}` is 22
  // characters and is the single most likely place a real IDOR lives; the text-length rule
  // classified it as an empty shell and dropped the endpoint from the scan entirely.
  const t = body.trim();
  if ((t.startsWith("{") || t.startsWith("[")) && /["']\w+["']\s*:|^\[\s*[{"\d]/.test(t.slice(0, 2000))) {
    return true;
  }

  // Interactive controls count: a real admin form - heading, three inputs, a button - can
  // carry under 40 characters of prose. `<form` is deliberately NOT in this list: an SPA
  // shell routinely ships a static login or search form before hydrating, and counting that
  // as content is how a shell starts comparing equal for every identity.
  return /<(?:input|button|select|textarea|table)\b/i.test(body);
}

/**
 * Compare two successful responses. Near-identical length means the second identity got
 * the same page, not a trimmed "you have no access to this" variant.
 */
export function sameResource(a: Probe, b: Probe): boolean {
  return similarity(a, b) > 0.9;
}

/**
 * How alike two successful responses are, 0 to 1. Returns 0 if either did not reach the
 * resource at all.
 *
 * A single boolean at 0.9 was a false-negative knob with no middle ground: a real IDOR
 * where B reads A's data but sees a different nav, no owner-only banner and no edit
 * controls routinely differs by more than 10%, and every one of those was discarded with
 * no record that a near-miss had even been considered. Exposing the ratio lets the caller
 * report a maybe instead of silently deciding no.
 */
export function similarity(a: Probe, b: Probe): number {
  if (!reachedResource(a) || !reachedResource(b)) return 0;
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 1 : 0;
  return Math.min(a.length, b.length) / Math.max(a.length, b.length);
}

/**
 * Floor for reporting a near-miss.
 *
 * 0.5 was far too low. similarity() is a BYTE-LENGTH RATIO - two unrelated pages of similar
 * size score 1.0 - so on a site with a personalised nav, where the same page differs 0-45%
 * between users, roughly four comparisons in five landed in the band. With 48 templates and
 * two personas that is ~76 unactionable "needs a human" findings per run, which is how the
 * whole Z-class gets ignored, genuine criticals included.
 *
 * 0.8 keeps the case the band exists for - the other user sees the same record minus the
 * owner's edit controls and banner - while excluding pages that merely happen to be a
 * similar size.
 */
export const NEAR_MISS_FLOOR = 0.8;

/** At most this many near-misses per run. Beyond it they are summarised, not enumerated. */
const MAX_NEAR_MISSES = 5;

export async function probe(ctx: APIRequestContext, url: string, timeoutMs: number): Promise<Probe | null> {
  // Through the shared limiter like every other requester; this scan used to go out
  // unspaced and unbudgeted. Deliberately OUTSIDE the try: a PolitenessError means "stop
  // the scan", and swallowing it as an unreachable probe would just spin to the end.
  await polite().gate(url);
  try {
    // No redirect following: a 302 to /login is itself the answer, and following it would
    // turn a clean "denied" into a confusing 200.
    const res = await ctx.get(url, { maxRedirects: 0, timeout: timeoutMs, failOnStatusCode: false });
    // So a run of 429s opens the breaker and the next gate() stops the scan.
    polite().report(url, res.status(), res.headers()["retry-after"] ?? null);
    const body = await res.text().catch(() => "");
    return classify(res.status(), body);
  } catch {
    return null;
  }
}

function readAuthPages(): PageRecord[] {
  const file = resolve(OUT, "pages.auth.jsonl");
  if (!existsSync(file)) return [];
  const out: PageRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as PageRecord);
    } catch {
      /* partial line */
    }
  }
  return out;
}

/** One URL per template - probing 60 samples of the same page shape proves nothing extra. */
function candidates(pages: PageRecord[], cfg: QaConfig): PageRecord[] {
  const byTemplate = new Map<string, PageRecord>();
  for (const p of pages) {
    if (p.ok === false || (p.status ?? 0) >= 400) continue;
    if (!isAllowedUrl(p.url, cfg)) continue;
    // Never issue a request that might change something, even a GET.
    if (isDeniedUrl(p.url, cfg)) continue;
    if (!byTemplate.has(p.template)) byTemplate.set(p.template, p);
  }
  return [...byTemplate.values()];
}

interface StorageState {
  cookies?: { name: string; value: string }[];
}

/**
 * Persona ids whose saved sessions carry an identical session cookie.
 *
 * On a target with one shared demo login, every persona ends up as the same user. Without
 * this check the scan reports "B can reach A's page" for every page on the site - all
 * technically true, all worthless.
 */
export function sharedIdentity(personas: Persona[], cfg?: QaConfig): string[] {
  // Configured collision first, and it is the one that actually catches this: two personas
  // pointed at the same site account get DIFFERENT session cookies, so comparing cookies
  // alone says they are distinct people when they are the same user logged in twice.
  const byUsername = new Map<string, string[]>();
  for (const p of cfg?.personas ?? []) {
    const key = (p.username ?? "").toLowerCase();
    if (!key) continue;
    byUsername.set(key, [...(byUsername.get(key) ?? []), p.id]);
  }
  for (const ids of byUsername.values()) if (ids.length > 1) return ids;

  const byCookie = new Map<string, string[]>();
  for (const p of personas) {
    if (!existsSync(p.statePath)) continue;
    let state: StorageState;
    try {
      state = JSON.parse(readFileSync(p.statePath, "utf8")) as StorageState;
    } catch {
      continue;
    }
    const session = (state.cookies ?? []).find((c) => /session|sid|auth|token/i.test(c.name));
    if (!session) continue;
    const list = byCookie.get(session.value) ?? [];
    list.push(p.id);
    byCookie.set(session.value, list);
  }
  for (const ids of byCookie.values()) if (ids.length > 1) return ids;
  return [];
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const personas = knownPersonas().filter((p) => existsSync(p.statePath));
  const timeoutMs = Math.min(cfg.navTimeoutMs, 30_000);

  // Remove any previous verdict FIRST. Two earlier exit paths do not write a status file,
  // and nothing deleted the old one - so a stale "clean" survived and report.html presented
  // it as the current run. An absent file renders as "no scan", which is honest.
  const pages = readAuthPages();
  if (pages.length === 0) {
    console.error(
      "No output/pages.auth.jsonl. Run an authenticated crawl first:\n" +
        "  npx playwright test --project=setup && npm run crawl:auth",
    );
    process.exit(1);
  }

  // Retire the previous verdict only once this run is certain to produce its own.
  //
  // Deleting it at the top of main() meant a run that could not start - no pages.auth.jsonl,
  // expired session, wrong working directory - ERASED a valid earlier result, and the report
  // then showed "no authorization scan" for a project that had one. That is worse than the
  // stale-verdict bug it replaced: mislabelling a real result is recoverable, destroying the
  // evidence on an operator error is not.
  rmSync(resolve(OUT, "authz-status.json"), { force: true });

  const targets = candidates(pages, cfg);
  console.log(`Cross-user authorization scan`);
  console.log(`  ${targets.length} distinct template(s) from the authenticated crawl`);
  console.log(`  personas with a saved session: ${personas.map((p) => p.id).join(", ") || "none"}\n`);

  // Anonymous is always probed; it is the cheapest and worst failure.
  const anon = await request.newContext({ ignoreHTTPSErrors: false });
  const sessions: { persona: Persona; ctx: APIRequestContext }[] = [];
  for (const p of personas) {
    sessions.push({ persona: p, ctx: await request.newContext({ storageState: p.statePath }) });
  }

  // Two personas that resolve to the SAME account make every user-to-user finding
  // meaningless - of course B can read A's page, B is A. Detect it rather than emitting a
  // page of confident false positives.
  const shared = sharedIdentity(personas, cfg);
  if (shared.length > 1) {
    console.log(
      `  WARNING: ${shared.join(" and ")} share one session identity - they are the same\n` +
        `  account on the target. Skipping the user-to-user comparison; only the\n` +
        `  signed-out check below is meaningful. Give each persona its own account.\n`,
    );
  }
  const compareUsers = shared.length <= 1;

  const findings: AuthzFinding[] = [];
  let n = 0;
  const owner = sessions[0];

  // Suppression must be visible. A template skipped because its baseline was unreachable,
  // or because it was classified as a login page, is a template that was NOT checked - and
  // printing only "no problems found" made those indistinguishable from a clean result.
  const ledger = { compared: 0, baselineUnreachable: 0, classifiedLogin: 0, ownerDenied: 0 };
  // Capped so a personalised-nav site cannot bury the criticals under near-misses.
  let nearMisses = 0;
  let nearMissesSuppressed = 0;

  // A probe that throws returns null and is skipped. Counting those is not bookkeeping:
  // with DNS down, every probe failed and this scan printed "No cross-user access problems
  // found" - a clean bill of health for a scan that never reached the site once.
  let attempted = 0;
  let unreachable = 0;
  // Set when the limiter refuses a request (breaker open or budget spent). Comparing
  // throttled bodies would only produce findings about the throttling.
  let refused: string | null = null;

  try {
    for (const page of targets) {
      const url = page.url;

      // Baseline: can the owning persona reach it at all? If not, nothing below means anything.
      const base = owner ? await probe(owner.ctx, url, timeoutMs) : null;
      const anonProbe = await probe(anon, url, timeoutMs);

      attempted += 2;
      if (base === null) unreachable++;
      if (anonProbe === null) unreachable++;

      const ownerReached = base ? reachedResource(base) : false;

      // Record WHY a template is about to be skipped, so suppression shows up in the
      // summary instead of masquerading as a clean result.
      if (!ownerReached) {
        if (base === null) ledger.baselineUnreachable++;
        else if (base.looksLikeLogin) ledger.classifiedLogin++;
        else ledger.baselineUnreachable++;
      } else {
        ledger.compared++;
      }

      // 1. Signed out, but the page came back anyway.
      if (anonProbe && reachedResource(anonProbe) && ownerReached && sameResource(base!, anonProbe)) {
        // Only interesting if the page looked like it needed auth during the crawl, or it
        // sits behind a path that suggests it should.
        const suspicious = page.authRequired || /account|admin|dashboard|profile|settings|secure|private|billing/i.test(url);
        if (suspicious) {
          findings.push({
            id: `Z-${String(++n).padStart(2, "0")}`,
            url,
            feature: "Protected page reachable while signed out",
            severity: "critical",
            steps: [`GET ${url} with no cookies`, "Compare against the same URL as a signed-in user"],
            expected: "Redirect to sign-in, or 401/403",
            actual: `HTTP ${anonProbe.status}, ${anonProbe.length} bytes - the same page a signed-in user sees`,
            source: "authz",
          });
          continue;
        }
      }

      // 2. A different signed-in persona reached the same resource.
      if (!ownerReached || sessions.length < 2 || !compareUsers) continue;
      for (const other of sessions.slice(1)) {
        const p = await probe(other.ctx, url, timeoutMs);
        // Counted here too. Leaving the cross-user loop out of the tally meant that if every
        // single IDOR probe timed out, failRate stayed at whatever the base/anon pair
        // produced - so the guard against a false clean bill did not fire on the half of
        // the scan that actually finds IDOR.
        attempted++;
        if (!p) {
          unreachable++;
          continue;
        }
        const ratio = similarity(base!, p);
        const pct = Math.round(ratio * 100);

        if (ratio > 0.9) {
          findings.push({
            id: `Z-${String(++n).padStart(2, "0")}`,
            url,
            feature: `${other.persona.id} (${other.persona.role}) can reach ${owner!.persona.id}'s page`,
            severity: "high",
            steps: [
              `Sign in as ${owner!.persona.id} and open ${url}`,
              `Request the same URL with ${other.persona.id}'s session`,
              "Compare the responses",
            ],
            expected: `403, 404, or a page scoped to ${other.persona.id}'s own data`,
            actual: `HTTP ${p.status}, ${p.length} bytes vs ${base!.length} - ${pct}% alike, effectively the same page`,
            source: "authz",
          });
        } else if (ratio >= NEAR_MISS_FLOOR && nearMisses >= MAX_NEAR_MISSES) {
          nearMissesSuppressed++;
        } else if (ratio >= NEAR_MISS_FLOOR) {
          nearMisses++;
          // Reported rather than discarded. A partial match is what a real IDOR looks like
          // when the other user sees the same record without the owner's edit controls or
          // banner - the case the old boolean threw away with no record at all.
          findings.push({
            id: `Z-${String(++n).padStart(2, "0")}`,
            url,
            feature: `Possible cross-user read: ${other.persona.id} got a similar page to ${owner!.persona.id}'s`,
            severity: "medium",
            steps: [
              `Sign in as ${owner!.persona.id} and open ${url}`,
              `Request the same URL with ${other.persona.id}'s session`,
              "Compare the two responses by eye - this one needs a human",
            ],
            expected: `403, 404, or a page containing only ${other.persona.id}'s own data`,
            actual:
              `HTTP ${p.status}, ${p.length} bytes vs ${base!.length} - ${pct}% alike. ` +
              `Not identical, so it may be a correctly scoped page; it may also be the same ` +
              `record without the owner's controls.`,
            source: "authz",
          });
        }
      }
    }
  } catch (err) {
    if (!(err instanceof PolitenessError)) throw err;
    refused = err.message;
  } finally {
    await Promise.allSettled([anon.dispose(), ...sessions.map((s) => s.ctx.dispose())]);
  }

  rmSync(FINDINGS, { force: true });
  for (const f of findings) appendFileSync(FINDINGS, `${JSON.stringify(f)}\n`);

  console.log("=".repeat(60));

  // Refuse to report a clean result from a scan that could not reach the target. Silence
  // must never be mistaken for safety.
  const failRate = attempted === 0 ? 1 : unreachable / attempted;

  // Write the scan's own verdict to disk BEFORE any exit path. An inconclusive run that
  // leaves no trace looks identical to a clean one downstream - report.html had no way to
  // tell them apart, so a report built from a scan that proved nothing read as reassuring.
  writeFileSync(
    resolve(OUT, "authz-status.json"),
    `${JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        templates: targets.length,
        compared: ledger.compared,
        baselineUnreachable: ledger.baselineUnreachable,
        classifiedLogin: ledger.classifiedLogin,
        probesAttempted: attempted,
        probesFailed: unreachable,
        nearMissesSuppressed,
        personas: personas.map((p) => p.id),
        sharedIdentity: shared,
        ...(refused === null ? {} : { refused }),
        verdict:
          refused !== null || ledger.compared === 0 || failRate > 0.25
            ? "inconclusive"
            : findings.length > 0
              ? "findings"
              : "clean",
      },
      null,
      2,
    )}\n`,
  );
  if (refused !== null) {
    console.error(
      `SCAN INCONCLUSIVE - stopped by the politeness limiter.\n  ${refused}\n` +
        `  This is NOT a clean result.`,
    );
    process.exit(2);
  }
  if (failRate > 0.25) {
    console.error(
      `SCAN INCONCLUSIVE - ${unreachable} of ${attempted} requests could not be completed ` +
        `(${Math.round(failRate * 100)}%).\n` +
        `  This is NOT a clean result. The target was unreachable or timing out.\n` +
        `  Fix connectivity and re-run before trusting any authorization conclusion.`,
    );
    process.exit(2);
  }
  if (nearMissesSuppressed > 0) {
    console.log(
      `  note: ${nearMissesSuppressed} further near-miss comparison(s) were not reported. ` +
        `Similarity is a byte-length ratio, so a personalised page can look alike without ` +
        `sharing data - review the ${MAX_NEAR_MISSES} reported first.`,
    );
  }
  if (unreachable > 0) {
    console.log(`  note: ${unreachable} of ${attempted} requests failed and were skipped.`);
  }

  // The ledger goes out before the verdict, because "clean" over 3 compared templates out
  // of 48 is not the same statement as "clean" over 48.
  console.log(
    `templates compared: ${ledger.compared} of ${targets.length}` +
      `   skipped: ${ledger.baselineUnreachable} baseline unreachable, ` +
      `${ledger.classifiedLogin} classified as a login page`,
  );
  if (ledger.compared === 0) {
    console.error(
      `\nSCAN INCONCLUSIVE - not a single template was actually compared.\n` +
        `  Every candidate was unreachable or classified as a login page, so this run\n` +
        `  proves nothing about authorization. Check the session is still valid.`,
    );
    process.exit(2);
  }
  if (ledger.compared < targets.length / 2) {
    console.log(
      `  WARNING: fewer than half the templates were compared. Treat the result below as\n` +
        `  partial, not as a clean bill of health.`,
    );
  }

  if (findings.length === 0) {
    console.log("No cross-user access problems found.");
    if (sessions.length < 2) {
      console.log(
        "\nNote: only one persona has a saved session, so the user-to-user half of this\n" +
          "scan did not run. Add a second persona to qa.config.json to enable it.",
      );
    }
  } else {
    for (const f of findings) console.log(`  [${f.severity}] ${f.feature}\n            ${f.url}`);
  }
  // The findings file is removed and then appended to, so a clean scan leaves no file at
  // all. Claiming to have written one sent anyone looking for it to a path that does not
  // exist, and made an absent file indistinguishable from a scan that never ran. The
  // verdict lives in authz-status.json either way, which is what the report reads.
  console.log(
    findings.length > 0
      ? `\nwrote ${FINDINGS}`
      : `\nno findings, so no ${FINDINGS} - the verdict is in authz-status.json`,
  );

  const blocking = findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
  if (blocking > 0) process.exit(1);
}

if (process.argv[1]?.endsWith("authz-check.ts")) {
  main().catch((err: unknown) => {
    console.error(`Authorization scan failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
