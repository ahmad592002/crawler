/**
 * Index and landing pages: the site root and the three section indexes whose only job is
 * to point at their examples. Feature map: output/features.jsonl
 *
 * These look trivial and are not: an index whose links have rotted is a broken site even
 * when every destination page is perfect, and nothing else in the suite would notice. The
 * link checks go through page.request so one test can verify many destinations without
 * forty navigations.
 */
import { test, expect, safeGoto, safeClickLink } from "./fixtures.js";

/**
 * Fetch each href with the page's own session and return the ones that are actually broken.
 *
 * 401 and 403 are not rot. /basic_auth, /digest_auth and /download_secure all answer 401
 * to an unauthenticated request, which is the correct behaviour and the whole point of
 * those examples - a plain response.ok() check reported three healthy pages as broken
 * links. What this is looking for is 404/410 (gone) and 5xx (there and failing).
 */
async function brokenLinks(
  page: import("@playwright/test").Page,
  hrefs: string[],
): Promise<string[]> {
  const broken: string[] = [];
  for (const href of hrefs) {
    const response = await page.request.get(href, { maxRedirects: 5 });
    const status = response.status();
    if (response.ok() || status === 401 || status === 403) continue;
    broken.push(`${href} -> ${status}`);
  }
  return broken;
}

test.describe("site root", () => {
  test("lists the examples and every link it advertises resolves", async ({ page }) => {
    await safeGoto(page, "/");
    await expect(page.getByRole("heading", { name: "Welcome to the-internet" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Available Examples" })).toBeVisible();

    const hrefs = await page.locator("#content ul li a").evaluateAll((els) =>
      els.map((e) => (e as HTMLAnchorElement).getAttribute("href") ?? "").filter((h) => h.startsWith("/")),
    );
    // The index is the only inventory of this site; if it shrinks, pages have gone missing.
    expect(hrefs.length, "the index listed almost nothing").toBeGreaterThan(35);

    const broken = await brokenLinks(page, hrefs);
    expect(broken, `index links that did not answer 2xx: ${broken.join(", ")}`).toEqual([]);
  });

  test("basic auth is advertised with the credentials it needs", async ({ page }) => {
    // The one index entry that carries information beyond the link, so losing the note
    // would make the example unusable without changing any link.
    await safeGoto(page, "/");
    await expect(page.locator("#content li", { hasText: "Basic Auth" })).toContainText(
      /user and pass: admin/i,
    );
  });
});

test.describe("dynamic loading index", () => {
  test("offers both examples and both answer", async ({ page }) => {
    await safeGoto(page, "/dynamic_loading");
    await expect(page.getByRole("heading", { name: /Dynamically Loaded Page Elements/i })).toBeVisible();

    const links = page.locator("#content a");
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toContainText(/Element on page that is hidden/i);
    await expect(links.nth(1)).toContainText(/Element rendered after the fact/i);

    const broken = await brokenLinks(page, ["/dynamic_loading/1", "/dynamic_loading/2"]);
    expect(broken, broken.join(", ")).toEqual([]);
  });

  test("the first example link actually goes there", async ({ page }) => {
    await safeGoto(page, "/dynamic_loading");
    await safeClickLink(page, /Element on page that is hidden/i);
    await expect(page).toHaveURL(/\/dynamic_loading\/1$/);
    await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  });
});

test.describe("jQuery UI index", () => {
  test("points at the menu example", async ({ page }) => {
    await safeGoto(page, "/jqueryui");
    await expect(page.getByRole("heading", { name: "JQuery UI" })).toBeVisible();

    const menuLink = page.getByRole("link", { name: "Menu", exact: true });
    await expect(menuLink).toBeVisible();
    await expect(menuLink).toHaveAttribute("href", "/jqueryui/menu");

    const broken = await brokenLinks(page, ["/jqueryui/menu"]);
    expect(broken, broken.join(", ")).toEqual([]);
  });
});

test.describe("new window target", () => {
  test("/windows/new is reachable as a direct deep link", async ({ page }) => {
    // The suite already opens this page by clicking through /windows. This covers the other
    // way in: pasted, bookmarked, or arrived at from search, with no opener behind it.
    await safeGoto(page, "/windows/new");
    await expect(page).toHaveTitle("New Window");
    await expect(page.getByRole("heading", { name: "New Window" })).toBeVisible();
  });
});
