/**
 * Authentication feature tests. Role-based locators only - no CSS or XPath.
 *
 * submitAndWait is used for every form submit: this target can take tens of seconds to
 * respond, and a rejected login re-renders the same /login URL, so neither a bare
 * assertion nor waitForURL is a reliable "the server has answered" signal.
 */
import { test, expect, submitAndWait, safeClick } from "./fixtures.js";

test.describe("login", () => {
  // These exercise the failure paths, so they must start from a signed-out browser.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("rejects a wrong password", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username").fill("tomsmith");
    await page.getByLabel("Password").fill("definitely-not-the-password");
    await submitAndWait(page, safeClick(page, "Login"), "/authenticate");

    await expect(page.getByText("Your password is invalid!")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("rejects an unknown username", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Username").fill("no-such-user");
    await page.getByLabel("Password").fill("SuperSecretPassword!");
    await submitAndWait(page, safeClick(page, "Login"), "/authenticate");

    await expect(page.getByText("Your username is invalid!")).toBeVisible();
  });

  test("rejects empty credentials", async ({ page }) => {
    await page.goto("/login");
    await submitAndWait(page, safeClick(page, "Login"), "/authenticate");

    await expect(page.getByText("Your username is invalid!")).toBeVisible();
  });

  test("the secure area is not reachable while signed out", async ({ page }) => {
    // goto follows the redirect itself, so the landing page is already the real one.
    await page.goto("/secure");

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText("You must login to view the secure area!")).toBeVisible();
  });
});

test.describe("signed in", () => {
  test("the saved session lands on the secure area", async ({ page }) => {
    await page.goto("/secure");

    // exact: true - the subheader "Welcome to the Secure Area." also matches otherwise.
    await expect(page.getByRole("heading", { name: "Secure Area", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /Logout/i })).toBeVisible();
  });
});
