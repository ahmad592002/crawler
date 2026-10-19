import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDeepScan } from "./report.js";

test("renderDeepScan omits the section for empty/whitespace input", () => {
  assert.equal(renderDeepScan(""), "");
  assert.equal(renderDeepScan("   \n  "), "");
  assert.equal(renderDeepScan(undefined as unknown as string), "");
});

test("renderDeepScan emits a section with the content for real input", () => {
  const md = "# deepscan (both)\n\nTarget: https://staging.example.com\nTriage report: C:/x/report.md";
  const html = renderDeepScan(md);
  assert.match(html, /<h2>Deep scan/);
  assert.match(html, /staging\.example\.com/);
  assert.match(html, /Triage report/);
});

test("renderDeepScan HTML-escapes its input (no markup injection from a path/label)", () => {
  const html = renderDeepScan('Label: <img src=x onerror=alert(1)> "q" & \'z\'');
  assert.ok(!html.includes("<img src=x"), "raw tag must not appear");
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /&amp;/);
  assert.match(html, /&quot;|&#39;/);
});
