/**
 * Coverage-gap detection tests. Offline: no browser, no network.
 *
 * The thing worth testing here is that it does not lie in either direction - it must not
 * claim coverage nothing provides, and it must not report a gap that a spec clearly fills.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCoverage, type FeatureEntry } from "./coverage.js";
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
    links: 0,
    authRequired: false,
    ok: true,
    mode: "anon",
    crawledAt: "",
    ...over,
  }) as unknown as PageRecord;

const specs = (text: string) => ({ text: text.toLowerCase(), files: ["a.spec.ts"] });
const noFeatures: FeatureEntry[] = [];

test("a page a spec visits counts as covered", () => {
  const cov = computeCoverage(
    [page({ url: "https://t.test/login", template: "https://t.test/login" })],
    noFeatures,
    specs(`await page.goto("/login")`),
  );
  assert.equal(cov.templates.covered, 1);
  assert.deepEqual(cov.templates.uncovered, []);
});

test("a page nothing mentions is reported as a gap", () => {
  const cov = computeCoverage(
    [page({ url: "https://t.test/orphan", template: "https://t.test/orphan" })],
    noFeatures,
    specs(`await page.goto("/login")`),
  );
  assert.equal(cov.templates.covered, 0);
  assert.equal(cov.gaps.filter((g) => g.kind === "template").length, 1);
});

test("Phase 5 feature mapping also counts as coverage", () => {
  const cov = computeCoverage(
    [page({ url: "https://t.test/a", template: "https://t.test/a" })],
    [{ feature: "A", template: "https://t.test/a" }],
    specs(""),
  );
  assert.equal(cov.templates.covered, 1);
});

test("an untested form is a HIGH weight gap, ranked above controls", () => {
  const cov = computeCoverage(
    [
      page({
        url: "https://t.test/signup",
        template: "https://t.test/signup",
        forms: [{ action: "/register", method: "post", destructive: false,
          fields: [{ name: "email", type: "email", label: "Email", required: true }] }],
        buttons: ["Some Button"],
      }),
    ],
    noFeatures,
    specs(""),
  );
  const formGap = cov.gaps.find((g) => g.kind === "form");
  assert.ok(formGap, "expected a form gap");
  assert.equal(formGap.weight, "high");
  // High-weight gaps sort first, so the list leads with what matters.
  assert.equal(cov.gaps[0]?.weight, "high");
});

test("a form is covered when a spec names its action", () => {
  const cov = computeCoverage(
    [page({ forms: [{ action: "/register", method: "post", destructive: false, fields: [] }] })],
    noFeatures,
    specs(`await page.goto("/x"); expect(res.url()).toContain("/register")`),
  );
  assert.equal(cov.forms.covered, 1);
  assert.equal(cov.gaps.filter((g) => g.kind === "form").length, 0);
});

test("a form is covered when a spec names one of its fields", () => {
  const cov = computeCoverage(
    [page({ forms: [{ action: "", method: "post", destructive: false,
      fields: [{ name: "coupon_code", type: "text", label: "Coupon", required: false }] }] })],
    noFeatures,
    specs(`await page.fill('[name=coupon_code]', "X")`),
  );
  assert.equal(cov.forms.covered, 1);
});

test("a button no spec names is reported", () => {
  const cov = computeCoverage(
    [page({ buttons: ["Publish", "Save draft"] })],
    noFeatures,
    specs(`getByRole("button", { name: "Publish" })`),
  );
  assert.equal(cov.controls.total, 2);
  assert.equal(cov.controls.covered, 1);
  assert.ok(cov.gaps.some((g) => g.detail.includes("Save draft")));
});

test("failed pages are excluded - a page that never loaded is not an untested page", () => {
  const cov = computeCoverage(
    [page({ url: "https://t.test/dead", template: "https://t.test/dead", ok: false })],
    noFeatures,
    specs(""),
  );
  assert.equal(cov.templates.total, 0);
});

test("one template, many sample URLs, counted once", () => {
  const cov = computeCoverage(
    [
      page({ url: "https://t.test/u/1", template: "https://t.test/u/:id" }),
      page({ url: "https://t.test/u/2", template: "https://t.test/u/:id" }),
      page({ url: "https://t.test/u/3", template: "https://t.test/u/:id" }),
    ],
    noFeatures,
    specs(""),
  );
  assert.equal(cov.templates.total, 1);
});

test("the richest sample of a template is the one measured", () => {
  // Otherwise a template's forms could go uncounted because a barer sample won.
  const cov = computeCoverage(
    [
      page({ url: "https://t.test/u/1", template: "https://t.test/u/:id" }),
      page({
        url: "https://t.test/u/2",
        template: "https://t.test/u/:id",
        forms: [{ action: "/save", method: "post", destructive: false, fields: [] }],
      }),
    ],
    noFeatures,
    specs(""),
  );
  assert.equal(cov.forms.total, 1);
});

test("a 404 page is not counted as an untested page", () => {
  const cov = computeCoverage(
    [
      page({ url: "https://t.test/real", template: "https://t.test/real", status: 200 }),
      page({ url: "https://t.test/gone", template: "https://t.test/gone", status: 404 }),
    ],
    noFeatures,
    specs(`page.goto("/real")`),
  );
  // One reachable page, and it is covered: 100%, not 50%.
  assert.equal(cov.templates.total, 1);
  assert.equal(cov.templates.covered, 1);
});


test("an anonymous form is credited when a spec visits its page", () => {
  // No action and no named fields: there is nothing else to match on, so refusing to
  // credit it would make the form permanently uncoverable.
  const cov = computeCoverage(
    [
      page({
        url: "https://t.test/checkboxes",
        template: "https://t.test/checkboxes",
        forms: [{ action: "", method: "get", destructive: false,
          fields: [{ name: "", type: "checkbox", label: "", required: false }] }],
      }),
    ],
    noFeatures,
    specs(`await page.goto("/checkboxes")`),
  );
  assert.equal(cov.forms.covered, 1);
  assert.equal(cov.gaps.filter((g) => g.kind === "form").length, 0);
});

test("an anonymous form on a page no spec visits is still a gap", () => {
  const cov = computeCoverage(
    [
      page({
        url: "https://t.test/orphan",
        template: "https://t.test/orphan",
        forms: [{ action: "", method: "get", destructive: false,
          fields: [{ name: "", type: "checkbox", label: "", required: false }] }],
      }),
    ],
    noFeatures,
    specs(`await page.goto("/elsewhere")`),
  );
  assert.equal(cov.forms.covered, 0);
});

test("a NAMED form is not credited just because the page is visited", () => {
  // The fallback must not weaken the rule for forms that do offer something to match.
  const cov = computeCoverage(
    [
      page({
        url: "https://t.test/signup",
        template: "https://t.test/signup",
        forms: [{ action: "/register", method: "post", destructive: false,
          fields: [{ name: "email", type: "email", label: "Email", required: true }] }],
      }),
    ],
    noFeatures,
    specs(`await page.goto("/signup")`),
  );
  assert.equal(cov.forms.covered, 0);
});

// ------------------------------------------------- audit round 1 regressions

test("a path named only in a COMMENT is not coverage", () => {
  const cov = computeCoverage(
    [
      page({
        url: "https://t.test/checkboxes",
        template: "https://t.test/checkboxes",
        forms: [{ action: "", method: "get", destructive: false,
          fields: [{ name: "", type: "checkbox", label: "", required: false }] }],
      }),
    ],
    noFeatures,
    { text: "// todo: write a test for /checkboxes one day", files: ["x.spec.ts"] },
  );
  assert.equal(cov.templates.covered, 0, "credited a commented-out intention");
  assert.equal(cov.forms.covered, 0, "an unwritten test laundered into forms.covered");
});

test("a longer path does not credit the shorter path it contains", () => {
  // A spec visiting /notification_message_rendered credited /notification_message for free.
  const cov = computeCoverage(
    [
      page({ url: "https://t.test/notification_message", template: "https://t.test/notification_message" }),
      page({ url: "https://t.test/notification_message_rendered", template: "https://t.test/notification_message_rendered" }),
    ],
    noFeatures,
    specs(`await page.goto("/notification_message_rendered")`),
  );
  assert.equal(cov.templates.total, 2);
  assert.equal(cov.templates.covered, 1, "prefix bleed: the shorter path was credited");
});

test("a 5xx page is COUNTED, not excluded", () => {
  // Excluding it let a site erroring under load raise its own coverage score, and dropped
  // the very page F-010 (/upload returns 500) was found on.
  const cov = computeCoverage(
    [page({ url: "https://t.test/upload", template: "https://t.test/upload", status: 500 })],
    noFeatures,
    specs(""),
  );
  assert.equal(cov.templates.total, 1);
  assert.equal(cov.templates.covered, 0);
});

test("410 Gone is excluded like 404", () => {
  const cov = computeCoverage(
    [page({ url: "https://t.test/old", template: "https://t.test/old", status: 410 })],
    noFeatures,
    specs(""),
  );
  assert.equal(cov.templates.total, 0);
});

test("a real navigation still counts", () => {
  for (const src of [
    `await page.goto("/upload")`,
    `page.goto('/upload')`,
    `await expect(page).toHaveURL("/upload")`,
    `href="/upload"`,
    `await page.goto("/upload?x=1")`,
  ]) {
    const cov = computeCoverage(
      [page({ url: "https://t.test/upload", template: "https://t.test/upload" })],
      noFeatures,
      specs(src),
    );
    assert.equal(cov.templates.covered, 1, `not credited for: ${src}`);
  }
});
