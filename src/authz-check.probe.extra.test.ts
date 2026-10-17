/**
 * probe() - the authorization scan's single request - with a fake APIRequestContext.
 *
 * polite-wiring.test.ts proves probes are paced and budgeted against a real server. This
 * pins the rest of the contract round 1 gave probe(): what it asks Playwright for (no
 * redirects, no throw on 4xx), that every answer is reported back to the limiter so a run
 * of 429s stops the scan, that a refusal propagates instead of being swallowed, and that a
 * transport failure is "unreachable" (null) rather than a crash.
 *
 * Named authz-check.probe.extra.test.ts because authz-check.extra.test.ts already exists
 * (round 1) and existing test files are not edited.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "playwright";
import { probe, reachedResource } from "./authz-check.js";
import {
  setPoliteClient,
  resetPoliteClient,
  createPoliteClient,
  DEFAULT_POLITE,
  PolitenessError,
  type PoliteConfig,
} from "./polite.js";

afterEach(() => resetPoliteClient());

interface Answer {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** Make text() reject, as Playwright does for a disposed or bodiless response. */
  bodyFails?: boolean;
  /** Make get() itself reject (DNS, refused, timeout). */
  throws?: boolean;
}

function fakeCtx(answers: Answer[]) {
  const calls: { url: string; opts: Record<string, unknown> }[] = [];
  let i = 0;
  const ctx = {
    async get(url: string, opts: Record<string, unknown>) {
      calls.push({ url, opts });
      const a = answers[Math.min(i++, answers.length - 1)] ?? { status: 200 };
      if (a.throws) throw new Error("connect ECONNREFUSED");
      return {
        status: () => a.status,
        headers: () => a.headers ?? {},
        text: async () => {
          if (a.bodyFails) throw new Error("Response has been disposed");
          return a.body ?? "";
        },
      };
    },
  } as unknown as APIRequestContext;
  return { ctx, calls };
}

function install(over: Partial<PoliteConfig> = {}) {
  let t = 1_000_000;
  const clock = {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
  const client = createPoliteClient({ ...DEFAULT_POLITE, delayMs: 0, budget: 0, ...over }, clock);
  setPoliteClient(client);
  return { client, elapsed: () => t - 1_000_000 };
}

const PAGE = `<html><body><main><h1>Invoice 42</h1><p>${"Line item. ".repeat(40)}</p></main></body></html>`;

test("probe asks for the raw answer: no redirect following, no throw on 4xx, the given timeout", async () => {
  install();
  const { ctx, calls } = fakeCtx([{ status: 200, body: PAGE }]);
  await probe(ctx, "https://t.test/invoices/42", 1234);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.opts.maxRedirects, 0, "a 302 to /login is the answer; following it hides the denial");
  assert.equal(calls[0]?.opts.failOnStatusCode, false);
  assert.equal(calls[0]?.opts.timeout, 1234);
});

test("probe classifies what came back", async () => {
  install();
  const ok = await probe(fakeCtx([{ status: 200, body: PAGE }]).ctx, "https://t.test/a", 1000);
  assert.ok(ok && reachedResource(ok), "a real page with content is reached");

  const redirect = await probe(fakeCtx([{ status: 302, headers: { location: "/login" } }]).ctx, "https://t.test/b", 1000);
  assert.equal(redirect?.status, 302);
  assert.ok(redirect && !reachedResource(redirect), "a redirect is not the resource");

  const forbidden = await probe(fakeCtx([{ status: 403, body: "Forbidden" }]).ctx, "https://t.test/c", 1000);
  assert.ok(forbidden && !reachedResource(forbidden));
});

test("probe: a body that cannot be read is classified as empty, not thrown", async () => {
  install();
  const p = await probe(fakeCtx([{ status: 200, bodyFails: true }]).ctx, "https://t.test/a", 1000);
  assert.ok(p, "the probe still answers");
  assert.equal(p.length, 0);
  assert.equal(reachedResource(p), false, "an unreadable 200 must not count as reaching the resource");
});

test("probe: a transport failure is null (unreachable), and still costs a request", async () => {
  const { client } = install();
  const p = await probe(fakeCtx([{ status: 0, throws: true }]).ctx, "https://t.test/a", 1000);
  assert.equal(p, null);
  assert.equal(client.stats().sent, 1, "the gate was passed before the attempt");
  assert.equal(client.stats().rateLimited, 0, "nothing is reported for an answer that never came");
});

test("probe: a run of 429s opens the breaker and the next probe is refused before any request", async () => {
  install({ breakAfter: 3 });
  const { ctx, calls } = fakeCtx([{ status: 429, body: "slow down" }]);
  for (let i = 0; i < 3; i++) {
    const p = await probe(ctx, `https://t.test/p${i}`, 1000);
    assert.equal(p?.status, 429, "the throttled answer itself is still returned");
  }
  await assert.rejects(
    () => probe(ctx, "https://t.test/p3", 1000),
    (e: unknown) => e instanceof PolitenessError && e.kind === "breaker",
    "a PolitenessError must propagate - swallowing it as null would let the scan spin on",
  );
  assert.equal(calls.length, 3, "the refused probe made no request");
});

test("probe: Retry-After on a 503 holds the NEXT probe back by that long", async () => {
  const { elapsed } = install({ breakAfter: 50 });
  const { ctx } = fakeCtx([{ status: 503, headers: { "retry-after": "9" } }, { status: 200, body: PAGE }]);
  await probe(ctx, "https://t.test/a", 1000);
  const before = elapsed();
  await probe(ctx, "https://t.test/b", 1000);
  assert.equal(elapsed() - before, 9_000);
});

test("probe: a success between 429s resets the strike run", async () => {
  const { client } = install({ breakAfter: 2 });
  const { ctx } = fakeCtx([{ status: 429 }, { status: 200, body: PAGE }, { status: 429 }]);
  for (const p of ["a", "b", "c"]) await probe(ctx, `https://t.test/${p}`, 1000);
  assert.equal(client.throttled(), false);
});

test("probe: the budget refusal happens before the request", async () => {
  install({ budget: 1 });
  const { ctx, calls } = fakeCtx([{ status: 200, body: PAGE }]);
  await probe(ctx, "https://t.test/a", 1000);
  await assert.rejects(
    () => probe(ctx, "https://t.test/b", 1000),
    (e: unknown) => e instanceof PolitenessError && e.kind === "budget",
  );
  assert.equal(calls.length, 1);
});
