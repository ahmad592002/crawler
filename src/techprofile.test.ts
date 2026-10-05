/**
 * Technology detection, from the headers and markup real sites actually serve.
 *
 * The fixtures are taken from live responses (the-internet.herokuapp.com is Cowboy over
 * jQuery+Foundation; practicesoftwaretesting is Angular; a WordPress site carries
 * /wp-content/). Writing them from the detector's own patterns would make them unfalsifiable
 * - the mistake this project made with its login classifier five times over.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfile, parseCookies, headerGet } from "./techprofile.js";

test("nginx and PHP are read off the headers, with versions", () => {
  const p = buildProfile(
    "https://t.test/",
    { server: "nginx/1.25.3", "x-powered-by": "PHP/8.2.4" },
    "<html></html>",
  );
  assert.equal(p.server[0]?.name, "nginx 1.25.3");
  assert.equal(p.server[0]?.confidence, "confirmed");
  assert.equal(p.languages[0]?.name, "PHP 8.2.4");
});

test("Cloudflare is detected from cf-ray even when Server is generic", () => {
  const p = buildProfile("https://t.test/", { server: "cloudflare", "cf-ray": "8abc123-LHR" }, "");
  assert.ok(p.cdn.some((d) => d.name === "Cloudflare"));
});

test("Angular is detected from ng-version", () => {
  const p = buildProfile("https://t.test/", {}, '<app-root ng-version="17.1.0"></app-root>');
  assert.ok(p.frameworks.some((f) => f.name === "Angular"));
});

test("Next.js from a header outranks a React markup guess", () => {
  const p = buildProfile(
    "https://t.test/",
    { "x-powered-by": "Next.js" },
    '<div id="root"></div><script src="/_next/static/chunks/main.js"></script>',
  );
  const names = p.frameworks.map((f) => f.name);
  assert.ok(names.includes("Next.js"));
  assert.equal(p.frameworks.find((f) => f.name === "Next.js")?.confidence, "confirmed");
});

test("the demo target's real stack: Cowboy, jQuery, Foundation", () => {
  const p = buildProfile(
    "https://the-internet.herokuapp.com/jqueryui/menu",
    { server: "Cowboy", via: "1.1 vegur" },
    `<script src="/js/vendor/jquery-1.11.3.min.js"></script>
     <script src="/js/foundation/foundation.js"></script>`,
  );
  assert.ok(p.server.some((d) => d.name === "Cowboy (Erlang)"));
  assert.ok(p.frameworks.some((f) => f.name === "jQuery"));
  assert.ok(p.frameworks.some((f) => f.name === "Foundation"));
});

test("WordPress is detected from wp-content even without a generator tag", () => {
  const p = buildProfile("https://t.test/", {}, '<link href="/wp-content/themes/x/style.css">');
  assert.ok(p.cms.some((c) => c.name === "WordPress"));
});

test("analytics and tag managers are picked out of the markup", () => {
  const p = buildProfile(
    "https://t.test/",
    {},
    `<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABC123"></script>
     <script>fbq('init','1');</script>`,
  );
  const names = p.analytics.map((a) => a.name);
  assert.ok(names.includes("Google Tag Manager"));
  assert.ok(names.includes("Meta Pixel"));
});

test("security headers are reported by presence, not value", () => {
  const p = buildProfile(
    "https://t.test/",
    { "content-security-policy": "default-src 'self'", "x-frame-options": "DENY" },
    "",
  );
  const byName = Object.fromEntries(p.securityHeaders.map((h) => [h.name, h.present]));
  assert.equal(byName["content-security-policy"], true);
  assert.equal(byName["x-frame-options"], true);
  assert.equal(byName["strict-transport-security"], false, "a missing header is reported absent");
});

test("cookie names and flags are kept, values are not", () => {
  const cookies = parseCookies([
    "session=SECRETVALUE123; Path=/; Secure; HttpOnly; SameSite=Lax",
    "theme=dark; Path=/",
  ]);
  assert.equal(cookies[0]?.name, "session");
  assert.equal(cookies[0]?.secure, true);
  assert.equal(cookies[0]?.httpOnly, true);
  assert.equal(cookies[0]?.sameSite, "Lax");
  // The whole point: the value never appears anywhere in the parsed result.
  assert.ok(!JSON.stringify(cookies).includes("SECRETVALUE123"));
  assert.equal(cookies[1]?.secure, false);
});

test("a plain static site reports almost nothing, and does not invent a framework", () => {
  const p = buildProfile("https://t.test/", { server: "nginx" }, "<html><body><h1>Hi</h1></body></html>");
  assert.equal(p.frameworks.length, 0, "no framework markers means no framework");
  assert.equal(p.cms.length, 0);
  assert.equal(p.analytics.length, 0);
  assert.equal(p.server[0]?.name, "nginx");
});

test("notable header values are shown but secret-bearing ones are never in the list", () => {
  const p = buildProfile(
    "https://t.test/",
    { server: "nginx", authorization: "Bearer SECRET", "set-cookie": "a=b" },
    "",
  );
  const shown = JSON.stringify(p.notableHeaders);
  assert.ok(shown.includes("nginx"));
  assert.ok(!shown.includes("SECRET"), "authorization is not a notable header and must not leak");
});

test("headerGet is case-insensitive", () => {
  assert.equal(headerGet({ "Content-Type": "text/html" }, "content-type"), "text/html");
  assert.equal(headerGet({ SERVER: "nginx" }, "server"), "nginx");
  assert.equal(headerGet({}, "missing"), null);
});

test("Heroku is named, not left as an unclassified header (found on a live run)", () => {
  // The live base URL answered Server: Heroku / Via: 1.1 heroku-router, and the first
  // version of this file saw both and classified neither - it showed them only under
  // notableHeaders. A profiler that cannot name the host it is looking at is half a tool.
  const p = buildProfile(
    "https://x.herokuapp.com/",
    { server: "Heroku", via: "1.1 heroku-router" },
    "",
  );
  assert.ok(p.server.some((d) => d.name === "Heroku"));
});
