/**
 * Fast parallel crawler. Plain Playwright - no MCP, no AI, no tokens.
 *
 *   npm run crawl        # anonymous  -> output/pages.jsonl
 *   npm run crawl:auth   # logged in  -> output/pages.auth.jsonl
 *
 * Resumable: every page is appended to the .jsonl the moment it is done, and a restart
 * skips URLs already recorded there.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { loadConfig, isAllowedUrl, isDenied, isDeniedUrl, ROOT, type QaConfig, OUT } from "./config.js";
import { recordHistory, writeBurpXml, drainHistory, historyJsonl, historyXml } from "./http-history.js";
import { acquireLock } from "./runlock.js";
import { judgeCrawl } from "./crawl-verdict.js";
import { politeClient, PolitenessError } from "./polite.js";
import { detectCaptcha, isBlocked, type CaptchaSignal } from "./captcha.js";

const SHOTS = resolve(OUT, "screenshots");
const CONTENT = resolve(OUT, "content");
const STATE = resolve(OUT, "auth", "state.json");

export interface FormField {
  name: string;
  type: string;
  label: string;
  required: boolean;
}

export interface FormInfo {
  action: string;
  method: string;
  fields: FormField[];
  /** True if the action URL or the submit label matches denyList. Never submit these. */
  destructive: boolean;
}

export interface PageRecord {
  url: string;
  template: string;
  depth: number;
  status: number | null;
  title: string;
  loadMs: number;
  screenshot: string | null;
  consoleErrors: string[];
  failedRequests: { url: string; status: number | string }[];
  pageErrors: string[];
  forms: FormInfo[];
  buttons: string[];
  /** Buttons withheld because their label matches denyList. Never offered as targets. */
  deniedButtons: string[];
  /** Links withheld because the URL or anchor text looks destructive. Never followed. */
  deniedLinks: string[];
  links: number;
  authRequired: boolean;
  /**
   * True when the final URL differed from the requested one.
   *
   * `status` is the status of the FINAL response after Playwright follows redirects, so
   * a path that 302s elsewhere is recorded as 200 against the URL that was asked for.
   * Without this flag nothing downstream can tell a real page from a redirect stub, and
   * coverage.ts treated the stub as a page in its own right.
   */
  redirected: boolean;
  /**
   * CAPTCHA challenges found on this page.
   *
   * Recorded so a gated flow is reported as GATED rather than broken. Without it, a
   * signup behind a challenge looks like a form that silently fails - the agent submits,
   * nothing happens, and the finding written is about the wrong thing entirely.
   */
  captcha: CaptchaSignal[];
  /** False when the navigation itself failed. A failed visit is NOT a crawled page. */
  ok: boolean;
  mode: "anon" | "auth";
  crawledAt: string;
}

// ---------------------------------------------------------------- URL handling

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|referrer$|_ga$|msclkid$)/i;

/** Canonical form used for dedup: no hash, no tracking params, sorted query, no trailing slash. */
export function normalizeUrl(raw: string, base?: string): string | null {
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  u.hash = "";

  // Strip userinfo. "https://user:pw@host/p" would otherwise be stored verbatim in
  // pages.jsonl, baked into a screenshot FILENAME on disk, and rendered into report.html
  // - which CI uploads as an artifact. Credentials must not survive normalisation.
  u.username = "";
  u.password = "";

  // Rebuild the query from the raw string rather than via searchParams: re-appending
  // through searchParams form-encodes, turning %20 into + - a different resource to
  // servers that treat the query as an opaque token.
  const query = u.search.startsWith("?") ? u.search.slice(1) : u.search;
  const kept = query
    .split("&")
    .filter((pair) => pair.length > 0)
    .filter((pair) => !TRACKING_PARAM.test(pair.split("=")[0] ?? ""))
    .sort((a, b) => (a.split("=")[0] ?? "").localeCompare(b.split("=")[0] ?? ""));
  u.search = kept.length ? `?${kept.join("&")}` : "";

  // NOTE: the trailing slash is deliberately preserved here. It is not always cosmetic -
  // this target serves /add_remove_elements/ but 404s /add_remove_elements - so the URL
  // that gets fetched must stay as the site published it. Use dedupKey() for identity.
  return u.toString();
}

/**
 * Identity of a page for deduplication, as distinct from the URL to request.
 *
 * Folds "/x/" and "/x" together so one page is not crawled twice, while normalizeUrl
 * keeps whichever form the site actually links to.
 */
export function dedupKey(url: string): string {
  const norm = normalizeUrl(url);
  if (!norm) return url;
  try {
    const u = new URL(norm);
    if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return norm;
  }
}

/**
 * Collapse URLs that differ only by an id into one template, so /users/1 and /users/2
 * are recognised as the same page shape and only a few samples get crawled.
 */
