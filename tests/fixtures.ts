/**
 * Shared test fixture.
 *
 * Blocks the same third-party domains the crawler blocks. Without this, page.goto's
 * default waitUntil:"load" waits on tracker requests that may hang or fail to resolve,
 * which shows up as a navigation timeout that has nothing to do with the site under test.
 */
import {
  test as base,
  expect,
  type Page,
  type Locator,
  type Browser,
  type BrowserContext,
  type Response,
} from "@playwright/test";
import { existsSync } from "node:fs";
import { loadConfig, isDenied, isDeniedUrl, isAllowedUrl } from "../src/config.js";
import { personaById, type Persona } from "../src/personas.js";

const cfg = loadConfig();

export const test = base.extend({
  page: async ({ page }, use) => {
    // Block every off-origin request, not just a named list. The target itself answers in
    // well under a second; what makes a page take 30s+ is a third-party subresource whose
    // DNS stalls. Nothing outside allowedOrigins is under test, so none of it is worth
    // waiting for. Set captureOffOrigin to keep third parties if you ever need them.
    if (!cfg.captureOffOrigin) {
      // Predicate, not "**/*": a catch-all ending in continue() proxies every same-origin
      // request through Node. This intercepts only what is actually being blocked.
      await page.route(
        (url) => !isAllowedUrl(url.toString(), cfg),
        (route) => route.abort(),
      );
    } else {
      for (const domain of cfg.blockDomains) {
        await page.route(`**://*.${domain}/**`, (route) => route.abort());
        await page.route(`**://${domain}/**`, (route) => route.abort());
      }
    }
    await page.route(/\.(woff2?|ttf|otf|eot|mp4|webm|mp3|avi|mov)(\?|$)/i, (route) => route.abort());

    // Default every navigation to domcontentloaded. Playwright's default is "load", which
    // waits for every last image and third-party script; on a slow or partly-broken page
    // that reads as a navigation timeout even though the DOM was ready in a second.
    // Assertions (expect...toBeVisible) provide the real waiting, so nothing is lost.
    const goto = page.goto.bind(page);
    page.goto = (url, options) => goto(url, { waitUntil: "domcontentloaded", ...options });

    await use(page);
  },
});

export { expect };

// ------------------------------------------------------------------ multi-user

/**
 * Apply the same routing and navigation defaults the `page` fixture applies.
 *
 * A second persona's page is created by hand rather than by the fixture, so without this
 * it would wait on third-party subresources the first page never sees - and fail in a way
 * that looks like the feature is broken.
 */
async function harden(page: Page): Promise<void> {
  if (!cfg.captureOffOrigin) {
    await page.route(
      (url) => !isAllowedUrl(url.toString(), cfg),
      (route) => route.abort(),
    );
  }
  await page.route(/\.(woff2?|ttf|otf|eot|mp4|webm|mp3|avi|mov)(\?|$)/i, (route) => route.abort());
  const goto = page.goto.bind(page);
  page.goto = (url, options) => goto(url, { waitUntil: "domcontentloaded", ...options });
}

export interface UserSession {
  /** The persona this session belongs to. */
  persona: Persona;
  page: Page;
  context: BrowserContext;
  /** Close early if a test needs to prove a session ends. Otherwise handled for you. */
  close(): Promise<void>;
}

/**
 * Open a browser session for a named persona, using its own saved login.
 *
 * Each persona gets a separate BrowserContext, which is what keeps the two identities
 * genuinely independent: separate cookies, separate storage, separate service workers.
 * Two pages in one context would share a session and silently test nothing.
 */
export async function openAs(browser: Browser, id: string): Promise<UserSession> {
  const persona = personaById(id);
  if (!existsSync(persona.statePath)) {
    throw new Error(
      `Persona "${id}" has no saved session at ${persona.statePath}. ` +
        `Run: npx playwright test --project=setup`,
    );
  }
  const context = await browser.newContext({ storageState: persona.statePath });
  const page = await context.newPage();
  await harden(page);
  return {
    persona,
    page,
    context,
    close: () => context.close(),
  };
}

