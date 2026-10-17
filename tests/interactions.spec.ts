/**
 * Direct-manipulation behaviour: hover, drag, slider, dialogs, new windows.
 *
 * These are the interactions a crawler can inventory but never verify - it records that a
 * control exists, not that operating it does anything.
 *
 * Dialogs: Playwright auto-dismisses by default, which would make an assertion about a
 * dialog silently vacuous. Every dialog test below installs an explicit handler and
 * asserts on what it captured.
 */
import {
  test,
  expect,
  safeClick,
  safeClickLink,
  safeRightClick,
  safeGoto,
  guardNavigation,
} from "./fixtures.js";

/** True when the fixture's navigation guard would refuse this URL. */
function navigationRefused(url: string): boolean {
  try {
    guardNavigation(url);
    return false;
  } catch {
    return true;
  }
}

test.describe("hovers", () => {
  test("hovering a figure reveals its caption and profile link", async ({ page }) => {
    await page.goto("/hovers");
    const figure = page.locator(".figure").first();
    const caption = figure.locator(".figcaption");

    await expect(caption).toBeHidden();
    await figure.hover();
    await expect(caption).toBeVisible();
    await expect(caption.getByRole("link", { name: /View profile/i })).toBeVisible();
  });

  test("each figure reveals its own caption, not a shared one", async ({ page }) => {
    await page.goto("/hovers");
    const figures = page.locator(".figure");
    await expect(figures).toHaveCount(3);

    await figures.nth(1).hover();
    await expect(figures.nth(1).locator(".figcaption")).toBeVisible();
    await expect(figures.nth(0).locator(".figcaption")).toBeHidden();
  });
});

test.describe("drag and drop", () => {
  test("dragging A onto B swaps the two columns", async ({ page }) => {
    // "drop" is one of isDeniedUrl's built-in destructive route verbs, so the crawler
    // already withholds this page and the guarded goto refuses it. A bare goto used to walk
    // past that. Skipped as destructive (CLAUDE.md) until someone reviews the page and adds
    // a denyUrlExceptions entry for it - at which point this runs again on its own.
    test.skip(navigationRefused("/drag_and_drop"), "skipped: destructive - /drag_and_drop matches the deny rules");
    await safeGoto(page, "/drag_and_drop");
    const a = page.locator("#column-a");
    const b = page.locator("#column-b");

    await expect(a.locator("header")).toHaveText("A");
    await expect(b.locator("header")).toHaveText("B");

    await a.dragTo(b);

    // HTML5 drag and drop is notoriously flaky to automate; assert the outcome rather
    // than the mechanism, and accept either order as long as they actually swapped.
    const headers = await page.locator("#columns header").allTextContents();
    expect(headers.join("")).toBe("BA");
  });
});

test.describe("horizontal slider", () => {
  test("keyboard arrows move the slider and update the readout", async ({ page }) => {
    await page.goto("/horizontal_slider");
    const slider = page.getByRole("slider");
    const range = page.locator("#range");

    await expect(range).toHaveText("0");
    await slider.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");

    // The readout must track the control, not merely change.
    await expect(range).toHaveText("2");
    await expect(slider).toHaveValue("2");
  });

  test("the slider respects its declared bounds", async ({ page }) => {
    await page.goto("/horizontal_slider");
    const slider = page.getByRole("slider");

    await expect(slider).toHaveAttribute("min", "0.0");
    await expect(slider).toHaveAttribute("max", "5.0");

    await slider.focus();
    for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
    await expect(page.locator("#range")).toHaveText("5");
  });
});

test.describe("javascript dialogs", () => {
  test("an alert reports its message and can be accepted", async ({ page }) => {
    await page.goto("/javascript_alerts");

    let seen = "";
    page.once("dialog", (d) => {
      seen = `${d.type()}:${d.message()}`;
      void d.accept();
    });

    await safeClick(page, "Click for JS Alert");
    await expect(page.locator("#result")).toHaveText("You successfully clicked an alert");
    expect(seen).toBe("alert:I am a JS Alert");
  });

  test("dismissing a confirm is reported differently from accepting it", async ({ page }) => {
    await page.goto("/javascript_alerts");

    page.once("dialog", (d) => void d.dismiss());
    await safeClick(page, "Click for JS Confirm");
    await expect(page.locator("#result")).toHaveText("You clicked: Cancel");

    page.once("dialog", (d) => void d.accept());
    await safeClick(page, "Click for JS Confirm");
    await expect(page.locator("#result")).toHaveText("You clicked: Ok");
  });

  test("text typed into a prompt comes back", async ({ page }) => {
    await page.goto("/javascript_alerts");

    page.once("dialog", (d) => void d.accept("qa-agent"));
    await safeClick(page, "Click for JS Prompt");

    await expect(page.locator("#result")).toHaveText("You entered: qa-agent");
  });
});

test.describe("new windows", () => {
  test("the link opens a second page and the original survives", async ({ page, context }) => {
    await page.goto("/windows");

    const opened = context.waitForEvent("page");
    await safeClickLink(page, "Click Here");
    const child = await opened;

    await child.waitForLoadState("domcontentloaded");
    await expect(child).toHaveURL(/\/windows\/new$/);
    await expect(child.getByText("New Window")).toBeVisible();

    // The opener must still be usable - a popup that navigates the parent is a bug.
    await expect(page).toHaveURL(/\/windows$/);
    await child.close();
  });
});

test.describe("context menu", () => {
  test("right-clicking the hot spot raises a dialog", async ({ page }) => {
    await page.goto("/context_menu");

    let message = "";
    page.once("dialog", (d) => {
      message = d.message();
      void d.accept();
    });

    await safeRightClick(page.locator("#hot-spot"), "context menu hot spot");
    expect(message).toBe("You selected a context menu");
  });
});