export function templateOf(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const path = u.pathname
    .split("/")
    .map((seg) => {
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":uuid";
      if (/^[0-9a-f]{24,}$/i.test(seg)) return ":hash";
      // A ULID: 26 characters of Crockford base32, which is digits plus uppercase
      // letters with I, L, O and U left out. It matches none of the rules above - not
      // all digits, not a uuid, and not hex, because it carries letters past F - so 35
      // of 46 pages on an SPA target came back as 35 separate templates, each its own
      // "untested page", and the templates figure read 2%.
      if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(seg)) return ":ulid";
      // Slugs that merely end in an id: product-123 -> product-:id
      if (/^[a-z0-9-]*-\d+$/i.test(seg)) return seg.replace(/-\d+$/, "-:id");
      return seg;
    })
    .join("/");
  // Query VALUES are part of the template, not noise. Folding them away made ?page=1 and
  // ?page=50 - and every faceted-navigation URL - a single shape, so the per-template
  // sample cap crawled three of them and declared the section covered. Path ids are
  // already collapsed above; that is the case the cap is for.
  const params = [...u.searchParams.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  return `${u.origin}${path}${params.length ? `?${params.join("&")}` : ""}`;
}

function matchesAny(url: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    try {
      return new RegExp(p).test(url);
    } catch {
      return false;
    }
  });
}

function inScope(url: string, cfg: QaConfig): boolean {
  // Origin check goes through the shared guard rather than a second copy of the rule,
  // so there is exactly one place where "may we visit this?" is decided.
  if (!isAllowedUrl(url, cfg)) return false;
  if (cfg.exclude.length && matchesAny(url, cfg.exclude)) return false;
  if (cfg.include.length && !matchesAny(url, cfg.include)) return false;
  return true;
}

export function slugify(url: string): string {
  const s = url.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
  // The hash is ALWAYS appended, not just for long URLs: collapsing every punctuation run
  // to "_" makes /a/b, /a-b and /a_b share a slug, so one screenshot would silently
  // overwrite another and the report would show the wrong evidence.
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0;
  const hash = (h >>> 0).toString(36);
  // Keep the name well inside the Windows path limit.
  return `${(s || "root").slice(0, 70)}_${hash}`;
}

// ---------------------------------------------------------------- seeding

/**
 * Sitemaps very often list http:// URLs for an https:// site. inScope compares origins
 * exactly, so those seeds would all be discarded and the crawl would start from a single
 * URL. Realign the scheme when only the scheme differs.
 */
function alignScheme(url: string, base: string): string {
  try {
    const u = new URL(url);
    const b = new URL(base);
    if (u.host === b.host && u.protocol !== b.protocol) {
      u.protocol = b.protocol;
      return u.toString();
    }
  } catch {
    // Not a URL we can fix up; hand it back unchanged and let inScope reject it.
  }
  return url;
}

async function sitemapSeeds(base: string, cfg: QaConfig): Promise<string[]> {
  const found = new Set<string>();
  const candidates = [`${base}/sitemap.xml`];

  try {
    const res = await politeClient(cfg).fetch(`${base}/robots.txt`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const text = await res.text();
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*sitemap:\s*(\S+)/i.exec(line);
        if (m?.[1]) candidates.push(m[1]);
      }
    }
  } catch {
    // robots.txt is optional; a missing or slow one must not block the crawl.
  }

  for (const sitemap of candidates) {
    try {
      const res = await politeClient(cfg).fetch(sitemap, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const xml = await res.text();
      const locRe = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
      for (let m = locRe.exec(xml); m !== null; m = locRe.exec(xml)) {
        const norm = m[1] ? normalizeUrl(alignScheme(m[1], base)) : null;
        if (norm && inScope(norm, cfg)) found.add(norm);
      }
    } catch {
      // Same: sitemaps are a bonus, not a requirement.
    }
  }
  return [...found];
}

// ---------------------------------------------------------------- page visit

/** Pulled out of the page in one evaluate call - one round trip instead of many. */
/** A clickable control, with BOTH of its candidate names kept for deny matching. */
export interface ControlInfo {
  /** What a human sees / what a locator will match on. */
  label: string;
  /** The other candidate name (aria-label when label came from text, and vice versa). */
  alt: string;
  /** Every candidate name, untruncated - what the deny-list is matched against. */
  names?: string[];
}

/** A link, with BOTH candidate names kept so the deny-list can be applied to it. */
export interface AnchorInfo {
  href: string;
  label: string;
  /** The other name, as in ControlInfo. One name let aria-label="Details" hide "Delete". */
  alt: string;
  /** As in ControlInfo. */
  names?: string[];
}

/** Every name a link or control can be known by, as read off the DOM. Untruncated. */
export interface RawNames {
  aria: string;
  /** textContent, or `value` for an input. */
  text: string;
  title: string;
  /** Text of the elements aria-labelledby points at. */
  labelledBy: string;
  /** alt of descendant images (and of the element itself, for input type=image). */
  imgAlt: string[];
  /** Text of descendant <svg><title>. */
  svgTitle: string[];
}

/**
 * Display names plus the full candidate list.
 *
 * aria-label and text alone missed every icon link: <a title="Delete order"> or
 * <a><img alt="Delete"></a> had two empty names and was queued and fetched. And the names
 * were cut to 80 characters in the page, so padding a label pushed the word out of reach.
 * Now the deny-list sees every name in full; only `label`/`alt` are cut, for display.
 */
