/**
 * The report must survive a malformed status file.
 *
 * A non-array `personas` crashed the whole report - not just that section - because the
 * code used `?? []`, which guards null and undefined but not a string. strArr() had been
 * written for exactly this and was sitting three hundred lines above, unused.
 *
 * These call buildReport() directly. The previous version copied src/, junctioned the real
 * node_modules into a temp box, spawned a subprocess render per test and then removed the
 * box recursively - 13 seconds of an 8 second suite, and one filesystem behaviour change
 * away from deleting node_modules through that junction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport } from "./report.js";

/** Render into a throwaway output directory and return the HTML. */
function renderWith(files: Record<string, string>): string {
  const box = mkdtempSync(join(tmpdir(), "qa-report-"));
  mkdirSync(join(box, "screenshots"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(box, name), body);
  }
  try {
    return buildReport(box);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

const MINIMAL_PAGE = JSON.stringify({
  url: "https://t.test/a",
  template: "https://t.test/a",
  status: 200,
  title: "a",
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
  depth: 0,
});

test("a non-array personas does not take the report down", () => {
  const html = renderWith({
    "pages.jsonl": MINIMAL_PAGE + "\n",
    "authz-status.json": JSON.stringify({ verdict: "clean", personas: "alice", sharedIdentity: "ab" }),
  });
  assert.match(html, /Authorization scan/);
  assert.match(html, /alice/, "a lone string persona should be shown, not silently dropped");
});

test("a corrupt status file renders the empty state, never a clean verdict", () => {
  const html = renderWith({
    "pages.jsonl": MINIMAL_PAGE + "\n",
    "authz-status.json": "{ not json",
  });
  assert.match(html, /No authorization scan in this run/);
  assert.doesNotMatch(html, /sev low">clean/);
});

test("markup in a verdict is escaped, not rendered", () => {
  const html = renderWith({
    "pages.jsonl": MINIMAL_PAGE + "\n",
    "authz-status.json": JSON.stringify({ verdict: "<img src=x onerror=alert(1)>", personas: [] }),
  });
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img src=x/);
});

test("a missing coverage bucket produces 0%, not NaN", () => {
  const html = renderWith({
    "pages.jsonl": MINIMAL_PAGE + "\n",
    "coverage.json": JSON.stringify({ templates: {}, forms: null }),
  });
  assert.doesNotMatch(html, /NaN/);
  assert.match(html, /Test coverage/);
});

test("an inconclusive verdict says so plainly", () => {
  // A scan that compared nothing must not look like a clean one.
  const html = renderWith({
    "pages.jsonl": MINIMAL_PAGE + "\n",
    "authz-status.json": JSON.stringify({ verdict: "inconclusive", compared: 0, templates: 48 }),
  });
  assert.match(html, /This scan proved nothing/);
});

test("rendering into a temp directory leaves the real output untouched", () => {
  // buildReport mutates a module-level OUT; if it did not reset, the next caller would
  // write into a directory that has just been deleted.
  renderWith({ "pages.jsonl": MINIMAL_PAGE + "\n" });
  const html = buildReport();
  assert.match(html, /QA report/);
});

// ------------------------------------------- does the report describe the current suite?

/**
 * The report quoted "72 tests" from a results file written nine hours earlier, before three
 * spec files existed, and said nothing about it. Two easy ways to get there:
 *
 *   npx playwright test --reporter=line     a CLI reporter REPLACES the configured ones,
 *                                           so the json reporter never runs and the old
 *                                           results file survives untouched
 *   npx playwright test one.spec.ts         overwrites the results with a subset
 *
 * A report that describes a different suite from the repository is worse than one that
 * describes none, so the mismatch has to be visible in the HTML.
 */

/** Render with a tests/ directory beside the output box, so provenance can be checked. */
function renderWithSuite(
  files: Record<string, string>,
  specs: Record<string, string>,
  opts?: { resultsOlderThanSpecs?: boolean },
): string {
  const box = mkdtempSync(join(tmpdir(), "qa-prov-"));
  const out = join(box, "output");
  mkdirSync(join(out, "screenshots"), { recursive: true });
  mkdirSync(join(box, "tests"), { recursive: true });

  // Specs first, then the results, so a healthy run has the NEWER results file - which is
  // the normal case and must not trip the staleness check. Writing them the other way round
  // made the "no warning" test fail on its own fixture.
  for (const [name, body] of Object.entries(specs)) writeFileSync(join(box, "tests", name), body);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(out, name), body);

  if (opts?.resultsOlderThanSpecs) {
    const old = (Date.now() - 86_400_000) / 1000;
    utimesSync(join(out, "pw-results.json"), old, old);
  }

  try {
    // The specs directory is the checkout's tests/ by default (C-47), not OUT/../tests, so
    // this fixture's own tests/ has to be named.
    return buildReport(out, join(box, "tests"));
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

/** A results file naming exactly the given spec files, each with one passing test. */
const resultsFor = (specFiles: string[], startTime = new Date().toISOString()): string =>
  JSON.stringify({
    stats: { startTime },
    suites: specFiles.map((file) => ({
      title: file,
      file,
      specs: [{ title: "a test", ok: true }],
    })),
  });

test("a spec file missing from the results is named in the report", () => {
  const html = renderWithSuite(
    { "pages.jsonl": MINIMAL_PAGE + "\n", "pw-results.json": resultsFor(["old.spec.ts"]) },
    { "old.spec.ts": "// ran", "new.spec.ts": "// never ran" },
  );

  assert.match(html, /do not describe the current suite/);
  assert.match(html, /new\.spec\.ts/, "the report must name the spec file it left out");
});

test("a results file older than the specs is called out", () => {
  const html = renderWithSuite(
    { "pages.jsonl": MINIMAL_PAGE + "\n", "pw-results.json": resultsFor(["a.spec.ts"]) },
    { "a.spec.ts": "// edited after the run" },
    { resultsOlderThanSpecs: true },
  );

  assert.match(html, /changed after this test run/);
  assert.match(html, /a\.spec\.ts/);
});

test("results that match the suite produce no warning at all", () => {
  // The warning has to stay quiet on a healthy run, or it becomes noise people skip past.
  const html = renderWithSuite(
    {
      "pages.jsonl": MINIMAL_PAGE + "\n",
      "pw-results.json": resultsFor(["a.spec.ts", "b.spec.ts"]),
    },
    { "a.spec.ts": "// ran", "b.spec.ts": "// ran" },
  );

  assert.doesNotMatch(html, /do not describe the current suite/);
  assert.doesNotMatch(html, /changed after this test run/);
  assert.match(html, /Run started /, "the run's own timestamp is still shown");
});

test("a setup file is not mistaken for a missing spec", () => {
  // tests/ also holds *.setup.ts, which the json results do not list as spec files.
  const html = renderWithSuite(
    { "pages.jsonl": MINIMAL_PAGE + "\n", "pw-results.json": resultsFor(["a.spec.ts"]) },
    { "a.spec.ts": "// ran", "auth.setup.ts": "// a setup project, not a spec" },
  );
  assert.doesNotMatch(html, /do not describe the current suite/);
});

// ------------------------------------------------------------- flaky is not green

/**
 * A flaky test has ok: true, because it passed on a retry.
 *
 * A real run came back "87 passed, 4 skipped" with TEN tests that had only passed on a
 * second attempt, and the report rendered every one of them as an ordinary pass. The whole
 * suite looked green. Worse, the terminal summary I was reading had been truncated by
 * `tail`, so the two genuine failures were invisible too - the json was the only honest
 * account of that run.
 */
function resultsWith(specs: { title: string; ok: boolean; flaky?: boolean }[]): string {
  return JSON.stringify({
    stats: { startTime: new Date().toISOString() },
    suites: [
      {
        title: "a.spec.ts",
        file: "a.spec.ts",
        specs: specs.map((s) => ({
          title: s.title,
          ok: s.ok,
          tests: [{ status: s.flaky ? "flaky" : s.ok ? "expected" : "unexpected" }],
        })),
      },
    ],
  });
}

test("a test that only passed on a retry is labelled flaky, not pass", () => {
  const html = renderWithSuite(
    {
      "pages.jsonl": MINIMAL_PAGE + "\n",
      "pw-results.json": resultsWith([
        { title: "steady", ok: true },
        { title: "racy", ok: true, flaky: true },
      ]),
    },
    { "a.spec.ts": "// ran" },
  );

  assert.match(html, /1 test\(s\) only passed on a retry/);
  assert.match(html, /sev high">flaky/, "the row itself has to say so, not just a banner");
  assert.match(html, /sev low">pass/, "the steady test is still an ordinary pass");
});

test("a run with no flakes shows no flaky banner at all", () => {
  // It has to stay quiet when things are fine, or it becomes another line people skip.
  const html = renderWithSuite(
    {
      "pages.jsonl": MINIMAL_PAGE + "\n",
      "pw-results.json": resultsWith([{ title: "steady", ok: true }]),
    },
    { "a.spec.ts": "// ran" },
  );
  assert.doesNotMatch(html, /only passed on a retry/);
  assert.doesNotMatch(html, /sev high">flaky/);
});

test("a genuine failure still outranks flakiness", () => {
  const html = renderWithSuite(
    {
      "pages.jsonl": MINIMAL_PAGE + "\n",
      "pw-results.json": resultsWith([{ title: "broken", ok: false, flaky: true }]),
    },
    { "a.spec.ts": "// ran" },
  );
  assert.match(html, /sev critical">fail/, "a failing test is a failure first");
});

// ------------------------------------------------------- the site analysis section

test("a tech profile renders as chips, confirmed solid and guesses dashed", () => {
  const html = renderWith({
    "pages.jsonl": MINIMAL_PAGE + "\n",
    "techprofile.json": JSON.stringify({
      url: "https://t.test/",
      server: [{ name: "nginx 1.25", confidence: "confirmed", evidence: "server: nginx/1.25" }],
      frameworks: [{ name: "React", confidence: "likely", evidence: "data-reactroot" }],
      cdn: [], cms: [], analytics: [], languages: [],
      securityHeaders: [{ name: "content-security-policy", present: false }],
      cookies: [{ name: "sid", secure: true, httpOnly: true, sameSite: "Lax" }],
      notableHeaders: [{ name: "server", value: "nginx/1.25" }],
    }),
  });
  assert.match(html, /Site analysis/);
  assert.match(html, /nginx 1.25/);
  assert.match(html, /pill likely[^>]*>React/, "a markup guess must be marked likely");
  assert.match(html, /hdr miss">[^<]*content-security-policy/, "a missing header shows as missing");
  assert.match(html, /sid/);
});

test("no tech profile means no site-analysis section, not a broken one", () => {
  const html = renderWith({ "pages.jsonl": MINIMAL_PAGE + "\n" });
  assert.doesNotMatch(html, /Site analysis/);
});

test("a corrupt techprofile.json does not take the report down", () => {
  const html = renderWith({ "pages.jsonl": MINIMAL_PAGE + "\n", "techprofile.json": "{ not json" });
  assert.match(html, /QA report/, "the rest of the report still renders");
  assert.doesNotMatch(html, /Site analysis/);
});

test("markup in a detected name is escaped, not rendered", () => {
  const html = renderWith({
    "pages.jsonl": MINIMAL_PAGE + "\n",
    "techprofile.json": JSON.stringify({
      url: "https://t.test/", server: [{ name: "<img src=x onerror=alert(1)>", confidence: "confirmed", evidence: "x" }],
      frameworks: [], cdn: [], cms: [], analytics: [], languages: [], securityHeaders: [], cookies: [], notableHeaders: [],
    }),
  });
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img src=x/);
});

// ------------------------------------------------------- C-25: report injection defences
//
// safety.md promised these were regression-tested; nothing exercised either function. Both
// are driven through the rendered report, which is where a hostile value actually lands.

test("a hostile finding URL or evidence link never becomes a live href", () => {
  const findings = [
    { id: "F-1", url: "javascript:alert(1)", severity: "high", feature: "a" },
    { id: "F-2", url: "//evil.test/x", severity: "high", feature: "b", evidence: "data:text/html,<b>x</b>" },
    { id: "F-3", url: "JaVaScRiPt:alert(2)", severity: "low", feature: "c", evidence: "java\u0009script:alert(3)" },
    { id: "F-4", url: "https://t.test/ok", severity: "low", feature: "d", evidence: "screenshots/ok.png" },
  ]
    .map((f) => JSON.stringify(f))
    .join("\n");
  const html = renderWith({ "pages.jsonl": `${MINIMAL_PAGE}\n`, "findings.jsonl": `${findings}\n` });

  for (const bad of [/href="\s*javascript:/i, /href="data:/i, /href="\/\/evil/i, /href="java\s*script/i]) {
    assert.doesNotMatch(html, bad);
  }
  assert.match(html, /href="https:\/\/t\.test\/ok"/, "a safe https link is still a link");
  assert.match(html, /href="screenshots\/ok\.png"/, "a relative evidence path is still a link");
});

test("a screenshot path cannot embed a file from outside output/screenshots", () => {
  const MARK = "LEAK-MARKER-c25";
  const b64 = Buffer.from(MARK).toString("base64");
  const elsewhere = mkdtempSync(join(tmpdir(), "qa-outside-"));
  const outsideAbs = join(elsewhere, "secret.png");
  writeFileSync(outsideAbs, MARK);

  const page = (screenshot: string, n: number): string =>
    JSON.stringify({ ...JSON.parse(MINIMAL_PAGE), url: `https://t.test/p${n}`, template: `https://t.test/p${n}`, screenshot });

  try {
    const html = renderWith({
      // An image extension, inside the output dir but NOT inside screenshots/.
      "leak.png": MARK,
      ".env": MARK,
      "screenshots/notes.txt": MARK, // inside screenshots/, but not an image
      "screenshots/ok.png": "PNG-OK",
      "pages.jsonl": [
        page("../.env", 1),
        page(".env", 2),
        page("leak.png", 3),
        page("screenshots/../leak.png", 4),
        page(outsideAbs, 5),
        page("screenshots/notes.txt", 6),
        page("screenshots/ok.png", 7),
      ].join("\n"),
    });
    assert.ok(!html.includes(b64), "a file outside screenshots/ (or a non-image) was base64'd into the report");
    assert.ok(html.includes(Buffer.from("PNG-OK").toString("base64")), "a real screenshot is still embedded");
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// ------------------------------------------------- C-47: where the specs actually live

/**
 * The provenance check looked for specs at OUT/../tests. Under QA_OUT=output/shop that is
 * output/tests, which does not exist, so the stale-results warning silently disappeared
 * for every non-default target. And it read tests/ flat, so tests/generated/ - where
 * Phase 6 writes its specs - was never looked at.
 */
test("C-47: under a nested output directory the repo's specs are still checked", () => {
  const box = mkdtempSync(join(tmpdir(), "qa-nested-"));
  const out = join(box, "output", "shop"); // what QA_OUT=output/shop produces
  mkdirSync(join(out, "screenshots"), { recursive: true });
  writeFileSync(join(out, "pages.jsonl"), MINIMAL_PAGE + "\n");
  writeFileSync(join(out, "pw-results.json"), resultsFor(["auth.spec.ts"]));
  // Older than every spec in the repository.
  utimesSync(join(out, "pw-results.json"), 1, 1);
  try {
    const html = buildReport(out);
    assert.match(html, /changed after this test run/);
    assert.match(html, /auth\.spec\.ts/);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test("C-47: a generated spec newer than the results is called out", () => {
  const box = mkdtempSync(join(tmpdir(), "qa-gen-"));
  const out = join(box, "output");
  mkdirSync(join(out, "screenshots"), { recursive: true });
  mkdirSync(join(box, "tests", "generated"), { recursive: true });
  writeFileSync(join(box, "tests", "a.spec.ts"), "// ran");
  writeFileSync(join(out, "pages.jsonl"), MINIMAL_PAGE + "\n");
  writeFileSync(join(out, "pw-results.json"), resultsFor(["a.spec.ts"]));
  const old = (Date.now() - 86_400_000) / 1000;
  utimesSync(join(out, "pw-results.json"), old, old);
  utimesSync(join(box, "tests", "a.spec.ts"), old - 60, old - 60);
  writeFileSync(join(box, "tests", "generated", "found-01.spec.ts"), "// written after the run");
  try {
    const html = buildReport(out, join(box, "tests"));
    assert.match(html, /changed after this test run/);
    assert.match(html, /generated\/found-01\.spec\.ts/);
    assert.match(html, /not in this run at all/, "a generated spec absent from the results is named too");
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});
