/**
 * Offline regression tests for the pure logic - no browser, no network, no target site.
 *
 *   npx tsx --test src/*.test.ts
 *
 * Every case here is a bug that was actually found and fixed, not a hypothetical. If one
 * of these starts failing, a guarantee this tool makes in its README has stopped holding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDenied, isDeniedUrl, isAllowedUrl, type QaConfig } from "./config.js";
import { normalizeUrl, dedupKey, templateOf } from "./crawl.js";
import { toBurpXml, type HttpExchange } from "./http-history.js";
import { extractCode, extractLinks } from "./email/lib.js";

const cfg = {
  allowedOrigins: ["https://target.test"],
  denyList: [
    "delete",
    "remove",
    "deactivate",
    "empty cart",
    "cancel subscription",
    "close account",
    "pay",
    "purchase",
    "checkout",
  ],
  denyUrlExceptions: [
    "/add_remove_elements",
  ],
} as unknown as QaConfig;

// ------------------------------------------------------------------ deny matching

test("deny-list survives the ways real UIs spell a word", () => {
  for (const label of [
    "Delete",
    "DELETE",
    "delete",
    "Dele​te", // zero-width space
    "Délete", // combining acute
    "Ｄelete", // fullwidth D
    "Rem ove", // letter-spaced
    "  Delete  account ",
    "Delete account", // nbsp
  ]) {
    assert.equal(isDenied(label, cfg), true, `should be denied: ${JSON.stringify(label)}`);
  }
});

test("deny-list does not swallow innocent labels", () => {
  for (const label of ["Repay loan", "Payment history", "Undelete", "Display", "Removal notes", "Paypal receipts"]) {
    assert.equal(isDenied(label, cfg), false, `should be allowed: ${JSON.stringify(label)}`);
  }
});

test("destructive URLs are denied, not just destructive button labels", () => {
  for (const url of [
    "https://target.test/admin/users/7/delete",
    "https://target.test/account/close",
    "https://target.test/cart?action=remove&id=1",
    "https://target.test/api/v1/destroy",
    "/users/3/deactivate",
  ]) {
    assert.equal(isDeniedUrl(url, cfg), true, `should be denied: ${url}`);
  }
  for (const url of ["https://target.test/payments", "https://target.test/deleted-items-report"]) {
    assert.equal(isDeniedUrl(url, cfg), false, `should be allowed: ${url}`);
  }
});

test("isAllowedUrl rejects lookalike and userinfo hosts", () => {
  assert.equal(isAllowedUrl("https://target.test/x", cfg), true);
  assert.equal(isAllowedUrl("https://target.test.evil.com/x", cfg), false);
  assert.equal(isAllowedUrl("https://target.test@evil.com/x", cfg), false);
  assert.equal(isAllowedUrl("https://evil.com@target.test/x", cfg), false, "userinfo is refused outright");
  assert.equal(isAllowedUrl("http://target.test/x", cfg), false, "scheme downgrade");
  assert.equal(isAllowedUrl("javascript:alert(1)", cfg), false);
});

// ------------------------------------------------------------------ URL handling

test("normalizeUrl strips credentials", () => {
  assert.equal(normalizeUrl("https://u:pw@target.test/p"), "https://target.test/p");
});

test("normalizeUrl keeps what actually identifies a resource", () => {
  assert.equal(normalizeUrl("https://target.test/a%2Fb"), "https://target.test/a%2Fb");
  assert.equal(normalizeUrl("https://target.test/Path"), "https://target.test/Path");
  assert.equal(normalizeUrl("https://target.test/p?q=x%20y"), "https://target.test/p?q=x%20y");
  assert.equal(normalizeUrl("https://target.test/p?utm_source=x&id=9"), "https://target.test/p?id=9");
});

test("dedupKey folds only the trailing slash", () => {
  assert.equal(dedupKey("https://target.test/a/"), dedupKey("https://target.test/a"));
  assert.notEqual(dedupKey("https://target.test/a"), dedupKey("https://target.test/A"));
});

test("templateOf collapses ids but NOT pagination", () => {
  assert.equal(templateOf("https://target.test/users/1"), templateOf("https://target.test/users/2"));
  assert.notEqual(
    templateOf("https://target.test/list?page=1"),
    templateOf("https://target.test/list?page=2"),
    "collapsing query values capped every paginated section at 3 crawled pages",
  );
});


test("templateOf collapses a ULID, which is neither digits nor hex", () => {
  // 26 characters of Crockford base32. It matched none of the id rules - not all digits,
  // not a uuid, and not hex because it carries letters past F - so on an SPA target 35 of
  // 46 crawled pages came back as 35 separate templates, each counted as its own untested
  // page, and the templates coverage figure read 2%.
  const a = "https://t.test/product/01M3XCAC8QVZ53KPRDYNSB7ZGJ";
  const b = "https://t.test/product/01M3XCAC906ZH2WZ7YZGSBYHRQ";
  assert.equal(templateOf(a), templateOf(b));
  assert.equal(templateOf(a), "https://t.test/product/:ulid");

  // Crockford base32 leaves out I, L, O and U, and a ULID is exactly 26 characters, so a
  // word of the same length is not swallowed.
  const slug = "https://t.test/product/COMBINATIONPLIERSOURBLUE26";
  assert.notEqual(templateOf(slug), "https://t.test/product/:ulid");
  assert.equal(
    templateOf("https://t.test/product/combination-pliers"),
    "https://t.test/product/combination-pliers",
    "a human-readable slug is a page in its own right, not an id",
  );
});


// ------------------------------------------- concatenated destructive routes

/**
 * A URL concatenates what a label spaces out.
 *
 * Found by pointing the agent at a banking demo: /transfer.htm and /withdraw.htm were
 * correctly refused, because those are single words, while /billpay.htm was ALLOWED - the
 * path splits into the one token "billpay", and the deny entry "bill pay" cannot match it
 * on a word boundary. A money-moving route, waved through by the guard whose entire job is
 * to stop exactly that.
 */
