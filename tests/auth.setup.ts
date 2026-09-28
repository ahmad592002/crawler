/**
 * Auth setup project: logs in once and saves the session for every other spec.
 *
 * This target (the-internet.herokuapp.com) uses a plain form login with fixed demo
 * credentials and has no signup or email verification step. A site that does verify by
 * email would insert the email steps here - createInbox() before submitting the signup
 * form, then extractCode/extractLinks on what waitForEmail returns. The rest is identical.
 */
import { test as setup, expect, safeClick } from "./fixtures.js";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../src/config.js";

const STATE = resolve(ROOT, "output/auth/state.json");

const USERNAME = process.env["TEST_USERNAME"] ?? "tomsmith";
const PASSWORD = process.env["TEST_PASSWORD"] ?? "SuperSecretPassword!";

setup("log in and save session", async ({ page }) => {
  mkdirSync(resolve(ROOT, "output/auth"), { recursive: true });

  await page.goto("/login");
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill(PASSWORD);
  await safeClick(page, "Login");

  // Wait for the navigation the click starts before asserting on content. Otherwise the
  // assertion polls the old page and can exhaust its own timeout while the new one loads.
  //
  // The setup project gates every other spec, so a single slow response here reports as
  // "27 tests did not run" and looks like a broken suite. Give the login its own generous
  // budget rather than inheriting the default and failing the whole run over one timeout.
  await page.waitForURL(/\/secure$/, { timeout: 180_000 });
  await expect(page.getByText("You logged into a secure area!")).toBeVisible({ timeout: 30_000 });

  await page.context().storageState({ path: STATE });
});
