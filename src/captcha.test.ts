/**
 * CAPTCHA detection, with real widget markup.
 *
 * The snippets below are the shapes the providers actually document, not invented ones -
 * writing fixtures from a detector's own vocabulary is how this project previously shipped
 * a login classifier that was wrong five times running.
 *
 * Note what is NOT tested here, because it is not implemented and will not be: solving a
 * challenge. The job is to know a challenge is there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCaptcha, isBlocked, unprotectedSensitiveForm } from "./captcha.js";

const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

test("reCAPTCHA v2 checkbox markup is detected and is blocking", () => {
  const html = page(
    `<form action="/signup" method="post">
       <div class="g-recaptcha" data-sitekey="6Lc_aXkUAAAAABdPW3PdSvPGCEDZKTq6XxxxxxXX"></div>
       <script src="https://www.google.com/recaptcha/api.js" async defer></script>
     </form>`,
  );
  const found = detectCaptcha(html);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.kind, "recaptcha-v2");
  assert.equal(isBlocked(found), true);
});

test("reCAPTCHA v3 is detected but is NOT treated as blocking", () => {
  // v3 scores silently. Reporting it as a wall would stop flows that actually work.
  const html = page(
    `<script src="https://www.google.com/recaptcha/api.js?render=6Lc_aXkUAAAAABdPW3PdSvPGCEDZKTq6XxxxxxXX"></script>`,
  );
  const found = detectCaptcha(html);
  assert.equal(found.length, 1, "must not also report v2 for the same widget");
  assert.equal(found[0]?.kind, "recaptcha-v3");
  assert.equal(isBlocked(found), false);
});

test("hCaptcha and Turnstile are detected", () => {
  const h = detectCaptcha(page(`<div class="h-captcha" data-sitekey="abc"></div>
    <script src="https://js.hcaptcha.com/1/api.js"></script>`));
  assert.equal(h[0]?.kind, "hcaptcha");
  assert.equal(isBlocked(h), true);

  const t = detectCaptcha(page(`<div class="cf-turnstile" data-sitekey="0x4AAA"></div>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>`));
  assert.equal(t[0]?.kind, "turnstile");
  assert.equal(isBlocked(t), true);
});

test("a home-grown image CAPTCHA field is detected", () => {
  const html = page(
    `<form action="/register"><img src="/captcha.php">
     <input type="text" name="captcha_code" maxlength="6"></form>`,
  );
  const found = detectCaptcha(html);
  assert.equal(found[0]?.kind, "image-captcha");
  assert.equal(isBlocked(found), true);
});

test("an ordinary page reports nothing", () => {
  // The false-positive direction. A detector that fires on normal pages would mark every
  // flow as gated and the signal would be worthless.
  for (const body of [
    `<form action="/login"><input name="username"><input name="password" type="password"></form>`,
    `<p>We use a captcha on our contact page.</p>`,
    `<img src="/img/photo.jpg" alt="a photo">`,
    `<input name="verification" type="text">`,
  ]) {
    assert.deepEqual(detectCaptcha(page(body)), [], body.slice(0, 40));
  }
});

test("two different providers on one page are both reported", () => {
  const found = detectCaptcha(
    page(`<div class="h-captcha" data-hcaptcha-sitekey="a"></div>
          <div class="cf-turnstile"></div>`),
  );
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.kind).sort(), ["hcaptcha", "turnstile"]);
});

test("a sensitive form with no protection on the page is reported", () => {
  // The finding this project could not previously express: a signup form anyone can
  // automate against.
  const r = unprotectedSensitiveForm(["/signup", "email", "password"], []);
  assert.equal(r?.what, "account creation");

  assert.equal(unprotectedSensitiveForm(["/forgot_password", "email"], [])?.what, "password reset");
  assert.equal(unprotectedSensitiveForm(["/contact-us", "message"], [])?.what, "a message-sending form");
  assert.equal(unprotectedSensitiveForm(["/checkout", "card_number"], [])?.what, "a payment form");
});

test("a protected form is not reported, even an invisible one", () => {
  const v2 = detectCaptcha(page(`<div class="g-recaptcha" data-sitekey="x"></div>`));
  assert.equal(unprotectedSensitiveForm(["/signup", "email"], v2), null);

  // v3 is not blocking, but it IS protection - the point of this check is whether bot
  // protection exists, not whether it stops our crawler.
  const v3 = detectCaptcha(
    page(`<script src="https://www.google.com/recaptcha/api.js?render=6Lc_aXkUAAAAABdPW3xxxxxxXX"></script>`),
  );
  assert.equal(unprotectedSensitiveForm(["/signup", "email"], v3), null);
});

test("an ordinary form is not demanded to have a CAPTCHA", () => {
  // Demanding one everywhere is how a check gets switched off. A search box does not need
  // bot protection and must not be reported as missing it.
  for (const ids of [["/search", "q"], ["/login", "username", "password"], ["", "sort"], [""]]) {
    assert.equal(unprotectedSensitiveForm(ids, []), null, ids.join(","));
  }
});
