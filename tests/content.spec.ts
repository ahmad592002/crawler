/**
 * Content and asset integrity: broken images, copy correctness, routing.
 * Feature map: output/features.jsonl
 */
import { test, expect } from "./fixtures.js";

test.describe("images", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/broken_images");
  });

  // F-003: two of the three images reference assets that do not exist.
  test.fail("every image resolves to a real asset", async ({ page }) => {
    const images = page.locator("#content img");
    await expect(images).toHaveCount(3);

    // naturalWidth is 0 for an image the browser could not decode.
    const broken = await images.evaluateAll(
      (els) => els.filter((i) => (i as HTMLImageElement).naturalWidth === 0).length,
    );
    expect(broken).toBe(0);
  });

  // F-004: all three images have an empty alt attribute.
  test.fail("every image carries alt text", async ({ page }) => {
    const missing = await page
      .locator("#content img")
      .evaluateAll((els) => els.filter((i) => !(i as HTMLImageElement).alt).length);
    expect(missing).toBe(0);
  });

  test("the valid image does render", async ({ page }) => {
    const width = await page
      .locator("#content img")
      .last()
      .evaluate((i) => (i as HTMLImageElement).naturalWidth);
    expect(width).toBeGreaterThan(0);
  });
});

test.describe("copy", () => {
  // F-006: the paragraph alternates between correct text and "you won,t."
  //
  // The variant is chosen at random per request, so a handful of samples can all land the
  // same way and make this test flake. Sampling over plain HTTP instead of page loads lets
  // us take enough samples to be reliable (20 requests: missing both variants is ~1 in 500k)
  // without paying for 20 navigations against a slow host.
  test.fail("the typos page renders correct copy on every load", async ({ page }) => {
    const variants = new Set<string>();

    for (let i = 0; i < 20; i++) {
      const res = await page.request.get("/typos");
      expect(res.ok()).toBe(true);
      const html = await res.text();
      const m = /Sometimes you'll see a typo[^<]*/.exec(html);
      if (m) variants.add(m[0].trim());
    }

    expect(variants.size).toBeGreaterThan(0); // guard: the paragraph was actually found
    expect([...variants]).toHaveLength(1);
  });
});

test.describe("routing", () => {
  test("the canonical trailing-slash URL serves the page", async ({ page }) => {
    const res = await page.goto("/add_remove_elements/");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("button", { name: "Add Element" })).toBeVisible();
  });

  // F-007: the slashless form 404s instead of resolving or redirecting.
  test.fail("the same page is reachable without the trailing slash", async ({ page }) => {
    const res = await page.goto("/add_remove_elements");
    expect(res?.status()).toBe(200);
  });
});
