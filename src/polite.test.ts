/**
 * The politeness layer, driven with an injected clock so nothing actually waits.
 *
 * These exist because the damage was real and measured: four parallel crawls got this agent
 * throttled off a demo site mid-verification, and a suite degraded its own target until its
 * largest asset took 26.8s and twelve tests went flaky. In both cases the tool reported the
 * throttling as findings about the site.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPoliteClient,
  retryAfterMs,
  originOf,
  PolitenessError,
  DEFAULT_POLITE,
  type PoliteConfig,
} from "./polite.js";

/** A fake clock that only advances when something sleeps. */
function fakeTime() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    get value() {
      return t;
    },
  };
}

/** A fetch stub that returns the given statuses in order, then 200 forever. */
function stubFetch(statuses: number[], headers: Record<string, string> = {}) {
  const calls: string[] = [];
  let i = 0;
  const impl = (async (url: string) => {
    calls.push(String(url));
    const status = statuses[i++] ?? 200;
    return {
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const cfg = (over: Partial<PoliteConfig> = {}): PoliteConfig => ({
  ...DEFAULT_POLITE,
  delayMs: 100,
  maxRetries: 3,
  breakAfter: 3,
  budget: 0,
  ...over,
});

test("requests to one origin are spaced by delayMs", async () => {
  const clock = fakeTime();
  const { impl } = stubFetch([]);
  const c = createPoliteClient(cfg({ delayMs: 500 }), { ...clock, fetchImpl: impl });

  const start = clock.value;
  await c.fetch("https://t.test/a");
  await c.fetch("https://t.test/b");
  await c.fetch("https://t.test/c");

  // First goes immediately; each subsequent one waits out the gap.
  assert.equal(clock.value - start, 1000, "two gaps of 500ms for three requests");
  assert.equal(c.stats().sent, 3);
});

test("different origins do not wait for each other", async () => {
  const clock = fakeTime();
  const { impl } = stubFetch([]);
  const c = createPoliteClient(cfg({ delayMs: 500 }), { ...clock, fetchImpl: impl });

  const start = clock.value;
  await c.fetch("https://a.test/x");
  await c.fetch("https://b.test/x");
  assert.equal(clock.value - start, 0, "spacing is per-origin, not global");
});

test("a 429 is retried after backing off, and then succeeds", async () => {
  const clock = fakeTime();
  const { impl, calls } = stubFetch([429, 429, 200]);
  const c = createPoliteClient(cfg(), { ...clock, fetchImpl: impl, random: () => 0.5 });

  const res = await c.fetch("https://t.test/a");
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3, "two retries then the real answer");
  assert.equal(c.stats().retried, 2);
  assert.equal(c.stats().rateLimited, 2);
  assert.ok(c.stats().waitedMs > 0, "it actually waited rather than hammering");
});

test("Retry-After is honoured over our own backoff", async () => {
  const clock = fakeTime();
  const { impl } = stubFetch([429, 200], { "retry-after": "7" });
  const c = createPoliteClient(cfg({ delayMs: 0 }), { ...clock, fetchImpl: impl });

  const start = clock.value;
  await c.fetch("https://t.test/a");
  // 7 seconds, as asked - not the 1s our own first-attempt backoff would have chosen.
  assert.equal(clock.value - start, 7000);
});

test("an absurd Retry-After is capped", async () => {
  const clock = fakeTime();
  const { impl } = stubFetch([429, 200], { "retry-after": "86400" });
  const c = createPoliteClient(cfg({ delayMs: 0, maxBackoffMs: 30_000 }), {
    ...clock,
    fetchImpl: impl,
  });

  const start = clock.value;
  await c.fetch("https://t.test/a");
  assert.equal(clock.value - start, 30_000, "a day-long Retry-After must not hang the run");
});

test("the breaker opens after repeated rate limits, and later calls refuse to fire", async () => {
  const clock = fakeTime();
  // Always 429: the origin is saying stop.
  const { impl, calls } = stubFetch(Array(20).fill(429));
  const c = createPoliteClient(cfg({ breakAfter: 3, maxRetries: 10 }), {
    ...clock,
    fetchImpl: impl,
    random: () => 0,
  });

  const res = await c.fetch("https://t.test/a");
  assert.equal(res.status, 429);
  assert.equal(calls.length, 3, "stopped at breakAfter rather than exhausting maxRetries");
  assert.ok(c.throttled());
  assert.deepEqual(c.stats().throttledOrigins, ["https://t.test"]);

  await assert.rejects(
    () => c.fetch("https://t.test/b"),
    (e: unknown) =>
      e instanceof PolitenessError && e.kind === "breaker" && /breaker is open/.test(e.message),
    "a run that continues past this point reports throttling as site defects",
  );
});

test("the breaker is per-origin", async () => {
  const clock = fakeTime();
  const impl = (async (url: string) =>
    ({
      status: String(url).includes("bad.test") ? 429 : 200,
      headers: { get: () => null },
    }) as unknown as Response) as unknown as typeof fetch;
  const c = createPoliteClient(cfg({ breakAfter: 2, maxRetries: 5 }), {
    ...clock,
    fetchImpl: impl,
    random: () => 0,
  });

  await c.fetch("https://bad.test/a");
  assert.ok(c.throttled());
  const ok = await c.fetch("https://good.test/a");
  assert.equal(ok.status, 200, "one hostile origin must not stop the whole run");
});

test("a success resets the strike count", async () => {
  const clock = fakeTime();
  // 429, then 200, then 429s: the run of consecutive limits is broken in the middle.
  const { impl } = stubFetch([429, 200, 429, 200]);
  const c = createPoliteClient(cfg({ breakAfter: 2, maxRetries: 1 }), {
    ...clock,
    fetchImpl: impl,
    random: () => 0,
  });

  await c.fetch("https://t.test/a");
  await c.fetch("https://t.test/b");
  assert.equal(c.throttled(), false, "two isolated 429s are not a pattern");
});

test("5xx that is not a rate limit is retried but never opens the breaker", async () => {
  const clock = fakeTime();
  const { impl, calls } = stubFetch([502, 504, 200]);
  const c = createPoliteClient(cfg({ breakAfter: 2 }), { ...clock, fetchImpl: impl, random: () => 0 });

  const res = await c.fetch("https://t.test/a");
  assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(c.throttled(), false, "a flaky gateway is not the origin asking us to stop");
});

test("a 404 is returned immediately and is not a retryable condition", async () => {
  const clock = fakeTime();
  const { impl, calls } = stubFetch([404]);
  const c = createPoliteClient(cfg(), { ...clock, fetchImpl: impl });

  const res = await c.fetch("https://t.test/missing");
  assert.equal(res.status, 404);
  assert.equal(calls.length, 1, "retrying a 404 just wastes someone else's capacity");
});

test("the request budget is enforced and counts browser navigations too", async () => {
  const clock = fakeTime();
  const { impl } = stubFetch([]);
  const c = createPoliteClient(cfg({ budget: 3, delayMs: 0 }), { ...clock, fetchImpl: impl });

  await c.fetch("https://t.test/1");
  await c.gate("https://t.test/2"); // a page.goto costs the target the same as a fetch
  await c.fetch("https://t.test/3");

  await assert.rejects(
    () => c.fetch("https://t.test/4"),
    (e: unknown) => e instanceof PolitenessError && e.kind === "budget",
  );
  assert.equal(c.stats().sent, 3);
});

test("gate paces browser navigations without making a request", async () => {
  const clock = fakeTime();
  const { impl, calls } = stubFetch([]);
  const c = createPoliteClient(cfg({ delayMs: 400 }), { ...clock, fetchImpl: impl });

  const start = clock.value;
  await c.gate("https://t.test/a");
  await c.gate("https://t.test/b");
  assert.equal(clock.value - start, 400);
  assert.equal(calls.length, 0, "gate must not issue a request of its own");
});

// C-10: crawler navigations were gated but their answers were never looked at, so a crawl
// against a server answering 429 on every page could never trip the breaker or back off.
test("report() feeds navigation answers into the breaker", async () => {
  const clock = fakeTime();
  const { impl, calls } = stubFetch([]);
  const c = createPoliteClient(cfg({ breakAfter: 3, delayMs: 0 }), { ...clock, fetchImpl: impl });

  for (const p of ["a", "b", "c"]) {
    await c.gate(`https://t.test/${p}`);
    c.report(`https://t.test/${p}`, 429);
  }
  assert.ok(c.throttled(), "three 429 navigations in a row open the breaker");
  assert.equal(c.stats().rateLimited, 3);
  assert.equal(calls.length, 0, "report() never makes a request of its own");
  await assert.rejects(
    () => c.gate("https://t.test/d"),
    (e: unknown) => e instanceof PolitenessError && e.kind === "breaker",
  );
});

test("report() honours Retry-After on the next gate, and a success resets strikes", async () => {
  const clock = fakeTime();
  const { impl } = stubFetch([]);
  const c = createPoliteClient(cfg({ breakAfter: 2, delayMs: 0 }), { ...clock, fetchImpl: impl });

  await c.gate("https://t.test/a");
  c.report("https://t.test/a", 503, "5");
  const start = clock.value;
  await c.gate("https://t.test/b");
  assert.equal(clock.value - start, 5000, "the origin is held back for Retry-After");

  c.report("https://t.test/b", 200);
  c.report("https://t.test/c", 429);
  assert.equal(c.throttled(), false, "a success in between resets the strike run");
});

test("retryAfterMs reads both forms and rejects nonsense", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(retryAfterMs("5", now), 5000);
  assert.equal(retryAfterMs("  12 ", now), 12_000);
  assert.equal(retryAfterMs("Thu, 01 Jan 2026 00:00:30 GMT", now), 30_000);
  // A date already in the past means "now", not a negative wait.
  assert.equal(retryAfterMs("Thu, 01 Jan 2020 00:00:00 GMT", now), 0);
  assert.equal(retryAfterMs("soon please", now), null);
  assert.equal(retryAfterMs(null, now), null);
});

test("originOf is stable for odd input", () => {
  assert.equal(originOf("https://t.test/a?b=c#d"), "https://t.test");
  assert.equal(originOf("not a url"), "not a url");
});
