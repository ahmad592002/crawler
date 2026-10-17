/**
 * Extra tests for the crawl frontier (createFrontier) and the link filter (partitionLinks),
 * both lifted out of crawl.ts in improvement round 1. guards.test.ts pins the headline
 * cases (a destructive seed, a link denied on its second name); these pin the edges:
 * dedup, depth, the per-template cap, resume, encodings, and every href shape the
 * harvester can hand over.
 *
 * Offline and pure: no browser, no server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFrontier, partitionLinks, dedupKey, namesFrom, runPool, type AnchorInfo, type RawNames } from "./crawl.js";
import { createPoliteClient, DEFAULT_POLITE, PolitenessError } from "./polite.js";
import type { QaConfig } from "./config.js";

const ORIGIN = "https://target.test";

const cfg = (over: Partial<QaConfig> = {}): QaConfig =>
  ({
    baseUrl: `${ORIGIN}/`,
    allowedOrigins: [ORIGIN],
    maxDepth: 3,
    include: [],
    exclude: [],
    denyList: ["delete", "remove", "close account", "pay", "logout"],
    denyUrlExceptions: ["/add_remove_elements/?$"],
    ...over,
  }) as unknown as QaConfig;

const urls = (f: { queue: { url: string }[] }) => f.queue.map((j) => j.url);

// ------------------------------------------------------------- createFrontier

test("frontier: /x and /x/ are one page; the first form seen is the one fetched", () => {
  const f = createFrontier(cfg(), new Set());
  f.enqueue(`${ORIGIN}/about/`, 1);
  f.enqueue(`${ORIGIN}/about`, 1);
  f.enqueue(`${ORIGIN}/about/?utm_source=x`, 1);
  assert.deepEqual(urls(f), [`${ORIGIN}/about/`]);
});

test("frontier: depth equal to maxDepth is queued, deeper is not", () => {
  const f = createFrontier(cfg({ maxDepth: 2 }), new Set());
  f.enqueue(`${ORIGIN}/a`, 2);
  f.enqueue(`${ORIGIN}/b`, 3);
  assert.deepEqual(urls(f), [`${ORIGIN}/a`]);
  // A URL refused for depth is not remembered: reached later at a shallower depth, it is queued.
  f.enqueue(`${ORIGIN}/b`, 1);
  assert.deepEqual(urls(f), [`${ORIGIN}/a`, `${ORIGIN}/b`]);
});

test("frontier: at most three samples of one page shape", () => {
  const f = createFrontier(cfg(), new Set());
  for (const id of [1, 2, 3, 4, 5]) f.enqueue(`${ORIGIN}/users/${id}`, 1);
  f.enqueue(`${ORIGIN}/users/new`, 1); // a different template
  assert.deepEqual(urls(f), [`${ORIGIN}/users/1`, `${ORIGIN}/users/2`, `${ORIGIN}/users/3`, `${ORIGIN}/users/new`]);
});

test("frontier: a resumed crawl neither refetches done pages nor takes 3 more samples", () => {
  const done = new Set([dedupKey(`${ORIGIN}/users/1`), dedupKey(`${ORIGIN}/users/2`)]);
  const f = createFrontier(cfg(), done);
  f.enqueue(`${ORIGIN}/users/1`, 1);
  f.enqueue(`${ORIGIN}/users/1/`, 1);
  for (const id of [3, 4, 5]) f.enqueue(`${ORIGIN}/users/${id}`, 1);
  assert.deepEqual(urls(f), [`${ORIGIN}/users/3`], "two done + one new = the cap of three");
});

test("frontier: destructive seeds are refused however they are spelled", () => {
  const f = createFrontier(cfg(), new Set());
  const bad = [
    `${ORIGIN}/account/%64elete`, // percent-encoded letter
    `${ORIGIN}/Account/DELETE`, // case
    `${ORIGIN}/cart?action=remove&id=1`, // in the query
    `${ORIGIN}/account/close`, // multi-word term, reversed order
    `${ORIGIN}/billing/pay`,
    `${ORIGIN}/api/v1/purge`, // built-in destructive verb, not on this deny list
  ];
  for (const u of bad) f.enqueue(u, 1);
  assert.deepEqual(urls(f), []);
  assert.deepEqual(f.deniedSeeds, bad);
});

test("frontier: a denied URL is recorded once, however many pages link to it", () => {
  const f = createFrontier(cfg(), new Set());
  f.enqueue(`${ORIGIN}/items/7/delete`, 1);
  f.enqueue(`${ORIGIN}/items/7/delete`, 2);
  f.enqueue(`${ORIGIN}/items/7/delete/`, 1);
  f.enqueue(`${ORIGIN}/items/7/delete#x`, 1);
  assert.deepEqual(f.deniedSeeds, [`${ORIGIN}/items/7/delete`]);
});

test("frontier: the shipped exception admits its own page and nothing that merely mentions it", () => {
  const f = createFrontier(cfg(), new Set());
  f.enqueue(`${ORIGIN}/add_remove_elements/`, 1);
  f.enqueue(`${ORIGIN}/account/delete?next=/add_remove_elements/`, 1);
  assert.deepEqual(urls(f), [`${ORIGIN}/add_remove_elements/`]);
  assert.deepEqual(f.deniedSeeds, [`${ORIGIN}/account/delete?next=/add_remove_elements/`]);
});

test("frontier: safe words that contain a deny term are not refused", () => {
  const f = createFrontier(cfg(), new Set());
  for (const p of ["/payments", "/deleted-items-report", "/removals-policy", "/closet/account-settings"]) {
    f.enqueue(`${ORIGIN}${p}`, 1);
  }
  assert.equal(f.deniedSeeds.length, 0, `refused: ${f.deniedSeeds.join(", ")}`);
  assert.equal(f.queue.length, 4);
});

// F-T14: createFrontier checked isDeniedUrl but not isAllowedUrl; origin scope relied on every caller.
test(
  "frontier: an off-origin URL never enters the queue, even when a caller forgets to filter",
  () => {
    // The frontier is documented as the single door ("every URL the crawler will ever fetch
    // enters through enqueue()"), and round 1 moved the deny check here because seeds
    // bypassed the link filter. The origin rule (CLAUDE.md rule 1) is still enforced only by
    // the callers; baseUrl itself is enqueued with no scope check at all.
    const f = createFrontier(cfg(), new Set());
    f.enqueue("https://evil.test/", 0);
    f.enqueue("https://user:pw@target.test.evil.test/", 0);
    assert.deepEqual(urls(f), []);
  },
);

// ------------------------------------------------------------- partitionLinks

const a = (href: string, label = "", alt = ""): AnchorInfo => ({ href, label, alt });

test("partitionLinks: non-HTTP hrefs are dropped, not denied and not followed", () => {
  const { discovered, deniedLinks } = partitionLinks(
    [
      a("javascript:deleteAll()", "Delete"),
      a("mailto:ops@target.test", "Mail"),
      a("tel:+100", "Call"),
      a("data:text/html,<b>x</b>"),
      a("http://[::1"), // unparseable
    ],
    `${ORIGIN}/page`,
    cfg(),
  );
  assert.deepEqual(discovered, []);
  assert.deepEqual(deniedLinks, []);
});

test("partitionLinks: off-origin and lookalike hosts are dropped", () => {
  const { discovered, deniedLinks } = partitionLinks(
    [
      a("https://evil.test/"),
      a("//evil.test/x"), // protocol-relative
      a("https://target.test.evil.test/"),
      a("http://target.test/"), // scheme downgrade is another origin
      a("https://target.test:8443/"),
    ],
    `${ORIGIN}/page`,
    cfg(),
  );
  assert.deepEqual(discovered, []);
  assert.deepEqual(deniedLinks, []);
});

test("partitionLinks: credentials in a link are stripped before it is kept", () => {
  const { discovered } = partitionLinks([a("https://admin:secret@target.test/panel")], `${ORIGIN}/`, cfg());
  assert.deepEqual(discovered, [`${ORIGIN}/panel`]);
  assert.ok(!discovered.some((u) => u.includes("secret")));
});

test("partitionLinks: relative hrefs resolve against the page, fragments and trackers go", () => {
  const { discovered } = partitionLinks(
    [a("c"), a("../up"), a("#top"), a("?b=2&a=1&utm_campaign=z"), a("  /spaced  ")],
    `${ORIGIN}/x/y/page`,
    cfg(),
  );
  assert.deepEqual(discovered, [
    `${ORIGIN}/x/y/c`,
    `${ORIGIN}/x/up`,
    `${ORIGIN}/x/y/page`,
    `${ORIGIN}/x/y/page?a=1&b=2`,
    `${ORIGIN}/spaced`,
  ]);
});

test("partitionLinks: exclude drops a link silently, include restricts to matches", () => {
  const excl = partitionLinks([a("/help"), a("/docs/file.pdf"), a("/ok")], `${ORIGIN}/`, cfg({ exclude: ["\\.pdf$"] }));
  assert.deepEqual(excl.discovered, [`${ORIGIN}/help`, `${ORIGIN}/ok`]);

  const incl = partitionLinks([a("/shop/1"), a("/blog/1")], `${ORIGIN}/`, cfg({ include: ["/shop/"] }));
  assert.deepEqual(incl.discovered, [`${ORIGIN}/shop/1`]);
});

test("partitionLinks: a bad include/exclude regex does not throw", () => {
  const r = partitionLinks([a("/ok")], `${ORIGIN}/`, cfg({ exclude: ["(unclosed"] }));
  assert.deepEqual(r.discovered, [`${ORIGIN}/ok`]);
});

test("partitionLinks: denied on the URL alone, with an innocent label", () => {
  const { discovered, deniedLinks } = partitionLinks(
    [a("/items/7/delete", "Details", "View"), a("/session/logout", "Profile")],
    `${ORIGIN}/`,
    cfg(),
  );
  assert.deepEqual(discovered, []);
  assert.deepEqual(deniedLinks, [`${ORIGIN}/items/7/delete`, `${ORIGIN}/session/logout`]);
});

test("partitionLinks: a label hidden behind Unicode tricks is still denied", () => {
  const { deniedLinks } = partitionLinks(
    [
      a("/i/1", "Dele​te"), // zero-width space
      a("/i/2", "Ｄelete"), // fullwidth D
      a("/i/3", "R e m o v e"), // letter-spaced
      a("/i/4", "", "Close   Account"), // only the alt name, extra spaces
    ],
    `${ORIGIN}/`,
    cfg(),
  );
  assert.deepEqual(deniedLinks, ["/i/1", "/i/2", "/i/3", "/i/4"].map((p) => `${ORIGIN}${p}`));
});

test("partitionLinks: empty names and safe look-alike words are not denied", () => {
  const { discovered, deniedLinks } = partitionLinks(
    [a("/a", "", ""), a("/b", "Payment history"), a("/c", "Undelete"), a("/d", "Repay")],
    `${ORIGIN}/`,
    cfg(),
  );
  assert.deepEqual(deniedLinks, []);
  assert.equal(discovered.length, 4);
});

test("partitionLinks: an off-origin destructive link is dropped, not reported as denied", () => {
  // deniedLinks is the inventory of withheld controls on THIS site; another site's delete
  // link is out of scope and must not clutter it.
  const { deniedLinks } = partitionLinks([a("https://evil.test/delete", "Delete")], `${ORIGIN}/`, cfg());
  assert.deepEqual(deniedLinks, []);
});

// ------------------------------------------------------------- C-32: every candidate name

/**
 * The deny check read only aria-label and textContent, each cut to 80 characters in the
 * page. An icon link - no text, no aria-label, title="Delete order" or <img alt="Delete"> -
 * had two empty names and was queued and fetched; so was a label padded past 80 characters
 * with the destructive word at the end.
 */