/**
 * Two personas in one test, torn down together.
 *
 * Use for anything that only exists between people: A shares with B, A invites B, A
 * messages B, an admin suspends a member. The callback gets both sessions live at once, so
 * a test can act as A and assert as B without logging in and out.
 */
export async function withTwoUsers<T>(
  browser: Browser,
  a: string,
  b: string,
  fn: (userA: UserSession, userB: UserSession) => Promise<T>,
): Promise<T> {
  const [userA, userB] = await Promise.all([openAs(browser, a), openAs(browser, b)]);
  try {
    return await fn(userA, userB);
  } finally {
    await Promise.allSettled([userA.close(), userB.close()]);
  }
}

/**
 * Open a session with no cookies at all.
 *
 * The third identity every permission test needs: "and a stranger cannot see it either".
 * Forgetting this is how a resource ends up protected from other users but public to the
 * internet.
 */
export async function openAnonymous(browser: Browser): Promise<UserSession> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await harden(page);
  return {
    persona: { id: "anonymous", role: "signed out", email: "", password: "", statePath: "", createdAt: "" },
    page,
    context,
    close: () => context.close(),
  };
}

/**
 * Click something that submits a form, and resolve once the server has answered.
 *
 * waitForURL is no help here: a rejected login re-renders the same /login URL, so it
 * matches immediately and the assertion that follows races the in-flight navigation.
 * Waiting on the response to the form POST is the signal that actually means "done".
 */
/**
 * Click a control by its accessible name, refusing anything on the deny-list.
 *
 * CLAUDE.md promises destructive controls are never clicked. This is where that promise
 * is executable for generated specs: a spec that names "Delete account" fails loudly at
 * the call instead of quietly performing it.
 *
 * The check runs against the element that the locator ACTUALLY RESOLVED TO, not against
 * the text of the selector. Checking `name.source` meant `safeClick(page, /Dele.e/)`
 * passed the guard and then clicked Delete - and regex locators are exactly what the
 * generated specs use.
 */
async function guardedClick(page: Page, role: "button" | "link", name: string | RegExp): Promise<void> {
  const selectorText = typeof name === "string" ? name : name.source;
  if (isDenied(selectorText, cfg)) {
    throw new Error(
      `Refusing to click "${selectorText}": it matches qa.config.json denyList. ` +
        `Record it as "skipped: destructive" in findings.jsonl instead.`,
    );
  }

  const locator = page.getByRole(role, { name });
  const count = await locator.count();
  if (count === 0) throw new Error(`safeClick: no ${role} matching ${String(name)}`);
  if (count > 1) {
    throw new Error(
      `safeClick: ${count} ${role}s match ${String(name)} - refusing to guess which one. ` +
        `Narrow the locator.`,
    );
  }

  // Everything the element could be called, and where it would take us.
  const candidates = await locator.evaluate((el) => [
    el.getAttribute("aria-label") ?? "",
    el.textContent ?? "",
    el.getAttribute("title") ?? "",
    el.getAttribute("value") ?? "",
    (el as HTMLAnchorElement).href ?? "",
    el.getAttribute("formaction") ?? "",
    el.closest("form")?.getAttribute("action") ?? "",
    // An icon inside <a href="/account/delete"> has no attributes of its own, so without
    // the ancestor anchor every candidate was empty and the guard waved it through.
    (el.closest("a") as HTMLAnchorElement | null)?.href ?? "",
    el.closest("a")?.textContent ?? "",
    // A router link, an inline handler, and a label that activates a control elsewhere:
    // three ways the destructive target sits on none of self, form or anchor. A <label
    // for=x> click activates x per the HTML spec while the label text says "Confirm".
    el.getAttribute("onclick") ?? "",
    el.getAttribute("data-href") ?? "",
    el.getAttribute("data-url") ?? "",
    el.getAttribute("data-action") ?? "",
    el.closest("[role=link]")?.getAttribute("href") ?? "",
    (() => {
      const target = el.getAttribute("for") ?? el.getAttribute("aria-controls");
      if (!target) return "";
      const ctl = document.getElementById(target);
      if (!ctl) return "";
      return [
        ctl.getAttribute("aria-label") ?? "",
        ctl.textContent ?? "",
        ctl.getAttribute("value") ?? "",
        ctl.getAttribute("formaction") ?? "",
      ].join(" ");
    })(),
  ]);

  for (const candidate of candidates) {
    if (!candidate) continue;
    const denied = /^https?:|^\//.test(candidate)
      ? isDeniedUrl(candidate, cfg)
      : isDenied(candidate, cfg);
    if (denied) {
      throw new Error(
        `Refusing to click ${role} ${String(name)}: the resolved element matches ` +
          `qa.config.json denyList via ${JSON.stringify(candidate.slice(0, 120))}. ` +
          `Record it as "skipped: destructive" in findings.jsonl instead.`,
      );
    }
  }

  await locator.click();
}