export function namesFrom(raw: RawNames): { label: string; alt: string; names: string[] } {
  const clean = (s: string): string => s.replace(/\s+/g, " ").trim();
  const aria = clean(raw.aria);
  const txt = clean(raw.text);
  const [label, alt] = aria ? [aria, txt] : [txt, aria];
  const names = [aria, txt, raw.title, raw.labelledBy, ...raw.imgAlt, ...raw.svgTitle]
    .map(clean)
    .filter((s) => s.length > 0);
  // Something to show for an icon-only control, which used to be dropped as nameless.
  const shown = label || names[0] || "";
  return { label: shown.slice(0, 80), alt: alt.slice(0, 80), names: [...new Set(names)] };
}

/** Denied if ANY name matches - the two display names and every other candidate. */
function deniedByName(c: ControlInfo | AnchorInfo, cfg: QaConfig): boolean {
  return [c.label, c.alt, ...(c.names ?? [])].some((n) => isDenied(n, cfg));
}

interface Harvest {
  title: string;
  anchors: AnchorInfo[];
  /** `destructive` is decided outside the page, from the action and the submit labels. */
  forms: (Omit<FormInfo, "destructive"> & { submitLabels: string[] })[];
  controls: ControlInfo[];
  links: number;
}

async function harvest(page: Page): Promise<Harvest> {
  const raw = await page.evaluate(() => {
    // Every name is returned, never just one. Reading `aria-label ?? textContent` meant
    // a button reading "Delete" with aria-label="Confirm" was classified as safe - and a
    // button reading "Confirm" with aria-label="Delete account" as unsafe. Only checking
    // all of them can be correct. Untruncated and uncleaned: namesFrom() does that in
    // Node, where it can be tested.
    const names = (el: Element) => ({
      aria: el.getAttribute("aria-label") ?? "",
      text: (el.tagName === "INPUT" ? el.getAttribute("value") : el.textContent) ?? "",
      title: el.getAttribute("title") ?? "",
      labelledBy: (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" "),
      imgAlt: [
        ...(el.hasAttribute("alt") ? [el.getAttribute("alt") ?? ""] : []),
        ...[...el.querySelectorAll("img[alt]")].map((i) => i.getAttribute("alt") ?? ""),
      ],
      svgTitle: [...el.querySelectorAll("svg title")].map((t) => t.textContent ?? ""),
    });

    const labelFor = (el: Element): string => {
      const id = el.getAttribute("id");
      if (id) {
        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lab?.textContent) return lab.textContent.replace(/\s+/g, " ").trim().slice(0, 80);
      }
      const wrap = el.closest("label");
      if (wrap?.textContent) return wrap.textContent.replace(/\s+/g, " ").trim().slice(0, 80);
      return (
        el.getAttribute("aria-label") ??
        el.getAttribute("placeholder") ??
        el.getAttribute("name") ??
        ""
      ).slice(0, 80);
    };

    const anchors: { href: string; raw: ReturnType<typeof names> }[] = [];
    for (const a of document.querySelectorAll<HTMLElement>("a[href], [role=link], [data-href]")) {
      const h = a.getAttribute("href") ?? a.getAttribute("data-href");
      // The anchor text travels with the href so the deny-list can be applied to links,
      // not only to buttons. "Delete account" as a link used to be followed silently.
      if (h) anchors.push({ href: h, raw: names(a) });
    }

    const forms = [...document.querySelectorAll("form")].map((f) => ({
      action: f.getAttribute("action") ?? "",
      method: (f.getAttribute("method") ?? "get").toLowerCase(),
      submitRaw: [
        ...f.querySelectorAll("button, input[type=submit], input[type=button], input[type=image]"),
      ].map(names),
      fields: [...f.querySelectorAll("input, select, textarea")]
        .filter((el) => (el.getAttribute("type") ?? "") !== "hidden")
        .map((el) => ({
          name: el.getAttribute("name") ?? el.getAttribute("id") ?? "",
          type: el.getAttribute("type") ?? el.tagName.toLowerCase(),
          label: labelFor(el),
          required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
        })),
    }));

    const controls = [
      ...document.querySelectorAll(
        "button, [role=button], input[type=submit], input[type=button], input[type=image]",
      ),
    ].map(names);

    return {
      title: document.title,
      anchors,
      forms,
      controls,
      links: document.querySelectorAll("a[href]").length,
    };
  });

  return {
    title: raw.title,
    anchors: raw.anchors.map((a) => ({ href: a.href, ...namesFrom(a.raw) })),
    forms: raw.forms.map(({ submitRaw, ...f }) => ({
      ...f,
      submitLabels: submitRaw.flatMap((r) => namesFrom(r).names),
    })),
    // A control with no name at all has nothing to show or match; one named only by a
    // title or an icon's alt is kept now, where it used to be dropped as nameless.
    controls: raw.controls.map(namesFrom).filter((c) => c.names.length > 0),
    links: raw.links,
  };
}

/**
 * Split harvested links into the ones to follow and the ones withheld as destructive.
 *
 * Links are filtered by the deny-list too. Previously isDenied was applied only to
 * button labels while <a href="/users/7/delete">Delete</a> was queued and GET-ted by
 * the crawler itself - the destructive action fired without anything "clicking" it.
 */
