/**
 * The one place that knows how to log in.
 *
 * This used to live inline in tests/auth.setup.ts and again in tests/personas.setup.ts,
 * hardcoded to the demo target in six ways: the /login path, the "Username" and "Password"
 * label text, the "Login" button name, a /secure success URL and the literal sentence
 * "You logged into a secure area!". Credentials were configurable, which made the rest easy
 * to miss - the one part that looked parameterised was the only part that was. Pointing the
 * agent at any other site meant editing a spec.
 *
 * Everything is now driven by the optional `login` block in the target's config, defaulting
 * to the demo target's shape so existing configs keep working.
 */
import { expect, safeGoto, safeClick } from "./fixtures.js";
import type { Page } from "@playwright/test";
import { loadConfig } from "../src/config.js";

const cfg = loadConfig();

/** The login shape for this target, with the demo target's values as defaults. */
export const loginShape = {
  path: cfg.login?.path ?? "/login",
  usernameLabel: cfg.login?.usernameLabel ?? "Username",
  passwordLabel: cfg.login?.passwordLabel ?? "Password",
  submitLabel: cfg.login?.submitLabel ?? "Login",
  successUrl: cfg.login?.successUrl ?? "/secure$",
  successText: cfg.login?.successText,
};

/**
 * Fill the sign-in form and wait for the success signal.
 *
 * `timeoutMs` is generous by default because the setup project gates every other spec: a
 * single slow response here reports as "27 tests did not run" and reads as a broken suite
 * rather than one slow login.
 */
export async function logIn(
  page: Page,
  username: string,
  password: string,
  timeoutMs = 180_000,
): Promise<void> {
  await safeGoto(page, loginShape.path);

  // Labels are matched case-insensitively, because "Username", "User Name" and "Email" are
  // the same field as far as a target config is concerned.
  const label = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  await page.getByLabel(label(loginShape.usernameLabel)).fill(username);
  await page.getByLabel(label(loginShape.passwordLabel)).fill(password);
  await safeClick(page, label(loginShape.submitLabel));

  // Wait for the navigation the click starts BEFORE asserting on content. Otherwise the
  // assertion polls the old page and can exhaust its own timeout while the new one loads.
  await page.waitForURL(new RegExp(loginShape.successUrl), { timeout: timeoutMs });

  // Only if the target actually has a success sentence. Asserting on one that does not
  // exist turns a working login into a 30-second timeout that looks like a broken site.
  if (loginShape.successText) {
    await expect(page.getByText(loginShape.successText)).toBeVisible({ timeout: 30_000 });
  }
}