const bankCfg = {
  ...cfg,
  denyList: [
    ...cfg.denyList,
    "bill pay",
    "transfer funds",
    "open new account",
    "request loan",
    "update profile",
    // Single words, as a real banking target would carry them. The regression test below
    // needs these present to prove the squash pass did not disturb word-boundary matching.
    "transfer",
    "withdraw",
    "deposit",
  ],
  denyUrlExceptions: [],
};

test("a concatenated multi-word destructive route is refused", () => {
  for (const path of [
    "/billpay.htm",
    "/BillPay.htm",
    "/bill-pay",
    "/bill_pay",
    "/transferfunds.htm",
    "/opennewaccount.htm",
    "/requestloan.htm",
    "/updateprofile.htm",
    "/parabank/billpay.htm?accountId=12345",
  ]) {
    assert.equal(
      isDeniedUrl(`https://bank.test${path}`, bankCfg),
      true,
      `${path} moves money or changes an account and must be refused`,
    );
  }
});

test("squashing does not start refusing innocent paths", () => {
  // The reason only MULTI-WORD entries are squashed: doing it to single words would match
  // "pay" inside "paypal" and "repayment", and a guard that blocks legitimate pages is a
  // guard somebody switches off.
  for (const path of [
    "/paypal-integration-docs",
    "/repayment-calculator",
    "/about.htm",
    "/news.htm",
    "/services/ParaBank?wsdl",
    "/closest-branch",
    "/transfers-explained-help",
  ]) {
    assert.equal(
      isDeniedUrl(`https://bank.test${path}`, bankCfg),
      false,
      `${path} is informational and must stay crawlable`,
    );
  }
});

test("the single-word routes that already worked still work", () => {
  // Regression guard: the squash pass is additive and must not have changed these.
  for (const path of ["/transfer.htm", "/withdraw.htm", "/deposit.htm"]) {
    assert.equal(isDeniedUrl(`https://bank.test${path}`, bankCfg), true, path);
  }
});