export function partitionLinks(
  anchors: AnchorInfo[],
  base: string,
  cfg: QaConfig,
): { discovered: string[]; deniedLinks: string[] } {
  const discovered: string[] = [];
  const deniedLinks: string[] = [];
  for (const a of anchors) {
    const n = normalizeUrl(a.href, base);
    if (!n || !inScope(n, cfg)) continue;
    if (isDeniedUrl(n, cfg) || deniedByName(a, cfg)) {
      deniedLinks.push(n);
      continue;
    }
    discovered.push(n);
  }
  return { discovered, deniedLinks };
}

const LOGIN_HINT = /\b(log ?in|sign ?in|authenticate)\b/i;

interface VisitResult {
  record: PageRecord;
  discovered: string[];
}

async function visit(
  ctx: BrowserContext,
  url: string,
  depth: number,
  cfg: QaConfig,
  mode: "anon" | "auth",
): Promise<VisitResult> {
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  const failedRequests: { url: string; status: number | string }[] = [];
  const pageErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on("pageerror", (err) => pageErrors.push(String(err.message).slice(0, 300)));
  page.on("requestfailed", (req) => {
    failedRequests.push({ url: req.url().slice(0, 300), status: req.failure()?.errorText ?? "failed" });
  });
  page.on("response", (res) => {
    if (res.status() >= 400) failedRequests.push({ url: res.url().slice(0, 300), status: res.status() });
  });

  const started = Date.now();
  let status: number | null = null;
  let finalUrl = url;

  try {
    // Wait for this origin's turn before navigating. Without it, `concurrency` workers
    // all load pages as fast as the browser allows and a small target simply folds.
    await politeClient(cfg).gate(url);
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.navTimeoutMs });
    status = res?.status() ?? null;
    // Hand the answer back. Gating alone paced the crawl but never heard a 429, so the
    // breaker and backoff could not trip on the requester that makes the most requests.
    if (res) politeClient(cfg).report(url, res.status(), res.headers()["retry-after"] ?? null);
    // Bounded quiet period - never an unbounded networkidle, which can hang forever.
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
    finalUrl = page.url();
  } catch (err) {
    // The limiter refusing is not a page that failed to load: nothing was requested.
    // Recording it as one wrote an ok:false line for every job left in the queue.
    if (err instanceof PolitenessError) {
      await page.close().catch(() => {});
      throw err;
    }
    pageErrors.push(`navigation: ${err instanceof Error ? err.message : String(err)}`);
  }
  const loadMs = Date.now() - started;
  const navOk = status !== null;

  let info: Harvest = { title: "", anchors: [], forms: [], controls: [], links: 0 };
  try {
    // page.evaluate has no timeout of its own. A page that blocks the main thread would
    // otherwise hang this worker forever, and the pool's "active === 0" exit condition
    // means every OTHER worker then spins on the 50ms poll for the rest of the run.
    info = await withTimeout(harvest(page), 20_000, "harvest");
  } catch (err) {
    pageErrors.push(`harvest: ${err instanceof Error ? err.message : String(err)}`);
  }

  let screenshot: string | null = null;
  try {
    const file = resolve(SHOTS, `${mode === "auth" ? "auth_" : ""}${slugify(url)}.jpg`);
    await page.screenshot({ path: file, fullPage: true, type: "jpeg", quality: 70, timeout: 20_000 });
    screenshot = `screenshots/${file.split(/[\\/]/).pop()}`;
  } catch {
    // A screenshot failure (huge page, detached frame) must not lose the record.
  }

  // Split destructive controls out of the inventory here, at the point the data is
  // produced. Phase 5 plans its clicks from this file, so a label that never appears in
  // `buttons` is never a candidate - the deny-list stops being advice and starts being
  // a property of the data.
  //
  // EVERY candidate name is checked: aria-label, visible text, title, aria-labelledby and
  // icon alt text. Checking only one let a "Delete" button with aria-label="Confirm" through.
  const isDeniedControl = (c: ControlInfo): boolean => deniedByName(c, cfg);
  const display = (c: ControlInfo): string => c.label || c.alt;
  const safeButtons = [
    ...new Set(info.controls.filter((c) => !isDeniedControl(c)).map(display)),
  ].slice(0, 40);
  const deniedButtons = [...new Set(info.controls.filter(isDeniedControl).map(display))];

  // Forms carry the same risk as buttons and were never classified at all: an innocuous
  // "Continue" submitting to /account/close was inventoried as safe.
  const forms: FormInfo[] = info.forms.map((f) => {
    const actionUrl = normalizeUrl(f.action, finalUrl);
    return {
      action: f.action,
      method: f.method,
      fields: f.fields,
      destructive:
        (actionUrl !== null && isDeniedUrl(actionUrl, cfg)) ||
        isDeniedUrl(f.action, cfg) ||
        f.submitLabels.some((l) => isDenied(l, cfg)),
    };
  });

  // Read from the live DOM rather than the served HTML: these widgets are injected by
  // script, so the markup that arrived over the wire often contains no trace of them.
  let captcha: CaptchaSignal[] = [];
  let pageHtml: string | null = null;
  try {
    pageHtml = await page.content();
    captcha = detectCaptcha(pageHtml);
  } catch {
    /* a page that died before content() is already recorded as not ok */
  }

  // Save the rendered DOM so the content scan never re-fetches this page. Capped, and
  // best-effort: a failed write must not fail a crawl.
  const htmlToSave = pageHtml;
  if (cfg.savePageHtml && htmlToSave && navOk) {
    try {
      mkdirSync(CONTENT, { recursive: true });
      writeFileSync(
        resolve(CONTENT, `${slugify(url)}.html`),
        htmlToSave.slice(0, cfg.savePageHtmlMaxBytes),
      );
    } catch {
      /* out of disk, or a path the filesystem refuses - not worth failing a crawl */
    }
  }
  if (isBlocked(captcha)) {
    console.log(`  [captcha] ${url} is gated by ${captcha.map((c) => c.kind).join(", ")}`);
  }

  const normFinal = normalizeUrl(finalUrl) ?? finalUrl;
  const redirected = normFinal !== url;
  const authRequired =
    redirected && (LOGIN_HINT.test(normFinal) || LOGIN_HINT.test(info.title)) ;

  const { discovered, deniedLinks } = partitionLinks(info.anchors, finalUrl, cfg);

  await page.close().catch(() => {});

  return {
    record: {
      url,
      // templateOf(dedupKey(url)), not templateOf(url): the per-template BUDGET is counted
      // on the dedup key, so recording a different template here made the report's
      // template count disagree with the crawler's own accounting on any trailing slash.
      template: templateOf(dedupKey(url)),
      depth,
      status,
      title: info.title,
      loadMs,
      screenshot,
      consoleErrors,
      failedRequests: failedRequests.slice(0, 20),
      pageErrors,
      forms,
      buttons: safeButtons,
      deniedButtons,
      deniedLinks: [...new Set(deniedLinks)],
      links: info.links,
      authRequired,
      redirected,
      captcha,
      ok: navOk,
      mode,
      crawledAt: new Date().toISOString(),
    },
    discovered,
  };

}