const raw = (over: Partial<RawNames> = {}): RawNames => ({
  aria: "",
  text: "",
  title: "",
  labelledBy: "",
  imgAlt: [],
  svgTitle: [],
  ...over,
});
const named = (href: string, r: RawNames): AnchorInfo => ({ href, ...namesFrom(r) });

test("C-32: an icon link named only by title, img alt, svg title or aria-labelledby is denied", () => {
  const { discovered, deniedLinks } = partitionLinks(
    [
      named("/orders/7", raw({ title: "Delete order" })),
      named("/orders/8", raw({ imgAlt: ["Delete"] })),
      named("/orders/9", raw({ svgTitle: ["Remove item"] })),
      named("/orders/10", raw({ labelledBy: "Delete this order" })),
      named("/orders/11", raw({ title: "View order" })),
    ],
    `${ORIGIN}/`,
    cfg(),
  );
  assert.deepEqual(deniedLinks, [7, 8, 9, 10].map((n) => `${ORIGIN}/orders/${n}`));
  assert.deepEqual(discovered, [`${ORIGIN}/orders/11`]);
});

test("C-32: a long label is matched in full and only truncated for display", () => {
  const long = `${"x ".repeat(45)}Delete`; // 96 characters, the word past column 80
  const info = namesFrom(raw({ text: long }));
  assert.ok(info.label.length <= 80, "the display label is still short");
  const { deniedLinks } = partitionLinks([{ href: "/orders/7", ...info }], `${ORIGIN}/`, cfg());
  assert.deepEqual(deniedLinks, [`${ORIGIN}/orders/7`]);
});

