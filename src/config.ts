import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ConfigSchema = z.object({
  baseUrl: z.string(),
  allowedOrigins: z.array(z.string()),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  maxPages: z.number().int().positive(),
  maxDepth: z.number().int().positive(),
  concurrency: z.number().int().positive(),
  navTimeoutMs: z.number().int().positive(),
  /** Hard wall-clock cap on one crawl. Without it a single hung page stalls forever. */
  maxRuntimeMs: z.number().int().positive().default(30 * 60_000),
  blockDomains: z.array(z.string()),
  denyList: z.array(z.string()),
  /**
   * Regexes for URLs that look destructive but are not, e.g. a demo page literally named
   * /add_remove_elements/. A URL-level deny-list WILL have false positives; this is the
   * documented way to grant an exception, one URL shape at a time, instead of the
   * tempting alternative of loosening the rule for everything.
   */
  denyUrlExceptions: z.array(z.string()).default([]),
  emailPattern: z.string(),
  emailProvider: z.enum(["mailtm", "imap"]).default("mailtm"),
  /** Record every request/response as a Burp-importable proxy history. */
  captureHttpHistory: z.boolean().default(false),
  /** Truncate any single captured body beyond this many bytes. */
  captureMaxBodyBytes: z.number().int().positive().default(2_000_000),
  /** Also record third-party requests. Off by default to keep the capture on target. */
  captureOffOrigin: z.boolean().default(false),
  /**
   * Playwright workers. Defaults to half the CPUs, but a small or slow target is the
   * bottleneck long before the machine is - too many workers just times each other out.
   */
  testWorkers: z.number().int().positive().optional(),
});

export type QaConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(path = resolve(ROOT, "qa.config.json")): QaConfig {
  return ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** True if the URL's origin is in allowedOrigins. All navigation must pass this. */
export function isAllowedUrl(url: string, cfg: QaConfig): boolean {
  try {
    const u = new URL(url);
    // Userinfo is not part of an origin, but "https://target.com@evil.com/" parses with
    // origin evil.com and reads like the target to a human. Refuse it outright.
    if (u.username || u.password) return false;
    return cfg.allowedOrigins.includes(u.origin);
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- deny matching

const ZERO_WIDTH = /[­​-‏⁠﻿]/g;

/**
 * Fold a label to a comparable form before deny matching.
 *
 * A raw `toLowerCase().includes()` is defeated by anything a real UI does to text:
 * fullwidth characters (Ｄelete), diacritics (Délete), zero-width joiners inside the word,
 * and letter-spacing implemented as literal spaces (D e l e t e). NFKD + diacritic strip +
 * NFKC + zero-width removal + whitespace collapse folds all of those onto the same string.
 */
export function foldLabel(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match one deny term against a folded haystack.
 *
 * Single-word terms are matched on word boundaries, because a bare substring test makes
 * "pay" reject "Payment history" and "Repay loan", and makes "delete" reject "Undelete".
 * Those false positives are not harmless: they silently remove safe controls from the
 * inventory, so nobody ever tests them and nobody notices why.
 */
function hasWord(haystack: string, word: string): number {
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(word)}(?![\\p{L}\\p{N}])`, "u").exec(haystack);
  return m ? m.index : -1;
}

/** How far apart a multi-word term's words may sit and still count as the same phrase. */
const PHRASE_WINDOW = 40;

function matchesTerm(haystack: string, term: string): boolean {
  if (!term) return false;
  const words = term.split(" ").filter(Boolean);
  if (words.length === 1) return hasWord(haystack, term) >= 0;

  // Word ORDER is not reliable. "close account" as a deny term has to catch the route
  // /account/close, which reads as "account close" once separators become spaces - and
  // that was the exact hole that let an account-closing link through. Require all the
  // words within a short window instead of an exact phrase.
  let lo = Infinity;
  let hi = -Infinity;
  for (const word of words) {
    const at = hasWord(haystack, word);
    if (at < 0) return false;
    lo = Math.min(lo, at);
    hi = Math.max(hi, at + word.length);
  }
  return hi - lo <= term.length + PHRASE_WINDOW;
}

/** True if a label/text matches any denyList entry. Unicode- and spacing-insensitive. */
export function isDenied(text: string, cfg: QaConfig): boolean {
  if (!text) return false;
  const folded = foldLabel(text);
  // "R e m o v e" and "Rem ove" both fold to a spaced string; also test it with all
  // internal spacing removed so letter-spaced labels cannot slip past.
  const squashed = folded.replace(/ /g, "");
  return cfg.denyList.some((d) => {
    const term = foldLabel(d);
    return matchesTerm(folded, term) || matchesTerm(squashed, term.replace(/ /g, ""));
  });
}

/**
 * Verbs that mean "this request changes or destroys something" even when the site never
 * writes them on a button. Checked against the URL in addition to the configured
 * denyList, because a deny-list tuned to button labels is not tuned to route names.
 */
const DESTRUCTIVE_ROUTE =
  /(?<![\p{L}\p{N}])(delete|destroy|remove|purge|drop|wipe|erase|revoke|deactivate|unsubscribe|terminate)(?![\p{L}\p{N}])/u;

/**
 * True if navigating this URL would plausibly perform a destructive action.
 *
 * This exists because the deny-list used to be applied only to button labels, while the
 * crawler happily followed <a href="/admin/users/7/delete">. Separators are turned into
 * spaces so the path reads as words and the same word-boundary rules apply.
 */
export function isDeniedUrl(url: string, cfg: QaConfig): boolean {
  for (const pattern of cfg.denyUrlExceptions ?? []) {
    try {
      if (new RegExp(pattern).test(url)) return false;
    } catch {
      // A bad regex in config must not silently disable the guard for everything else.
    }
  }

  let target: string;
  try {
    const u = new URL(url);
    target = `${u.pathname}${u.search}`;
  } catch {
    target = url;
  }
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // Malformed percent-encoding; match against the raw form instead.
  }
  const words = foldLabel(decoded.replace(/[/_\-+.=&?]+/g, " "));
  return isDenied(words, cfg) || DESTRUCTIVE_ROUTE.test(words);
}
