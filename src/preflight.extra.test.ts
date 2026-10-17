/**
 * checkHealth end to end, against real HTTP servers on 127.0.0.1. preflight.test.ts drives
 * judgeHealth and subresources with literal input; this proves checkHealth wires them up:
 * which URLs it actually requests, what it refuses to request, and how a dead or stalling
 * entry page is reported.
 *
 * No third party is touched. The shared polite client is replaced with one that does not
 * space requests, so the suite does not wait 250ms per probe.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { checkHealth } from "./preflight.js";
import { setPoliteClient, resetPoliteClient, createPoliteClient, DEFAULT_POLITE } from "./polite.js";
import type { QaConfig } from "./config.js";

type Route = (res: ServerResponse) => void;

async function serve(routes: Record<string, Route>) {
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    paths.push(req.url ?? "");
    const route = routes[req.url ?? ""];
    if (route) return route(res);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    paths,
    stop: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const html = (body: string): Route => (res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head>${body}</head><body>hi</body></html>`);
};
// Retry-After: 0 so the polite client's 503 retries do not sleep through a 1-4s backoff.
const status = (code: number): Route => (res) => {
  res.writeHead(code, { "content-type": "text/plain", ...(code === 503 ? { "retry-after": "0" } : {}) });
  res.end(String(code));
};

const cfgFor = (origin: string, over: Partial<QaConfig> = {}): QaConfig =>
  ({
    baseUrl: `${origin}/`,
    allowedOrigins: [origin],
    navTimeoutMs: 5_000,
    denyList: ["delete", "logout"],
    denyUrlExceptions: [],
    include: [],
    exclude: [],
    ...over,
  }) as unknown as QaConfig;

beforeEach(() => setPoliteClient(createPoliteClient({ ...DEFAULT_POLITE, delayMs: 0, budget: 0 })));
afterEach(() => resetPoliteClient());

test("checkHealth probes the page and its same-origin assets, and never an off-origin one", async () => {
  const other = await serve({ "/evil.js": status(200) });
  const srv = await serve({
    "/": html(
      `<script src="/js/app.js"></script>
       <link rel="stylesheet" href="/css/site.css">
       <script src="${other.origin}/evil.js"></script>`,
    ),
    "/js/app.js": status(200),
    "/css/site.css": status(200),
  });
  try {
    const h = await checkHealth(cfgFor(srv.origin));
    assert.equal(h.healthy, true, h.reason);
    assert.deepEqual(
      h.probes.map((p) => p.url).sort(),
      [`${srv.origin}/`, `${srv.origin}/css/site.css`, `${srv.origin}/js/app.js`].sort(),
    );
    assert.deepEqual(other.paths, [], "an off-origin script must not be requested");
  } finally {
    await srv.stop();
    await other.stop();
  }
});

test("checkHealth: one asset answering 503 makes the target unhealthy", async () => {
  const srv = await serve({
    "/": html(`<script src="/a.js"></script><script src="/b.js"></script>`),
    "/a.js": status(200),
    "/b.js": status(503),
  });
  try {
    const h = await checkHealth(cfgFor(srv.origin));
    assert.equal(h.healthy, false);
    assert.match(h.reason, /1 of 3/);
    assert.equal(h.probes.find((p) => p.url.endsWith("/b.js"))?.status, 503);
  } finally {
    await srv.stop();
  }
});

test("checkHealth: a 404 asset does not block the run", async () => {
  const srv = await serve({ "/": html(`<script src="/missing.js"></script>`) });
  try {
    const h = await checkHealth(cfgFor(srv.origin));
    assert.equal(h.healthy, true, h.reason);
  } finally {
    await srv.stop();
  }
});

for (const code of [404, 500, 503]) {
  test(`checkHealth: an entry page answering ${code} stops before any asset is requested`, async () => {
    const srv = await serve({ "/": status(code) });
    try {
      const h = await checkHealth(cfgFor(srv.origin));
      assert.equal(h.healthy, false);
      assert.match(h.reason, new RegExp(`entry page answered ${code}`));
      assert.equal(h.probes.length, 1);
      // A 503 is retried by the polite client (1 + rateLimitRetries tries); still only "/".
      assert.deepEqual(new Set(srv.paths), new Set(["/"]), "nothing else is fetched once the document fails");
    } finally {
      await srv.stop();
    }
  });
}

test("checkHealth: an unreachable target is unhealthy, with a reason instead of a throw", async () => {
  const srv = await serve({});
  const origin = srv.origin;
  await srv.stop(); // the port is now closed
  const h = await checkHealth(cfgFor(origin));
  assert.equal(h.healthy, false);
  assert.equal(typeof h.probes[0]?.status, "string", "a transport failure is reported by error name");
  assert.match(h.reason, /entry page answered/);
});

test("checkHealth: an entry page that sends headers and then stalls times out as unhealthy", async () => {
  // The shape that makes a browser hang while a HEAD-only check looks fine.
  const srv = await serve({
    "/": (res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html><head>");
      // never ends
    },
  });
  try {
    const h = await checkHealth(cfgFor(srv.origin, { navTimeoutMs: 300 }));
    assert.equal(h.healthy, false);
    assert.equal(typeof h.probes[0]?.status, "string", `status was ${String(h.probes[0]?.status)}`);
  } finally {
    await srv.stop();
  }
});

test("checkHealth resolves relative asset paths against a baseUrl with a path", async () => {
  const srv = await serve({
    "/app/": html(`<script src="main.js"></script>`),
    "/app/main.js": status(200),
  });
  try {
    const h = await checkHealth(cfgFor(srv.origin, { baseUrl: `${srv.origin}/app/` }));
    assert.equal(h.healthy, true, h.reason);
    assert.ok(srv.paths.includes("/app/main.js"), `requested: ${srv.paths.join(", ")}`);
  } finally {
    await srv.stop();
  }
});

// F-T11: checkHealth filtered assets by isAllowedUrl only, not isDeniedUrl.
test(
  "checkHealth never requests a destructive-looking asset URL",
  async () => {
    // Every other requester (crawl frontier, authz candidates, the deploy content scan)
    // refuses an isDeniedUrl target. A <script src> on the home page is just as much a GET.
    const srv = await serve({
      "/": html(
        `<script src="/session/logout.js"></script><link rel="stylesheet" href="/account/delete?format=css">`,
      ),
    });
    try {
      await checkHealth(cfgFor(srv.origin));
      const hit = srv.paths.filter((p) => p !== "/");
      assert.deepEqual(hit, [], `requested: ${hit.join(", ")}`);
    } finally {
      await srv.stop();
    }
  },
);

test(
  "checkHealth reports a fast 503 asset as 503, not as a timeout",
  { todo: "F-T13: the probe's AbortSignal.timeout spans the polite client's 503 retries, so a fast 503 becomes 'TimeoutError'" },
  async () => {
    // No Retry-After: the client backs off ~0.5-1s, 1-2s, 2-4s, which outlives a 1s budget.
    const srv = await serve({
      "/": html(`<script src="/busy.js"></script>`),
      "/busy.js": (res) => {
        res.writeHead(503);
        res.end("busy");
      },
    });
    try {
      const h = await checkHealth(cfgFor(srv.origin, { navTimeoutMs: 1_000 }));
      assert.equal(h.healthy, false);
      assert.equal(h.probes.find((p) => p.url.endsWith("/busy.js"))?.status, 503);
    } finally {
      await srv.stop();
    }
  },
);

test(
  "checkHealth fetches the entry page once",
  { todo: "F-T12: checkHealth GETs baseUrl twice - once to probe, once more to read assets" },
  async () => {
    const srv = await serve({ "/": html(`<script src="/a.js"></script>`), "/a.js": status(200) });
    try {
      await checkHealth(cfgFor(srv.origin));
      assert.equal(srv.paths.filter((p) => p === "/").length, 1, `requested: ${srv.paths.join(", ")}`);
    } finally {
      await srv.stop();
    }
  },
);