// ------------------------------------------------------------- C-33: the limiter says stop

/**
 * A PolitenessError from gate() was caught inside visit() as a navigation error, so once
 * the budget was spent or the breaker opened, every remaining job in the queue was still
 * taken, "visited" without a request, and written as an ok:false record - and the crawl
 * exited 0. The pool now stops every worker on the first refusal and records nothing for
 * the refused job.
 */
async function poolOverBudget(concurrency: number) {
  const client = createPoliteClient({ ...DEFAULT_POLITE, delayMs: 0, budget: 1 });
  const queue = ["/a", "/b", "/c", "/d"].map((p) => `${ORIGIN}${p}`);
  const written: string[] = [];
  const outcome = await runPool({
    queue,
    concurrency,
    deadline: Date.now() + 60_000,
    stop: () => false,
    handle: async (url) => {
      await client.gate(url); // what visit() does before every navigation
      written.push(url);
    },
  });
  return { queue, written, outcome };
}

test("C-33: a limiter refusal stops the pool and writes no record for the refused jobs", async () => {
  // Two workers, as a real crawl has: both stop, and gate() does not let the second through
  // on a budget the first already spent (T-09).
  const { written, outcome } = await poolOverBudget(2);
  assert.deepEqual(written, [`${ORIGIN}/a`], "only the job the budget paid for is recorded");
  assert.ok(outcome.refused instanceof PolitenessError);
  assert.equal(outcome.refused?.kind, "budget");
});

test("C-33: once refused, the pool takes no further jobs", async () => {
  // One worker, so the count is deterministic: /a is paid for, /b is refused, /c and /d
  // are never taken. (With N workers up to N jobs can be in hand when the refusal lands.)
  const { queue, written } = await poolOverBudget(1);
  assert.deepEqual(written, [`${ORIGIN}/a`]);
  assert.deepEqual(queue, [`${ORIGIN}/c`, `${ORIGIN}/d`]);
});

test("C-33: an ordinary crash loses one page, not the crawl", async () => {
  const queue = ["/a", "/b", "/c"].map((p) => `${ORIGIN}${p}`);
  const written: string[] = [];
  const outcome = await runPool({
    queue,
    concurrency: 1,
    deadline: Date.now() + 60_000,
    stop: () => false,
    handle: async (url) => {
      if (url.endsWith("/b")) throw new Error("context closed");
      written.push(url);
    },
    log: () => {},
  });
  assert.deepEqual(written, [`${ORIGIN}/a`, `${ORIGIN}/c`]);
  assert.equal(outcome.refused, null);
});
