/**
 * Persona setup: create each configured identity and save its own logged-in session.
 *
 * Runs once per suite, before anything else, alongside the single-user auth setup. Each
 * persona ends up with its own output/auth/state.<id>.json, which is what lets one test
 * drive two people at the same time.
 *
 * Signing up is site-specific. The generic flow is:
 *
 *   1. record `since` BEFORE submitting anything
 *   2. submit the signup form with persona.email / persona.password
 *   3. waitForEmail({ to: persona.email, since }) and extract the code or link
 *   4. complete verification, log in, save storageState
 *
 * The demo target has no signup at all - it has one fixed account - so this file logs each
 * persona into that same account and marks the sessions as not independent. Replace the
 * body of `signUpAndLogIn` for a real target; everything around it stays.
 */
import { test as setup, expect, safeClick, safeGoto } from "./fixtures.js";
import { logIn } from "./login.js";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, OUT } from "../src/config.js";
import { loadPersonas, describePersona, type Persona } from "../src/personas.js";
import { waitForEmail, extractCode, extractLinks } from "../src/email/lib.js";

const cfg = loadConfig();

setup("create personas and save a session for each", async ({ browser }) => {
  const personas = await loadPersonas();

  if (personas.length === 0) {
    setup.skip(true, 'No "personas" in qa.config.json - nothing to set up.');
    return;
  }

  // OUT, not ROOT: these must follow QA_OUT or the session is written to the default
  // output/ while playwright.config.ts reads storageState from the target's own
  // directory - every non-default target would then run signed out while the setup
  // project reported success.
  mkdirSync(resolve(OUT, "auth"), { recursive: true });
  for (const p of personas) console.log(`  ${describePersona(p)}`);

  // Sequentially: a signup flow that races itself against the same site is a bad first
  // impression, and these run once.
  for (const persona of personas) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await signUpAndLogIn(page, persona);
      await context.storageState({ path: persona.statePath });
      console.log(`  session saved for ${persona.id}`);
    } finally {
      await context.close();
    }
  }
});

/**
 * Site-specific. Everything above this line is reusable; this is the part you rewrite.
 */
async function signUpAndLogIn(
  page: import("@playwright/test").Page,
  persona: Persona,
): Promise<void> {
  // A persona with a configured username logs in as that fixed account. Where the target
  // has no signup - the demo site - this is the whole flow. The login SHAPE is no longer
  // written here: it comes from the target's config via tests/login.ts, so a new target
  // needs a config block rather than an edit to this file.
  const configured = cfg.personas?.find((p) => p.id === persona.id)?.username;
  const username = configured ?? persona.email;

  // The per-persona timeout is shorter than the auth setup's: several personas run in
  // sequence here, and one unreachable target should not burn three minutes per identity.
  await logIn(page, username, persona.password, 60_000);
}

/**
 * The real shape, kept as a reference so the email half is not lost.
 *
 * Unused against the demo target - it has no signup - but this is the flow a site with
 * email verification needs, and the reason each persona owns a real mailbox.
 */
export async function signUpWithEmailVerification(
  page: import("@playwright/test").Page,
  persona: Persona,
): Promise<void> {
  // Recorded before submitting: the inbox may already hold mail from an earlier run, and
  // accepting a stale code is the classic way this flow goes green while being broken.
  const since = new Date();

  await safeGoto(page, "/signup");
  await page.getByLabel(/email/i).fill(persona.email);
  await page.getByLabel(/password/i).first().fill(persona.password);
  await safeClick(page, /sign up|create account|register/i);

  const mail = await waitForEmail({ to: persona.email, since, timeoutSec: 120 });
  const body = `${mail.text}\n${mail.html}`;

  const code = extractCode(body);
  if (code) {
    await page.getByLabel(/code|verification/i).fill(code);
    await safeClick(page, /verify|confirm/i);
  } else {
    const [link] = extractLinks(body, new URL(cfg.baseUrl).host);
    if (!link) throw new Error(`No verification code or link in "${mail.subject}"`);
    await page.goto(link, { waitUntil: "domcontentloaded" });
  }

  await expect(page).not.toHaveURL(/signup/);
}
