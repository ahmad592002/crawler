import { loadConfig } from "./config.js";
/**
 * One place that decides when this agent is allowed to make a request.
 *
 * There was no such place. Seven raw fetch call sites plus every browser navigation went
 * out as fast as the event loop allowed, with no spacing, no retry, and nothing anywhere
 * that looked at a 429 or a Retry-After header. The result was measurable: four parallel
 * crawls got us throttled off a demo site mid-verification, and a test suite degraded its
 * own target until its largest asset took 26.8 seconds and twelve tests went flaky. Both
 * times the tool reported the symptoms as findings about the site.
 *
 * Three jobs here, in order of how much damage they prevent:
 *
 *   1. SPACING. A minimum gap between requests to the same origin. Cheap, and it is what
 *      stops a burst becoming a throttle in the first place.
 *   2. BACKING OFF. A 429 or 503 is the server asking for less. Honour Retry-After when it
 *      is given, otherwise exponential backoff with jitter, and give up after a few tries
 *      rather than hammering.
 *   3. STOPPING. If an origin rate-limits us repeatedly, keep going and every later result
 *      is garbage: pages "fail", assets "break", and the run produces confident nonsense.
 *      A breaker opens and the run says it was throttled instead of inventing findings.
 *
 * A request budget sits across all three, so a misconfigured crawl cannot spend ten
 * thousand requests on someone else's server.
 *
 * Everything is injectable - clock, sleep, fetch - so the tests are deterministic and
 * instant rather than actually waiting.
 */

export interface PoliteConfig {
  /** Minimum gap between two requests to the SAME origin. */
  delayMs: number;
  /** How many times to retry one URL after a rate-limit or 5xx answer. */
  maxRetries: number;
  /** Never wait longer than this for a single backoff, even if Retry-After says so. */
  maxBackoffMs: number;
  /** Consecutive rate-limit answers from one origin before the breaker opens. */
  breakAfter: number;
  /** Hard cap on requests this process may make. 0 means no cap. */
  budget: number;
}

export const DEFAULT_POLITE: PoliteConfig = {
  delayMs: 250,
  maxRetries: 3,
  maxBackoffMs: 30_000,
  breakAfter: 5,
  budget: 2000,
};

export interface PoliteStats {
  sent: number;
  retried: number;
  rateLimited: number;
  waitedMs: number;
  /** Origins whose breaker opened. A non-empty list invalidates the run's conclusions. */
  throttledOrigins: string[];
}

/** Thrown when the agent refuses to make a request, rather than when a request fails. */
export class PolitenessError extends Error {
  constructor(
    message: string,
    readonly kind: "breaker" | "budget",
  ) {
    super(message);
    this.name = "PolitenessError";
  }
}

interface Deps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** Jitter factor in [0,1). Injectable so tests are deterministic. */
  random?: () => number;
}

/** 429 and 503 are "ask again later". 502/504 are usually an overloaded box too. */
function isRateLimit(status: number): boolean {
  return status === 429 || status === 503;
}
function isTransient(status: number): boolean {
  return isRateLimit(status) || status === 502 || status === 504;
}

/**
 * Retry-After, in milliseconds.
 *
 * It comes either as seconds or as an HTTP date, and both appear in the wild. A missing or
 * unparseable value returns null so the caller falls back to its own backoff.
 */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - now);
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export interface PoliteClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Wait for this origin's turn without making a request - for browser navigations. */
  gate(url: string): Promise<void>;
  /**
   * Tell the limiter how a gated request was answered. Same strike, breaker and backoff
   * bookkeeping as fetch(), but no retry and no sleep: the next gate() does the waiting.
   */
  report(url: string, status: number, retryAfter?: string | null): void;
  stats(): PoliteStats;
  /** True once any origin has been throttled badly enough to invalidate results. */
  throttled(): boolean;
}