/** Click a button, refusing anything the deny-list covers. Use this, not `.click()`. */
/**
 * Guarded click for a locator that is not addressable by role and name.
 *
 * A table header, a hot-spot div, a CSS-selected element - `safeClick` cannot express any
 * of them, so every legitimate need became a bare `.click()`, which CLAUDE.md forbids. The
 * absence of this function is why ten violations existed: the rule had no compliant path.
 *
 * The check is the same one `safeClick` applies, and it runs against the element the
 * locator actually resolved to.
 */
export async function safeClickLocator(
  locator: Locator,
  options?: { button?: "left" | "right" | "middle"; label?: string },
): Promise<void> {
  const count = await locator.count();
  if (count === 0) throw new Error(`safeClickLocator: locator matched nothing`);
  if (count > 1) {
    throw new Error(
      `safeClickLocator: ${count} elements match - refusing to guess which one. Narrow the locator.`,
    );
  }

  const candidates = await locator.evaluate((el) => [
    el.getAttribute("aria-label") ?? "",
    el.textContent ?? "",
    el.getAttribute("title") ?? "",
    el.getAttribute("value") ?? "",
    (el as HTMLAnchorElement).href ?? "",
    el.getAttribute("formaction") ?? "",
    el.closest("form")?.getAttribute("action") ?? "",
    // An icon inside <a href="/account/delete"> has no attributes of its own, so without
    // the ancestor anchor every candidate was empty and the guard waved it through.
    (el.closest("a") as HTMLAnchorElement | null)?.href ?? "",
    el.closest("a")?.textContent ?? "",
    // A router link, an inline handler, and a label that activates a control elsewhere:
    // three ways the destructive target sits on none of self, form or anchor. A <label
    // for=x> click activates x per the HTML spec while the label text says "Confirm".
    el.getAttribute("onclick") ?? "",
    el.getAttribute("data-href") ?? "",
    el.getAttribute("data-url") ?? "",
    el.getAttribute("data-action") ?? "",
    el.closest("[role=link]")?.getAttribute("href") ?? "",
    (() => {
      const target = el.getAttribute("for") ?? el.getAttribute("aria-controls");
      if (!target) return "";
      const ctl = document.getElementById(target);
      if (!ctl) return "";
      return [
        ctl.getAttribute("aria-label") ?? "",
        ctl.textContent ?? "",
        ctl.getAttribute("value") ?? "",
        ctl.getAttribute("formaction") ?? "",
      ].join(" ");
    })(),
  ]);

  for (const candidate of [...candidates, options?.label ?? ""]) {
    if (!candidate) continue;
    const denied = /^https?:|^\//.test(candidate)
      ? isDeniedUrl(candidate, cfg)
      : isDenied(candidate, cfg);
    if (denied) {
      throw new Error(
        `Refusing to click: the resolved element matches qa.config.json denyList via ` +
          `${JSON.stringify(candidate.slice(0, 120))}. ` +
          `Record it as "skipped: destructive" in findings.jsonl instead.`,
      );
    }
  }

  await locator.click(options?.button ? { button: options.button } : undefined);
}

