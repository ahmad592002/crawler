/**
 * Auth setup project: logs in once and saves the session for every other spec.
 *
 * This target (the-internet.herokuapp.com) uses a plain form login with fixed demo
 * credentials and has no signup or email verification step. A site that does verify by
 * email would insert the email steps here - createInbox() before submitting the signup
 * form, then extractCode/extractLinks on what waitForEmail returns. The rest is identical.
 */
import { test as setup } from "./fixtures.js";
import { logIn } from "./login.js";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { env, OUT } from "../src/config.js";

// OUT, not ROOT: these must follow QA_OUT or the session is written to the default
// output/ while playwright.config.ts reads storageState from the target's own
// directory - every non-default target would then run signed out while the setup
// project reported success.
const STATE = resolve(OUT, "auth/state.json");

const USERNAME = env("TEST_USERNAME", "tomsmith")!;
const PASSWORD = env("TEST_PASSWORD", "SuperSecretPassword!")!;

setup("log in and save session", async ({ page }) => {
  mkdirSync(resolve(OUT, "auth"), { recursive: true });

  // The login shape comes from the target's config now - see tests/login.ts. The path,
  // the field labels, the submit control and the success signal were all hardcoded here
  // to the demo site, so this file had to be edited for every new target.
  await logIn(page, USERNAME, PASSWORD);

  await page.context().storageState({ path: STATE });
});
