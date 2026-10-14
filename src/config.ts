import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Where this run reads its config and writes its artifacts.
 *
 * Both were pinned to the checkout, which meant one checkout could only ever hold one
 * target: a second site would overwrite the first one's pages.jsonl, findings, history
 * and lock. Testing more than one site at a time is the point of a QA agent, so both
 * are overridable:
 *
 *   QA_CONFIG=targets/shop.json QA_OUT=output/shop npm run crawl
 *
 * A relative QA_OUT resolves against the checkout, so the artifacts stay inside the
 * project and .gitignore keeps covering them. Defaults are exactly the old behaviour.
 */
export const CONFIG_PATH = process.env.QA_CONFIG?.trim()
  ? resolve(ROOT, process.env.QA_CONFIG.trim())
  : resolve(ROOT, "qa.config.json");

export const OUT = process.env.QA_OUT?.trim()
  ? resolve(ROOT, process.env.QA_OUT.trim())
  : resolve(ROOT, "output");

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
  /**
   * How hard this agent is allowed to lean on a target.
   *
   * There was nothing here, and the consequences were measured twice: four parallel
   * crawls got the agent throttled off a demo site, and a suite degraded its own target
   * until its largest asset took 26.8 seconds and twelve tests went flaky. Both times
   * the throttling was reported as findings about the site.
   *
   * requestDelayMs is the minimum gap between two requests to the SAME origin, and it
   * is the setting that prevents the problem rather than reacting to it. maxRequests is
   * a hard ceiling for one run, counting browser navigations as well as fetches - a page
   * load costs the target the same either way.
   */
  /**
   * Save each crawled page's HTML so nothing has to fetch it twice.
   *
   * The crawler already holds the rendered DOM - it reads it for CAPTCHA detection - and
   * the pre-deploy content scan was then fetching all 51 reachable pages AGAIN. Two full
   * passes over someone else's site to look at the same bytes, which is both the slowest
   * part of a run and the rudest.
   *
   * Saved content is the RENDERED DOM, which is strictly better input for the scan than
   * the served HTML: a leftover injected by script is invisible in the bytes on the wire.
   */
  savePageHtml: z.boolean().default(true),
  /** Per-page cap on saved HTML. A 500KB page is not 500KB of interesting leftovers. */
  savePageHtmlMaxBytes: z.number().int().positive().default(300_000),
  requestDelayMs: z.number().int().nonnegative().default(250),
  maxRequests: z.number().int().nonnegative().default(2000),
  /** Consecutive 429/503 answers from one origin before the run stops touching it. */
  rateLimitBreakAfter: z.number().int().positive().default(5),
  /** Retries after a rate-limit or gateway answer, before giving up on a URL. */
  rateLimitRetries: z.number().int().nonnegative().default(3),
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
  /**
   * Identities for features that only exist between two people - sharing, invitations,
   * messaging, admin-over-member. Each gets its own mailbox and its own saved session.
   */
  /**
   * How to log in to THIS target.
   *
   * The login was hardcoded to the demo site in six separate places - the /login path,
   * the "Username" and "Password" label text, the "Login" button name, a /secure success
   * URL and the literal success sentence - so pointing the agent at any other site meant
   * editing tests/auth.setup.ts. Credentials were already configurable, which made the
   * limitation easy to miss: the one part that looked parameterised was the only part
   * that was.
   *
   * Everything here is optional and defaults to the demo target's shape, so existing
   * configs keep working untouched. Labels are matched case-insensitively as regular
   * expressions, because "Username", "User Name" and "Email" are the same field.
   */
  login: z
    .object({
      /** Path to the sign-in page, relative to baseUrl. */
      path: z.string().default("/login"),
      /** Accessible label of the identifier field. */
      usernameLabel: z.string().default("Username"),
      passwordLabel: z.string().default("Password"),
      /**
       * Credentials for this target.
       *
       * Optional, and env wins over them: TEST_USERNAME and TEST_PASSWORD keep real
       * secrets out of a committed config. These exist because the setup project read
       * ONLY the env vars, each with the demo site's value as its default, so pointing
       * the agent at a new target sent tomsmith/SuperSecretPassword! to it and waited
       * three minutes for a navigation that was never going to happen.
       *
       * Fine to commit for a public demo account. For anything real, use the env vars.
       */
      username: z.string().optional(),
      password: z.string().optional(),
      /** Accessible name of the submit control. */
      submitLabel: z.string().default("Login"),
      /**
       * A URL pattern that proves the login worked, as a regular expression source.
       * Checked before successText, because a site that redirects is the common case.
       */
      successUrl: z.string().default("/secure$"),
      /**
       * Text that proves the login worked. Optional: many sites show nothing specific,
       * and asserting on a sentence that does not exist turns a working login into a
       * 30-second timeout that reads as a broken site.
       */
      successText: z.string().optional(),
    })
    .strict()
    .optional(),

  personas: z
    .array(
      z.object({
        /** Stable handle: used in specs, filenames and the report. */
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,20}$/, "id must be lowercase letters, digits or hyphens"),
        /** What this identity is for, e.g. "owner", "member", "admin". */
        role: z.string().optional(),
        /** Fixed site password. Omit to generate one, or for a site with fixed demo logins. */
        password: z.string().optional(),
        /** Fixed site username, for targets that log in by username rather than email. */
        username: z.string().optional(),
      }).strict(),
    )
    .optional(),
});

