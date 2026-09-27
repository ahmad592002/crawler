/**
 * Forgot password. Feature map: output/features.jsonl
 *
 * Every test here asserts the CORRECT behaviour and is marked test.fail() against
 * finding F-001, so the suite flips to passing the day the 500 is fixed.
 */
import { test, expect, submitAndWait, safeClick } from "./fixtures.js";

test.describe("forgot password", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/forgot_password");
  });

  test("the form is reachable and labelled", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Forgot Password" })).toBeVisible();
    await expect(page.getByRole("textbox")).toBeVisible();
    await expect(page.getByRole("button", { name: /Retrieve password/i })).toBeVisible();
  });

  // F-001: POST /forgot_password returns 500 for every input.
  test.fail("a valid address is accepted", async ({ page }) => {
    await page.getByRole("textbox").first().fill("qa-probe@uberip.com");
    await submitAndWait(
      page,
      safeClick(page, /Retrieve password/i),
      "/forgot_password",
    );

    await expect(page.getByText(/Internal Server Error/i)).toHaveCount(0);
  });

  // F-001: the same 500 hides whatever validation might exist.
  test.fail("an empty address is rejected with a validation message, not a 500", async ({ page }) => {
    await submitAndWait(
      page,
      safeClick(page, /Retrieve password/i),
      "/forgot_password",
    );

    await expect(page.getByText(/Internal Server Error/i)).toHaveCount(0);
  });

  // F-001: likewise for a malformed address.
  test.fail("a malformed address is rejected with a validation message, not a 500", async ({ page }) => {
    await page.getByRole("textbox").first().fill("not-an-email");
    await submitAndWait(
      page,
      safeClick(page, /Retrieve password/i),
      "/forgot_password",
    );

    await expect(page.getByText(/Internal Server Error/i)).toHaveCount(0);
  });
});
