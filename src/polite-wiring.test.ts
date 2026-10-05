/**
 * Is the politeness layer actually WIRED IN, or just well tested in isolation?
 *
 * polite.test.ts proves the limiter behaves. It cannot prove that the modules which make
 * requests go through it - and that gap is the whole bug: there were seven raw fetch call
 * sites and a browser navigation, each perfectly correct on its own and collectively
 * capable of throttling a demo site off the air.
 *
 * So this runs the real code against a real HTTP server on localhost: no third party is
 * touched, nothing is stubbed, and the assertions are on observed wall-clock spacing and on
 * what the server actually received.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { collectHtml } from "./deploy-check.js";
import { setPoliteClient, resetPoliteClient, createPoliteClient, DEFAULT_POLITE } from "./polite.js";
import type { PageRecord } from "./crawl.js";
import type { QaConfig } from "./config.js";

/** A server that records when each request arrived, and can be told to rate-limit. */
async function start(handler?: (n: number) => { status: number; headers?: Record<string, string> }) {
  const hits: number[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(Date.now());
    const verdict = handler?.(hits.length) ?? { status: 200 };
    res.writeHead(verdict.status, { "content-type": "text/html", ...(verdict.headers ?? {}) });
    res.end("<html><body>page</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const page = (url: string): PageRecord =>
  ({
    url,
    template: url,
    depth: 0,
    status: 200,
    title: "",
    loadMs: 1,
    screenshot: null,
    consoleErrors: [],
    failedRequests: [],
    pageErrors: [],
    forms: [],
    buttons: [],
    deniedButtons: [],
    deniedLinks: [],
    links: 0,
    authRequired: false,
    redirected: false,
    ok: true,
    mode: "anon",
    crawledAt: "",
  }) as unknown as PageRecord;

const cfgFor = (origin: string): QaConfig =>
  ({
    baseUrl: origin,
    allowedOrigins: [origin],
    denyList: [],
    denyUrlExceptions: [],
    include: [],
    exclude: [],
  }) as unknown as QaConfig;

test("the content scan really is paced - gaps appear in the server's own log", async () => {
  const srv = await start();
  const DELAY = 300;
  setPoliteClient(createPoliteClient({ ...DEFAULT_POLITE, delayMs: DELAY, budget: 0 }));

  try {
    const pages = [1, 2, 3, 4].map((n) => page(`${srv.origin}/p${n}`));
    const started = Date.now();
    const html = await collectHtml(pages, [], cfgFor(srv.origin), 5_000);
    const elapsed = Date.now() - started;

    assert.equal(html.size, 4, "all four pages were still fetched");
    assert.equal(srv.hits.length, 4);

    // Three gaps between four requests. Allow slack for scheduling, but the floor is what
    // matters: without the limiter this loop completes in a few milliseconds.
    assert.ok(
      elapsed >= DELAY * 3 * 0.9,
      `expected at least ~${DELAY * 3}ms of spacing, took ${elapsed}ms`,
    );

    for (let i = 1; i < srv.hits.length; i++) {
      const gap = (srv.hits[i] ?? 0) - (srv.hits[i - 1] ?? 0);
      assert.ok(gap >= DELAY * 0.8, `gap ${i} was ${gap}ms, expected ~${DELAY}ms`);
    }
  } finally {
    resetPoliteClient();
    await srv.stop();
  }
});

test("a server answering 429 gets backed off and then left alone", async () => {
  // Always 429 with a short Retry-After: the server is asking us to stop.
  const srv = await start(() => ({ status: 429, headers: { "retry-after": "1" } }));
  setPoliteClient(
    createPoliteClient({
      ...DEFAULT_POLITE,
      delayMs: 0,
      budget: 0,
      breakAfter: 2,
      maxRetries: 5,
      maxBackoffMs: 50, // keep the test quick; the honouring of Retry-After is unit-tested
    }),
  );

  try {
    const pages = [1, 2, 3, 4, 5, 6].map((n) => page(`${srv.origin}/p${n}`));
    const html = await collectHtml(pages, [], cfgFor(srv.origin), 5_000);

    assert.equal(html.size, 0, "a 429 is not a document");
    // Two strikes opens the breaker, so the server must NOT see one request per page.
    assert.ok(
      srv.hits.length <= 3,
      `breaker should have stopped the run; server saw ${srv.hits.length} requests for 6 pages`,
    );
  } finally {
    resetPoliteClient();
    await srv.stop();
  }
});

test("a healthy server is not slowed down beyond its configured gap", async () => {
  // The reverse check: politeness must not mean "always slow". With delayMs 0 the limiter
  // should add essentially nothing, or every run pays for a problem it does not have.
  const srv = await start();
  setPoliteClient(createPoliteClient({ ...DEFAULT_POLITE, delayMs: 0, budget: 0 }));

  try {
    const pages = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => page(`${srv.origin}/p${n}`));
    const started = Date.now();
    await collectHtml(pages, [], cfgFor(srv.origin), 5_000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `8 localhost requests should be quick, took ${elapsed}ms`);
    assert.equal(srv.hits.length, 8);
  } finally {
    resetPoliteClient();
    await srv.stop();
  }
});
