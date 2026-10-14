/**
 * A CLAUDE.md rule with no test is a suggestion.
 *
 * "In generated specs use safeClick / safeClickLink / safeGoto. A bare page.click() or
 * getByRole(...).click() bypasses the guard and is a bug." Ten violations had accumulated
 * before this existed, mostly because the fixture offered no guarded path for a CSS locator
 * or a right-click. It does now, so the rule is enforceable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { resolve } from "node:path";
import { ROOT, loadConfig } from "./config.js";
import { stripComments } from "./coverage.js";

const TESTS = resolve(ROOT, "tests");

/**
 * Every spec, at any depth, as an absolute path.
 *
 * A flat readdir never looked inside tests/generated/ - and Phase 6 generates specs, so the
 * files most likely to contain a machine-written unguarded click were the ones the rule did
 * not cover.
 */
function findSpecs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...findSpecs(full));
    else if (/\.(spec|setup)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const specFiles = findSpecs(TESTS);

/** Any way of reaching Locator.click - a call, bracket notation, or a saved reference. */
/**
 * Ways of clicking that must go through a guard.
 *
 * Each alternative is here because an audit demonstrated it slipping past:
 *   .click(              the obvious call
 *   ["click"]()          bracket notation
 *   .click not called    a saved reference, invoked later
 *   dispatchEvent(click) the obvious next move after .click() is rejected, and the one that
 *                        still performs a real click on a deny-listed control
 *   { click } = ...      destructuring off a locator
 */
const UNGUARDED_CLICK = new RegExp(
  [
    String.raw`\.click\s*\(`,
    String.raw`\[\s*["'\`]click["'\`]\s*\]`,
    String.raw`\.click\b(?!\s*\()`,
    String.raw`dispatchEvent\s*\(\s*["'\`]click`,
    String.raw`\{[^}]*\bclick\b[^}]*\}\s*=`,
  ].join("|"),
);

/**
 * Shapes that merely LOOK like a click and must not be flagged.
 *
 * A lint that rejects valid code gets switched off, which is indistinguishable from having
 * no lint. page.mouse.click takes coordinates, not a locator, so no guard can express it;
 * a CSS class called `.click-me` is a selector, not a call; and an in-page DOM click inside
 * evaluate() runs in the browser where the fixture does not exist.
 */
const NOT_A_LOCATOR_CLICK = new RegExp(
  [
    // Coordinates, not a locator - safeClickLocator cannot express it.
    String.raw`page\.mouse\.click`,
    // A CSS class or selector that merely starts with "click".
    String.raw`\.click[-_][\w-]+`,
    String.raw`class~?=["'][^"']*click`,
    // evaluate() is NOT here. Its whole call is removed by stripEvaluateCalls first,
    // because deleting only the token would leave the in-page body - and its click - behind.
  ].join("|"),
);

/** The sanctioned wrappers. Only a call to one of these exempts a line. */
const GUARDED = /\bsafeClick\s*\(|\bsafeClickLink\s*\(|\bsafeClickLocator\s*\(|\bsafeRightClick\s*\(/;

/**
 * Strip comments, reusing the string-aware scanner from coverage.ts.
 *
 * This file had its own regex copy, which carried the exact flaw an audit found in the
 * other one three rounds earlier: a block-comment OPENER inside a string literal began a
 * comment that ran to the next closer anywhere in the file. A real violation vanished, and
 * every reported line number after it was wrong. Two copies of a subtle function is how one
 * of them stays broken.
 *
 * (Writing those two markers literally in this comment is what broke the build a moment
 * ago, which is a fair demonstration of the problem.)
 */
const codeOnly = stripComments;

test("no spec performs an unguarded click", () => {
  const offenders: string[] = [];

  for (const file of specFiles) {
    // Comments are removed FIRST. The exemptions below are substring tests, so a comment
    // saying "safeClick cannot express this" - the natural thing to write when bypassing the
    // rule - used to switch the rule off for that very line.
    const src = codeOnly(readFileSync(file, "utf8"));

    src.split("\n").forEach((line, i) => {
      // Any way of reaching .click, not just `.click(`: ["click"]() and a bound reference
      // both slipped through a dot-only match.
      // `.click(` is the obvious form. The others are the evasions an audit demonstrated:
      // bracket notation, and taking a REFERENCE to click (`.click.bind(x)`, `= x.click`)
      // to call later. A trailing `.click` not followed by `(` covers every reference form,
      // including ones behind a call like `page.locator("#x").click`.
      if (!isUnguardedClick(line)) return;
      // The guarded helpers are the only sanctioned way to click.
      if (GUARDED.test(line)) return;
      // submitAndWait takes a click PROMISE, so a guarded click inside it is fine - but the
      // exemption used to cover an UNGUARDED one, including on a deny-listed control. It
      // only applies when the click it wraps is itself guarded, which the check above
      // already decided, so there is no separate exemption here at all.
      offenders.push(`${file.replace(ROOT, "").replace(/^[\/]/, "")}:${i + 1}  ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `unguarded click(s) - use safeClick / safeClickLocator / safeRightClick:\n  ${offenders.join("\n  ")}`,
  );
});

test("fixtures.ts exports a guarded path for every click shape", () => {
  // The reason the rule was broken ten times: there was no compliant way to click a CSS
  // locator or to right-click. If one of these disappears, the violations come back.
  const src = readFileSync(resolve(TESTS, "fixtures.ts"), "utf8");
  for (const name of ["safeClick", "safeClickLink", "safeClickLocator", "safeRightClick", "safeGoto"]) {
    // A plain string search, not a regex: building one from a template literal is how this
    // line first shipped asserting on a literal backspace character.
    assert.ok(
      src.includes(`export function ${name}(`) || src.includes(`export async function ${name}(`),
      `fixtures.ts no longer exports ${name} - the unguarded clicks will come back`,
    );
  }
});

// ------------------------------------------------- round-6 audit: evasions

/**
 * Exactly the rule the lint applies, so an evasion is tested against the real patterns
 * rather than a copy that can drift out of step with them.
 */
/**
 * Remove `…evaluate(…)` calls, parentheses balanced.
 *
 * Code inside evaluate runs in the page, where the fixture does not exist, so it cannot be
 * guarded. Deleting only the `.evaluate(` token leaves the in-page body behind (and its
 * `.click()` with it); exempting the whole line hides a real violation that follows the
 * call on the same line. Removing the call and nothing else is the only option that is
 * wrong in neither direction.
 */
function stripEvaluateCalls(line: string): string {
  const re = /\.(?:evaluate|evaluateAll|evaluateHandle)\s*\(/g;
  let out = line;
  for (;;) {
    re.lastIndex = 0;
    const m = re.exec(out);
    if (!m) return out;

    let depth = 0;
    let i = m.index + m[0].length - 1; // at the opening paren
    for (; i < out.length; i++) {
      if (out[i] === "(") depth++;
      else if (out[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    // Unbalanced (the call continues on the next line): drop the rest of the line.
    out = out.slice(0, m.index) + " " + (i < out.length ? out.slice(i + 1) : "");
  }
}

function isUnguardedClick(line: string): boolean {
  // Remove the exempt constructs, then judge what is LEFT. Exempting the whole line let a
  // real violation shelter beside a safe one - a click on "Delete account" passed simply
  // because the same line also mentioned an evaluate() or a `.click-me` selector.
  const remainder = stripEvaluateCalls(line).replace(
    new RegExp(NOT_A_LOCATOR_CLICK.source, "gi"),
    " ",
  );
  return UNGUARDED_CLICK.test(remainder) && !GUARDED.test(remainder);
}

test("a comment mentioning safeClick does not exempt the code beside it", () => {
  // The natural thing to write when bypassing the rule is a comment explaining why - which
  // switched the rule off, because the exemption was a substring test on the whole line.
  const line = codeOnly(`await page.locator("#danger").click(); // safeClick cannot express this`);
  assert.equal(isUnguardedClick(line), true);
});

test("submitAndWait does not exempt an unguarded click on a deny-listed control", () => {
  const line = `await submitAndWait(page, page.getByRole("button", { name: "Delete account" }).click(), "/account");`;
  assert.equal(isUnguardedClick(line), true);
});

test("a bracket-notation click is caught", () => {
  assert.equal(isUnguardedClick(`await b["click"]();`), true);
});

test("a bound click reference is caught", () => {
  assert.equal(isUnguardedClick(`const c = b.click.bind(b);`), true);
  assert.equal(isUnguardedClick(`const c = page.locator("#x").click;`), true);
});

test("a genuinely guarded click still passes", () => {
  for (const line of [
    `await safeClick(page, "Login");`,
    `await safeClickLink(page, "Click Here");`,
    `await safeClickLocator(table.locator("thead th").first());`,
    `await safeRightClick(page.locator("#hot-spot"), "hot spot");`,
    `await submitAndWait(page, safeClick(page, "Login"), "/authenticate");`,
  ]) {
    assert.equal(isUnguardedClick(line), false, `wrongly flagged: ${line}`);
  }
});


// =============================================================== round-8 audit

test("dispatchEvent('click') is caught - the obvious move after .click() is rejected", () => {
  assert.equal(
    isUnguardedClick(`await page.getByRole("button", { name: "Delete account" }).dispatchEvent("click");`),
    true,
  );
});

test("destructuring click off a locator is caught", () => {
  assert.equal(isUnguardedClick(`const { click } = page.locator("#danger"); await click();`), true);
});

test("legitimate code that merely mentions click is NOT flagged", () => {
  // A lint that rejects valid code gets switched off, which is the same as no lint.
  for (const line of [
    `await page.mouse.click(120, 240);`,
    `await page.locator(".click-me").waitFor();`,
    `await page.locator('[class~="click-area"]').waitFor();`,
    `await page.evaluate(() => document.querySelector("#x")?.click());`,
    `const handler = { onclick: noop };`,
    `await page.locator("#x").dblclick();`,
    `expect(label).toBe("[click] Login");`,
  ]) {
    assert.equal(isUnguardedClick(line), false, `false positive: ${line}`);
  }
});

test("a block-comment marker inside a string cannot hide a violation", () => {
  // The lint's own comment stripper had the flaw it was written to avoid.
  const src = [
    `await page.fill("#comment", "/* not a comment");`,
    `await page.locator("#really-dangerous").click();`,
    `await page.fill("#comment2", "*/");`,
    `await page.locator("#second-violation").click();`,
  ].join("\n");

  const offenders = codeOnly(src)
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => isUnguardedClick(line));

  assert.equal(offenders.length, 2, "a violation was swallowed by a string-borne comment marker");
  assert.deepEqual(offenders.map((o) => o.n), [2, 4], "line numbers shifted");
});

test("the lint really does recurse into nested spec directories", () => {
  // The previous version of this test asserted only that every path was under tests/ and
  // that there were at least five - both true of a FLAT readdir, so the recursion it was
  // named for was never exercised. This builds a nested tree and proves it is walked.
  const box = mkdtempSync(join(tmpdir(), "qa-lint-"));
  mkdirSync(join(box, "generated", "deep"), { recursive: true });
  writeFileSync(join(box, "top.spec.ts"), "//\n");
  writeFileSync(join(box, "generated", "mid.spec.ts"), "//\n");
  writeFileSync(join(box, "generated", "deep", "low.setup.ts"), "//\n");
  writeFileSync(join(box, "generated", "ignored.txt"), "not a spec\n");

  const found = findSpecs(box).map((f) => f.replace(box, "").split(sep).join("/"));
  rmSync(box, { recursive: true, force: true });

  assert.deepEqual(found.sort(), ["/generated/deep/low.setup.ts", "/generated/mid.spec.ts", "/top.spec.ts"]);
});

test("a real click hiding beside an exempt token is still caught", () => {
  // Exempting the whole line meant a genuine violation could shelter next to a safe one.
  for (const line of [
    `await page.locator(".click-me").click();`,
    `await page.evaluate(() => 1); await page.locator("#danger").click();`,
    `await row.evaluateAll(() => {}); await page.getByRole("button", {name:"Delete"}).click();`,
    `await page.mouse.move(1, 2); await page.locator("#danger").click();`,
  ]) {
    assert.equal(isUnguardedClick(line), true, `violation sheltered behind an exemption: ${line}`);
  }
});

test("the exemptions still hold when nothing else is on the line", () => {
  for (const line of [
    `await page.mouse.click(120, 240);`,
    `await page.locator(".click-me").waitFor();`,
    `await page.evaluate(() => document.querySelector("#x")?.click());`,
  ]) {
    assert.equal(isUnguardedClick(line), false, `false positive: ${line}`);
  }
});

// =============================================================== improve round 1 (C-06)

/**
 * A navigation that skips safeGoto.
 *
 * A literal relative path ("/login") is allowed: it cannot leave the origin, and a reviewer
 * sees exactly where it goes. Anything COMPUTED is not - a link pulled out of an email, or a
 * URL read back off another page, is precisely the input safeGoto's scope and deny checks
 * exist for, and personas.setup.ts was following verification links with a bare goto.
 */
const BARE_GOTO = /\.goto\s*\(\s*(?!["']\/[^"'`$]*["']\s*[,)])|\[\s*["'`]goto["'`]\s*\]/;

function isBareGoto(line: string): boolean {
  return BARE_GOTO.test(line);
}

test("no spec navigates to a computed URL with a bare goto", () => {
  const offenders: string[] = [];
  for (const file of specFiles) {
    const src = codeOnly(readFileSync(file, "utf8"));
    src.split("\n").forEach((line, i) => {
      if (isBareGoto(line)) {
        offenders.push(`${file.replace(ROOT, "").replace(/^[\/]/, "")}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `bare goto on a computed URL - use safeGoto / safeGotoResponse:\n  ${offenders.join("\n  ")}`,
  );
});

test("the goto rule flags computed targets and allows literal relative paths", () => {
  for (const line of [
    `await page.goto(link, { waitUntil: "domcontentloaded" });`,
    `await userB.page.goto(link!);`,
    "await page.goto(`/users/${id}/delete`);",
    `await page.goto("https://evil.test/");`,
    `const res = await stranger.page.goto(url);`,
    `await page["goto"]("/login");`,
  ]) {
    assert.equal(isBareGoto(line), true, `should be flagged: ${line}`);
  }
  for (const line of [
    `await page.goto("/login");`,
    `const res = await page.goto("/status_codes/404", { waitUntil: "commit" });`,
    `await Promise.all([userA.page.goto("/secure"), userB.page.goto("/secure")]);`,
    `await safeGoto(page, link);`,
    `const res = await safeGotoResponse(userB.page, url);`,
  ]) {
    assert.equal(isBareGoto(line), false, `false positive: ${line}`);
  }
});

test("safeGoto refuses an off-origin or destructive link before navigating", async () => {
  // What the migrated call sites now rely on: an emailed link is checked, not followed.
  const { safeGoto } = await import("../tests/fixtures.js");
  const visited: string[] = [];
  const fakePage = {
    goto: async (url: string) => {
      visited.push(url);
      return null;
    },
  } as unknown as Parameters<typeof safeGoto>[0];

  await assert.rejects(() => safeGoto(fakePage, "https://evil.test/verify?t=1"), /outside allowedOrigins/);
  await assert.rejects(() => safeGoto(fakePage, "/account/7/delete"), /denyList/);
  assert.deepEqual(visited, [], "a refused link must not be navigated at all");

  await safeGoto(fakePage, "/login");
  assert.deepEqual(visited, [new URL("/login", loadConfig().baseUrl).toString()]);
});
