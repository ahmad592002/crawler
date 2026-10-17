/**
 * Extra tests for the politeness layer: the config-to-client mapping (politeClient), the
 * edges of report() that polite.test.ts does not pin, and gate() under concurrency.
 *
 * Offline. The mapping tests use the real clock with requestDelayMs 0 (or a short delay
 * where spacing itself is the point) and stub globalThis.fetch, which the client resolves
 * at call time. Everything else uses an injected clock.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createPoliteClient,
  politeClient,
  resetPoliteClient,
  PolitenessError,
  DEFAULT_POLITE,
  type PoliteConfig,
} from "./polite.js";

afterEach(() => resetPoliteClient());

function fakeTime() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    get value() {
      return t;
    },
  };
}

const cfg = (over: Partial<PoliteConfig> = {}): PoliteConfig => ({ ...DEFAULT_POLITE, ...over });

const noFetch: typeof fetch = async () => {
  throw new Error("no request expected");
};

const isKind = (kind: "breaker" | "budget") => (e: unknown) =>
  e instanceof PolitenessError && e.kind === kind;

// ------------------------------------------------------------- politeClient mapping

test("politeClient: maxRequests becomes the request budget", async () => {
  const c = politeClient({ requestDelayMs: 0, maxRequests: 2 });
  await c.gate("https://t.test/a");
  await c.gate("https://t.test/b");
  await assert.rejects(() => c.gate("https://t.test/c"), isKind("budget"), "third request is over a budget of 2");
});

test("politeClient: maxRequests 0 means no cap, not a budget of zero", async () => {
  // `?? default` keeps 0; a `|| default` would have turned "unlimited" into 2000.
  const c = politeClient({ requestDelayMs: 0, maxRequests: 0 });
  for (let i = 0; i < 25; i++) await c.gate(`https://t.test/${i}`);
  assert.equal(c.stats().sent, 25);
});

test("politeClient: rateLimitBreakAfter sets the breaker threshold", () => {
  const c = politeClient({ requestDelayMs: 0, rateLimitBreakAfter: 2 });
  c.report("https://t.test/a", 429);
  assert.equal(c.throttled(), false, "one 429 is below a threshold of 2");
  c.report("https://t.test/b", 429);
  assert.equal(c.throttled(), true, "two 429s in a row reach a threshold of 2");
});

test("politeClient: a missing rateLimitBreakAfter falls back to the default of 5", () => {
  const c = politeClient({ requestDelayMs: 0 });
  for (let i = 1; i < DEFAULT_POLITE.breakAfter; i++) c.report(`https://t.test/${i}`, 429);
  assert.equal(c.throttled(), false, `${DEFAULT_POLITE.breakAfter - 1} strikes must not open it`);
  c.report("https://t.test/last", 429);
  assert.equal(c.throttled(), true);
});

test("politeClient: rateLimitRetries is the number of retries after a 503", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  // Retry-After: 0 keeps the backoff at zero so the real clock never waits.
  globalThis.fetch = (async () => {
    calls++;
    return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
  }) as typeof fetch;
  try {
    const c = politeClient({ requestDelayMs: 0, rateLimitRetries: 2, rateLimitBreakAfter: 50 });
    const res = await c.fetch("https://t.test/x");
    assert.equal(res.status, 503, "the last answer is returned, not thrown");
    assert.equal(calls, 3, "one try plus two retries");
    assert.equal(c.stats().retried, 2);

    resetPoliteClient();
    calls = 0;
    const none = politeClient({ requestDelayMs: 0, rateLimitRetries: 0, rateLimitBreakAfter: 50 });
    await none.fetch("https://t.test/y");
    assert.equal(calls, 1, "rateLimitRetries 0 means a single attempt");
  } finally {
    globalThis.fetch = original;
  }
});

test("politeClient: requestDelayMs spaces two requests to the same origin", async () => {
  const c = politeClient({ requestDelayMs: 120, maxRequests: 0 });
  const t0 = Date.now();
  await c.gate("https://t.test/a");
  await c.gate("https://t.test/b");
  const gap = Date.now() - t0;
  assert.ok(gap >= 100, `second gate came after ${gap}ms, expected ~120ms`);
});

test("politeClient: one client per process - a later config does not replace it", async () => {
  // Documented: two clients would each think they were alone with the origin. The cost of
  // that choice is that the first caller's settings win; pin it so it is not a surprise.
  const first = politeClient({ requestDelayMs: 0, maxRequests: 1 });
  const second = politeClient({ requestDelayMs: 0, maxRequests: 100 });
  assert.equal(second, first);
  await second.gate("https://t.test/a");
  await assert.rejects(() => second.gate("https://t.test/b"), isKind("budget"));

  resetPoliteClient();
  const fresh = politeClient({ requestDelayMs: 0, maxRequests: 100 });
  assert.notEqual(fresh, first, "reset builds a new client from the new config");
});

// ------------------------------------------------------------- report() edges

test("report(): a later, shorter Retry-After never pulls the origin's next slot in", async () => {
  const clock = fakeTime();
  const c = createPoliteClient(cfg({ delayMs: 0, breakAfter: 50 }), { ...clock, fetchImpl: noFetch });
  c.report("https://t.test/a", 503, "10");
  c.report("https://t.test/b", 429, "1");
  const start = clock.value;
  await c.gate("https://t.test/c");
  assert.equal(clock.value - start, 10_000);
});

test("report(): Retry-After is capped at maxBackoffMs", async () => {
  const clock = fakeTime();
  const c = createPoliteClient(cfg({ delayMs: 0, maxBackoffMs: 30_000 }), { ...clock, fetchImpl: noFetch });
  c.report("https://t.test/a", 429, "3600");
  const start = clock.value;
  await c.gate("https://t.test/b");
  assert.equal(clock.value - start, 30_000, "an hour-long Retry-After must not stall the run for an hour");
});

test("report(): an HTTP-date Retry-After is honoured", async () => {
  const clock = fakeTime();
  const c = createPoliteClient(cfg({ delayMs: 0 }), { ...clock, fetchImpl: noFetch });
  const when = new Date(clock.value + 7_000).toUTCString();
  c.report("https://t.test/a", 503, when);
  const start = clock.value;
  await c.gate("https://t.test/b");
  // toUTCString has 1s resolution, so the wait is 6-7s.
  const waited = clock.value - start;
  assert.ok(waited > 6_000 && waited <= 7_000, `waited ${waited}ms`);
});

test("report(): backoff without Retry-After grows with the strike run", async () => {
  const clock = fakeTime();
  // random 0 -> the jittered wait is exactly half the exponential step.
  const c = createPoliteClient(cfg({ delayMs: 0, breakAfter: 50 }), { ...clock, fetchImpl: noFetch, random: () => 0 });
  c.report("https://t.test/a", 429);
  let start = clock.value;
  await c.gate("https://t.test/a");
  assert.equal(clock.value - start, 500, "first strike: 1s step, half-jittered");

  c.report("https://t.test/a", 429);
  start = clock.value;
  await c.gate("https://t.test/a");
  assert.equal(clock.value - start, 1000, "second strike: 2s step, half-jittered");
});

test("report(): a 502 holds the origin back but is not a rate-limit strike", async () => {
  const clock = fakeTime();
  const c = createPoliteClient(cfg({ delayMs: 0, breakAfter: 1 }), { ...clock, fetchImpl: noFetch, random: () => 0 });
  c.report("https://t.test/a", 502);
  assert.equal(c.throttled(), false, "a gateway error alone never opens the breaker");
  assert.equal(c.stats().rateLimited, 0);
  const start = clock.value;
  await c.gate("https://t.test/b");
  assert.equal(clock.value - start, 500);
});

test("report(): a 502 between two 429s neither resets nor extends the strike run", () => {
  const c = createPoliteClient(cfg({ delayMs: 0, breakAfter: 2 }), { fetchImpl: noFetch });
  c.report("https://t.test/a", 429);
  c.report("https://t.test/a", 502);
  assert.equal(c.throttled(), false);
  c.report("https://t.test/a", 429);
  assert.equal(c.throttled(), true, "429, 502, 429 is two consecutive rate-limits");
});

test("report(): a 404 or 200 adds no wait and resets the run", async () => {
  const clock = fakeTime();
  const c = createPoliteClient(cfg({ delayMs: 0, breakAfter: 2 }), { ...clock, fetchImpl: noFetch });
  c.report("https://t.test/a", 429);
  c.report("https://t.test/a", 404);
  c.report("https://t.test/a", 429);
  assert.equal(c.throttled(), false, "a 404 is an answer, not a throttle");
  const fresh = createPoliteClient(cfg({ delayMs: 0 }), { ...clock, fetchImpl: noFetch });
  fresh.report("https://t.test/a", 200);
  const start = clock.value;
  await fresh.gate("https://t.test/a");
  assert.equal(clock.value - start, 0);
});

test("report(): strikes and the breaker are per origin, including the port", async () => {
  const c = createPoliteClient(cfg({ delayMs: 0, breakAfter: 2 }), { fetchImpl: noFetch, sleep: async () => {} });
  c.report("http://127.0.0.1:8001/a", 429);
  c.report("http://127.0.0.1:8001/b", 429);
  assert.deepEqual(c.stats().throttledOrigins, ["http://127.0.0.1:8001"]);
  await assert.rejects(() => c.gate("http://127.0.0.1:8001/c"), isKind("breaker"));
  await c.gate("http://127.0.0.1:8002/c"); // another port is another origin
  await c.gate("https://other.test/"); // and another host is untouched
});

test("report(): an origin is listed once however often it is throttled", () => {
  const c = createPoliteClient(cfg({ delayMs: 0, breakAfter: 1 }), { fetchImpl: noFetch });
  for (let i = 0; i < 4; i++) c.report("https://t.test/x", 429);
  assert.deepEqual(c.stats().throttledOrigins, ["https://t.test"]);
  assert.equal(c.stats().rateLimited, 4);
});

test("stats() is a copy: a caller cannot clear the throttled list", () => {
  const c = createPoliteClient(cfg({ delayMs: 0, breakAfter: 1 }), { fetchImpl: noFetch });
  c.report("https://t.test/x", 429);
  c.stats().throttledOrigins.length = 0;
  assert.equal(c.throttled(), true);
});

// ------------------------------------------------------------- gate() under concurrency

// F-T09: gate() checked the budget before waitTurn and never again, so N concurrent gates all passed.
test(
  "gate(): concurrent navigations cannot overspend the budget",
  async () => {
    // The crawler runs `concurrency` workers, each calling gate() before page.goto. fetch()
    // re-checks guard() after its wait; gate() does not, so every worker that arrived while
    // `sent` was below the budget gets through.
    const c = createPoliteClient(cfg({ delayMs: 0, budget: 1 }), { fetchImpl: noFetch, sleep: async () => {} });
    const results = await Promise.allSettled([
      c.gate("https://t.test/a"),
      c.gate("https://t.test/b"),
      c.gate("https://other.test/c"),
    ]);
    const passed = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(passed, 1, `budget 1, but ${passed} navigations were allowed (sent=${c.stats().sent})`);
  },
);

// F-T10: gate() did not re-check the breaker after waitTurn, unlike fetch().
test(
  "gate(): a navigation waiting for its slot is refused if the breaker opens meanwhile",
  async () => {
    const clock = fakeTime();
    const c = createPoliteClient(cfg({ delayMs: 100, breakAfter: 1 }), { ...clock, fetchImpl: noFetch });
    await c.gate("https://t.test/a");
    const waiting = c.gate("https://t.test/b"); // now queued behind the 100ms spacing
    c.report("https://t.test/a", 429); // the first navigation came back 429: breaker opens
    await assert.rejects(() => waiting, isKind("breaker"));
  },
);
