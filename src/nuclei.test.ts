/**
 * Nuclei recommender tests. Offline, no network. The one that matters most is scope: an
 * out-of-scope or deny-listed URL must never reach a target list or a command.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rpsFromConfig, techTags, categorize, buildRecommendations } from "./nuclei.js";
import { materializeNuclei } from "./summary.js";
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
  ({ action: "/x", method: "post", destructive, fields: [{ name: "q", type, label: "q", required: false }] });

test("rpsFromConfig turns the crawler's delay into requests/second", () => {
  assert.equal(rpsFromConfig(cfg({ requestDelayMs: 400 })), 2);
  assert.equal(rpsFromConfig(cfg({ requestDelayMs: 1000 })), 1);
  assert.equal(rpsFromConfig(cfg({ requestDelayMs: 50 })), 20);
  assert.equal(rpsFromConfig(cfg({ requestDelayMs: 0 })), 10); // unset: modest default, never 0
});

test("techTags maps detected stack to nuclei tags", () => {
  const tech = { frameworks: [{ name: "jQuery 1.11", confidence: "likely", evidence: "" }], server: [{ name: "nginx", confidence: "confirmed", evidence: "" }] } as unknown as TechProfile;
  const tags = techTags(tech);
  assert.ok(tags.includes("jquery"));
  assert.ok(tags.includes("nginx"));
  assert.deepEqual(techTags(null), []);
});

test("categorize sorts pages into one category each, most specific first", () => {
  const pages = [
    page("https://t.test/login"),
    page("https://t.test/upload", { forms: [form("file") as never] }),
    page("https://t.test/search", { forms: [form("text") as never] }),
    page("https://t.test/api/users"),
    page("https://t.test/about"),
    page("https://t.test/secure", { authRequired: true }),
  ];
  const c = categorize(pages, cfg());
  assert.deepEqual(c.upload, ["https://t.test/upload"]);
  assert.ok(c.auth.includes("https://t.test/login") && c.auth.includes("https://t.test/secure"));
  assert.deepEqual(c.api, ["https://t.test/api/users"]);
  assert.deepEqual(c.forms, ["https://t.test/search"]);
  assert.deepEqual(c.static, ["https://t.test/about"]);
});

test("a login page that is ALSO an upload page counts once, as upload (most specific)", () => {
  const c = categorize([page("https://t.test/login", { forms: [form("file") as never] })], cfg());
  assert.deepEqual(c.upload, ["https://t.test/login"]);
  assert.equal(c.auth.length, 0);
});

test("scope: off-origin and deny-listed URLs never enter a category", () => {
  const pages = [
    page("https://evil.test/login"), // off origin
    page("https://t.test/account/delete"), // deny-listed path
    page("https://t.test/ok"),
    page("https://t.test/broken", { ok: false }), // failed load
  ];
  const c = categorize(pages, cfg());
  const all = [...c.auth, ...c.forms, ...c.upload, ...c.api, ...c.static];
  assert.ok(!all.some((u) => u.includes("evil.test")), "no off-origin URL");
  assert.ok(!all.some((u) => u.includes("/account/delete")), "no deny-listed URL");
  assert.ok(!all.includes("https://t.test/broken"), "no failed page");
  assert.deepEqual(all, ["https://t.test/ok"]);
});

test("buildRecommendations always leads with a non-intrusive baseline", () => {
  const recs = buildRecommendations([page("https://t.test/")], null, cfg());
  assert.equal(recs[0]?.id, "baseline");
  assert.equal(recs[0]?.intrusive, false);
  assert.ok(recs[0]?.command.includes("-u 'https://t.test'"));
  assert.ok(recs[0]?.command.includes("-rate-limit 2"));
});

test("headers/cookies recs appear only when the profile shows a problem", () => {
  const clean = { securityHeaders: [{ name: "content-security-policy", present: true }], cookies: [{ name: "s", secure: true, httpOnly: true, sameSite: "Lax" }] } as unknown as TechProfile;
  assert.ok(!buildRecommendations([page("https://t.test/")], clean, cfg()).some((r) => r.id === "headers" || r.id === "cookies"));
  const bad = { securityHeaders: [{ name: "content-security-policy", present: false }], cookies: [{ name: "s", secure: false, httpOnly: true, sameSite: null }] } as unknown as TechProfile;
  const recs = buildRecommendations([page("https://t.test/")], bad, cfg());
  assert.ok(recs.some((r) => r.id === "headers"));
  assert.ok(recs.some((r) => r.id === "cookies"));
});

test("form and upload scans are flagged intrusive; auth is not", () => {
  const pages = [page("https://t.test/search", { forms: [form("text") as never] }), page("https://t.test/upload", { forms: [form("file") as never] }), page("https://t.test/login")];
  const recs = buildRecommendations(pages, null, cfg());
  assert.equal(recs.find((r) => r.id === "forms")?.intrusive, true);
  assert.equal(recs.find((r) => r.id === "upload")?.intrusive, true);
  assert.equal(recs.find((r) => r.id === "auth")?.intrusive, false);
});

test("every command targets only an in-scope host or a list file - never a raw off-scope URL", () => {
  const pages = [page("https://t.test/login"), page("https://t.test/search", { forms: [form("text") as never] })];
  for (const r of materializeNuclei(buildRecommendations(pages, null, cfg()), "output", false)) {
    assert.ok(!r.command.includes("{list}"), `${r.id}: {list} was substituted`);
    const urls = r.command.match(/https?:\/\/[^\s']+/g) ?? [];
    for (const u of urls) assert.ok(u.startsWith("https://t.test"), `${r.id}: in-scope only, saw ${u}`);
  }
});
