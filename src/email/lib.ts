/**
 * Public email surface for tests and the MCP server.
 *
 * Provider-agnostic: pick the backend with EMAIL_PROVIDER in .env or "emailProvider"
 * in qa.config.json. "mailtm" needs no credentials; "imap" reads a real Gmail mailbox.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../config.js";
import { imapProvider } from "./imap.js";
import { mailtmProvider } from "./mailtm.js";
import type { EmailProvider, FoundEmail, TestInbox, WaitForEmailOptions } from "./types.js";

export type { EmailProvider, FoundEmail, TestInbox, WaitForEmailOptions } from "./types.js";

const PROVIDERS: Record<string, EmailProvider> = {
  imap: imapProvider,
  mailtm: mailtmProvider,
};

/** Read emailProvider from qa.config.json without failing if the file is mid-edit. */
function configuredProvider(): string | null {
  try {
    const raw = JSON.parse(readFileSync(resolve(ROOT, "qa.config.json"), "utf8")) as {
      emailProvider?: unknown;
    };
    return typeof raw.emailProvider === "string" ? raw.emailProvider : null;
  } catch {
    return null;
  }
}

export function getProvider(name?: string): EmailProvider {
  const wanted = name ?? process.env["EMAIL_PROVIDER"] ?? configuredProvider() ?? "mailtm";
  const provider = PROVIDERS[wanted];
  if (!provider) {
    throw new Error(`Unknown email provider "${wanted}". Use one of: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return provider;
}

/** Fresh signup address. `tag` should be unique per test (run id + index). */
export function createInbox(tag: string): Promise<TestInbox> {
  return getProvider().createInbox(tag);
}

export function waitForEmail(opts: WaitForEmailOptions): Promise<FoundEmail> {
  return getProvider().waitForEmail(opts);
}

export function closeEmail(): Promise<void> {
  return getProvider().close();
}

const CODE_HINTS = ["code", "verification", "verify", "otp", "passcode", "pin", "confirm"];

/**
 * Strip everything a code cannot legitimately live in before scoring.
 *
 * The MCP server feeds this function raw HTML. Without this pass, a perfectly ordinary
 * verification email -
 *     <a href="https://x.com/verify/998877">Verify</a> ... Your code: 314159
 * - returned 998877, because "verify" sits one character before the URL's digits and
 * outscores the real code. URLs, tag names, attribute values, entities and CSS lengths
 * are all removed; only human-visible text is scored.
 */
function visibleText(input: string): string {
  return (
    input
      // <script>/<style> contents are never shown to a reader.
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      // Whole tags, attributes and all - this is what removes href="/verify/998877".
      .replace(/<[^>]*>/g, " ")
      // Bare URLs in plain-text bodies carry the same trap.
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ")
      .replace(/&[a-z]+;|&#\d+;/gi, " ")
      // CSS lengths and hex colours that survive in inlined styles.
      .replace(/#[0-9a-f]{3,8}\b/gi, " ")
      .replace(/\b\d+(?:px|pt|em|rem|%)\b/gi, " ")
      .replace(/\s+/g, " ")
  );
}

/** Below this, the best candidate is not evidence of anything. */
const MIN_CODE_SCORE = 100;

/**
 * Pull a one-time code out of message text. Prefers digit runs that sit near a word
 * like "code" or "OTP", so a year or an order number does not win.
 *
 * Returns null when nothing scores above MIN_CODE_SCORE. It used to return the
 * best-shaped digit run unconditionally, so "123456 Main Street" in a footer came back
 * as a verification code with no way for the caller to tell.
 */
export function extractCode(text: string, pattern?: string | RegExp): string | null {
  if (pattern) {
    // Rebuild without g/y. Reusing a caller's global regexp would carry lastIndex across
    // calls, so the same module-level pattern would return null on its second use.
    const re =
      typeof pattern === "string"
        ? new RegExp(pattern)
        : new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
    const m = re.exec(text);
    return m ? (m[1] ?? m[0]) : null;
  }

  const scanned = visibleText(text);
  const lower = scanned.toLowerCase();

  // Where each hint word ends, so proximity can be measured from it.
  const hintEnds: number[] = [];
  for (const hint of CODE_HINTS) {
    for (let i = lower.indexOf(hint); i !== -1; i = lower.indexOf(hint, i + 1)) {
      hintEnds.push(i + hint.length);
    }
  }

  // A hint reads as a label when it comes just before the digits ("your code: 1234").
  // A hint after the digits is much weaker evidence, so its window is tight - otherwise
  // a year or an order number sitting ahead of "code" would win.
  const BEFORE_WINDOW = 40;
  const AFTER_WINDOW = 8;

  const re = /\b\d{4,8}\b/g;
  let best: { code: string; score: number } | null = null;
  for (let m = re.exec(scanned); m !== null; m = re.exec(scanned)) {
    const code = m[0];
    const start = m.index;
    const end = start + code.length;

    let proximity = 0;
    for (const hintEnd of hintEnds) {
      if (hintEnd <= start && start - hintEnd <= BEFORE_WINDOW) {
        proximity = Math.max(proximity, 100 - (start - hintEnd));
      } else if (hintEnd > end && hintEnd - end <= AFTER_WINDOW) {
        proximity = Math.max(proximity, 40 - (hintEnd - end));
      }
    }

    // Among equally-hinted candidates, prefer the shapes sites actually use.
    const shape = code.length === 6 ? 3 : code.length === 4 ? 2 : code.length === 8 ? 1 : 0;
    const score = proximity * 10 + shape;
    // On a tie, keep the EARLIER candidate. "Your code is 111111. Ignore the old code
    // 222222." scored both from their own adjacent hint; taking the later one handed
    // back the expired code.
    if (!best || score > best.score) best = { code, score };
  }
  // A candidate with no hint anywhere near it is a street number, not a passcode.
  if (!best || best.score < MIN_CODE_SCORE) return null;
  return best.code;
}

/** Words that mean "this is the action link", in the URL or in the anchor text. */
const ACTION_HINT = /\b(verify|verification|confirm|activate|activation|reset|validate|signup|sign-up|register|token|magic)\b/i;
/** Words that mean "this is boilerplate", however early in the email it appears. */
const NOISE_HINT =
  /\b(unsubscribe|opt[-_]?out|preferences|privacy|terms|track|tracking|click|open|pixel|beacon|utm_|view[-_]?in[-_]?browser|webversion|twitter|facebook|linkedin|instagram|itunes|play\.google)\b/i;

interface ScoredLink {
  url: string;
  text: string;
  order: number;
}

/**
 * Unique http(s) links from HTML or plain text, best candidate FIRST.
 *
 * Document order is the wrong order. Every templated email starts with a logo link and
 * an open-tracking pixel, so `links[0]` - which is exactly what the MCP
 * get_verification_link tool returns - was reliably the tracker rather than the
 * verification URL. Links are now ranked: action words in the URL or anchor text score
 * up, unsubscribe/tracking boilerplate scores down, and ties fall back to document order.
 */
export function extractLinks(content: string, contains?: string): string[] {
  const seen = new Map<string, ScoredLink>();
  let order = 0;

  const add = (url: string, text: string): void => {
    const clean = decodeEntities(url).replace(/[.,;:]+$/, "");
    if (!/^https?:\/\//i.test(clean)) return;
    const existing = seen.get(clean);
    if (existing) {
      // Keep the richer anchor text if we see the same URL twice.
      if (!existing.text && text) existing.text = text;
      return;
    }
    seen.set(clean, { url: clean, text, order: order++ });
  };

  // Anchors first, so the link text travels with the href. Quoted and unquoted forms.
  const anchorRe = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))[^>]*>([\s\S]*?)<\/a>/gi;
  for (let m = anchorRe.exec(content); m !== null; m = anchorRe.exec(content)) {
    const href = m[1] ?? m[2] ?? m[3] ?? "";
    const text = (m[4] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    add(href, text);
  }
  // Any remaining href (self-closing or malformed anchors), then bare URLs.
  const hrefRe = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  for (let m = hrefRe.exec(content); m !== null; m = hrefRe.exec(content)) {
    add(m[1] ?? m[2] ?? m[3] ?? "", "");
  }
  const bareRe = /https?:\/\/[^\s<>"'\]]+/gi;
  for (let m = bareRe.exec(content); m !== null; m = bareRe.exec(content)) {
    if (m[0]) add(m[0], "");
  }

  const score = (l: ScoredLink): number => {
    let s = 0;
    if (ACTION_HINT.test(l.url)) s += 40;
    if (ACTION_HINT.test(l.text)) s += 30;
    // A long opaque query value is what a one-time token looks like.
    if (/[?&][^=]*=[A-Za-z0-9_-]{16,}/.test(l.url)) s += 15;
    if (NOISE_HINT.test(l.url)) s -= 50;
    if (NOISE_HINT.test(l.text)) s -= 40;
    // Image URLs are pixels, never action links.
    if (/\.(gif|png|jpe?g|webp|svg)(\?|$)/i.test(l.url)) s -= 60;
    return s;
  };

  const all = [...seen.values()]
    .sort((a, b) => score(b) - score(a) || a.order - b.order)
    .map((l) => l.url);
  return contains ? all.filter((l) => l.includes(contains)) : all;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Build a plus-addressed test email from qa.config.json's emailPattern (imap provider). */
export function buildTestEmail(pattern: string, runId: string | number, n: number): string {
  const user = process.env["GMAIL_USER"];
  if (!user) throw new Error("GMAIL_USER must be set in .env");
  const local = user.split("@")[0] ?? "";
  return pattern
    .replace("{GMAIL_LOCAL}", local)
    .replace("{runId}", String(runId))
    .replace("{n}", String(n));
}
