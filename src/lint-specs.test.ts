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
const specFiles = readdirSync(TESTS).filter((f) => /\.(spec|setup)\.ts$/.test(f));

test("no spec performs an unguarded click", () => {
  const offenders: string[] = [];

  for (const file of specFiles) {
    const src = readFileSync(resolve(TESTS, file), "utf8");
    src.split("\n").forEach((line, i) => {
      if (!/\.click\s*\(/.test(line)) return;
      // The guarded helpers are the only sanctioned way to click.
      if (/safeClick|safeClickLink|safeClickLocator|safeRightClick/.test(line)) return;
      // A line that only passes a click PROMISE to submitAndWait is fine.
      if (/submitAndWait/.test(line)) return;
      offenders.push(`${file}:${i + 1}  ${line.trim()}`);
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
