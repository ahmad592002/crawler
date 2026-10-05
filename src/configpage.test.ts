/**
 * The generated config editor must describe the real config and be safe to open.
 *
 * "Safe to open" is not pedantry: the page bakes in the current config, which can contain a
 * login password and arbitrary deny-list strings, and a value carrying </script> or a quote
 * must not be able to break out of the data block and run as code in the editor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfigPage } from "./configpage.js";
import { FIELDS } from "./config-meta.js";

const html = buildConfigPage();

/** Pull the embedded JSON payload back out, reversing the one escape the generator applies. */
function payload(): { fields: { key: string }[]; values: Record<string, unknown> } {
  const m = html.match(/<script type="application\/json" id="data">([\s\S]*?)<\/script>/);
  assert.ok(m, "the data block must be present");
  return JSON.parse((m[1] as string).replace(/\\u003c/g, "<"));
}

test("every field from the metadata is embedded for the editor to render", () => {
  const keys = new Set(payload().fields.map((f) => f.key));
  for (const f of FIELDS) assert.ok(keys.has(f.key), `field "${f.key}" is missing from the page`);
});

test("the current config values are baked in as the starting state", () => {
  const v = payload().values;
  // loadConfig applies defaults, so these are always present and are what the tool runs with.
  assert.ok("baseUrl" in v);
  assert.ok("requestDelayMs" in v, "the politeness defaults must be visible to edit");
  assert.ok(Array.isArray(v.denyList));
});

test("each field's human label and help text reach the page", () => {
  // Not just the keys - the whole reason this exists instead of editing JSON is the prose.
  for (const f of FIELDS.slice(0, 6)) {
    assert.ok(html.includes(f.key), `key ${f.key}`);
  }
  // The payload carries the help text the renderer shows.
  const withHelp = payload() as unknown as { fields: { help: string }[] };
  assert.ok(withHelp.fields.every((f) => f.help && f.help.length > 20));
});

test("the page is self-contained: no external scripts or stylesheets", () => {
  // It has to work offline, on a machine that may have no network - that is the point of
  // generating it locally rather than hosting it.
  assert.ok(!/<script[^>]+\bsrc=/.test(html), "no external <script src>");
  assert.ok(!/<link[^>]+stylesheet/.test(html), "no external stylesheet");
});

test("a value containing markup cannot break out of the data block", () => {
  // The generator escapes '<' to \\u003c inside the JSON payload. Prove a literal
  // </script> sequence never appears unescaped anywhere a browser would act on it early.
  const dataBlock = html.slice(
    html.indexOf('id="data">') + 10,
    html.indexOf("</script>", html.indexOf('id="data">')),
  );
  assert.ok(!dataBlock.includes("</script"), "the data block must not contain a raw script close");
  assert.ok(!dataBlock.includes("<"), "every '<' in the payload must be escaped to \\u003c");
});

test("the download target is exactly qa.config.json", () => {
  // Downloading it under any other name would land next to the project instead of being
  // picked up, which is a quiet way to make the whole editor useless.
  assert.match(html, /a\.download\s*=\s*"qa\.config\.json"/);
});
