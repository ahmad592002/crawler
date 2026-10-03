/**
 * Layout, positioning and widgets that need mouse work: a menu that follows the scroll,
 * content that shifts a few pixels per load, jQuery UI's menu, two modals that trigger on
 * page events rather than on a click, and a geolocation prompt.
 * Feature map: output/features.jsonl
 *
 * Every number asserted here was read off the live DOM, not off the page's own prose - the
 * prose is wrong in at least two places on this target.
 *
 * test.fail() marks a known bug: the assertion states the behaviour we want, so the test
 * flips to passing when the bug is fixed.
 */
import { test, expect, safeGoto, safeClickLocator, openAnonymous } from "./fixtures.js";
import type { Page } from "@playwright/test";

test.describe("floating menu", () => {
  test.beforeEach(async ({ page }) => {
    await safeGoto(page, "/floating_menu");
  });

  test("the menu follows the page down a long scroll", async ({ page }) => {
    const menu = page.locator("#menu");
    await expect(menu.getByRole("link")).toHaveText(["Home", "News", "Contact", "About"]);

    const before = await menu.boundingBox();
    await page.evaluate(() => window.scrollTo(0, 3000));
    await page.waitForTimeout(500);

    const scrolled = await page.evaluate(() => Math.round(window.scrollY));
    expect(scrolled, "the page did not actually scroll, so this proves nothing").toBeGreaterThan(
      1000,
    );

    // The menu is position:absolute and repositioned by script on scroll. What matters is
    // that it tracks the viewport rather than scrolling away with the document: absolute
    // positioning left alone would put it ~3000px above the fold.
    const after = await menu.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(60);
  });

  // The menu settles 5px ABOVE the top of the viewport, so its first row of pixels is
  // clipped on every long page. It tracks the scroll correctly - this is the offset only.
  test.fail("the floating menu is fully inside the viewport", async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, 3000));
    await page.waitForTimeout(500);
    const box = await page.locator("#menu").boundingBox();
    expect(box?.y ?? -1, "clipped at the top edge").toBeGreaterThanOrEqual(0);
  });
});

test.describe("shifting content", () => {
  test("the index links to all three examples", async ({ page }) => {
    await safeGoto(page, "/shifting_content");
    for (const name of [/Menu Element/i, /An image/i, /List/i]) {
      await expect(page.getByRole("link", { name })).toBeVisible();
    }
  });

  test("the menu example shifts between loads", async ({ page }) => {
    const offsets = new Set<string>();
    for (let i = 0; i < 4; i++) {
      await safeGoto(page, "/shifting_content/menu");
      await expect(page.locator("#content li a").first()).toBeVisible();
      offsets.add(await page.locator(".shift").evaluate((e) => getComputedStyle(e).left));
    }
    expect(offsets.size, "a page whose purpose is to shift never shifted").toBeGreaterThan(1);
  });

  test("pixel_shift bounds the offset it is given", async ({ page }) => {
    // Measured, not assumed: the default draws from {0, -25} and ?pixel_shift=100 draws
    // from {0, -100}. So the parameter is an upper bound on the magnitude, and a shift
    // larger than the one asked for is the bug this guards.
    const seen = new Set<number>();
    for (let i = 0; i < 4; i++) {
      await safeGoto(page, "/shifting_content/image?pixel_shift=100");
      const left = await page
        .locator(".shift")
        .evaluate((e) => parseInt(getComputedStyle(e).left, 10));
      expect(Math.abs(left)).toBeLessThanOrEqual(100);
      seen.add(Math.abs(left));
    }
    expect(seen.size, "?pixel_shift=100 produced a single fixed offset").toBeGreaterThan(1);
  });

  test("image_type=simple serves a different image", async ({ page }) => {
    await safeGoto(page, "/shifting_content/image");
    const standard = await page.locator("#content img").first().getAttribute("src");

    await safeGoto(page, "/shifting_content/image?image_type=simple");
    const simple = await page.locator("#content img").first().getAttribute("src");

    expect(simple).not.toBe(standard);
    await expect(page.locator("#content img").first()).toBeVisible();
  });

  test("the list keeps its one static record while the rest churn", async ({ page }) => {
    for (let i = 0; i < 4; i++) {
      await safeGoto(page, "/shifting_content/list");
      // The whole point of the example: one findable row inside moving noise.
      await expect(page.getByText(/Important Information You.{0,3}re Looking For/)).toBeVisible();
    }
  });
});

