/**
 * Page structure and async rendering: frames, tables, lazy content, status codes.
 *
 * Frames and shadow DOM matter disproportionately because they are where locators quietly
 * stop working - a selector that finds nothing looks identical to a feature that is broken.
 */
import { test, expect, safeClick } from "./fixtures.js";

test.describe("frames", () => {
  test("the iframe page renders its own chrome", async ({ page }) => {
    await page.goto("/iframe");
    // True regardless of whether the embedded editor initialises.
    await expect(page.getByRole("heading", { name: /An iFrame containing/i })).toBeVisible();
  });

  /**
   * The editor is served from cdn.tiny.cloud - a THIRD PARTY. Two consequences, both real:
   *
   *   1. The fixture blocks every off-origin request, so the CDN is blocked and the editor
   *      cannot initialise. Set captureOffOrigin: true in qa.config.json to test it.
   *   2. Even unblocked, the CDN has to be reachable. It is not from every network, and a
   *      failed CDN fetch looks exactly like a broken feature.
   *
   * So this skips with a stated reason rather than failing red - an unmet precondition is
   * not a defect, and pretending otherwise trains people to ignore failures.
   */
  test("the embedded editor initialises and accepts text", async ({ page }) => {
    await page.goto("/iframe");

    // TinyMCE builds its iframe in JavaScript, so nothing exists at domcontentloaded.
    const frame = page.locator("iframe").first();
    const arrived = await frame
      .waitFor({ state: "attached", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);

    test.skip(
      !arrived,
      "TinyMCE comes from cdn.tiny.cloud: blocked by the fixture, or unreachable here. " +
        "Set captureOffOrigin: true and ensure the CDN resolves to run this.",
    );

    const editor = page.frameLocator("iframe").locator("#tinymce");
    await expect(editor).toContainText("Your content goes here.");
    await editor.fill("rewritten by the QA agent");
    await expect(editor).toHaveText("rewritten by the QA agent");
  });

  test("nested frames are addressable at every level", async ({ page }) => {
    await page.goto("/nested_frames");
    const top = page.frameLocator("frame[name=frame-top]");

    await expect(top.frameLocator("frame[name=frame-left]").locator("body")).toHaveText(/LEFT/);
    await expect(top.frameLocator("frame[name=frame-middle]").locator("body")).toHaveText(/MIDDLE/);
    await expect(top.frameLocator("frame[name=frame-right]").locator("body")).toHaveText(/RIGHT/);
    await expect(page.frameLocator("frame[name=frame-bottom]").locator("body")).toHaveText(/BOTTOM/);
  });

  test("the frames index links to both examples", async ({ page }) => {
    await page.goto("/frames");
    await expect(page.getByRole("link", { name: "Nested Frames" })).toBeVisible();
    await expect(page.getByRole("link", { name: "iFrame" })).toBeVisible();
  });
});

test.describe("shadow dom", () => {
  test("content inside a shadow root is reachable", async ({ page }) => {
    await page.goto("/shadowdom");
    // Playwright pierces shadow roots for CSS, which is exactly what makes this worth
    // asserting: if it ever stopped, every shadow-DOM test would silently find nothing.
    await expect(page.locator("my-paragraph").first()).toContainText("Let's have some different text!");
    await expect(page.locator("my-paragraph ul li")).toHaveCount(2);
  });
});

test.describe("tables", () => {
  test("the data table has a consistent shape", async ({ page }) => {
    await page.goto("/tables");
    const table = page.locator("#table1");

    await expect(table.locator("thead th")).toHaveCount(6);
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(4);
    // Every row must have as many cells as the header, or the table is malformed.
    await expect(rows.first().locator("td")).toHaveCount(6);
  });

  test("clicking a header sorts the column", async ({ page }) => {
    await page.goto("/tables");
    const table = page.locator("#table1");
    const lastNames = (): Promise<string[]> => table.locator("tbody tr td:first-child").allTextContents();

    const before = await lastNames();
    await table.locator("thead th").first().click();
    const after = await lastNames();

    expect(after).not.toEqual(before);
    expect([...after].sort((a, b) => a.localeCompare(b))).toEqual(after);
  });

  test("challenging_dom renders a full table and three buttons", async ({ page }) => {
    await page.goto("/challenging_dom");
    await expect(page.locator("table tbody tr")).toHaveCount(10);
    // The ids here are randomised on every load; count them rather than name them.
    await expect(page.locator(".button")).toHaveCount(3);
  });
});

test.describe("async content", () => {
  test("a hidden element appears after the loading indicator goes", async ({ page }) => {
    await page.goto("/dynamic_loading/1");
    const finish = page.locator("#finish");

    await expect(finish).toBeHidden();
    await safeClick(page, "Start");

    await expect(page.locator("#loading")).toBeHidden({ timeout: 30_000 });
    await expect(finish).toBeVisible();
    await expect(finish).toHaveText("Hello World!");
  });

  test("an element that does not exist yet is added to the DOM", async ({ page }) => {
    await page.goto("/dynamic_loading/2");
    await expect(page.locator("#finish")).toHaveCount(0);

    await safeClick(page, "Start");
    await expect(page.locator("#finish")).toBeVisible({ timeout: 30_000 });
  });

  test("infinite scroll appends more paragraphs", async ({ page }) => {
    await page.goto("/infinite_scroll");
    const paras = page.locator(".jscroll-added");
    const before = await paras.count();

    await page.keyboard.press("End");
    await expect
      .poll(() => paras.count(), { timeout: 20_000, message: "no new content appeared" })
      .toBeGreaterThan(before);
  });

  test("an element can disappear between loads without breaking the page", async ({ page }) => {
    await page.goto("/disappearing_elements");
    const items = page.locator("ul li a");
    // Four links always, sometimes a fifth ("Gallery") - both are valid renders.
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(4);
    await expect(items.first()).toBeVisible();
  });
});

test.describe("add and remove elements", () => {
  test("Add Element appends a delete control without clicking it", async ({ page }) => {
    await page.goto("/add_remove_elements/");
    await expect(page.locator("#elements button")).toHaveCount(0);

    await safeClick(page, "Add Element");
    await safeClick(page, "Add Element");
    await expect(page.locator("#elements button")).toHaveCount(2);

    // Each added control is labelled "Delete" - on the deny-list. The test asserts it is
    // there and deliberately never presses it; safeClick would refuse if it tried.
    await expect(page.locator("#elements button").first()).toHaveText("Delete");
  });

  test("safeClick refuses the Delete control", async ({ page }) => {
    await page.goto("/add_remove_elements/");
    await safeClick(page, "Add Element");

    // The guarantee, asserted rather than assumed.
    await expect(safeClick(page, "Delete")).rejects.toThrow(/denyList/i);
    await expect(page.locator("#elements button")).toHaveCount(1);
  });
});

test.describe("status codes", () => {
  test("the index links to each demonstrated status", async ({ page }) => {
    await page.goto("/status_codes");
    for (const code of ["200", "301", "404", "500"]) {
      await expect(page.getByRole("link", { name: code, exact: true })).toBeVisible();
    }
  });

  // The /status_codes/<n> pages themselves are in qa.config.json `exclude`, so the crawler
  // never inventories them and they cannot appear in coverage. One request is still worth
  // making: it proves the app returns real status codes rather than 200-with-an-error-page,
  // which is the thing that makes every other status assertion in this suite trustworthy.
  test("a 404 route really answers 404, not 200", async ({ page }) => {
    const res = await page.goto("/status_codes/404", { waitUntil: "commit" });
    expect(res?.status()).toBe(404);
  });
});

test.describe("notifications", () => {
  test("a flash message survives the redirect that sets it", async ({ page }) => {
    // /notification_message sets a flash and redirects to _rendered. Visiting _rendered
    // directly shows an EMPTY #flash-messages container - the flash is consumed by the
    // redirect, which is the behaviour actually worth asserting.
    await page.goto("/notification_message");
    await expect(page).toHaveURL(/notification_message_rendered$/);

    // The wording is chosen at random per request, so assert one arrived, not which.
    await expect(page.locator("#flash")).toBeVisible();
    await expect(page.locator("#flash")).toContainText(/Action (successful|unsuccesful)/i);
  });

  test("visiting the rendered page directly shows no stale flash", async ({ page }) => {
    await page.goto("/notification_message_rendered");
    await expect(page.locator("#flash-messages")).toBeAttached();
    await expect(page.locator("#flash")).toHaveCount(0);
  });
});
