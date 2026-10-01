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
import { test, expect, safeGoto, safeGotoResponse, safeClick, safeClickLink } from "./fixtures.js";
import { loadConfig } from "../src/config.js";

const cfg = loadConfig();

test.describe("A/B test", () => {
  test("the opt-out cookie turns the experiment off", async ({ page, context }) => {
    const heading = page.locator("#content h3");

    // The precondition has to establish that a VARIANT was live, or the test cannot tell
    // "the opt-out worked" from "no variant was ever assigned". The first version asserted
    // /A\/B Test/, which both possible headings satisfy - trivially true, and it would have
    // passed even if the cookie were ignored entirely. Measured in a browser: without the
    // cookie this is "A/B Test Variation 1" on every load, with it "No A/B Test".
    await safeGoto(page, "/abtest");
    await expect(heading).not.toHaveText("No A/B Test");

    await context.addCookies([
      {
        name: "optimizelyOptOut",
        value: "true",
        // Derived from config, so the test does not silently stop working if the target
        // moves. Host-only: deliberately not a .herokuapp.com wildcard, which would hand
        // the cookie to every unrelated app on that domain.
        domain: new URL(cfg.baseUrl).hostname,
        path: "/",
      },
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
    //
    // `not.toBeEmpty()` on <body> was the first version of this and proved nothing: every
    // page on this target carries a header and a footer, so it passes on a 404 body too.
    const response = await safeGotoResponse(page, "/infinite_scroll/1");
    expect(response?.status(), "the deep link must answer, not 404").toBe(200);

    // This URL serves a bare HTML FRAGMENT - no <html>, no <head>, no #content, no site
    // chrome - because it is the partial the scroller appends, not a page. Two selector
    // guesses failed here before I fetched it and looked: a <p> wrapper (there is none)
    // and #content (not present). The assertion that fits what it really is: the fragment
    // carries a substantial block of its own text.
    const body = page.locator("body");
    expect(
      (await body.innerText()).trim().length,
      "the deep link answered 200 but served no content",
    ).toBeGreaterThan(200);
  });
});

test.describe("slow and large pages", () => {
  test("/slow answers and serves its content", async ({ page }) => {
    // The 30s bound this used to assert was met by a 0.6s response, so nothing short of a
    // total outage could fail it. The bound is kept, loosely, as an upper guard against the
    // page becoming unbounded - but the real assertion is that the content arrives, which
    // is what a reader actually needs from a page whose whole gimmick is being slow.
    const started = Date.now();
    const response = await safeGotoResponse(page, "/slow");
    expect(response?.status()).toBe(200);
    await expect(page.locator("#content")).toContainText(/\S/);
    expect(Date.now() - started, "the page should not become unbounded").toBeLessThan(30_000);
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

test.describe("a page that is broken on purpose", () => {
  // /javascript_error throws from its own inline onload handler - same origin, nothing
  // third-party involved - so this is a genuine defect in the target. The assertion states
  // the healthy behaviour, so it flips green if the target is ever fixed, which is the
  // point of test.fail.
  //
  // The listener is attached before navigating and the assertion polls, because the
  // pageerror event can arrive after waitForLoadState("load") resolves. Asserting once,
  // immediately, made this report an unexpected PASS on a page that had thrown.
  test.fail("/javascript_error loads without throwing", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await safeGoto(page, "/javascript_error");
    await page.waitForLoadState("load");
    await expect
      .poll(() => errors.length, { timeout: 5_000, message: "waiting for the onload error" })
      .toBeGreaterThan(0);
    expect(errors, `onload threw: ${errors.join("; ")}`).toEqual([]);
  });
});

test.describe("tinymce under our own off-origin policy", () => {
  /**
   * There used to be a test.fail here claiming "/tinymce does not initialise its editor"
   * as a target defect. It was not one.
   *
   * The editor is served from https://cdn.tiny.cloud, and the `page` fixture aborts every
   * off-origin request (fixtures.ts: anything outside allowedOrigins). So `tinymce` is
   * never defined, the page's inline tinymce.init() throws, and the test.fail recorded a
   * pass - for a condition this suite creates itself. Worse, it would have flipped to an
   * unexpected pass, turning the suite red, if that CDN were ever allow-listed or
   * captureOffOrigin were turned on: red for the site getting better.
   *
   * What can honestly be tested under that policy is the progressive-enhancement floor:
   * with the editor's script blocked, the page must still serve usable markup. That is a
   * real property - it is what a user with a blocked CDN or a strict CSP gets.
   */
  test("the raw textarea is still served and editable when the CDN is blocked", async ({
    page,
  }) => {
    await safeGoto(page, "/tinymce");

    // Assert the policy this test depends on actually held, so the test cannot quietly
    // become a test of a fully-initialised editor that happens to also have a textarea.
    const editorLoaded = await page.evaluate(
      () => typeof (window as unknown as { tinymce?: unknown }).tinymce !== "undefined",
    );
    expect(editorLoaded, "cdn.tiny.cloud answered - this test's premise no longer holds").toBe(
      false,
    );

    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible();
    await expect(textarea).toHaveText(/Your content goes here/i);
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
