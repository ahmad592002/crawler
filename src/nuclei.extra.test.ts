/**
 * Extra nuclei-recommender edges (round 3). Focuses on branches the base nuclei.test.ts
 * leaves alone: rpsFromConfig's clamps, techTags dedup/languages/no-match, categorize's
 * static/authRequired/api branches and template de-duplication, and buildRecommendations
 * emitting the header/cookie recs only when warranted. Offline, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rpsFromConfig, techTags, categorize, buildRecommendations } from "./nuclei.js";
import type { QaConfig } from "./config.js";
import type { PageRecord } from "./crawl.js";
import type { TechProfile } from "./techprofile.js";

const cfg = (over: Partial<QaConfig> = {}): QaConfig =>
  ({
    baseUrl: "https://t.test",
    allowedOrigins: ["https://t.test"],
    denyList: ["delete", "remove"],
    denyUrlExceptions: [],
    requestDelayMs: 400,
    ...over,
  }) as unknown as QaConfig;

const page = (url: string, over: Partial<PageRecord> = {}): PageRecord =>
  ({ url, template: url, ok: true, authRequired: false, forms: [], deniedButtons: [], deniedLinks: [], ...over }) as PageRecord;

const form = (type: string, destructive = false) =>
  ({ action: "/x", method: "post", destructive, fields: [{ name: "q", type, label: "q", required: false }] }) as unknown as PageRecord["forms"][number];

test("rpsFromConfig clamps a negative/undefined delay to the modest default and never returns 0", () => {
  assert.equal(rpsFromConfig(cfg({ requestDelayMs: -100 })), 10, "a negative delay is treated as unset");
  const noDelay = { baseUrl: "https://t.test", allowedOrigins: ["https://t.test"] } as unknown as QaConfig;
  assert.equal(rpsFromConfig(noDelay), 10, "unset requestDelayMs -> default 10");
  // 1000/5000 floors to 0; Math.max keeps it at 1 so the command is never -rate-limit 0.
  assert.equal(rpsFromConfig(cfg({ requestDelayMs: 5000 })), 1, "a slow crawl floors to at least 1 rps");
});

test("techTags: languages feed in, duplicates collapse, and an unknown stack yields nothing", () => {
  const tech = {
    languages: [{ name: "PHP 8.1" }],
    frameworks: [{ name: "Laravel" }, { name: "laravel-mix" }],
    cms: [{ name: "WordPress 6" }],
  } as unknown as TechProfile;
  const tags = techTags(tech);
  assert.ok(tags.includes("php"), "a language maps to a tag");
  assert.ok(tags.includes("laravel"), "a framework maps to a tag");
  assert.ok(tags.includes("wordpress"), "a cms maps to a tag");
  assert.equal(tags.filter((t) => t === "laravel").length, 1, "two laravel-ish names collapse to one tag");
  assert.deepEqual(techTags({ server: [{ name: "SomethingProprietary" }] } as unknown as TechProfile), [], "no known match -> []");
});

test("categorize: a plain page is static, authRequired forces auth, .json and /vN are api", () => {
  const pages = [
    page("https://t.test/about"),
    page("https://t.test/dashboard", { authRequired: true }), // path is not auth-ish, flag is
    page("https://t.test/data.json"),
    page("https://t.test/v2/items"),
  ];
  const c = categorize(pages, cfg());
  assert.deepEqual(c.static, ["https://t.test/about"]);
  assert.deepEqual(c.auth, ["https://t.test/dashboard"], "authRequired alone routes to auth");
  assert.deepEqual(c.api.sort(), ["https://t.test/data.json", "https://t.test/v2/items"].sort());
});

test("categorize: an injectable form is 'forms' but a destructive form is not, and templates de-dup", () => {
  const pages = [
    page("https://t.test/search", { forms: [form("search")] }),
    page("https://t.test/danger", { forms: [form("text", true)] }), // destructive -> not injectable
    page("https://t.test/dup-a", { template: "T" }),
    page("https://t.test/dup-b", { template: "T" }), // same template -> counted once
  ];
  const c = categorize(pages, cfg());
  assert.deepEqual(c.forms, ["https://t.test/search"], "only the non-destructive text form is injectable");
  assert.ok(c.static.includes("https://t.test/danger"), "a page whose only form is destructive is static");
  const all = [...c.auth, ...c.forms, ...c.upload, ...c.api, ...c.static];
  assert.equal(all.filter((u) => u.startsWith("https://t.test/dup")).length, 1, "same template appears once");
});

test("categorize: a page that failed to load or has no url is skipped", () => {
  const pages = [
    page("https://t.test/ok"),
    page("https://t.test/broken", { ok: false }),
    page("", {}),
  ];
  const c = categorize(pages, cfg());
  const all = [...c.auth, ...c.forms, ...c.upload, ...c.api, ...c.static];
  assert.deepEqual(all, ["https://t.test/ok"]);
});

test("buildRecommendations: no missing headers and no insecure cookies -> no header/cookie recs", () => {
  const tech = {
    securityHeaders: [{ name: "content-security-policy", present: true }],
    cookies: [{ name: "s", secure: true, httpOnly: true }],
  } as unknown as TechProfile;
  const recs = buildRecommendations([page("https://t.test/about")], tech, cfg());
  const ids = recs.map((r) => r.id);
  assert.deepEqual(ids, ["baseline"], "a clean static site gets only the baseline scan");
  assert.ok(!ids.includes("headers") && !ids.includes("cookies"));
});

test("buildRecommendations: the pacing in every command matches rpsFromConfig", () => {
  const recs = buildRecommendations(
    [page("https://t.test/login"), page("https://t.test/data.json")],
    null,
    cfg({ requestDelayMs: 400 }),
  );
  for (const r of recs) assert.ok(r.command.includes("-rate-limit 2 -c 10"), `paced: ${r.id}`);
  const baseline = recs.find((r) => r.id === "baseline");
  assert.ok(baseline?.command.includes("-tags"), "baseline carries a -tags list");
});

// C-63: baseUrl is interpolated into a nuclei -u command a human copy-pastes. A bare
// single-quote wrap lets a quote in the value break out of the argument.
test("a baseUrl containing a single quote cannot break out of the -u argument", () => {
  const evil = "https://t.test/'; rm -rf / #";
  const recs = buildRecommendations([page("https://t.test/")], null, cfg({ baseUrl: evil, allowedOrigins: ["https://t.test"] }));
  const baseline = recs.find((r) => r.id === "baseline");
  assert.ok(baseline);
  const cmd = baseline.command;
  // The value must survive as ONE shell argument: wrapped in single quotes, each embedded
  // quote closed/escaped/reopened the POSIX way (' -> '\''). The whole thing re-parses to
  // the original base, so the `; rm -rf /` is inert text, not a second command.
  const escaped = `'${evil.replace(/'/g, "'\\''")}'`;
  assert.ok(cmd.includes(`-u ${escaped} `), "the base is wrapped as one escaped shell argument");
  assert.ok(cmd.includes(`'\\''`), "the embedded single quote is escaped, not left raw");
  assert.ok(!/-u 'https:\/\/t\.test\/';/.test(cmd), "the argument is not closed early by the embedded quote");
});

test("a non-URL or off-scope baseUrl produces a note, never a whole-site -u command", () => {
  for (const bad of ["not a url", "ftp://t.test", "javascript:alert(1)"]) {
    const recs = buildRecommendations([page("https://t.test/")], null, cfg({ baseUrl: bad, allowedOrigins: ["https://t.test"] }));
    const baseline = recs.find((r) => r.id === "baseline");
    assert.ok(baseline && !baseline.command.includes("nuclei -u"), `no -u command for baseUrl ${JSON.stringify(bad)}`);
  }
  // In scope must mean in allowedOrigins: a valid http(s) URL off-scope still gets no -u.
  const off = buildRecommendations([page("https://t.test/")], null, cfg({ baseUrl: "https://evil.test", allowedOrigins: ["https://t.test"] }));
  assert.ok(!off.find((r) => r.id === "baseline")?.command.includes("nuclei -u"), "an off-scope baseUrl gets no whole-site scan");
});
