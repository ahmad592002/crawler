/**
 * Auth setup project: logs in once and saves the session for every other spec.
 *
 * This target (the-internet.herokuapp.com) uses a plain form login with fixed demo
 * credentials and has no signup or email verification step. A site that does verify by
 * email would insert the email steps here - createInbox() before submitting the signup
 * form, then extractCode/extractLinks on what waitForEmail returns. The rest is identical.
 */
import { test as setup } from "./fixtures.js";
import { logIn, loginCredentials } from "./login.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUT } from "../src/config.js";

// OUT, not ROOT: these must follow QA_OUT or the session is written to the default
// output/ while playwright.config.ts reads storageState from the target's own
// directory - every non-default target would then run signed out while the setup
// project reported success.
const STATE = resolve(OUT, "auth/state.json");

/**
 * Credentials, most specific source first.
 *
 * These used to be env-only, each with the demo site's value as its DEFAULT - so a target
 * with its own credentials in config still got tomsmith/SuperSecretPassword!, and the run
 * spent three minutes waiting for a navigation that was never going to happen while the
 * page sat there saying the username and password did not match.
 *
 * Env stays highest priority so a real secret never has to live in a committed config.
 */
const creds = loginCredentials();
const USERNAME = creds.username;
const PASSWORD = creds.password;

setup("log in and save session", async ({ page }) => {
  mkdirSync(resolve(OUT, "auth"), { recursive: true });

  // The login shape comes from the target's config now - see tests/login.ts. The path,
  // the field labels, the submit control and the success signal were all hardcoded here
  // to the demo site, so this file had to be edited for every new target.
  const landing = await logIn(page, USERNAME, PASSWORD);

  await page.context().storageState({ path: STATE });

  // Saved beside the session so the authenticated crawl knows where the app actually
  // starts. Without it the crawl seeds baseUrl, which on a login-gated app is the
  // sign-in page whether or not the session is valid.
  writeFileSync(resolve(OUT, "auth/landing.json"), `${JSON.stringify({ url: landing }, null, 2)}\n`);
});
