/**
 * A crawl that went nowhere has to say so.
 *
 * Built from a real run: a login-gated target was crawled anonymously and produced exactly
 * one page - the sign-in screen - reported as "pages crawled: 1" and nothing else. Coverage
 * then computed percentages against that one page and the report rendered them. The tests
 * below pin both directions, because the failure that matters here is a FALSE ALARM on a
 * genuinely small site just as much as silence on a degenerate one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeCrawl, isLoginPage } from "./crawl-verdict.js";
import type { PageRecord } from "./crawl.js";

const page = (over: Partial<PageRecord>): PageRecord =>
  ({
    url: "https://t.test/x",
    template: "https://t.test/x",
    depth: 0,
    status: 200,
    title: "",
    loadMs: 1,
    screenshot: null,
    consoleErrors: [],
    failedRequests: [],
    pageErrors: [],
    forms: [],
    buttons: [],
    deniedButtons: [],
    deniedLinks: [],
    links: 5,
    authRequired: false,
    redirected: false,
    ok: true,
    mode: "anon",
    crawledAt: "",
    ...over,
  }) as unknown as PageRecord;

/** A page whose form carries a password field. */
const signIn = (url: string) =>
  page({
    url,
    template: url,
    title: "Swag Labs",
    links: 0,
    forms: [
      {
        action: "",
        method: "post",
        fields: [
          { name: "user-name", type: "text", label: "Username", required: false },
          { name: "password", type: "password", label: "Password", required: false },
        ],
        destructive: false,
      },
    ],
  } as Partial<PageRecord>);

test("the real case: one page, and it is the login screen", () => {
  const s = judgeCrawl([signIn("https://t.test/")], "anon");
  assert.equal(s.verdict, "login-wall");
  assert.match(s.reason, /sign-in screen/);
  assert.match(s.reason, /auth mode/, "the reason has to tell someone what to do next");
  assert.equal(s.pages, 1);
  assert.equal(s.loginPages, 1);
});

test("a password field identifies the login screen whatever the wording", () => {
  // Structural, so it holds for a site in any language and with any button text.
  assert.equal(isLoginPage(signIn("https://t.test/anmelden")), true);
  // ...and the title route, for a login page that renders its form later.
  assert.equal(isLoginPage(page({ title: "Sign In - Shop" })), true);
  assert.equal(isLoginPage(page({ title: "Products" })), false);
  // authRequired is set by the crawler when a page redirected to a login hint.
  assert.equal(isLoginPage(page({ title: "Account", authRequired: true })), true);
});

test("a large crawl that is mostly login screens is still a login wall", () => {
  // The failure is a ratio, not a count: forty pages that are all the sign-in screen is
  // the same nothing as one page.
  const records = [
    ...Array.from({ length: 20 }, (_, i) => signIn(`https://t.test/p${i}`)),
    ...Array.from({ length: 10 }, (_, i) => page({ url: `https://t.test/ok${i}` })),
  ];
  const s = judgeCrawl(records, "anon");
  assert.equal(s.verdict, "login-wall");
  assert.equal(s.loginPages, 20);
});

test("a genuinely small site is NOT flagged", () => {
  // The false alarm this must avoid. Three real pages with real links is a small site
  // crawled properly, and calling that inconclusive would train people to ignore the
  // warning entirely.
  const s = judgeCrawl(
    [
      page({ url: "https://t.test/a", template: "https://t.test/a" }),
      page({ url: "https://t.test/b", template: "https://t.test/b" }),
      page({ url: "https://t.test/c", template: "https://t.test/c" }),
    ],
    "anon",
  );
  assert.equal(s.verdict, "ok");
  assert.equal(s.reason, "");
});

test("pages that loaded but yielded no links are called out", () => {
  const s = judgeCrawl(
    Array.from({ length: 6 }, (_, i) =>
      page({ url: `https://t.test/p${i}`, template: `https://t.test/p${i}`, links: 0 }),
    ),
    "anon",
  );
  assert.equal(s.verdict, "no-links");
  assert.match(s.reason, /no links were discovered/);
});

test("a single ordinary page is too few to conclude anything from", () => {
  const s = judgeCrawl([page({ links: 3 })], "anon");
  assert.equal(s.verdict, "too-few-pages");
  assert.match(s.reason, /meaningless/);
});

test("failed navigations are not counted as crawled pages", () => {
  // ok === false means the navigation itself failed. Counting those would hide a login
  // wall behind a pile of non-pages.
  const records = [
    signIn("https://t.test/"),
    page({ url: "https://t.test/dead1", ok: false }),
    page({ url: "https://t.test/dead2", ok: false }),
    page({ url: "https://t.test/dead3", ok: false }),
  ];
  const s = judgeCrawl(records, "anon");
  assert.equal(s.pages, 1, "only the one real page counts");
  assert.equal(s.verdict, "login-wall");
});

test("an empty crawl does not divide by zero", () => {
  const s = judgeCrawl([], "anon");
  assert.equal(s.verdict, "too-few-pages");
  assert.equal(s.pages, 0);
});

test("the advice differs between an anonymous and an authenticated crawl", () => {
  // Telling someone to "configure login and crawl in auth mode" when they are ALREADY in
  // auth mode is the boilerplate that teaches people to ignore warnings.
  const anon = judgeCrawl([signIn("https://t.test/")], "anon");
  assert.match(anon.reason, /Configure the "login" block/);

  const auth = judgeCrawl([signIn("https://t.test/")], "auth");
  assert.doesNotMatch(auth.reason, /Configure the "login" block/);
  assert.match(auth.reason, /not a missing login/);
});

test("a 404 on a direct request is called out as client-side routing", () => {
  // The real case: saucedemo answers 404 for /inventory.html on a direct GET. The page
  // exists only after a click, so no amount of URL crawling will ever reach it, and the
  // verdict has to say that rather than imply the login is misconfigured.
  const s = judgeCrawl(
    [
      signIn("https://t.test/"),
      page({ url: "https://t.test/inventory.html", template: "https://t.test/inventory.html", status: 404, links: 0 }),
    ],
    "auth",
  );
  assert.equal(s.verdict, "login-wall");
  assert.match(s.reason, /client-routed/);
  assert.match(s.reason, /interaction-driven/);
});
