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
import { loadConfig, isAllowedUrl, isDeniedUrl, ROOT, type QaConfig } from "./config.js";
import { knownPersonas, type Persona } from "./personas.js";
import type { PageRecord } from "./crawl.js";

const OUT = resolve(ROOT, "output");
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
 * Replacement for looksLikeLoginPage.
 *
 * The bug that has now shipped twice: negative signals ("this looks like a settings page")
 * were evaluated BEFORE the positive test, and returned false unconditionally. Since a real
 * consumer login page almost always carries a sign-up link, and an enterprise one often
 * sits in a layout with a logout link, one negative match disarmed the whole classifier -
 * and a missed login page is not a harmless miss: the owner's expired session then compares
 * equal to an anonymous request on every URL, which FABRICATES critical findings.
 *
 * The order is therefore: interstitial, then the positive form test, and only then the
 * negative signals - which now only run when the positive test did NOT fire, to separate a
 * settings page (has a password field, is not a gate) from a login page.
 */
export function looksLikeLoginPage(body: string): boolean {
  const head = body.slice(0, 60_000);

  // ---- 1. An explicit "you are not allowed in" interstitial. -------------------------
  if (/you must (?:log\s?in|sign\s?in|be (?:logged|signed) in)/i.test(head)) return true;
  if (/(?:please\s+)?(?:log\s?in|sign\s?in) to (?:view|continue|access)/i.test(head)) return true;
  if (/your session has (?:expired|timed out)|session expired/i.test(head)) return true;

  const hasPasswordInput = /<input[^>]+type=["']?password/i.test(head);
  const hasIdentifier =
    /<input[^>]+(?:name|id)=["']?(?:j_)?(?:user(?:name|id)?|email|e?mail|login|account|benutzer|utilisateur|usuario|correo)/i.test(
      head,
    );
  const saysSignIn =
    /(?:sign\s?in|log\s?in|log\s?on|sign\s?on|anmelden|connexion|iniciar sesi)/i.test(head);

  // ---- 2. Is this page a GATE, or a page that merely contains a password field? ------
  // The distinguishing question is what the form is FOR, so look at the submit control and
  // the surrounding wording rather than at unrelated page furniture.
  const submitSaysSignIn =
    /<(?:button|input)[^>]*(?:value=["'][^"']*(?:sign\s?in|log\s?in|anmelden|connexion)|>\s*(?:sign\s?in|log\s?in|log\s?on|anmelden|connexion))/i.test(
      head,
    );
  const formActionIsAuth =
    /<form[^>]+action=["'][^"']*(?:login|signin|sign-in|authenticate|session|auth|sso)\b/i.test(head);

  // Wording that only appears when the page's JOB is something else. Deliberately narrow:
  // "sign up" and "new user" are NOT here, because a login page links to both.
  const isChangePassword = /current password|old password|confirm new password|change (?:your )?password/i.test(head);
  const isSettingsPage = /account settings|profile settings|notification settings|billing settings/i.test(head);
  const isAdminCreate = /\b(?:new|create|add|edit)\s+(?:user|member|admin)\b|name=["']?role["']?/i.test(head);
  const isSignupPage =
    /(?:create|register)\s+(?:your\s+)?(?:a\s+|an\s+)?(?:new\s+)?account|already have an account|confirm password/i.test(
      head,
    );

  // ---- 3. Positive: a credential form whose purpose is authentication. ---------------
  if (hasPasswordInput && (submitSaysSignIn || formActionIsAuth)) return true;

  // Password + identifier + sign-in wording, PROVIDED the page is not plainly something
  // else. A change-password form and an admin create-user form both match the first three.
  if (hasPasswordInput && hasIdentifier && saysSignIn) {
    if (isChangePassword || isSettingsPage || isAdminCreate || isSignupPage) return false;
    return true;
  }

  // ---- 4. Passwordless gates: magic link, SSO only. ----------------------------------
  const passwordless =
    /magic link|email me a (?:login )?link|(?:login|sign-?in) link|one-?time (?:code|password|link)|continue with (?:google|github|apple|microsoft|sso)|single sign-?on|\bsso\b/i.test(
      head,
    );
  if (saysSignIn && passwordless) {
    // A docs or integrations page describing SSO is not a gate. A gate has a form.
    const hasForm = /<form|<input/i.test(head);
    const isDocs = /documentation|integration|how to|guide|tutorial|\bdocs\b/i.test(head);
    if (hasForm && !isDocs) return true;
  }

  // ---- 5. A bare password prompt (PIN / lock screen) on a small page. ----------------
  // Requires sign-in wording too: a small internal page with a webhook-secret field is a
  // resource, and suppressing it hides real findings.
  if (hasPasswordInput && !hasIdentifier && saysSignIn && head.length < 8_000) {
    if (isChangePassword || isSettingsPage || isAdminCreate) return false;
    return true;
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
  return /<(?:input|button|select|textarea|table|form)\b/i.test(body);
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

async function probe(ctx: APIRequestContext, url: string, timeoutMs: number): Promise<Probe | null> {
  try {
    // No redirect following: a 302 to /login is itself the answer, and following it would
    // turn a clean "denied" into a confusing 200.
    const res = await ctx.get(url, { maxRedirects: 0, timeout: timeoutMs, failOnStatusCode: false });
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
  rmSync(resolve(OUT, "authz-status.json"), { force: true });

  const pages = readAuthPages();
  if (pages.length === 0) {
    console.error(
      "No output/pages.auth.jsonl. Run an authenticated crawl first:\n" +
        "  npx playwright test --project=setup && npm run crawl:auth",
    );
    process.exit(1);
  }

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
        verdict:
          ledger.compared === 0 || failRate > 0.25
            ? "inconclusive"
            : findings.length > 0
              ? "findings"
              : "clean",
      },
      null,
      2,
    )}\n`,
  );
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
  console.log(`\nwrote ${FINDINGS}`);

  const blocking = findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
  if (blocking > 0) process.exit(1);
}

if (process.argv[1]?.endsWith("authz-check.ts")) {
  main().catch((err: unknown) => {
    console.error(`Authorization scan failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