/** Guarded right-click. Same checks; a context menu can be as destructive as a button. */
export function safeRightClick(locator: Locator, label?: string): Promise<void> {
  return safeClickLocator(locator, { button: "right", ...(label === undefined ? {} : { label }) });
}

export function safeClick(page: Page, name: string | RegExp): Promise<void> {
  return guardedClick(page, "button", name);
}

/** Click a link, with the same guard. Links were previously unguarded entirely. */
export function safeClickLink(page: Page, name: string | RegExp): Promise<void> {
  return guardedClick(page, "link", name);
}

/**
 * Navigate, refusing destructive URLs and anything off-origin.
 *
 * The wait defaults to `domcontentloaded` rather than Playwright's `load`, to match what
 * the `page` fixture above already does to every page.goto it hands out. Keeping the two
 * in step is the whole value of this default: a spec that reaches for safeGoto should not
 * get a different navigation contract from one that does not.
 *
 * It is NOT what fixed the 90s setup-project timeouts. An earlier version of this comment
 * claimed that, and claimed the cause was `load` hanging on jQuery UI from
 * ajax.googleapis.com. Both are wrong: the fixture had already defaulted goto to
 * domcontentloaded, so the setups were never waiting for `load`, and off-origin requests
 * are aborted outright, so a third party cannot hold a navigation open. Those timeouts
 * remain undiagnosed - they have not recurred across several full runs, which points at
 * transient slowness at the target rather than anything in this file. Said plainly here
 * because a wrong explanation on the shelf is worse than an open question.
 *
 * Nothing is lost by not waiting for `load`: the assertions are what actually waits. A
 * test that genuinely needs the load event can pass `waitUntil` or call waitForLoadState.
 *
 * Pass `waitUntil` to override. The guard applies either way.
 */
export async function safeGoto(
  page: Page,
  url: string,
  options?: { waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle" },
): Promise<void> {
  const absolute = url.startsWith("http") ? url : new URL(url, cfg.baseUrl).toString();
  if (!isAllowedUrl(absolute, cfg)) {
    throw new Error(`Refusing to navigate to ${absolute}: outside allowedOrigins.`);
  }
  if (isDeniedUrl(absolute, cfg)) {
    throw new Error(`Refusing to navigate to ${absolute}: it matches qa.config.json denyList.`);
  }
  // The ABSOLUTE url, which was computed above to run the guard and was then thrown away
  // while the relative one was passed on. That made every safeGoto depend on the context
  // having inherited `baseURL` - true for the fixture's own page, not guaranteed for a
  // context built by hand in openAs/openAnonymous, where a relative goto is an Invalid URL.
  // Navigating the exact string the guard approved also removes any chance of the two
  // disagreeing about where the request is going.
  await page.goto(absolute, { waitUntil: options?.waitUntil ?? "domcontentloaded" });
}

/**
 * safeGoto, but handing back the Response.
 *
 * A test that needs the status code was reaching for a bare page.goto to get it, which
 * walks straight past the guard - the exact hole the guard exists to close. Same checks,
 * same absolute-URL navigation, just without throwing the response away.
 */
export async function safeGotoResponse(
  page: Page,
  url: string,
  options?: { waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle" },
): Promise<Response | null> {
  const absolute = url.startsWith("http") ? url : new URL(url, cfg.baseUrl).toString();
  if (!isAllowedUrl(absolute, cfg)) {
    throw new Error(`Refusing to navigate to ${absolute}: outside allowedOrigins.`);
  }
  if (isDeniedUrl(absolute, cfg)) {
    throw new Error(`Refusing to navigate to ${absolute}: it matches qa.config.json denyList.`);
  }
  return page.goto(absolute, { waitUntil: options?.waitUntil ?? "domcontentloaded" });
}

export async function submitAndWait(
  page: Page,
  click: Promise<void>,
  urlPart: string,
): Promise<void> {
  const response = page.waitForResponse(
    (r) => r.url().includes(urlPart) && r.request().method() === "POST",
  );
  await click;
  await response;
  await page.waitForLoadState("domcontentloaded");
}
