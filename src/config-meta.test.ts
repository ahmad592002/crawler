/**
 * The config editor and the Zod schema must describe the same config.
 *
 * If a field is added to the schema and not here, the editor silently cannot set it, and
 * someone goes back to hand-editing JSON - the exact thing this is meant to end. If a field
 * is removed from the schema but left here, the editor writes a key that loadConfig rejects.
 * Either drift is caught by this test rather than by a confused user.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.js";
import { FIELDS, GROUPS } from "./config-meta.js";

/** Structured fields the editor renders as their own sections, not as plain inputs. */
const HANDLED_SEPARATELY = new Set(["login", "personas", "customEngine"]);

/** Pull the top-level field names out of the Zod schema source. */
function schemaKeys(): string[] {
  const src = readFileSync(resolve(ROOT, "src/config.ts"), "utf8");
  const block = src.slice(src.indexOf("const ConfigSchema = z.object"), src.indexOf("\n});"));
  const keys: string[] = [];
  for (const m of block.matchAll(/^  ([a-zA-Z]+):/gm)) keys.push(m[1] as string);
  return keys;
}

test("every editor field exists in the schema", () => {
  const schema = new Set(schemaKeys());
  for (const f of FIELDS) {
    assert.ok(schema.has(f.key), `editor field "${f.key}" is not in the config schema`);
  }
});

test("every schema field is in the editor, or handled separately on purpose", () => {
  for (const key of schemaKeys()) {
    if (HANDLED_SEPARATELY.has(key)) continue;
    assert.ok(
      FIELDS.some((f) => f.key === key),
      `schema field "${key}" has no editor entry - add it to config-meta.ts or to HANDLED_SEPARATELY`,
    );
  }
});

test("no field is listed twice", () => {
  const seen = new Set<string>();
  for (const f of FIELDS) {
    assert.ok(!seen.has(f.key), `field "${f.key}" is listed twice`);
    seen.add(f.key);
  }
});

test("every field belongs to a declared group, and every declared group is used", () => {
  const groups = new Set<string>(GROUPS);
  for (const f of FIELDS) assert.ok(groups.has(f.group), `field "${f.key}" has unknown group "${f.group}"`);
  for (const g of GROUPS) {
    assert.ok(FIELDS.some((f) => f.group === g), `group "${g}" has no fields`);
  }
});

test("every field has help text a human can act on", () => {
  for (const f of FIELDS) {
    assert.ok(f.help.length > 20, `field "${f.key}" needs real help text, not "${f.help}"`);
  }
});
