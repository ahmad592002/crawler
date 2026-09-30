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
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.js";

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
const UNGUARDED_CLICK = /\.click\s*\(|\[\s*["'`]click["'`]\s*\]|\.click\b(?!\s*\()/;

/** The sanctioned wrappers. Only a call to one of these exempts a line. */
const GUARDED = /\bsafeClick\s*\(|\bsafeClickLink\s*\(|\bsafeClickLocator\s*\(|\bsafeRightClick\s*\(/;

/** Strip line and block comments so a comment cannot exempt the code beside it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

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
      if (!UNGUARDED_CLICK.test(line)) return;
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
function isUnguardedClick(line: string): boolean {
  return UNGUARDED_CLICK.test(line) && !GUARDED.test(line);
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

test("the lint scans nested spec directories", () => {
  // Phase 6 GENERATES specs, so a flat readdir missed the files most likely to contain a
  // machine-written unguarded click.
  assert.ok(
    findSpecs(TESTS).every((f) => f.includes(TESTS)),
    "findSpecs returned a path outside tests/",
  );
  assert.ok(findSpecs(TESTS).length >= 5, "found suspiciously few specs");
});
