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
import type { Page, Locator } from "@playwright/test";
import { loadConfig, env } from "../src/config.js";

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
 * Which credentials to sign in with, most specific source first.
 *
 * env > the target's `login` block > the first persona > the demo site's values. The env
 * vars come first so a real secret never has to live in a committed config; the demo
 * values come last so the original target keeps working with no config at all.
 *
 * Never logged. CLAUDE.md: refer to these by variable name only.
 */
export function loginCredentials(): { username: string; password: string } {
  const first = cfg.personas?.[0];
  return {
    username: env("TEST_USERNAME") ?? cfg.login?.username ?? first?.username ?? "tomsmith",
    password: env("TEST_PASSWORD") ?? cfg.login?.password ?? first?.password ?? "SuperSecretPassword!",
  };
}

/** Match a configured label loosely: "Username", "User Name" and "username" are one field. */
const label = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

/**
 * Find a login field by every name a site might give it.
 *
 * getByLabel alone is not enough. A real login form was served with NO <label> elements at
 * all - the fields were identified by placeholder, aria-label and a data-test attribute -
 * and a config that names the field "Username" has to work on all of those. The order is
 * strongest signal first: an accessible label, then the visible placeholder, then the
 * plumbing attributes.
 */
function field(page: Page, text: string): Locator {
  const rx = label(text);
  // A slug for attribute matching: "User Name" also appears as user-name, user_name,
  // username and data-test="username".
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const attr = `input[name*="${slug}" i], input[id*="${slug}" i], input[data-test*="${slug}" i]`;

  return page
    .getByLabel(rx)
    .or(page.getByPlaceholder(rx))
    .or(page.locator(attr))
    .first();
}

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
): Promise<string> {
  await safeGoto(page, loginShape.path);

  await field(page, loginShape.usernameLabel).fill(username);
  await field(page, loginShape.passwordLabel).fill(password);
  await safeClick(page, label(loginShape.submitLabel));

  // Wait for the navigation the click starts BEFORE asserting on content. Otherwise the
  // assertion polls the old page and can exhaust its own timeout while the new one loads.
  //
  // Raced against the form's own error message. A rejected login is not a slow login: with
  // only the URL wait, wrong credentials burned the full 180s timeout and reported
  // "waiting for navigation", while the page had said "Username and password do not match
  // any user in this service" within a second. Three minutes to learn the password was
  // wrong, and a message that pointed at the wrong problem.
  const rejected = page
    .locator('[role="alert"], .error-message-container, .alert-danger, .error, [data-test*="error"]')
    .first();

  const outcome = await Promise.race([
    page.waitForURL(new RegExp(loginShape.successUrl), { timeout: timeoutMs }).then(() => "ok"),
    rejected
      .waitFor({ state: "visible", timeout: timeoutMs })
      .then(() => "rejected")
      .catch(() => "never"),
  ]);

  if (outcome === "rejected") {
    const message = (await rejected.innerText().catch(() => "")).trim().replace(/\s+/g, " ");
    // The message is the site's, not ours, and carries no credential of ours in it.
    throw new Error(
      `Login was rejected by ${loginShape.path}: ${message || "(the form showed an error)"}. ` +
        `Check the target's login.username/login.password, or TEST_USERNAME/TEST_PASSWORD.`,
    );
  }

  // Only if the target actually has a success sentence. Asserting on one that does not
  // exist turns a working login into a 30-second timeout that looks like a broken site.
  if (loginShape.successText) {
    await expect(page.getByText(loginShape.successText)).toBeVisible({ timeout: 30_000 });
  }

  // Where the login actually landed. On a login-gated app this is the only entry point
  // that exists: saucedemo serves its sign-in form at / even WITH a valid session, and
  // reaches /inventory.html only through the login click - so an authenticated crawl
  // seeded from baseUrl walks straight back into the login page and reports one page.
  return page.url();
}
