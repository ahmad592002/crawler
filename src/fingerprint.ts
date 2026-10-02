/**
 * Is this response the site's catch-all page, or a real artifact?
 *
 * The pre-deploy scan used to answer that by BYTE LENGTH: a probe was treated as the
 * catch-all shell only if its body was within 64 bytes of a nonsense-path baseline. On a
 * site whose shell varies between paths that fails completely. Measured on a real target:
 * 19 probes all returned the same HTML shell at 7119-7249 bytes - a 130-byte spread - so
 * every one slipped past the 64-byte tolerance and was reported as an exposed path, seven
 * of them as `critical`. A scanner that invents seven criticals is worse than no scanner,
 * because the real ones stop being believed.
 *
 * So compare CONTENT. The fingerprint deliberately throws away the parts of a page that
 * legitimately differ between two renders of the same shell - digits, hex blobs, the
 * requested path echoed back, CSRF nonces - and keeps the structural words.
 */

/** Tokens of a page with the per-request noise removed. */
export function fingerprint(body: string): Set<string> {
  const normalized = body
    .toLowerCase()
    // Script and style bodies carry nonces and inlined state; the markup around them is
    // what identifies the shell.
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    // Long hex or base32/base64-ish runs: nonces, build hashes, ids.
    .replace(/[0-9a-f]{8,}/g, " ")
    .replace(/[a-z0-9_-]{24,}/g, " ")
    // Any digit run: timestamps, counters, prices, the echoed path's numbers.
    .replace(/\d+/g, " ")
    .replace(/[^a-z<>/= ]+/g, " ");

  const tokens = normalized.split(/\s+/).filter((t) => t.length > 1);
  return new Set(tokens);
}

/** Jaccard overlap of two fingerprints: 1 is identical, 0 shares nothing. */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * How alike two bodies must be to count as the same page.
 *
 * High on purpose. The question being asked is not "are these related" but "is this
 * literally the same shell with different filler", and the fingerprint has already removed
 * everything that varies per request. A genuine database dump or zip archive shares almost
 * no structural tokens with an HTML shell, so there is a wide margin here.
 */
export const SAME_PAGE = 0.9;

/** Does this response look like HTML, whatever it claims in its headers? */
export function looksLikeHtml(contentType: string, body: string): boolean {
  if (/text\/html|application\/xhtml/i.test(contentType)) return true;
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(body.slice(0, 200));
}

/**
 * File extensions whose contents could legitimately BE html.
 *
 * Everything else - .zip, .sql, .sqlite, .lock, .yml, .htaccess, .bak - is a file whose
 * body cannot be an HTML document. Receiving one means the server answered with its error
 * or index page, which is the single most common false positive in path probing and does
 * not need a baseline to detect. A bare path with no extension (a directory such as
 * /phpmyadmin/) is html-plausible and is left to the content comparison instead.
 */
const HTML_PLAUSIBLE = new Set(["", "php", "asp", "aspx", "jsp", "jspx", "html", "htm", "shtml", "cgi", "pl"]);

/** True when an HTML body is proof that `path` was NOT served as the artifact it names. */
export function htmlIsWrongFor(path: string): boolean {
  const last = path.split("/").filter(Boolean).pop() ?? "";
  if (!last.includes(".")) return false;
  const ext = last.split(".").pop()?.toLowerCase() ?? "";
  // A trailing .bak/.old/.orig hides the real extension: wp-config.php.bak is not html.
  if (["bak", "old", "orig", "save", "swp", "tmp"].includes(ext)) return true;
  return !HTML_PLAUSIBLE.has(ext);
}
