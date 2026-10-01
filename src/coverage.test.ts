/**
 * Coverage-gap detection tests. Offline: no browser, no network.
 *
 * The thing worth testing here is that it does not lie in either direction - it must not
 * claim coverage nothing provides, and it must not report a gap that a spec clearly fills.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCoverage, coverageKey, type FeatureEntry } from "./coverage.js";
import { templateOf, type PageRecord } from "./crawl.js";

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

// -------------------------------------------------- coverage unit vs crawl template

const at = (u: string) => page({ url: u, template: u });

test("coverageKey folds a query ONLY into a bare page that really exists", () => {
  const img = "https://t.test/shifting_content/image?mode=random&pixel_shift=100";
  const bare = "https://t.test/shifting_content/image";

  // With the bare page present, the query is a knob and folds away entirely.
  const parents = new Set([bare]);
  assert.equal(coverageKey(img, parents), bare);
  assert.equal(coverageKey(bare, parents), bare, "one knob setting is not a second page");

  // With no bare page underneath, NOTHING is folded - not even the value. Keeping names
  // and dropping values looked safe and merged ?page=login with ?page=admin.
  assert.equal(coverageKey(img), img, "no parent means no folding");
  assert.notEqual(
    coverageKey("https://t.test/x?page=login"),
    coverageKey("https://t.test/x?page=admin"),
    "two screens behind the same parameter name are two units",
  );
});

test("the coverage fold does NOT change what the crawler samples", () => {
  // crawl.ts keeps query values on purpose - folding them capped every paginated
  // section at three crawled pages. The coverage fold must stay on this side of the wall.
  assert.notEqual(
    templateOf("https://t.test/list?page=1"),
    templateOf("https://t.test/list?page=2"),
  );
});

test("query variants collapse only when their bare page was crawled", () => {
  const variants = [
    at("https://t.test/jitter?mode=random"),
    at("https://t.test/jitter?mode=fixed"),
    at("https://t.test/jitter?pixel_shift=100"),
  ];

  // No bare /jitter in the crawl: each variant stands alone, because nothing proves they
  // are the same page and the value may be what selects the screen.
  const alone = computeCoverage(variants, noFeatures, specs(""));
  assert.equal(alone.templates.total, 3);

  // Add the bare page and they are knobs on it.
  const folded = computeCoverage([at("https://t.test/jitter"), ...variants], noFeatures, specs(""));
  assert.equal(folded.templates.total, 1, "one page with knobs is one thing to test");
});

test("a spec visiting the bare path covers its knobs, but never its routing", () => {
  // Knob case: /jitter exists, so visiting it covers the unit its variants folded into.
  const knobs = computeCoverage(
    [at("https://t.test/jitter"), at("https://t.test/jitter?pixel_shift=100")],
    noFeatures,
    specs('await safeGoto(page, "/jitter");'),
  );
  assert.equal(knobs.templates.covered, 1);
  assert.deepEqual(knobs.templates.uncovered, []);

  // Routing case: no bare page, so visiting /index.php proves nothing about ?page=admin.
  const routed = computeCoverage(
    [at("https://t.test/index.php?page=admin")],
    noFeatures,
    specs('await safeGoto(page, "/index.php");'),
  );
  assert.equal(routed.templates.covered, 0, "the bare path is not a visit to the screen");
});

test("a query folds into the bare page when that page was itself crawled", () => {
  const pages = [
    at("https://t.test/jitter"),
    at("https://t.test/jitter?mode=random"),
    at("https://t.test/jitter?pixel_shift=100"),
    at("https://t.test/jitter?mode=random&pixel_shift=100"),
  ];
  const cov = computeCoverage(pages, noFeatures, specs(""));
  assert.equal(cov.templates.total, 1, "one page with knobs is one thing to test");
  assert.deepEqual(cov.templates.uncovered, ["https://t.test/jitter"]);
});

test("a query that IS the routing keeps every distinct value as its own unit", () => {
  // /index.php?page=login and ?page=admin are two screens, and /index.php was never
  // crawled as a page - there is nothing underneath for them to fold into, which is
  // precisely why the VALUE is the only thing telling them apart.
  const pages = [
    at("https://t.test/index.php?page=login"),
    at("https://t.test/index.php?page=admin"),
    at("https://t.test/index.php?page=login&tab=sso"),
  ];
  const cov = computeCoverage(pages, noFeatures, specs(""));
  assert.equal(cov.templates.total, 3, "three distinct screens, three units");
});

test("a 404 bare path does not swallow its query variants", () => {
  const pages = [
    page({ url: "https://t.test/r", template: "https://t.test/r", status: 404 }),
    at("https://t.test/r?a=1"),
    at("https://t.test/r?b=1"),
  ];
  const cov = computeCoverage(pages, noFeatures, specs(""));
  assert.equal(cov.templates.total, 2, "a page that does not exist is not the parent of anything");
});

test("a spec visiting a concrete id covers the :id template", () => {
  // visitsPath has always rewritten :id to a wildcard, but computeCoverage only ever
  // handed it the sampled URL, so the branch was dead and this scored 0.
  const cov = computeCoverage(
    [page({ url: "https://t.test/infinite_scroll/3", template: "https://t.test/infinite_scroll/:id" })],
    noFeatures,
    specs('await safeGoto(page, "/infinite_scroll/1");'),
  );
  assert.equal(cov.templates.covered, 1);
  assert.deepEqual(cov.templates.uncovered, []);
});

test("the template form does not credit an unrelated page", () => {
  const cov = computeCoverage(
    [page({ url: "https://t.test/users/3", template: "https://t.test/users/:id" })],
    noFeatures,
    specs('await safeGoto(page, "/orders/1");'),
  );
  assert.equal(cov.templates.covered, 0);
});

test("the site root is creditable, but only by an exact navigation to it", () => {
  const root = [page({ url: "https://t.test/", template: "https://t.test/" })];

  const covered = computeCoverage(root, noFeatures, specs('await safeGoto(page, "/");'));
  assert.equal(covered.templates.covered, 1, "a spec that visits the landing page tests it");

  // The reason "/" was refused outright: it must not be credited by every other path.
  const notCovered = computeCoverage(root, noFeatures, specs('await safeGoto(page, "/login");'));
  assert.equal(notCovered.templates.covered, 0, "/login is not a visit to the root");

  const alsoNot = computeCoverage(root, noFeatures, specs('expect(x).toBe("/");'));
  assert.equal(alsoNot.templates.covered, 0, "a mention outside a navigation is not a visit");
});

// ------------------------------------------------- the cases the first fixtures missed
//
// An audit found three over-credits that the tests above were constructed to miss: each
// fixture was written from the implementation's own vocabulary, so it asserted the thing
// that was already obviously true. These are the failing cases, written from the audit's
// reproductions rather than from the code.

test("a bare path that REDIRECTS is not a parent for its query variants", () => {
  // status is the status of the FINAL response, so /index.php -> 302 -> /index.php?page=home
  // is recorded as 200 against /index.php. Treating that stub as a real page folded three
  // separate admin screens into one covered unit, named in no gap list.
  const bare = page({ url: "https://t.test/index.php", template: "https://t.test/index.php" });
  (bare as { redirected: boolean }).redirected = true;

  const cov = computeCoverage(
    [
      bare,
      page({ url: "https://t.test/index.php?page=login", template: "https://t.test/index.php?page=login" }),
      page({ url: "https://t.test/index.php?page=admin", template: "https://t.test/index.php?page=admin" }),
      page({ url: "https://t.test/index.php?page=billing", template: "https://t.test/index.php?page=billing" }),
    ],
    noFeatures,
    specs('await safeGoto(page, "/index.php");'),
  );

  assert.equal(cov.templates.total, 4, "a redirect stub must not absorb the real screens");
  assert.equal(cov.templates.covered, 1);
  assert.equal(cov.templates.uncovered.length, 3, "the admin screens must be nameable gaps");
});

for (const status of [401, 403, 500, 503]) {
  test(`a bare path answering ${status} is not a parent either`, () => {
    // The old filter excluded only 404/410, so every one of these became a parent. A 403
    // on /admin is not "a page in its own right"; it is a locked door.
    const cov = computeCoverage(
      [
        page({ url: "https://t.test/admin", template: "https://t.test/admin", status }),
        page({ url: "https://t.test/admin?page=users", template: "https://t.test/admin?page=users" }),
      ],
      noFeatures,
      specs('await safeGoto(page, "/admin");'),
    );
    assert.equal(cov.templates.total, 2, `a ${status} must not swallow its query variants`);
  });
}

test("one navigation to a numeric id does not credit the uuid and hash shapes", () => {
  // crawl.ts emits :id, :uuid and :hash as DISTINCT templates, but all three used to
  // become the same catch-all wildcard, so visiting /u/1 scored all three - on a real app
  // usually three different resources, e.g. /share/:hash versus /share/:id.
  const cov = computeCoverage(
    [
      page({ url: "https://t.test/u/1", template: "https://t.test/u/:id" }),
      page({ url: "https://t.test/u/0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9", template: "https://t.test/u/:uuid" }),
      page({ url: `https://t.test/u/${"a".repeat(32)}`, template: "https://t.test/u/:hash" }),
    ],
    noFeatures,
    specs('await safeGoto(page, "/u/1");'),
  );
  assert.equal(cov.templates.covered, 1, "a numeric id is not a uuid and not a hash");
  assert.deepEqual(cov.templates.uncovered.sort(), [
    "https://t.test/u/:hash",
    "https://t.test/u/:uuid",
  ]);
});

for (const sibling of ["new", "settings", "export"]) {
  test(`visiting the sibling literal /u/${sibling} does not credit /u/:id`, () => {
    // The classic collision: /u/new and /u/:id are different pages, and the old wildcard
    // matched any non-slash segment, so testing the "new" form marked every user page
    // tested. This is the case the original guard test could not catch, because it changed
    // the FIRST path segment (/users/:id versus goto("/orders/1")) instead of the last.
    const cov = computeCoverage(
      [page({ url: "https://t.test/u/7", template: "https://t.test/u/:id" })],
      noFeatures,
      specs(`await safeGoto(page, "/u/${sibling}");`),
    );
    assert.equal(cov.templates.covered, 0, `/u/${sibling} is not a visit to /u/:id`);
  });
}

test("a numeric and an interpolated navigation both still credit :id", () => {
  // The other direction. Restricting the placeholder to \\d+ silently stopped crediting
  // every interpolated navigation in the suite until the shapes also accepted ${...}.
  for (const text of [
    'await safeGoto(page, "/u/42");',
    "await safeGoto(page, `/u/${id}`);",
    "await safeGoto(page, `/u/${user.id}`);",
  ]) {
    const cov = computeCoverage(
      [page({ url: "https://t.test/u/7", template: "https://t.test/u/:id" })],
      noFeatures,
      specs(text),
    );
    assert.equal(cov.templates.covered, 1, `should credit: ${text}`);
  }
});

test("an href selector or a markup assertion does not credit the site root", () => {
  // "/" is one character, so it matched inside `a[href="/"]` and inside a toContain on
  // markup - and this repository is a link-checking QA agent, so a spec asserting the nav
  // bar has a home link is the common case, not a contrived one. The test that was
  // supposed to guard this asserted "only by an exact navigation" and never tried an href.
  const root = [page({ url: "https://t.test/", template: "https://t.test/" })];

  for (const text of [
    "await page.locator('a[href=\"/\"]').click();",
    "expect(html).toContain('<a href=\"/\">home</a>');",
    'await expect(page.locator("nav a[href=\'/\']")).toBeVisible();',
  ]) {
    const cov = computeCoverage(root, noFeatures, specs(text));
    assert.equal(cov.templates.covered, 0, `must not credit the root: ${text}`);
  }

  // ...while the real navigations still do, including the two concatenated forms.
  for (const text of [
    'await safeGoto(page, "/");',
    'await page.goto(baseURL + "/");',
    "await page.goto(`${baseURL}/`);",
  ]) {
    const cov = computeCoverage(root, noFeatures, specs(text));
    assert.equal(cov.templates.covered, 1, `must credit the root: ${text}`);
  }
});

test("a feature recorded against a query variant is folded like the map keys", () => {
  // featureTemplates had no test at all. A Phase 5 feature recorded against
  // /jitter?mode=random must still match the unit it belongs to once the query is folded.
  const pages = [
    page({ url: "https://t.test/jitter", template: "https://t.test/jitter" }),
    page({ url: "https://t.test/jitter?mode=random", template: "https://t.test/jitter?mode=random" }),
  ];
  const cov = computeCoverage(
    pages,
    [{ template: "https://t.test/jitter?mode=random" } as FeatureEntry],
    specs(""),
  );
  assert.equal(cov.templates.total, 1);
  assert.equal(cov.templates.covered, 1, "the feature must credit the folded unit");
});