test.describe("jQuery UI menu", () => {
  test.beforeEach(async ({ page }) => {
    await safeGoto(page, "/jqueryui/menu");
  });

  /**
   * True once jQuery UI has actually upgraded #menu into a menu widget.
   *
   * This page serves jQuery and jQuery UI from its OWN origin
   * (/js/vendor/jquery-1.11.3.min.js and /js/vendor/jquery-ui-1.11.4/jquery-ui.js). The
   * ajax.googleapis.com tags further down are duplicates inside an embedded fragment, and
   * the fixture aborts them, so no third party is involved in the widget working. An
   * earlier version of this block blamed that CDN and skipped the test when the widget was
   * missing - a skip that could never fire for the stated reason, and that would have
   * hidden a genuine hover defect if it ever did.
   *
   * The readiness wait is kept, because the upgrade is still asynchronous, but a failure to
   * upgrade is now a failure of the page rather than an excuse to skip.
   *
   * On timeout it reports WHICH precondition failed. A bare waitForFunction cannot tell
   * "jQuery UI never arrived" from "the widget did not initialise", and those are different
   * problems: the first is the page failing to serve its own scripts - which is what happens
   * when the target is overloaded, and it took a spread of twenty unrelated red tests before
   * that was obvious - while the second is the defect this block exists to catch. A red
   * suite has to be diagnosable from one line of output.
   */
  const widgetReady = async (page: Page): Promise<void> => {
    const upgraded = () =>
      page.evaluate(() => {
        const jq = (window as unknown as { jQuery?: { fn?: { menu?: unknown; jquery?: string } } })
          .jQuery;
        return {
          jQuery: typeof jq !== "undefined",
          jQueryUi: typeof jq?.fn?.menu === "function",
          menuPresent: document.querySelector("#menu") !== null,
          widget: document.querySelector("#menu")?.classList.contains("ui-menu") === true,
        };
      });

    try {
      // 45s, and measured rather than guessed: jquery-ui.js on this target is 470KB - the
      // largest asset on the site - and a preflight check timed it at 26,849ms immediately
      // after a suite run. A 30s budget sat right on that edge, which is why this test
      // failed intermittently while the page was working.
      await expect.poll(async () => (await upgraded()).widget, { timeout: 45_000 }).toBe(true);
    } catch {
      const s = await upgraded();
      if (!s.jQuery || !s.jQueryUi) {
        throw new Error(
          `/jqueryui/menu did not serve its own scripts: jQuery ${s.jQuery ? "loaded" : "MISSING"}, ` +
            `jQuery UI ${s.jQueryUi ? "loaded" : "MISSING"}. Both are same-origin on this page ` +
            `(/js/vendor/...), so this is the target failing to respond, not a widget defect - ` +
            `check whether the site is up and not being hammered by a parallel run.`,
        );
      }
      throw new Error(
        `jQuery UI loaded but #menu was never upgraded into a widget ` +
          `(#menu ${s.menuPresent ? "exists" : "is MISSING"}, no ui-menu class). ` +
          `That is a defect in the page's own initialisation.`,
      );
    }
  };

  test("the menu is upgraded into a widget, with Disabled actually disabled", async ({ page }) => {
    // ui-state-disabled is SERVER-RENDERED in the static markup, so asserting it alone
    // proves nothing about jQuery UI and would pass with every script blocked. The widget
    // wait is what makes this a test of the upgrade; the classes are then checked on top.
    await widgetReady(page);

    const items = page.locator("#menu > li");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveClass(/ui-state-disabled/);
    await expect(items.nth(0)).toContainText("Disabled");
    await expect(items.nth(1)).not.toHaveClass(/ui-state-disabled/);
    await expect(items.nth(1)).toContainText("Enabled");

    // The part only the widget can produce: it owns the menu role and its items.
    await expect(page.locator("#menu")).toHaveAttribute("role", "menu");
  });

  test("hovering Enabled opens its submenu and leaving closes it", async ({ page }) => {
    await widgetReady(page);

    const submenu = page.locator("#menu > li").nth(1).locator("ul").first();
    await expect(submenu).toBeHidden();

    await page.getByRole("link", { name: "Enabled", exact: true }).hover();
    await expect(submenu).toBeVisible();

    // Synchronising on hover-out is the actual automation challenge this page exists for.
    // Moving the pointer to a dead corner is more reliable than hovering some other
    // element, which can itself be covered by the open submenu.
    await page.mouse.move(5, 5);
    await expect(submenu).toBeHidden();
  });
});

