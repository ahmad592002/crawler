/**
 * Extra control-panel edges (round 3). Pins esc() directly (an exported helper with no test),
 * exercises describeConfigError through a rejected save, confirms saveConfig drops keys that
 * are not real config fields, and checks the MCP catalogue renders into the page. Offline:
 * nothing here binds a socket or spawns a child — only the pure helpers are touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "qa-panel-x-"));
const cfgPath = resolve(dir, "qa.config.json");
const outDir = mkdtempSync(join(tmpdir(), "qa-panel-out-"));
process.env.QA_OUT = outDir;
writeFileSync(
  cfgPath,
  JSON.stringify({
    baseUrl: "https://t.test",
    allowedOrigins: ["https://t.test"],
    include: [".*"],
    exclude: ["/logout"],
    maxPages: 20,
    maxDepth: 4,
    concurrency: 2,
    navTimeoutMs: 30000,
    maxRuntimeMs: 600000,
    blockDomains: [],
    denyList: ["delete"],
    denyUrlExceptions: [],
    emailPattern: "{GMAIL_LOCAL}+{runId}-{n}@gmail.com",
    emailProvider: "mailtm",
  }),
);
process.env.QA_CONFIG = cfgPath;

const { esc, page, saveConfig, isLocalRequest, livePagesFiles, openTargetPath } = await import("./control-panel.js");
const { OUT } = await import("./config.js");

test("esc escapes every HTML-significant character and coerces null/undefined to ''", () => {
  assert.equal(esc(`<a href="x" data='y'>&`), "&lt;a href=&quot;x&quot; data=&#39;y&#39;&gt;&amp;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(42), "42", "a number is stringified");
});

test("describeConfigError turns a schema failure into a field-named, bounded message", () => {
  const res = saveConfig(JSON.stringify({ maxPages: -5 }));
  assert.equal(res.ok, false);
  const err = (res as { error: string }).error;
  assert.match(err, /maxPages:/, "the message names the field and uses the 'path: message' shape");
  assert.ok(err.length <= 300, "the message is bounded");
});

test("saveConfig reports invalid JSON distinctly and writes nothing", () => {
  const before = readFileSync(cfgPath, "utf8");
  const res = saveConfig("{not json");
  assert.deepEqual(res, { ok: false, error: "the form sent invalid JSON" });
  assert.equal(readFileSync(cfgPath, "utf8"), before, "a parse failure never touches the file");
});

test("saveConfig keeps only real config fields; an unknown key is dropped", () => {
  const res = saveConfig(JSON.stringify({ maxPages: 7, totallyNotAField: "x" }));
  assert.equal(res.ok, true);
  const written = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(written.maxPages, 7);
  assert.ok(!("totallyNotAField" in written), "a key outside FIELDS never reaches disk");
});

test("the page renders the MCP catalogue (both servers and their tools)", () => {
  const html = page();
  assert.ok(html.includes("playwright") && html.includes("email"), "both MCP servers are listed");
  assert.ok(html.includes("browser_snapshot"), "a playwright tool is shown");
  assert.ok(html.includes("create_test_inbox"), "an email tool is shown");
});

// C-62: the panel binds to loopback, but a web page the user is browsing could still POST
// to http://127.0.0.1:PORT/save or open /run. isLocalRequest is the Host/Origin interlock.
test("isLocalRequest: the Host header must name this loopback origin", () => {
  assert.equal(isLocalRequest({ host: "127.0.0.1:7777" }, 7777), true);
  assert.equal(isLocalRequest({ host: "localhost:7777" }, 7777), true);
  assert.equal(isLocalRequest({ host: "evil.com" }, 7777), false, "a rebinding attacker still sends its own Host");
  assert.equal(isLocalRequest({ host: "127.0.0.1:1234" }, 7777), false, "a different port is a different service");
  assert.equal(isLocalRequest({ host: undefined }, 7777), false, "no Host at all");
});

test("isLocalRequest: a side-effecting route refuses a cross-site Origin or Referer", () => {
  const port = 7777;
  const opt = { checkOrigin: true };
  // The panel's own fetch()/EventSource must keep working.
  assert.equal(isLocalRequest({ host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777" }, port, opt), true, "same-origin fetch");
  assert.equal(isLocalRequest({ host: "localhost:7777", origin: "http://localhost:7777" }, port, opt), true);
  assert.equal(isLocalRequest({ host: "127.0.0.1:7777" }, port, opt), true, "a same-origin navigation sends no Origin");
  assert.equal(isLocalRequest({ host: "127.0.0.1:7777", referer: "http://127.0.0.1:7777/" }, port, opt), true, "own Referer");
  // A cross-site attacker page carries its own Origin/Referer, which fails.
  assert.equal(isLocalRequest({ host: "127.0.0.1:7777", origin: "https://evil.com" }, port, opt), false);
  assert.equal(isLocalRequest({ host: "127.0.0.1:7777", referer: "https://evil.com/x" }, port, opt), false);
});

// C-61: the merged config carries login/persona passwords. The validation copy must not be
// left in os.tmpdir() for anyone on the box to read.
test("saveConfig leaves no merged-config temp file behind (secrets don't linger)", () => {
  const leftovers = (): string[] => readdirSync(tmpdir()).filter((f) => /^qa-config-.*\.json$/.test(f));
  const before = leftovers();
  const res = saveConfig(JSON.stringify({ baseUrl: "https://t.test", allowedOrigins: ["https://t.test"], maxPages: 11 }));
  assert.equal(res.ok, true);
  assert.deepEqual(leftovers(), before, "no qa-config-*.json is left in os.tmpdir()");
  assert.ok(!existsSync(resolve(OUT, ".qa-config.validate.json")), "the project-local validation copy is cleaned up");
});

// C-64: /live and /open follow QA_OUT (OUT), not a hardcoded ROOT/output.
test("livePagesFiles and openTargetPath resolve under OUT (QA_OUT honoured)", () => {
  assert.deepEqual(livePagesFiles(), [resolve(outDir, "pages.jsonl"), resolve(outDir, "pages.auth.jsonl")]);
  const report = openTargetPath("report");
  assert.equal(report?.path, resolve(outDir, "report.html"));
  assert.equal(openTargetPath("summary")?.path, resolve(outDir, "summary.md"));
  assert.equal(openTargetPath("nope"), null, "an unknown name is not served");
  // and the file actually opens from OUT
  writeFileSync(resolve(outDir, "report.html"), "<html>ok</html>");
  assert.equal(readFileSync(report!.path, "utf8"), "<html>ok</html>");
});
