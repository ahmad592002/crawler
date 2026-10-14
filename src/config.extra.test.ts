/**
 * Extra tests for foldLabel, the normaliser every deny-list match runs through.
 * Offline, pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROOT, foldLabel, isDenied, loadConfig, type QaConfig } from "./config.js";

test("foldLabel folds the ways real UIs disguise a word onto one string", () => {
  const cases: Array<[string, string]> = [
    ["Delete", "delete"],
    ["ＤＥＬＥＴＥ", "delete"], // fullwidth
    ["Délète", "delete"], // diacritics
    ["De​lete", "delete"], // zero-width space
    ["De­lete", "delete"], // soft hyphen
    ["De⁠lete", "delete"], // word joiner
    ["﻿Delete", "delete"], // BOM
    ["  Delete\n\taccount  ", "delete account"], // whitespace collapse + trim
    ["Delete account", "delete account"], // NBSP is whitespace
    ["Delete　account", "delete account"], // ideographic space (NFKC -> space)
    ["ﬁnalize", "finalize"], // ligature
  ];
  for (const [input, want] of cases) {
    assert.equal(foldLabel(input), want, JSON.stringify(input));
  }
});

test("foldLabel is idempotent and safe on empty input", () => {
  assert.equal(foldLabel(""), "");
  assert.equal(foldLabel("   "), "");
  for (const s of ["Ｄélete​  ME", "Pay now", "Ünsubscribe"]) {
    assert.equal(foldLabel(foldLabel(s)), foldLabel(s), JSON.stringify(s));
  }
});

test("foldLabel does not merge letter-spaced words (that is the matcher's job, not the folder's)", () => {
  // Pinned so nobody "fixes" it here and silently changes every deny decision: folding
  // keeps single spaces, and isDenied handles spaced-out letters on top of that.
  assert.equal(foldLabel("D e l e t e"), "d e l e t e");
});

test("folding feeds isDenied: disguised forms of a deny term are still denied", () => {
  const cfg = { denyList: ["delete"] } as unknown as QaConfig;
  for (const label of ["ＤＥＬＥＴＥ", "Délète", "De­lete", "﻿Delete"]) {
    assert.equal(isDenied(label, cfg), true, JSON.stringify(label));
  }
});

// ------------------------------------------------------------------ C-22: strict schema

/** Write a config to a temp file, run loadConfig on it, and clean up. */
function loadFrom(obj: unknown): QaConfig {
  const dir = mkdtempSync(join(tmpdir(), "qa-cfg-"));
  const file = join(dir, "qa.config.json");
  try {
    writeFileSync(file, JSON.stringify(obj));
    return loadConfig(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const shipped = JSON.parse(readFileSync(resolve(ROOT, "qa.config.json"), "utf8")) as Record<string, unknown>;

// The schema stripped unknown keys, so `requestDelayMS` (one capital) parsed fine and the
// run went out at the default spacing. A typo in a safety or politeness key must fail loudly.
test("a typo'd config key fails the load and names the key", () => {
  assert.throws(() => loadFrom({ ...shipped, requestDelayMS: 5000 }), /requestDelayMS/);
  assert.throws(
    () => loadFrom({ ...shipped, login: { path: "/login", sucessUrl: "/home" } }),
    /sucessUrl/,
    "nested login keys are checked too",
  );
  assert.throws(
    () => loadFrom({ ...shipped, personas: [{ id: "alice", usrname: "a" }] }),
    /usrname/,
    "persona keys are checked too",
  );
});

test("every shipped config still loads under the strict schema", () => {
  const files = [
    resolve(ROOT, "qa.config.json"),
    ...readdirSync(resolve(ROOT, "targets"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => resolve(ROOT, "targets", f)),
  ];
  assert.ok(files.length >= 2, "expected qa.config.json and at least one target");
  for (const f of files) assert.doesNotThrow(() => loadConfig(f), `${f} no longer loads`);
});