test.describe("entry ad", () => {
  test("the ad appears on load and stays away once dismissed", async ({ page }) => {
    await safeGoto(page, "/entry_ad");
    const modal = page.locator("#modal");

    // Shown by script a moment after load, so this must be awaited, not read.
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal.locator(".modal-title h3")).toHaveText("This is a modal window");

    // Hiding the modal is local, but REMEMBERING the dismissal is a POST to /entry_ad from
    // the page's dismissedAd() handler. Navigating the moment the modal disappears cancels
    // that POST, the server never records it, and the ad returns on the next load - which
    // is how this test failed before the wait below existed. Worth noting as a real race:
    // a user who closes the ad and immediately clicks a link will see it again.
    const dismissRecorded = page.waitForResponse(
      (r) => r.url().includes("/entry_ad") && r.request().method() === "POST",
    );

    // The dismiss control is a <p>, not a button or a link, so it needs the locator form
    // of the guard. "Close" here closes a modal - it is not "close account".
    await safeClickLocator(modal.locator(".modal-footer p"), { label: "Close (modal)" });
    await expect(modal).toBeHidden();
    await dismissRecorded;

    // Only now is the suppression durable for the rest of the session.
    await safeGoto(page, "/entry_ad");

    // A bare waitForTimeout + toBeHidden was a negative assertion racing a timer: the page
    // calls setTimeout(showAd, 500), so on a slow box the wait could elapse before the ad
    // would have appeared and the test would pass for the wrong reason, hiding a
    // regression in the dismissal. showAd() also hides #page-footer, so waiting for the
    // footer to be VISIBLE is a positive signal that the show path ran and declined.
    await expect(page.locator("#page-footer")).toBeVisible();
    await page.waitForTimeout(2000);
    await expect(modal).toBeHidden();
  });

  test("a fresh session sees the ad again", async ({ browser }) => {
    // Proves the suppression above is per-session state, not a permanent server flag -
    // otherwise the first test would quietly disable the feature for every later run.
    //
    // openAnonymous rather than browser.newContext() by hand: it applies harden(), which is
    // what aborts off-origin requests and sets the navigation default. Building the context
    // inline skipped that, making this the one page in the suite that really did contact
    // third parties - the exact thing the fixture exists to prevent.
    const guest = await openAnonymous(browser);
    try {
      await safeGoto(guest.page, "/entry_ad");
      await expect(guest.page.locator("#modal")).toBeVisible({ timeout: 10_000 });
    } finally {
      await guest.close();
    }
  });
});

test.describe("exit intent", () => {
  test("moving the pointer out of the top of the viewport opens the modal", async ({ page }) => {
    await safeGoto(page, "/exit_intent");
    const modal = page.locator("#ouibounce-modal");
    await expect(modal).toBeHidden();

    // Read out of the vendored js/vendor/ouibounce.min.js rather than guessed: the handler
    // is attached to document.documentElement by a setTimeout(.., timer) with timer=1000,
    // and it only fires when the event's clientY is at or under sensitivity=20. Dispatching
    // immediately after load - the first version of this test - hits nothing, because
    // nothing is listening yet.
    await page.waitForLoadState("load");
    await page.waitForTimeout(1500);

    await page.mouse.move(400, 300);
    for (let y = 300; y >= 0; y -= 20) await page.mouse.move(400, y);
    await page.evaluate(() =>
      document.documentElement.dispatchEvent(
        new MouseEvent("mouseleave", { clientY: 0, bubbles: true }),
      ),
    );

    await expect(modal).toBeVisible({ timeout: 10_000 });
    await expect(modal.locator(".modal-title h3")).toHaveText("This is a modal window");

    await safeClickLocator(modal.locator(".modal-footer p"), { label: "Close (modal)" });
    await expect(modal).toBeHidden();
  });
});

test.describe("geolocation", () => {
  // Granted at the context level; without the permission the page's callback never fires
  // and the test would time out on a feature that is working.
  test.use({
    geolocation: { latitude: 51.5074, longitude: -0.1278 },
    permissions: ["geolocation"],
  });

  test("the button reports the coordinates the browser hands it", async ({ page }) => {
    await safeGoto(page, "/geolocation");
    await expect(page.locator("#demo")).toContainText(/Click the button/i);

    await safeClickLocator(page.getByRole("button", { name: /Where am I/i }), {
      label: "Where am I?",
    });

    await expect(page.locator("#lat-value")).toHaveText("51.5074");
    await expect(page.locator("#long-value")).toHaveText("-0.1278");
    await expect(page.locator("#map-link a")).toBeVisible();
  });
});