// ---------------------------------------------------------------- driver

export interface Frontier {
  queue: { url: string; depth: number }[];
  /** URLs refused at the door because they look destructive. Never fetched. */
  deniedSeeds: string[];
  enqueue(url: string, depth: number): void;
}

/** The crawl queue. Every URL the crawler will ever fetch enters through enqueue(). */
export function createFrontier(cfg: QaConfig, done: Set<string>): Frontier {
  const queue: { url: string; depth: number }[] = [];
  const deniedSeeds: string[] = [];
  const queued = new Set<string>([...done]);

  // Seed the per-template counts from what a previous run already recorded. enqueue()
  // returns early for a known URL and never reaches the counter, so starting these at
  // zero would let a resumed run collect 3 MORE samples of every template.
  const perTemplate = new Map<string, number>();
  for (const url of done) {
    const t = templateOf(url);
    perTemplate.set(t, (perTemplate.get(t) ?? 0) + 1);
  }

  // Dedup on the key, but queue (and later fetch) the URL exactly as the site published it.
  const enqueue = (url: string, depth: number): void => {
    const key = dedupKey(url);
    if (queued.has(key) || depth > cfg.maxDepth) return;
    // So does the scope check. It was left to every caller, and baseUrl itself was enqueued
    // with none - this door is only "the single door" if it enforces CLAUDE.md rule 1 too.
    if (!isAllowedUrl(url, cfg)) {
      queued.add(key); // record it once, like a denied URL
      return;
    }
    // The deny check lives HERE, not only on harvested links. baseUrl, the auth landing
    // and sitemap <loc> entries never pass through visit()'s link filter, so a sitemap
    // listing /account/delete used to be queued and GET-ted by the crawler itself.
    if (isDeniedUrl(url, cfg)) {
      queued.add(key); // record it once, however many pages link to it
      deniedSeeds.push(url);
      return;
    }
    const t = templateOf(key);
    const n = perTemplate.get(t) ?? 0;
    if (n >= 3) return; // at most 3 samples per page shape
    perTemplate.set(t, n + 1);
    queued.add(key);
    queue.push({ url, depth });
  };

  return { queue, deniedSeeds, enqueue };
}

/**
 * Dedup keys of pages a previous run actually LOADED.
 *
 * Records whose navigation failed are excluded on purpose. They used to be counted as
 * done, so a page that timed out once was never retried and silently disappeared from
 * the inventory for good - the worst kind of gap, because nothing reports it.
 */
function previousUrls(file: string): Set<string> {
  if (!existsSync(file)) return new Set();
  const seen = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as Partial<PageRecord>;
      if (typeof rec.url !== "string") continue;
      // `ok` is newer than some existing files; fall back to "did it get a status?".
      const loaded = rec.ok ?? rec.status !== null;
      if (!loaded) continue;
      // Store the dedup key, since that is what enqueue() checks against.
      seen.add(dedupKey(rec.url));
    } catch {
      // A truncated last line from an interrupted run is simply ignored.
    }
  }
  return seen;
}

/** Reject after `ms` rather than letting one hung page stall the whole worker pool. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** How a crawl's worker pool ended, beyond simply running out of work. */
export interface PoolOutcome {
  timedOut: boolean;
  /** The limiter's refusal, if one stopped the pool. Not a page failure: nothing was sent. */
  refused: PolitenessError | null;
}

