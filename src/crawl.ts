/**
 * Fast parallel crawler. Plain Playwright - no MCP, no AI, no tokens.
 *
 *   npm run crawl        # anonymous  -> output/pages.jsonl
 *   npm run crawl:auth   # logged in  -> output/pages.auth.jsonl
 *
 * Resumable: every page is appended to the .jsonl the moment it is done, and a restart
 * skips URLs already recorded there.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { loadConfig, isAllowedUrl, isDenied, isDeniedUrl, ROOT, type QaConfig } from "./config.js";
import { recordHistory, writeBurpXml, drainHistory, HISTORY_JSONL } from "./http-history.js";

const OUT = resolve(ROOT, "output");
const SHOTS = resolve(OUT, "screenshots");
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

function slugify(url: string): string {
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
    const res = await fetch(`${base}/robots.txt`, { signal: AbortSignal.timeout(8000) });
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
      const res = await fetch(sitemap, { signal: AbortSignal.timeout(8000) });
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
}

/** A link, with the anchor text kept so the deny-list can be applied to it. */
export interface AnchorInfo {
  href: string;
  label: string;
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
  return page.evaluate(() => {
    const clean = (s: string | null | undefined): string =>
      (s ?? "").replace(/\s+/g, " ").trim().slice(0, 80);

    // Both names are returned, never just one. Reading `aria-label ?? textContent` meant
    // a button reading "Delete" with aria-label="Confirm" was classified as safe - and a
    // button reading "Confirm" with aria-label="Delete account" as unsafe. Only checking
    // both can be correct.
    const names = (el: Element): { label: string; alt: string } => {
      const aria = clean(el.getAttribute("aria-label"));
      const txt = clean(el.tagName === "INPUT" ? el.getAttribute("value") : el.textContent);
      return aria ? { label: aria, alt: txt } : { label: txt, alt: aria };
    };

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

    const anchors: { href: string; label: string }[] = [];
    for (const a of document.querySelectorAll<HTMLElement>("a[href], [role=link], [data-href]")) {
      const h = a.getAttribute("href") ?? a.getAttribute("data-href");
      // The anchor text travels with the href so the deny-list can be applied to links,
      // not only to buttons. "Delete account" as a link used to be followed silently.
      if (h) anchors.push({ href: h, label: names(a).label || names(a).alt });
    }

    const forms = [...document.querySelectorAll("form")].map((f) => ({
      action: f.getAttribute("action") ?? "",
      method: (f.getAttribute("method") ?? "get").toLowerCase(),
      submitLabels: [...f.querySelectorAll("button, input[type=submit], input[type=button]")]
        .flatMap((b) => [names(b).label, names(b).alt])
        .filter((s) => s.length > 0),
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
      ...document.querySelectorAll("button, [role=button], input[type=submit], input[type=button]"),
    ]
      .map(names)
      .filter((c) => c.label.length > 0 || c.alt.length > 0);

    return {
      title: document.title,
      anchors,
      forms,
      controls,
      links: document.querySelectorAll("a[href]").length,
    };
  });
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
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.navTimeoutMs });
    status = res?.status() ?? null;
    // Bounded quiet period - never an unbounded networkidle, which can hang forever.
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
    finalUrl = page.url();
  } catch (err) {
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
  // BOTH candidate names are checked: aria-label and visible text. Checking only one let
  // a "Delete" button with aria-label="Confirm" through.
  const isDeniedControl = (c: ControlInfo): boolean =>
    isDenied(c.label, cfg) || isDenied(c.alt, cfg);
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

  const normFinal = normalizeUrl(finalUrl) ?? finalUrl;
  const redirected = normFinal !== url;
  const authRequired =
    redirected && (LOGIN_HINT.test(normFinal) || LOGIN_HINT.test(info.title)) ;

  // Links are filtered by the deny-list too. Previously isDenied was applied only to
  // button labels while <a href="/users/7/delete">Delete</a> was queued and GET-ted by
  // the crawler itself - the destructive action fired without anything "clicking" it.
  const discovered: string[] = [];
  const deniedLinks: string[] = [];
  for (const a of info.anchors) {
    const n = normalizeUrl(a.href, finalUrl);
    if (!n || !inScope(n, cfg)) continue;
    if (isDeniedUrl(n, cfg) || isDenied(a.label, cfg)) {
      deniedLinks.push(n);
      continue;
    }
    discovered.push(n);
  }

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
      ok: navOk,
      mode,
      crawledAt: new Date().toISOString(),
    },
    discovered,
  };
}

