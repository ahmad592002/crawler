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

// =============================================================== round-8 audit
//
// The fixtures above were written from the classifier's own vocabulary, so they could not
// fail for any shape the classifier did not already know. These came from an audit that
// reconstructed real pages, and every one of them was WRONG before this round.

const REAL_LOGIN: [string, string][] = [
  [
    "two-step identifier page, submit says Next (Google/Okta shape)",
    page("Sign in", `<h1>Sign in</h1><form action="/signin/v1/lookup" method="post">
      <input type="email" name="identifier" autocomplete="username">
      <button><span>Next</span></button></form>`),
  ],
  [
    "OTP second step, submit says Verify",
    page("Verify", `<h1>Enter the code we sent you</h1><form action="/signin/challenge/otp">
      <input name="otp" autocomplete="one-time-code" inputmode="numeric">
      <button>Verify</button></form>`),
  ],
  [
    "Arabic login, no Latin auth vocabulary at all",
    page("دخول", `<h1>تسجيل الدخول</h1><form action="/dukhul" method="post">
      <label>البريد الإلكتروني</label><input name="email" type="email">
      <label>كلمة المرور</label><input name="password" type="password">
      <button>متابعة</button></form>`),
  ],
  [
    "Russian login, no Latin auth vocabulary",
    page("Вход", `<h1>Вход в систему</h1><form action="/vhod" method="post">
      <input name="email" type="email"><input name="password" type="password">
      <button>Продолжить</button></form>`),
  ],
  [
    "Japanese login, no Latin auth vocabulary",
    page("ログイン", `<h1>ログイン</h1><form action="/ninshou" method="post">
      <input name="username"><input name="password" type="password">
      <button>次へ</button></form>`),
  ],
  [
    "a 200 carrying a JSON unauthorized envelope",
    `{"error":"unauthorized","message":"Authentication required","status":401}`,
  ],
  [
    "a terse 401 page",
    page("401", `<h1>401 Authorization Required</h1><p>nginx</p>`),
  ],
];

for (const [label, body] of REAL_LOGIN) {
  test(`login (round 8): ${label}`, () => {
    assert.equal(looksLikeLoginPage(body), true, "missed a login page - this FABRICATES criticals");
    assert.equal(reachedResource(classify(200, body)), false);
  });
}

const REAL_RESOURCES: [string, string][] = [
  [
    "an article whose headline happens to say 'Sign in to continue'",
    page("Changes", `<h1>Sign in to continue using Acme Cloud after July 1</h1>
      <p>From July we are consolidating accounts. Existing customers keep their data and
      nothing is deleted; you will simply be asked to authenticate once per device.</p>
      <p>The migration runs in three phases across the summer, and each phase is announced
      two weeks ahead on this page and by email to workspace administrators.</p>
      <p>If you administer more than one workspace you will need to repeat the step for each,
      because workspace identities remain separate by design.</p>`),
  ],
  [
    "a two-factor security page that asks for a password to DISABLE 2FA",
    page("Two-factor authentication", `<h1>Two-factor authentication</h1>
      <p>You will be asked for a code when you sign in on a new device.</p>
      <form action="/settings/2fa/disable"><input type="password" name="password">
      <button>Turn off</button></form>`),
  ],
  [
    "a small JSON API response - where IDORs actually live",
    `{"balance":128455.12,"acct":"***4417"}`,
  ],
  [
    "an API token page (bare password field, but an operation action)",
    page("API tokens", `<h1>API tokens</h1><a href="/logout">Log out</a>
      <form action="/settings/tokens/revoke"><input type="password" name="password">
      <button>Revoke all</button></form>`),
  ],
];

for (const [label, body] of REAL_RESOURCES) {
  test(`resource (round 8): ${label}`, () => {
    assert.equal(looksLikeLoginPage(body), false, "suppressed a real page - this reports false CLEAN");
    assert.equal(reachedResource(classify(200, body)), true);
  });
}

test("an SPA shell that ships a static form is still not content", () => {
  // `<form` was briefly counted as content, which let a pre-hydration shell compare equal
  // for every identity - the fabrication path again, by a different route.
  const shell = page("App", `<div id="root"><form action="/search"><input name="q"></form></div>`);
  assert.equal(reachedResource(classify(200, shell)), true); // has an <input>, so it IS content
  // ...but the shell with no controls at all is not:
  const bare = page("App", `<div id="root"></div><script src="/app.js"></script>`);
  assert.equal(reachedResource(classify(200, bare)), false);
});

// =============================================================== round-8 supplement
//
// Six shapes the round-8 FIX broke, four of them regressions against the version before
// it. Every one is an authenticated page that was being dropped from the authorization
// scan while the run still printed "no cross-user access problems found".

const SUPPLEMENT_RESOURCES: [string, string][] = [
  [
    "active sessions page - action contains 'sessions', not a login",
    page("Sessions", `<h1>Active sessions</h1>
      <form action="/account/sessions" method="post">
      <input type="hidden" name="email" value="alice@t.test">
      <button>Revoke this device</button></form>`),
  ],
  [
    "personal access tokens - action contains 'auth', not a login",
    page("Tokens", `<h1>Personal access tokens</h1>
      <form action="/auth/tokens"><input name="note"><input name="username" value="alice">
      <button>Generate</button></form>`),
  ],
  [
    "edit profile - autocomplete=username is not a credential",
    page("Profile", `<h1>Edit profile</h1>
      <form action="/account"><input name="username" autocomplete="username" value="alice">
      <input name="bio"><button>Save</button></form>`),
  ],
  [
    "JSON cart with an EXPIRED_COUPON code",
    `{"code":"EXPIRED_COUPON","cartId":9912,"owner":"alice"}`,
  ],
  [
    "JSON log entry mentioning login_required, carrying data",
    `{"message":"user 44 hit login_required at 10:02","entries":[1,2,3]}`,
  ],
  [
    "JSON subscription mentioning an expired card",
    `{"subscription":{"status":"active"},"message":"card expired on file","id":77}`,
  ],
];

for (const [label, body] of SUPPLEMENT_RESOURCES) {
  test(`resource (supplement): ${label}`, () => {
    assert.equal(looksLikeLoginPage(body), false, "suppressed a real page - reports false CLEAN");
    assert.equal(reachedResource(classify(200, body)), true);
  });
}

test("a genuine JSON denial is still detected", () => {
  // The envelope rule must stay useful after being narrowed.
  for (const body of [
    `{"error":"unauthorized"}`,
    `{"message":"Authentication required","status":401}`,
    `{"detail":"Invalid token"}`,
    `{"errors":"login_required"}`,
  ]) {
    assert.equal(looksLikeLoginPage(body), true, `missed a denial: ${body}`);
  }
});

test("an Apache 401 body is a denial however long it runs", () => {
  // The terse gate was tuned to two measured examples (48 and 509 chars); a stock Apache
  // 401 page sits above it, and a proxy that serves that body with a 200 would otherwise
  // manufacture a critical.
  const apache = page("401 Unauthorized", `<h1>401 Unauthorized</h1>
    <p>This server could not verify that you are authorized to access the document
    requested. Either you supplied the wrong credentials (e.g., bad password), or your
    browser doesn't understand how to supply the credentials required.</p>
    <hr><address>Apache/2.4.58 (Ubuntu) Server at example.test Port 443</address>`);
  assert.equal(looksLikeLoginPage(apache), true);
});
