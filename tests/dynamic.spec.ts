/**
 * Content that changes under the test: A/B variants, per-refresh content, elements that
 * appear after the fact, pagination that never ends, and two pages that exist to be slow
 * or large. Feature map: output/features.jsonl
 *
 * These are the pages a crawler sees once and a suite has to see twice - the assertions
 * below deliberately re-load and compare, because "it rendered" is not the property under
 * test on any of them.
 *
 * test.fail() marks a known bug: the assertion states the behaviour we want, so the test
 * flips to passing when the bug is fixed.
 */
import { test, expect, safeGoto, safeClick, safeClickLink } from "./fixtures.js";

test.describe("A/B test", () => {
  test("the opt-out cookie pins the variant across reloads", async ({ page, context }) => {
    await safeGoto(page, "/abtest");
    const heading = page.locator("#content h3");
    await expect(heading).toHaveText(/A\/B Test/);

    // optimizelyOptOut is how the site pins "No A/B Test"; without it the heading is
    // one of two values and any assertion on it is a coin flip.
    await context.addCookies([
      { name: "optimizelyOptOut", value: "true", domain: "the-internet.herokuapp.com", path: "/" },
    ]);
    await safeGoto(page, "/abtest");
    await expect(heading).toHaveText("No A/B Test");
  });
});

test.describe("dynamic content", () => {
  // The page ships TWO elements with id="content", one nested in the other, and the
  // inner wrapper also carries .large-10.columns - so an unscoped selector matches four
  // elements and reports row 1 twice. :not(.large-centered) picks the three text cells.
  test("the body text changes between loads", async ({ page }) => {
    const read = async (): Promise<string[]> => {
      await safeGoto(page, "/dynamic_content");
      return page.locator("#content .row .large-10.columns:not(.large-centered)").allInnerTexts();
    };

    // Three rows, each independently randomised. Comparing the whole set over several
    // loads keeps this from flaking when one row happens to repeat.
    const a = await read();
    expect(a.length).toBeGreaterThan(0);

    let changed = false;
    for (let i = 0; i < 4 && !changed; i++) {
      const b = await read();
      if (b.join("|") !== a.join("|")) changed = true;
    }
    expect(changed, "content advertised as changing on every refresh never changed").toBe(true);
  });

  test("?with_content=static pins the first two rows and leaves the third random", async ({
    page,
  }) => {
    const rows = async (): Promise<string[]> => {
      await safeGoto(page, "/dynamic_content?with_content=static");
      return page.locator("#content .row .large-10.columns:not(.large-centered)").allInnerTexts();
    };

    const first = await rows();
    expect(first.length).toBe(3);

    // "some of the content static" is rows 1 and 2 - NOT the last one, which was the
    // assumption this test was first written on. Pinning the wrong row made it fail
    // against a perfectly healthy page.
    let thirdChanged = false;
    for (let i = 0; i < 4; i++) {
      const next = await rows();
      expect(next[0], "row 1 is pinned by ?with_content=static").toBe(first[0]);
      expect(next[1], "row 2 is pinned by ?with_content=static").toBe(first[1]);
      if (next[2] !== first[2]) thirdChanged = true;
    }
    expect(thirdChanged, "row 3 is not covered by the flag and should still vary").toBe(true);
  });
});

test.describe("dynamic loading", () => {
  test("example 1 reveals an element that was already in the DOM", async ({ page }) => {
    await safeGoto(page, "/dynamic_loading/1");
    const finish = page.locator("#finish");

    await expect(finish).toBeHidden();
    await safeClick(page, "Start");
    await expect(page.locator("#loading")).toBeVisible();
    await expect(finish).toHaveText("Hello World!", { timeout: 15_000 });
    await expect(page.locator("#loading")).toBeHidden();
  });

  test("example 2 adds an element that was not there", async ({ page }) => {
    await safeGoto(page, "/dynamic_loading/2");
    const finish = page.locator("#finish");

    await expect(finish).toHaveCount(0);
    await safeClick(page, "Start");
    await expect(finish).toHaveText("Hello World!", { timeout: 15_000 });
  });
});

test.describe("infinite scroll", () => {
  test("scrolling appends paragraphs rather than paginating", async ({ page }) => {
    await safeGoto(page, "/infinite_scroll");
    const paragraphs = page.locator(".jscroll-added, #content p");
    const before = await paragraphs.count();

    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("End");
      await page.waitForTimeout(600);
    }

    expect(await paragraphs.count(), "scrolling to the end loaded nothing").toBeGreaterThan(before);
    expect(page.url(), "an infinite scroll must not navigate").toContain("/infinite_scroll");
  });

  test("the numbered pages are reachable without scrolling", async ({ page }) => {
    // /infinite_scroll/:id is the template the crawler sees; it has to answer directly or
    // the content is unreachable to anything that does not run JavaScript.
    await safeGoto(page, "/infinite_scroll/1");
    await expect(page.locator("body")).not.toBeEmpty();
  });
});

test.describe("slow and large pages", () => {
  test("/slow answers within the timeout", async ({ page }) => {
    const started = Date.now();
    const response = await page.goto("/slow");
    expect(response?.status()).toBe(200);
    // Not a performance budget - a regression guard. The page is deliberately slow; what
    // would be a bug is it becoming unbounded.
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  test("/large renders its whole table", async ({ page }) => {
    await safeGoto(page, "/large");
    // 1 header row of <th> plus 50 data rows of 50 <td>, read off the live DOM. Counting
    // "<tr" in the served HTML gave 50 and was wrong; the parser is the authority here.
    await expect(page.locator("#large-table tr")).toHaveCount(51);
    await expect(page.locator("#large-table tr").first().locator("th")).toHaveCount(50);
    await expect(page.locator("#large-table tr").last().locator("td")).toHaveCount(50);
    await expect(page.locator("#large-table tr").last()).toContainText("50.1");
  });
});

test.describe("pages that are broken on purpose", () => {
  // These two pages exist to carry a defect. The assertion states the healthy behaviour,
  // so each one flips green if the target is ever fixed - which is the point of test.fail.
  test.fail("/javascript_error loads without throwing", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await safeGoto(page, "/javascript_error");
    await page.waitForLoadState("load");
    expect(errors, `onload threw: ${errors.join("; ")}`).toEqual([]);
  });

  test.fail("/tinymce initialises its editor", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await safeGoto(page, "/tinymce");
    await page.waitForLoadState("load");
    expect(errors, `editor bootstrap threw: ${errors.join("; ")}`).toEqual([]);
  });

  test("/tinymce still serves the textarea the editor is meant to replace", async ({ page }) => {
    // The progressive-enhancement floor: even with the editor failing, the content is
    // editable. This one passes today and is the regression guard around the bug above.
    await safeGoto(page, "/tinymce");
    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible();
    await textarea.fill("typed into the fallback");
    await expect(textarea).toHaveValue("typed into the fallback");
  });
});

test.describe("new window", () => {
  test("the link opens a second page and the opener survives", async ({ page, context }) => {
    await safeGoto(page, "/windows");
    const opened = context.waitForEvent("page");
    await safeClickLink(page, /click here/i);

    const child = await opened;
    await child.waitForLoadState();
    await expect(child).toHaveTitle("New Window");
    await expect(child.locator("h3")).toHaveText("New Window");

    await child.close();
    await expect(page.locator("h3")).toHaveText("Opening a new window");
  });
});