/**
 * Run `concurrency` workers over a shared queue until it drains, a cap is hit, or the
 * politeness limiter refuses a request.
 *
 * Lifted out of main() so the refusal decision can be tested without a browser. A
 * PolitenessError used to be caught as one more navigation failure, so when the budget
 * was spent or the breaker opened the crawl kept draining its queue, wrote an ok:false
 * record for every remaining job and exited 0 - and `npm run qa` carried on against a
 * target that had asked it to stop. Now the first refusal stops every worker.
 */
export async function runPool<J>(opts: {
  queue: J[];
  concurrency: number;
  deadline: number;
  /** Checked before taking each job: a page cap reached, or a fatal error elsewhere. */
  stop: () => boolean;
  handle: (job: J, worker: number) => Promise<void>;
  /** Where a crashed job is reported, and how it is named there. */
  log?: (line: string) => void;
  name?: (job: J) => string;
}): Promise<PoolOutcome> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const name = opts.name ?? ((job: J) => String(job));
  let active = 0;
  let timedOut = false;
  let refused: PolitenessError | null = null;

  const worker = async (id: number): Promise<void> => {
    for (;;) {
      if (refused || opts.stop()) return;
      // Wall-clock cap. Without one, a page that hangs past every per-step timeout keeps
      // `active` above zero and every other worker polls until the process is killed.
      if (Date.now() > opts.deadline) {
        timedOut = true;
        return;
      }

      const job = opts.queue.shift();
      if (job === undefined) {
        // An empty queue is not the end of the crawl while peers are still visiting -
        // they are about to enqueue what they discover. Exiting here is what collapses
        // a concurrency of N to 1, because all but one worker leave on the first tick.
        if (active === 0) return;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      active++;
      try {
        await opts.handle(job, id);
      } catch (err) {
        if (err instanceof PolitenessError) {
          refused ??= err;
          return;
        }
        // visit() handles its own navigation errors; reaching here means the context or
        // browser broke. Losing one page must not abandon the crawl and orphan chromium.
        log(`! [w${id}] CRASH ${name(job)}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        active--;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, (_, i) => worker(i + 1)));
  return { timedOut, refused };
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--mode=auth") ? "auth" : "anon";
  const cfg = loadConfig();
  if (!cfg.baseUrl || cfg.allowedOrigins.length === 0) {
    throw new Error("Set baseUrl and allowedOrigins in qa.config.json first.");
  }

  // Exclusive for the whole crawl: two crawlers appending to one .jsonl interleave their
  // writes and corrupt the inventory with no error anywhere.
  const releaseLock = acquireLock(`crawl-${mode}`, mode);

  mkdirSync(SHOTS, { recursive: true });
  const outFile = resolve(OUT, mode === "auth" ? "pages.auth.jsonl" : "pages.jsonl");

  if (mode === "auth" && !existsSync(STATE)) {
    throw new Error(`No saved session at ${STATE}. Run the auth setup (Phase 4) first.`);
  }

  if (mode === "auth") {
    // Server-side sessions expire, and a stale state.json produces a crawl that claims to
    // be authenticated but is not. Surface the risk before spending minutes on it.
    const ageMin = Math.round((Date.now() - statSync(STATE).mtimeMs) / 60000);
    const sessionOnly = JSON.parse(readFileSync(STATE, "utf8")) as {
      cookies?: { name: string; expires: number }[];
    };
    const ephemeral = (sessionOnly.cookies ?? []).filter((c) => c.expires === -1).map((c) => c.name);
    console.log(`Session saved ${ageMin} min ago${ephemeral.length ? `; browser-session cookies: ${ephemeral.join(", ")}` : ""}`);
    if (ageMin > 30 && ephemeral.length) {
      console.log(
        `  WARNING: browser-session cookies older than 30 min are often dead server-side.\n` +
          `  If the summary reports authRequired pages, re-run the auth setup and crawl again.`,
      );
    }
  }

  const done = previousUrls(outFile);
  if (done.size) console.log(`Resuming: ${done.size} page(s) already in ${outFile.split(/[\\/]/).pop()}`);

  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    ...(mode === "auth" ? { storageState: STATE } : {}),
  });

  // Block everything off-origin unless asked to keep it. A named block-list only catches
  // the trackers you thought of; any other third-party host whose DNS stalls still holds
  // the page open for tens of seconds. Nothing off-origin is part of the inventory.
  if (!cfg.captureOffOrigin) {
    // Match with a PREDICATE, not "**/*". A catch-all that ends in continue() routes every
    // same-origin request through Node and costs more than the trackers did. With a
    // predicate, only off-origin requests are intercepted; everything else goes direct.
    await context.route(
      (url) => !isAllowedUrl(url.toString(), cfg),
      (route) => route.abort(),
    );
  } else {
    for (const domain of cfg.blockDomains) {
      await context.route(`**://*.${domain}/**`, (route) => route.abort());
      await context.route(`**://${domain}/**`, (route) => route.abort());
    }
  }
  await context.route(/\.(woff2?|ttf|otf|eot|mp4|webm|ogv|mp3|wav|avi|mov|m4v)(\?|$)/i, (route) =>
    route.abort(),
  );

  // Proxy-history capture. Off unless asked for: reading every response body costs time
  // and disk, and most crawls only want the page inventory.
  if (cfg.captureHttpHistory) {
    recordHistory(context, cfg, {
      mode,
      maxBodyBytes: cfg.captureMaxBodyBytes,
      includeOffOrigin: cfg.captureOffOrigin,
    });
    console.log(`Recording HTTP exchanges -> ${historyJsonl(mode).split(/[\\/]/).pop()}`);
  }

  // tsx/esbuild rewrites functions with a __name() helper that does not exist in the page,
  // which makes every page.evaluate throw "ReferenceError: __name is not defined".
  await context.addInitScript(() => {
    const g = globalThis as unknown as { __name?: unknown };
    g.__name ??= <T,>(fn: T): T => fn;
  });

  const base = normalizeUrl(cfg.baseUrl) ?? cfg.baseUrl;
  const { queue, deniedSeeds, enqueue } = createFrontier(cfg, done);

  enqueue(base, 0);

  // In auth mode, also start from wherever the login landed. A login-gated app often
  // serves the sign-in form at its root even with a valid session - the post-login
  // entry point is reachable only by submitting the form - so seeding baseUrl alone
  // produced an authenticated crawl of exactly one page: the login screen again.
  if (mode === "auth") {
    const landingFile = resolve(OUT, "auth", "landing.json");
    if (existsSync(landingFile)) {
      try {
        const { url } = JSON.parse(readFileSync(landingFile, "utf8")) as { url?: unknown };
        const landing = typeof url === "string" ? normalizeUrl(url) : null;
        if (landing && inScope(landing, cfg)) {
          enqueue(landing, 0);
          console.log(`  auth entry point from the saved login: ${landing}`);
        }
      } catch {
        /* a corrupt landing file must not stop the crawl */
      }
    }
  }
  for (const seed of await sitemapSeeds(base, cfg)) enqueue(seed, 1);
  console.log(`Seeded ${queue.length} URL(s). Crawling with concurrency ${cfg.concurrency} ...`);

  const records: PageRecord[] = [];
  const started = Date.now();
  const deadline = started + cfg.maxRuntimeMs;
  /** Set when a write fails. A crawl that cannot persist its output must not continue. */
  let fatal: Error | null = null;
  /** Dedup keys already written this run - a belt-and-braces guard against double records. */
  const recorded = new Set<string>();
  let timedOut = false;
  let refused: PolitenessError | null = null;

  try {
    ({ timedOut, refused } = await runPool({
      queue,
      concurrency: cfg.concurrency,
      deadline,
      // Budget check BEFORE taking the job, so a job is never shifted then discarded.
      // done.size is included: maxPages is a cap on the inventory, not on one invocation.
      stop: () => fatal !== null || done.size + recorded.size >= cfg.maxPages,
      name: (job) => job.url,
      handle: async (job, id) => {
        const { record, discovered } = await visit(context, job.url, job.depth, cfg, mode);

        // Enqueue FIRST. This used to sit after the append, inside the same try, so a
        // single write error dropped every page reachable only through this one - a whole
        // subtree vanishing with nothing but a "CRASH" line to show for it.
        for (const url of discovered) enqueue(url, job.depth + 1);

        const key = dedupKey(record.url);
        if (recorded.has(key)) {
          console.error(`! [w${id}] DUPLICATE suppressed: ${record.url}`);
        } else {
          records.push(record);
          try {
            appendFileSync(outFile, `${JSON.stringify(record)}\n`);
          } catch (err) {
            // Losing the output file is not a per-page problem. Stop, loudly, rather than
            // finishing with a truncated inventory and an exit code of 0.
            fatal = new Error(
              `Cannot write ${outFile}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return;
          }
          recorded.add(key);
        }

        const flag = !record.ok || record.pageErrors.length || (record.status ?? 0) >= 400 ? "!" : " ";
        console.log(
          `${flag} [w${id}] ${String(record.status ?? "ERR").padEnd(3)} ${String(record.loadMs).padStart(5)}ms  ${record.url}`,
        );
      },
    }));
    // Let in-flight capture handlers finish reading their bodies BEFORE the context goes
    // away. response.body() throws once the context is closed, and those failures were
    // swallowed silently - exchanges just went missing from the export.
    if (cfg.captureHttpHistory) await drainHistory();
  } finally {
    // Always tear the browser down, even if a worker threw, so no chromium is left behind.
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (fatal) throw fatal;
  if (timedOut) {
    console.error(
      `\n  WARNING: hit maxRuntimeMs (${cfg.maxRuntimeMs}ms). The inventory is INCOMPLETE.`,
    );
  }

  // ------------------------------------------------------------ summary
  const totalSec = ((Date.now() - started) / 1000).toFixed(1);
  const withErrors = records.filter(
    (r) => r.pageErrors.length > 0 || r.consoleErrors.length > 0 || (r.status ?? 0) >= 400,
  );
  const slowest = [...records].sort((a, b) => b.loadMs - a.loadMs).slice(0, 10);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`mode:          ${mode}`);
  console.log(`pages crawled: ${records.length}${done.size ? ` (+${done.size} from a previous run)` : ""}`);
  console.log(`total time:    ${totalSec}s`);
  console.log(`templates:     ${new Set(records.map((r) => r.template)).size}`);

  // Judge the crawl before anything downstream is allowed to compute a percentage
  // from it. A one-page crawl of a login-gated app used to report "pages crawled: 1"
  // and nothing else, and coverage then produced a figure from that single page.
  const verdict = judgeCrawl(records, mode);

  // What this run cost the target, and whether the target asked us to stop. A crawl that
  // was throttled produces pages that "failed" and assets that "broke", and every one of
  // those is the throttling rather than the site - so it is recorded next to the verdict
  // and stated loudly, not left for someone to infer from a pile of odd failures.
  const load = politeClient(cfg).stats();
  console.log(
    `requests:      ${load.sent}` +
      (load.retried ? `, ${load.retried} retried` : "") +
      (load.rateLimited ? `, ${load.rateLimited} rate-limited` : "") +
      (load.waitedMs ? `, ${(load.waitedMs / 1000).toFixed(1)}s spent waiting politely` : ""),
  );

  const status = {
    ...verdict,
    load,
    ...(refused === null ? {} : { refused: { kind: refused.kind, message: refused.message } }),
  };
  writeFileSync(resolve(OUT, `crawl-status.${mode}.json`), `${JSON.stringify(status, null, 2)}\n`);

  if (refused !== null) {
    console.log(`\n${"!".repeat(60)}`);
    console.log(`CRAWL STOPPED BY THE POLITENESS LIMITER (${refused.kind}):`);
    console.log(`  ${refused.message}`);
    console.log(`  ${queue.length} queued page(s) were not visited. The inventory is INCOMPLETE.`);
    console.log(`${"!".repeat(60)}`);
  }

  if (load.throttledOrigins.length > 0) {
    console.log(`\n${"!".repeat(60)}`);
    console.log(`THE TARGET RATE-LIMITED THIS RUN: ${load.throttledOrigins.join(", ")}`);
    console.log(
      `  Nothing below is trustworthy. Raise requestDelayMs, lower concurrency, and re-run.`,
    );
    console.log(`${"!".repeat(60)}`);
  }
  if (verdict.verdict !== "ok") {
    console.log(`\n${"!".repeat(60)}`);
    console.log(`THIS CRAWL PROVED LITTLE: ${verdict.verdict}`);
    console.log(`  ${verdict.reason}`);
    console.log(`${"!".repeat(60)}`);
  }
  if (deniedSeeds.length > 0) {
    console.log(`refused (deny-list), never fetched: ${deniedSeeds.length}`);
    for (const u of deniedSeeds.slice(0, 10)) console.log(`  - ${u}`);
  }
  console.log(`pages w/ errors: ${withErrors.length}`);
  for (const r of withErrors.slice(0, 10)) {
    const bits = [
      (r.status ?? 0) >= 400 ? `HTTP ${r.status}` : "",
      r.pageErrors.length ? `${r.pageErrors.length} pageError` : "",
      r.consoleErrors.length ? `${r.consoleErrors.length} console` : "",
    ].filter(Boolean);
    console.log(`  - ${r.url}  (${bits.join(", ")})`);
  }
  console.log(`\ntop ${slowest.length} slowest:`);
  for (const r of slowest) console.log(`  ${String(r.loadMs).padStart(6)}ms  ${r.url}`);
  // A logged-in crawl that kept getting bounced to a login page is not a logged-in crawl.
  if (mode === "auth") {
    const bounced = records.filter((r) => r.authRequired).length;
    if (bounced > 0) {
      console.log(
        `\n  WARNING: ${bounced} of ${records.length} pages redirected to a login page.\n` +
          `  The saved session is probably expired - re-run the auth setup, then crawl again.\n` +
          `  This run's pages.auth.jsonl reflects an ANONYMOUS view.`,
      );
    }
  }

  console.log(`\nwrote ${outFile}`);

  if (cfg.captureHttpHistory) {
    // Only THIS crawl's capture. An anonymous crawl must not emit a file containing the
    // authenticated one.
    const n = writeBurpXml(mode);
    console.log(
      `wrote ${historyXml(mode).split(/[\/]/).pop()} (${n} exchanges, Burp proxy-history format)`,
    );
  }

  // Released here and also on exit/SIGINT, so a crash cannot leave a lock that blocks
  // every future run.
  releaseLock();

  // Exit 3, distinct from a crash (1): the target asked us to stop. qa.ts reads it and
  // skips the remaining network steps instead of carrying on against a throttling site.
  if (refused !== null) process.exitCode = CRAWL_REFUSED_EXIT;
}

/** The crawl's exit code when the politeness limiter stopped it. Read by qa.ts. */
export const CRAWL_REFUSED_EXIT = 3;

// Only crawl when this file is the entry point. Without the guard, importing
// normalizeUrl/templateOf from a test or another script starts a real crawl.
const isEntry = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isEntry) {
  main().catch((err: unknown) => {
    console.error(`Crawl failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
