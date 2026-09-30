/**
 * looksLikeLoginPage, pinned.
 *
 * This classifier has now regressed twice, in opposite directions, and shipped both times
 * with a commit message claiming it was tested. It was not: authz-check.test.ts exercised a
 * single bare login form, which happened to be the one shape that still worked.
 *
 * Both failure directions are costly and neither is obvious:
 *   MISS  - a login page read as a resource. The owner's expired session then compares equal
 *           to an anonymous request on every URL, FABRICATING critical findings that exit 1.
 *   FALSE - a resource read as a login page. The template is dropped from the scan and the
 *           run reports clean, which is the worst output this tool can produce.
 *
 * Every row below came from an audit that demonstrated the behaviour on real page shapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeLoginPage, classify, reachedResource } from "./authz-check.js";

const page = (title: string, body: string): string =>
  `<html><head><title>${title}</title></head><body>${body}</body></html>`;

// ---------------------------------------------------------------- must be LOGIN

const LOGIN_PAGES: [string, string][] = [
  [
    "canonical login form",
    page("Sign in", `<h1>Sign in</h1><form action="/session" method="post">
      <input name="email" type="email"><input name="password" type="password">
      <button type="submit">Sign in</button></form>`),
  ],
  [
    "login page with a sign-up link (the commonest shape there is)",
    page("Sign in", `<h1>Sign in</h1><form action="/login">
      <input name="email" type="email"><input name="password" type="password">
      <button>Sign in</button></form>
      <p>Don't have an account? <a href="/signup">Sign up</a></p>`),
  ],
  [
    "login page saying 'New user? Register here'",
    page("Log in", `<h1>Log in</h1><form action="/authenticate">
      <input name="username"><input name="password" type="password">
      <button>Log in</button></form><p>New user? <a href="/register">Register here</a></p>`),
  ],
  [
    "login form inside a shared layout carrying a logout link",
    page("Sign in", `<nav><a href="/logout">Log out</a></nav>
      <form action="/login"><input name="email"><input name="password" type="password">
      <button>Sign in</button></form>`),
  ],
  [
    "login page offering a forgot-password link",
    page("Sign in", `<h1>Sign in</h1><form action="/login">
      <input name="email"><input name="password" type="password"><button>Sign in</button></form>
      <a href="/forgot">Forgot password? Choose a new password</a>`),
  ],
  [
    "interstitial with no form at all",
    page("Members", `<h1>Members</h1><p>You must log in to view this page.</p><a href="/login">Login</a>`),
  ],
  [
    "session expired notice",
    page("Expired", `<h1>Session expired</h1><p>Your session has expired. Please sign in again.</p>`),
  ],
  [
    "magic-link sign-in, no password field",
    page("Sign in", `<h1>Sign in</h1><form action="/magic"><input name="email" type="email">
      <button>Email me a login link</button></form>`),
  ],
  [
    "SSO-only sign-in",
    page("Log in", `<h1>Log in</h1><form action="/sso"><button>Continue with Google</button></form>`),
  ],
  [
    "branded enterprise login well over 12KB",
    page("Portal", `<h1>Anmelden</h1><form action="/j_spring_security_check">
      <input name="j_username"><input name="j_password" type="password"><button>Anmelden</button></form>
      ${"<div class='brand'>filler</div>".repeat(600)}`),
  ],
];

for (const [label, body] of LOGIN_PAGES) {
  test(`login: ${label}`, () => {
    assert.equal(looksLikeLoginPage(body), true, "missed a login page - this FABRICATES criticals");
    // And the consequence that actually matters.
    assert.equal(reachedResource(classify(200, body)), false);
  });
}

// ---------------------------------------------------------------- must be RESOURCE

const RESOURCES: [string, string][] = [
  [
    "invoice page with a login link in the footer",
    page("Invoice", `<h1>Alice's invoice #4471</h1><p>Total 942.00 due 30 June</p>
      <footer><a href="/login">Login</a> | <a href="/help">Help</a></footer>`),
  ],
  [
    "account settings page carrying a change-password form",
    page("Account settings", `<h1>Account settings</h1><a href="/logout">Log out</a>
      <form action="/account"><input name="email" type="email">
      <label>Current password</label><input name="current_password" type="password">
      <label>New password</label><input name="password" type="password">
      <button>Save changes</button></form>`),
  ],
  [
    "signup page",
    page("Create account", `<h1>Create your account</h1><form action="/users">
      <input name="email" type="email"><input name="password" type="password">
      <input name="password_confirmation" type="password"><button>Sign up</button></form>
      <p>Already have an account? <a href="/login">Sign in</a></p>`),
  ],
  [
    "admin create-user form (a top-value finding if reachable)",
    page("New user", `<h1>New user</h1><a href="/logout">Log out</a>
      <form action="/admin/users"><input name="username"><input name="password" type="password">
      <select name="role"><option>admin</option></select><button>Create</button></form>`),
  ],
  [
    "docs page describing single sign-on",
    page("Docs", `<h1>Integration guide</h1><p>This documentation explains how to configure
      single sign-on and continue with Google for your workspace. Log in flows are covered below.</p>
      ${"<p>more guidance</p>".repeat(40)}`),
  ],
  [
    "internal page with a webhook-secret field",
    page("Webhooks", `<h1>Webhook endpoints</h1><a href="/logout">Log out</a>
      <form action="/webhooks"><input name="url"><input name="secret" type="password">
      <button>Save endpoint</button></form>`),
  ],
  [
    "dashboard mentioning 'log in' inside a script string",
    page("Dashboard", `<h1>Dashboard</h1><p>12 open tickets, 4 overdue</p>
      <script>const msg = "please log in again if this fails";</script>`),
  ],
];

for (const [label, body] of RESOURCES) {
  test(`resource: ${label}`, () => {
    assert.equal(looksLikeLoginPage(body), false, "suppressed a real page - this reports a false CLEAN");
    assert.equal(reachedResource(classify(200, body)), true);
  });
}

// ---------------------------------------------------------------- shells

test("an un-hydrated SPA shell is neither a login page nor a reached resource", () => {
  const shell = page("App", `<div id="root"></div><script src="/app.js"></script>`);
  assert.equal(looksLikeLoginPage(shell), false);
  // hasContent is what denies it: a 200 with no text proves nothing either way.
  assert.equal(reachedResource(classify(200, shell)), false);
});
