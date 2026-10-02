/**
 * The soft-404 case, built from a real run.
 *
 * A pre-deploy scan of a live target reported 19 "exposed" paths - /adminer.php,
 * /phpmyadmin/, /backup.zip, /backup.sql, /dump.sql, /db.sqlite, /debug/pprof/ and more,
 * seven of them `critical`. Every one was the site's ordinary HTML shell, served with 200
 * for any path. The guard at the time compared BYTE LENGTH within 64 bytes, and the shell
 * measured 7119-7249 bytes across those 19 responses - a 130-byte spread - so not one of
 * them was recognised.
 *
 * The sizes and the shell shape below are taken from that run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, overlap, SAME_PAGE, looksLikeHtml, htmlIsWrongFor } from "./fingerprint.js";

/** The shell, with per-request filler so two renders are never byte-identical. */
function shell(filler: string, pad = 0): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Automation Practice Site</title>
<script>(function(){ setTimeout(function(){ ga('send','pageview','${filler}'); }, 1200); })();</script>
</head><body>
<div class="container"><nav class="navbar"><a href="/">Home</a><a href="/products">Products</a>
<a href="/cart">Cart</a><a href="/login">Signup / Login</a></nav>
<div id="slider" data-token="${filler}a9f3b7c1d2e4">Featured categories</div>
<footer><p>Copyright 2026 All rights reserved</p></footer></div>
${"<!-- " + "x".repeat(pad) + " -->"}
</body></html>`;
}

test("two renders of the same shell are recognised as the same page", () => {
  // Different filler and a 130-byte size difference: exactly what defeated the old
  // 64-byte length window.
  const a = shell("alpha", 0);
  const b = shell("beta", 130);
  assert.ok(Math.abs(a.length - b.length) > 64, "the fixture must defeat a 64-byte window");
  assert.ok(
    overlap(fingerprint(a), fingerprint(b)) >= SAME_PAGE,
    "the shell must be recognised across per-request filler",
  );
});

test("a real database dump is NOT mistaken for the shell", () => {
  // The margin that matters: if this ever scored as the shell, a genuine critical would be
  // silently dropped, which is a worse failure than the false positives being fixed.
  const dump = `-- MySQL dump 10.13  Distrib 8.0.32
CREATE TABLE \`users\` (
  \`id\` int NOT NULL AUTO_INCREMENT,
  \`email\` varchar(255) NOT NULL,
  \`password_hash\` varchar(255) NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO \`users\` VALUES (1,'a@b.test','$2y$10$abcdefghijklmnop');`;

  assert.ok(
    overlap(fingerprint(dump), fingerprint(shell("alpha"))) < SAME_PAGE,
    "a SQL dump must never be filtered out as the catch-all page",
  );
});

test("an unrelated real page is not the shell either", () => {
  const page = `<!DOCTYPE html><html><head><title>Adminer</title></head><body>
  <form action="" method="post"><h1>Login</h1>
  <label>Server<input name="auth[server]"></label>
  <label>Username<input name="auth[username]"></label>
  <label>Password<input type="password" name="auth[password]"></label>
  <input type="submit" value="Login"></form></body></html>`;

  assert.ok(
    overlap(fingerprint(page), fingerprint(shell("alpha"))) < SAME_PAGE,
    "a genuine Adminer console shares the doctype but nothing that matters",
  );
});

test("htmlIsWrongFor knows which paths cannot be html", () => {
  // No baseline needed for these: a .zip that arrives as an HTML document was not served.
  for (const p of [
    "/backup.zip",
    "/backup.sql",
    "/dump.sql",
    "/db.sqlite",
    "/composer.lock",
    "/yarn.lock",
    "/docker-compose.yml",
    "/.htaccess",
    "/crossdomain.xml",
    "/wp-config.php.bak",
  ]) {
    assert.equal(htmlIsWrongFor(p), true, p);
  }

  // These legitimately could be, so they go to the content comparison instead.
  for (const p of ["/adminer.php", "/phpmyadmin/", "/debug/pprof/", "/", "/admin", "/index.html"]) {
    assert.equal(htmlIsWrongFor(p), false, p);
  }
});

test("looksLikeHtml trusts the body over a wrong content-type", () => {
  // A misconfigured server can serve the error page as application/octet-stream.
  assert.equal(looksLikeHtml("application/octet-stream", "<!doctype html><html>..."), true);
  assert.equal(looksLikeHtml("text/html; charset=utf-8", "anything"), true);
  assert.equal(looksLikeHtml("application/sql", "-- MySQL dump"), false);
  assert.equal(looksLikeHtml("", "PK\u0003\u0004binary zip bytes"), false);
});

test("an empty body does not divide by zero or score as everything", () => {
  assert.equal(overlap(fingerprint(""), fingerprint("")), 1);
  assert.equal(overlap(fingerprint(""), fingerprint(shell("a"))), 0);
});
