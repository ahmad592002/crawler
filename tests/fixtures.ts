/**
 * Shared test fixture.
 *
 * Blocks the same third-party domains the crawler blocks. Without this, page.goto's
 * default waitUntil:"load" waits on tracker requests that may hang or fail to resolve,
 * which shows up as a navigation timeout that has nothing to do with the site under test.
 */
import { test as base, expect, type Page } from "@playwright/test";
import { loadConfig, isDenied, isDeniedUrl, isAllowedUrl } from "../src/config.js";

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
export function safeClick(page: Page, name: string | RegExp): Promise<void> {
  return guardedClick(page, "button", name);
}

/** Click a link, with the same guard. Links were previously unguarded entirely. */
export function safeClickLink(page: Page, name: string | RegExp): Promise<void> {
  return guardedClick(page, "link", name);
}

/** Navigate, refusing destructive URLs and anything off-origin. */
export async function safeGoto(page: Page, url: string): Promise<void> {
  const absolute = url.startsWith("http") ? url : new URL(url, cfg.baseUrl).toString();
  if (!isAllowedUrl(absolute, cfg)) {
    throw new Error(`Refusing to navigate to ${absolute}: outside allowedOrigins.`);
  }
  if (isDeniedUrl(absolute, cfg)) {
    throw new Error(`Refusing to navigate to ${absolute}: it matches qa.config.json denyList.`);
  }
  await page.goto(url);
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