test("a deny-list exception still overrides the squash pass", () => {
  // Exceptions are checked first and must stay authoritative, or a target cannot opt a
  // known-safe path back in.
  const withException = { ...bankCfg, denyUrlExceptions: ["/billpay\\.htm$"] };
  assert.equal(isDeniedUrl("https://bank.test/billpay.htm", withException), false);
});

// ------------------------------------------------------------------ Burp XML

const exchange: HttpExchange = {
  time: "2026-01-02T03:04:05.000Z",
  url: "https://target.test/a",
  host: "target.test",
  ip: "1.2.3.4",
  port: 443,
  protocol: "https",
  method: "GET",
  path: "/a",
  extension: "null",
  request: "QQ==",
  status: 200,
  responseLength: 2,
  mimeType: "HTML",
  response: "QQ==",
};

test("XML export drops characters that would make the file unparseable", () => {
  const xml = toBurpXml([{ ...exchange, url: "https://target.test/a?q=\u0001\u0008" }]);
  assert.equal(/[\u0000-\u0008\u000e-\u001f]/.test(xml), false);
});

test("XML export cannot be made to grow an attribute", () => {
  const xml = toBurpXml([{ ...exchange, ip: '1" evil="y' }]);
  assert.equal(xml.includes('evil="y"'), false);
  assert.match(xml, /<host ip="1&quot; evil=&quot;y">/);
});

test("XML export coerces numeric fields instead of interpolating them", () => {
  const xml = toBurpXml([{ ...exchange, status: "200</status><x>" as unknown as number }]);
  // A non-numeric status becomes 0 rather than being pasted into the document.
  assert.equal(xml.includes("<x>"), false);
  assert.match(xml, /<status>0<\/status>/);
  assert.match(toBurpXml([{ ...exchange, port: NaN }]), /<port>0<\/port>/);
});

test("]]> inside a CDATA field is split, not emitted raw", () => {
  const xml = toBurpXml([{ ...exchange, path: "/a]]>b" }]);
  assert.match(xml, /<path><!\[CDATA\[\/a]]]]><!\[CDATA\[>b]]><\/path>/);
});

// ------------------------------------------------------------------ email

test("extractCode ignores digits that live inside a URL", () => {
  assert.equal(
    extractCode(`<a href="https://x.test/verify/998877">Verify</a><p>Your code: 314159</p>`),
    "314159",
  );
});

test("extractCode returns null rather than inventing a code", () => {
  assert.equal(extractCode("123456 Main Street\nSuite 400\nUnsubscribe."), null);
  assert.equal(extractCode("Nothing numeric here at all."), null);
});

test("extractCode still beats the usual decoys", () => {
  assert.equal(extractCode("Order #48213 confirmed. Your verification code is 903112."), "903112");
  assert.equal(extractCode("Total: 129900 USD. Your code: 4471"), "4471");
  assert.equal(extractCode("Call 18005551234. Your OTP is 5566"), "5566");
});

test("extractLinks puts the verification link first, not the tracker", () => {
  const html = `
    <a href="https://track.acme.test/o/abc123">logo</a>
    <img src="https://px.acme.test/p.gif">
    <a href="https://app.acme.test/verify?token=REALTOKEN0123456789">Verify your email</a>
    <a href="https://acme.test/unsubscribe?u=9">Unsubscribe</a>`;
  assert.equal(extractLinks(html)[0], "https://app.acme.test/verify?token=REALTOKEN0123456789");
});

test("extractLinks deprioritises unsubscribe in plain text too", () => {
  const txt = `Unsubscribe: https://acme.test/unsub?u=9\nConfirm: https://acme.test/confirm?t=abcdef0123456789`;
  assert.equal(extractLinks(txt)[0], "https://acme.test/confirm?t=abcdef0123456789");
});
