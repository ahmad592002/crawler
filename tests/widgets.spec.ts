/**
 * Form controls and widgets: dropdown, number input, key presses, dynamic controls.
 * Feature map: output/features.jsonl
 *
 * test.fail() marks a known bug from output/findings.jsonl - the assertion states the
 * behaviour we want, so the test flips to passing when the bug is fixed.
 */
import { test, expect, safeClick } from "./fixtures.js";

test.describe("dropdown", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dropdown");
  });

  test("offers a disabled placeholder and two selectable options", async ({ page }) => {
    // F-005: the select has no accessible name, so getByLabel cannot be used here.
    const select = page.getByRole("combobox");

    await expect(select).toBeVisible();
    await expect(select.getByRole("option")).toHaveText([
      "Please select an option",
      "Option 1",
      "Option 2",
    ]);
    await expect(select.getByRole("option", { name: "Please select an option" })).toBeDisabled();
  });

  test("selecting an option updates the value", async ({ page }) => {
    const select = page.getByRole("combobox");

    await select.selectOption("1");
    await expect(select).toHaveValue("1");

    await select.selectOption("2");
    await expect(select).toHaveValue("2");
  });

  // F-005: no <label for> and no aria-label, so the control is unnamed for assistive tech.
  test.fail("the select has an accessible name", async ({ page }) => {
    await expect(page.getByLabel(/dropdown/i)).toBeVisible();
  });
});

test.describe("number input", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/inputs");
  });

  const type = async (page: import("@playwright/test").Page, value: string) => {
    const input = page.getByRole("spinbutton");
    await input.fill("");
    await input.pressSequentially(value);
    return input;
  };

  test("accepts integers, negatives and decimals", async ({ page }) => {
    await expect(await type(page, "42")).toHaveValue("42");
    await expect(await type(page, "-17")).toHaveValue("-17");
    await expect(await type(page, "3.5")).toHaveValue("3.5");
  });

  test("discards non-numeric text", async ({ page }) => {
    await expect(await type(page, "abc")).toHaveValue("");
  });

  test("accepts a very long number without clamping or truncating", async ({ page }) => {
    await expect(await type(page, "99999999999999999999")).toHaveValue("99999999999999999999");
  });
});

test.describe("key presses", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/key_presses");
  });

  for (const [key, expected] of [
    ["a", "You entered: A"],
    ["Escape", "You entered: ESCAPE"],
    ["Tab", "You entered: TAB"],
  ] as const) {
    test(`reports ${key}`, async ({ page }) => {
      await page.locator("input#target").press(key);
      await expect(page.locator("#result")).toHaveText(expected);
    });
  }

  // F-002: Enter is the one key the handler does not report.
  test.fail("reports Enter", async ({ page }) => {
    await page.locator("input#target").press("Enter");
    await expect(page.locator("#result")).toHaveText("You entered: ENTER");
  });
});

test.describe("dynamic controls", () => {
  test("Enable un-disables the input and confirms", async ({ page }) => {
    await page.goto("/dynamic_controls");

    const input = page.locator("#input-example input[type=text]");
    await expect(input).toBeDisabled();

    await safeClick(page, "Enable");

    // The control is enabled asynchronously behind a loading indicator.
    await expect(input).toBeEnabled({ timeout: 30_000 });
    await expect(page.locator("#input-example #message")).toHaveText("It's enabled!");
  });

  test("the Remove control is on the deny-list and is never automated", async ({ page }) => {
    await page.goto("/dynamic_controls");

    // Asserting it EXISTS without clicking it. safeClick() would throw on this label,
    // and the crawler withholds it from pages.auth.jsonl as deniedButtons.
    await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  });
});
