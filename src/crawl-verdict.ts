/**
 * Did this crawl actually see the site, or did it stall at the front door?
 *
 * Pointing the agent at a login-gated app produced a crawl of exactly ONE page - the login
 * screen - and reported it as "pages crawled: 1" with no other comment. Coverage then
 * computed percentages against that single page, the report rendered them, and nothing
 * anywhere said the run had proved nothing about the site. A number computed from a
 * degenerate inventory is worse than no number, because it looks like a result.
 *
 * This is the same stance authz-check already takes: refuse to report a clean result from
 * a scan that could not reach the target.
 */
import type { PageRecord } from "./crawl.js";

export type CrawlVerdict = "ok" | "login-wall" | "too-few-pages" | "no-links";

export interface CrawlStatus {
  verdict: CrawlVerdict;
  /** One sentence a human can act on. Empty when the verdict is "ok". */
  reason: string;
  pages: number;
  templates: number;
  loginPages: number;
  linksFound: number;
  ranAt: string;
  mode: string;
}

/** Signs that a page IS the sign-in screen rather than content. */
const LOGIN_TITLE = /\b(log\s?in|sign\s?in|signin|authenticate|authentication|sign\s?on)\b/i;

/**
 * Does this record look like the login screen?
 *
 * Deliberately structural rather than keyword-only: a password field is the strongest
 * single signal a page is asking to authenticate, and it does not depend on the site's
 * wording or language.
 */
export function isLoginPage(page: PageRecord): boolean {
  if (page.authRequired) return true;
  const hasPasswordField = page.forms.some((f) =>
    f.fields.some((x) => (x.type ?? "").toLowerCase() === "password"),
  );
  if (hasPasswordField) return true;
  return LOGIN_TITLE.test(page.title ?? "");
}

/**
 * Judge a finished crawl.
 *
 * The thresholds are deliberately generous: this is meant to catch a run that plainly went
 * nowhere, not to second-guess a genuinely small site. A three-page site crawled properly
 * is fine; a forty-page site that returned three login screens is not.
 */
export function judgeCrawl(records: PageRecord[], mode: string): CrawlStatus {
  const live = records.filter((r) => r.ok !== false);
  const templates = new Set(live.map((r) => r.template)).size;
  const loginPages = live.filter(isLoginPage).length;
  const linksFound = live.reduce((n, r) => n + (r.links ?? 0), 0);

  const base = {
    pages: live.length,
    templates,
    loginPages,
    linksFound,
    ranAt: new Date().toISOString(),
    mode,
  };

  // Most of what we saw was the sign-in screen. Checked FIRST: it is the most specific
  // explanation, and it is actionable - configure `login` and crawl in auth mode.
  if (live.length > 0 && loginPages / live.length >= 0.5) {
    // The advice depends on whether a session was in play. Telling someone to "configure
    // login and crawl in auth mode" when they are ALREADY in auth mode is the kind of
    // unhelpful boilerplate that gets warnings ignored.
    const notFound = live.filter((r) => r.status === 404).length;
    const advice =
      mode === "auth"
        ? `A session was in use, so this is not a missing login. ` +
          (notFound > 0
            ? `${notFound} crawled page(s) answered 404 on a direct request, which is the ` +
              `signature of a client-routed app whose host does not serve its routes: those ` +
              `pages exist only after a click, and a crawler that navigates by URL cannot ` +
              `reach them at all. `
            : "") +
          `Treat this target as needing interaction-driven exploration rather than URL crawling.`
        : `Configure the "login" block for this target and crawl in auth mode.`;

    return {
      ...base,
      verdict: "login-wall",
      reason:
        `${loginPages} of ${live.length} crawled page(s) are the sign-in screen. This crawl ` +
        `did not get past authentication, so it says almost nothing about the site. ${advice}`,
    };
  }

  if (live.length <= 2) {
    return {
      ...base,
      verdict: "too-few-pages",
      reason:
        `only ${live.length} page(s) were reachable. Either the site is behind auth, the ` +
        `entry URL is wrong, or links are rendered in a way the crawler did not follow. ` +
        `Any percentage computed from this is meaningless.`,
    };
  }

  // Pages loaded but no outbound links were found anywhere: a client-rendered app whose
  // navigation never materialised, so the crawl saw only whatever was seeded.
  if (linksFound === 0) {
    return {
      ...base,
      verdict: "no-links",
      reason:
        `${live.length} page(s) loaded but no links were discovered on any of them. The ` +
        `crawl could only ever see its seed URLs, so coverage is measured against a ` +
        `fraction of the site.`,
    };
  }

  return { ...base, verdict: "ok", reason: "" };
}
