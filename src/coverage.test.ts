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