export type QaConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(path = CONFIG_PATH): QaConfig {
  // Strict: an unknown key is an error, not silently dropped. A stripping schema let
  // `requestDelayMS` parse cleanly and the run go out at the default spacing.
  return ConfigSchema.strict().parse(JSON.parse(readFileSync(path, "utf8")));
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
  // Exceptions are PATH regexes. Matched against the whole URL, '/add_remove_elements/?$'
  // also matched '/account/delete?next=/add_remove_elements/' and exempted the delete.
  // The placeholder base lets a relative href be cut down to its path the same way.
  let exceptionPath = url;
  try {
    exceptionPath = new URL(url, "http://relative.invalid").pathname;
  } catch {
    // Unparseable; match the raw string, which is no looser than before.
  }
  for (const pattern of cfg.denyUrlExceptions ?? []) {
    try {
      if (new RegExp(pattern).test(exceptionPath)) return false;
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
  if (isDenied(words, cfg) || DESTRUCTIVE_ROUTE.test(words)) return true;

  // URLs concatenate what labels space out. Splitting the path on separators turns
  // /billpay.htm into the single token "billpay", which the phrase "bill pay" can never
  // match on a word boundary - so a money-moving route on a banking target was allowed
  // while /transfer.htm and /withdraw.htm, single words, were correctly refused. Same hole
  // for /newaccount, /placeorder, /closeaccount, /requestloan, /emptycart.
  //
  // So multi-word deny entries are ALSO matched against the path with every separator
  // removed. Only multi-word ones, and only from six characters up: squashing single words
  // would match "pay" inside "paypal" and "repayment", which is how an over-eager guard
  // starts blocking legitimate pages and gets switched off.
  const squashed = foldLabel(decoded).replace(/[^a-z0-9]+/g, "");
  if (squashed) {
    for (const entry of cfg.denyList) {
      if (!/[\s_-]/.test(entry)) continue;
      const phrase = foldLabel(entry).replace(/[^a-z0-9]+/g, "");
      if (phrase.length >= 6 && squashed.includes(phrase)) return true;
    }
  }
  return false;
}

/** One entry of qa.config.json "personas". */
export type PersonaConfig = NonNullable<QaConfig["personas"]>[number];

/**
 * An environment variable, treating empty as absent.
 *
 * `process.env.X ?? fallback` does NOT fall back on an empty string, and a .env written as
 * `TEST_PASSWORD=` produces exactly that. The login then submitted a blank password, sat on
 * /login, and the setup project failed with a navigation timeout that looked for all the
 * world like a slow host - it survived two timeout increases before being diagnosed.
 */
export function env(name: string, fallback?: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw;
}
