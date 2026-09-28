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
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
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
}

const LOGIN_MARKERS =
  /(type=["']?password|name=["']?password|sign\s?in|log\s?in|<form[^>]+login|you must login)/i;

export function classify(status: number, body: string): Probe {
  return {
    status,
    length: body.length,
    looksLikeLogin: LOGIN_MARKERS.test(body.slice(0, 40_000)),
  };
}

/**
 * Did this request actually get the resource?
 *
 * A 200 is not enough on its own: plenty of apps answer 200 and render a login form, and
 * an SPA shell answers 200 for everything. Both are "denied" for our purposes.
 */
export function reachedResource(p: Probe): boolean {
  return p.status >= 200 && p.status < 300 && !p.looksLikeLogin;
}

/**
 * Compare two successful responses. Near-identical length means the second identity got
 * the same page, not a trimmed "you have no access to this" variant.
 */
export function sameResource(a: Probe, b: Probe): boolean {
  if (!reachedResource(a) || !reachedResource(b)) return false;
  if (a.length === 0 || b.length === 0) return a.length === b.length;
  const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return ratio > 0.9;
}

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
        if (!p) continue;
        if (sameResource(base!, p)) {
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
            actual: `HTTP ${p.status}, ${p.length} bytes vs ${base!.length} - effectively the same page`,
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
  if (failRate > 0.25) {
    console.error(
      `SCAN INCONCLUSIVE - ${unreachable} of ${attempted} requests could not be completed ` +
        `(${Math.round(failRate * 100)}%).\n` +
        `  This is NOT a clean result. The target was unreachable or timing out.\n` +
        `  Fix connectivity and re-run before trusting any authorization conclusion.`,
    );
    process.exit(2);
  }
  if (unreachable > 0) {
    console.log(`  note: ${unreachable} of ${attempted} requests failed and were skipped.`);
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
