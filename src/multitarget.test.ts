/**
 * One checkout, several targets.
 *
 * CONFIG_PATH and OUT used to be pinned to the checkout, so a second site would overwrite
 * the first one's pages.jsonl, findings, history and run lock - a QA agent that could only
 * ever remember one site. These tests pin the override contract and, just as importantly,
 * that the defaults did not move: every existing script, the CI workflow and the docs all
 * assume plain `output/` and plain `qa.config.json`.
 *
 * The module reads the environment once, at import, so each case runs in its own child
 * process rather than trying to re-import with a mutated env.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./config.js";

/** Print CONFIG_PATH and OUT from a fresh process with the given environment. */
function paths(env: Record<string, string>): { config: string; out: string } {
  // An absolute file URL, not './src/config.js': --eval has no containing file, so a
  // relative specifier has nothing to resolve against and fails with MODULE_NOT_FOUND.
  const mod = pathToFileURL(resolve(ROOT, "src/config.ts")).href;
  // .then rather than top-level await: --eval is transformed as CJS, where a top-level
  // await is a syntax error.
  const script =
    `import(${JSON.stringify(mod)}).then((m) => ` +
    "console.log(JSON.stringify({ config: m.CONFIG_PATH, out: m.OUT })));";

  const stdout = execFileSync(
    process.execPath,
    [resolve(ROOT, "node_modules/tsx/dist/cli.mjs"), "--eval", script],
    { cwd: ROOT, env: { ...process.env, QA_CONFIG: "", QA_OUT: "", ...env }, encoding: "utf8" },
  );
  const line = stdout.trim().split("\n").pop() ?? "{}";
  return JSON.parse(line) as { config: string; out: string };
}

const norm = (p: string) => p.replace(/\\/g, "/");

test("with no environment set, the defaults are exactly the old paths", () => {
  const { config, out } = paths({});
  assert.equal(norm(config), norm(resolve(ROOT, "qa.config.json")));
  assert.equal(norm(out), norm(resolve(ROOT, "output")));
});

test("QA_CONFIG and QA_OUT redirect both, relative to the checkout", () => {
  const { config, out } = paths({ QA_CONFIG: "targets/shop.json", QA_OUT: "output/shop" });
  assert.equal(norm(config), norm(resolve(ROOT, "targets/shop.json")));
  assert.equal(norm(out), norm(resolve(ROOT, "output/shop")));
});

test("the two are independent", () => {
  // A target may want its own config while still writing to the default output, or the
  // reverse - pointing one must not silently move the other.
  const onlyConfig = paths({ QA_CONFIG: "targets/shop.json" });
  assert.equal(norm(onlyConfig.out), norm(resolve(ROOT, "output")));

  const onlyOut = paths({ QA_OUT: "output/shop" });
  assert.equal(norm(onlyOut.config), norm(resolve(ROOT, "qa.config.json")));
});

test("an empty or whitespace value falls back rather than resolving to the checkout root", () => {
  // `process.env.X ?? fallback` does not guard "" - the bug that cost an afternoon on
  // TEST_PASSWORD. Here it would have made OUT the checkout itself, so a crawl would
  // scatter pages.jsonl, findings and screenshots across the source tree.
  for (const value of ["", "   "]) {
    const { config, out } = paths({ QA_CONFIG: value, QA_OUT: value });
    assert.equal(norm(out), norm(resolve(ROOT, "output")), `QA_OUT=${JSON.stringify(value)}`);
    assert.equal(
      norm(config),
      norm(resolve(ROOT, "qa.config.json")),
      `QA_CONFIG=${JSON.stringify(value)}`,
    );
  }
});

test("two targets do not share an output directory", () => {
  const a = paths({ QA_OUT: "output/alpha" });
  const b = paths({ QA_OUT: "output/beta" });
  assert.notEqual(a.out, b.out);
  // The run lock, the history and every .jsonl live under OUT, so distinct OUT is the
  // whole of the isolation. If these ever collapse, two crawls corrupt each other.
  assert.equal(norm(a.out), norm(resolve(ROOT, "output/alpha")));
  assert.equal(norm(b.out), norm(resolve(ROOT, "output/beta")));
});