export function createPoliteClient(cfg: PoliteConfig, deps: Deps = {}): PoliteClient {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Resolved at call time, not captured here: capturing the global made this layer
  // opaque to a stubbed globalThis.fetch, which silently broke four offline tests that had
  // been exercising the real code path for months.
  const doFetch: typeof fetch = deps.fetchImpl ?? ((u, i) => globalThis.fetch(u, i));
  const random = deps.random ?? Math.random;

  /** Earliest time this origin may be touched again, and its consecutive-429 run. */
  const nextFree = new Map<string, number>();
  const strikes = new Map<string, number>();
  const broken = new Set<string>();

  const stats: PoliteStats = {
    sent: 0,
    retried: 0,
    rateLimited: 0,
    waitedMs: 0,
    throttledOrigins: [],
  };

  /** Serialise the wait per origin so two callers cannot both think they are next. */
  const chains = new Map<string, Promise<void>>();

  async function waitTurn(origin: string): Promise<void> {
    const prior = chains.get(origin) ?? Promise.resolve();
    let release = (): void => {};
    chains.set(
      origin,
      new Promise<void>((r) => {
        release = r;
      }),
    );
    await prior;

    const due = nextFree.get(origin) ?? 0;
    const wait = due - now();
    if (wait > 0) {
      stats.waitedMs += wait;
      await sleep(wait);
    }
    nextFree.set(origin, now() + cfg.delayMs);
    release();
  }

  function guard(origin: string): void {
    if (broken.has(origin)) {
      throw new PolitenessError(
        `refusing to contact ${origin}: it rate-limited this run ${cfg.breakAfter} times in a ` +
          `row, so the breaker is open. Later results would be the throttling, not the site.`,
        "breaker",
      );
    }
    if (cfg.budget > 0 && stats.sent >= cfg.budget) {
      throw new PolitenessError(
        `request budget of ${cfg.budget} spent. Raise maxRequests in the config if this run ` +
          `genuinely needs more, but first check it is not looping.`,
        "budget",
      );
    }
  }

  function backoffMs(attempt: number, header: string | null): number {
    const asked = retryAfterMs(header, now());
    // Exponential with full jitter: 1s, 2s, 4s... jittered, so several workers backing off
    // together do not all return at the same instant and re-throttle the origin.
    const own = Math.min(cfg.maxBackoffMs, 1000 * 2 ** attempt);
    return Math.min(cfg.maxBackoffMs, asked ?? Math.round(own * (0.5 + random() * 0.5)));
  }

  async function backoff(origin: string, attempt: number, header: string | null): Promise<void> {
    const wait = backoffMs(attempt, header);
    stats.waitedMs += wait;
    // Hold the whole origin back, not just this request: a 429 is about the origin.
    nextFree.set(origin, now() + wait);
    await sleep(wait);
  }

  /**
   * Count one answer against the origin's strike run. Returns the strike count after this
   * answer (0 for a success), and opens the breaker once it reaches breakAfter.
   */
  function strike(origin: string, status: number): number {
    if (!isTransient(status)) {
      strikes.set(origin, 0);
      return 0;
    }
    const prior = strikes.get(origin) ?? 0;
    if (!isRateLimit(status)) return prior;
    stats.rateLimited++;
    const n = prior + 1;
    strikes.set(origin, n);
    if (n >= cfg.breakAfter) {
      broken.add(origin);
      if (!stats.throttledOrigins.includes(origin)) stats.throttledOrigins.push(origin);
    }
    return n;
  }

  return {
    async fetch(url, init) {
      const origin = originOf(url);

      for (let attempt = 0; ; attempt++) {
        guard(origin);
        await waitTurn(origin);
        guard(origin);

        stats.sent++;
        const res = await doFetch(url, init);

        strike(origin, res.status);
        if (!isTransient(res.status) || broken.has(origin)) return res;
        if (attempt >= cfg.maxRetries) return res;

        stats.retried++;
        await backoff(origin, attempt, res.headers.get("retry-after"));
      }
    },

    async gate(url) {
      const origin = originOf(url);
      guard(origin);
      await waitTurn(origin);
      // Counted: a browser navigation costs the target exactly as much as a fetch, and a
      // budget that ignored them would be describing a fraction of the real load.
      stats.sent++;
    },

    report(url, status, retryAfter = null) {
      const origin = originOf(url);
      const n = strike(origin, status);
      if (!isTransient(status)) return;
      // Push the origin's next slot out rather than sleeping here: the caller has already
      // got its answer, and it is the NEXT navigation that must wait. Never pull it in.
      const until = now() + backoffMs(Math.max(0, n - 1), retryAfter);
      if (until > (nextFree.get(origin) ?? 0)) nextFree.set(origin, until);
    },

    stats() {
      return { ...stats, throttledOrigins: [...stats.throttledOrigins] };
    },

    throttled() {
      return stats.throttledOrigins.length > 0;
    },
  };
}


/**
 * The client every module shares, built from the loaded config.
 *
 * One per process on purpose: spacing and the breaker are only meaningful if all the
 * callers go through the same bookkeeping. Two clients would each think they were the
 * only one talking to the origin, which is exactly the bug this file exists to fix.
 */
let shared: PoliteClient | null = null;

export function politeClient(cfg: {
  requestDelayMs?: number;
  maxRequests?: number;
  rateLimitBreakAfter?: number;
  rateLimitRetries?: number;
}): PoliteClient {
  if (shared) return shared;
  shared = createPoliteClient({
    delayMs: cfg.requestDelayMs ?? DEFAULT_POLITE.delayMs,
    budget: cfg.maxRequests ?? DEFAULT_POLITE.budget,
    breakAfter: cfg.rateLimitBreakAfter ?? DEFAULT_POLITE.breakAfter,
    maxRetries: cfg.rateLimitRetries ?? DEFAULT_POLITE.maxRetries,
    maxBackoffMs: DEFAULT_POLITE.maxBackoffMs,
  });
  return shared;
}

/**
 * The shared client, loading the config itself.
 *
 * For helpers that legitimately do not carry cfg in scope - a probe function takes a URL
 * and a timeout, and threading config through it only to reach the limiter would be worse
 * than this. config.ts does not import this module, so there is no cycle.
 */
export function polite(): PoliteClient {
  return politeClient(loadConfig());
}

/**
 * Tests only: install a client of your own.
 *
 * The shared client takes its spacing from the config, so a test that drives 150 requests
 * through it would genuinely wait 150 x 250ms. A test wants the breaker and the budget, not
 * the waiting.
 */
export function setPoliteClient(client: PoliteClient): void {
  shared = client;
}

/** Tests only: forget the shared client so each case starts clean. */
export function resetPoliteClient(): void {
  shared = null;
}