// ---------------------------------------------------------------- driver

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

async function main(): Promise<void> {
  const mode = process.argv.includes("--mode=auth") ? "auth" : "anon";
  const cfg = loadConfig();
  if (!cfg.baseUrl || cfg.allowedOrigins.length === 0) {
    throw new Error("Set baseUrl and allowedOrigins in qa.config.json first.");
  }

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
      maxBodyBytes: cfg.captureMaxBodyBytes,
      includeOffOrigin: cfg.captureOffOrigin,
    });
    console.log(`Recording HTTP exchanges -> ${HISTORY_JSONL.split(/[\\/]/).pop()}`);
  }

  // tsx/esbuild rewrites functions with a __name() helper that does not exist in the page,
  // which makes every page.evaluate throw "ReferenceError: __name is not defined".
  await context.addInitScript(() => {
    const g = globalThis as unknown as { __name?: unknown };
    g.__name ??= <T,>(fn: T): T => fn;
  });

  const base = normalizeUrl(cfg.baseUrl) ?? cfg.baseUrl;
  const queue: { url: string; depth: number }[] = [];
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
    const t = templateOf(key);
    const n = perTemplate.get(t) ?? 0;
    if (n >= 3) return; // at most 3 samples per page shape
    perTemplate.set(t, n + 1);
    queued.add(key);
    queue.push({ url, depth });
  };

  enqueue(base, 0);
  for (const seed of await sitemapSeeds(base, cfg)) enqueue(seed, 1);
  console.log(`Seeded ${queue.length} URL(s). Crawling with concurrency ${cfg.concurrency} ...`);

  const records: PageRecord[] = [];
  const started = Date.now();
  const deadline = started + cfg.maxRuntimeMs;
  let crawled = 0;
  let active = 0;
  /** Set when a write fails. A crawl that cannot persist its output must not continue. */
  let fatal: Error | null = null;
  /** Dedup keys already written this run - a belt-and-braces guard against double records. */
  const recorded = new Set<string>();
  let timedOut = false;

  const worker = async (id: number): Promise<void> => {
    for (;;) {
      if (fatal) return;
      // Wall-clock cap. Without one, a page that hangs past every per-step timeout keeps
      // `active` above zero and every other worker polls until the process is killed.
      if (Date.now() > deadline) {
        timedOut = true;
        return;
      }
      // Budget check BEFORE taking the job, so a job is never shifted then discarded.
      // done.size is included: maxPages is a cap on the inventory, not on one invocation.
      if (done.size + recorded.size >= cfg.maxPages) return;

      const job = queue.shift();
      if (!job) {
        // An empty queue is not the end of the crawl while peers are still visiting -
        // they are about to enqueue what they discover. Exiting here is what collapses
        // a concurrency of N to 1, because all but one worker leave on the first tick.
        if (active === 0) return;
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      active++;
      crawled++;
      try {
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
      } catch (err) {
        // visit() handles its own navigation errors; reaching here means the context or
        // browser broke. Losing one page must not abandon the crawl and orphan chromium.
        console.error(`! [w${id}] CRASH ${job.url}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        active--;
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.max(1, cfg.concurrency) }, (_, i) => worker(i + 1)),
    );
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
    const n = writeBurpXml();
    console.log(`wrote output/http-history.xml (${n} exchanges, Burp proxy-history format)`);
  }
}

// Only crawl when this file is the entry point. Without the guard, importing
// normalizeUrl/templateOf from a test or another script starts a real crawl.
const isEntry = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isEntry) {
  main().catch((err: unknown) => {
    console.error(`Crawl failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
