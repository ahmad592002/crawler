# Architecture

## Why it is split this way

The expensive part of AI-driven testing is asking a model to do things a script can do.
Crawling 60 pages, taking screenshots, diffing statuses and re-running a suite are all
deterministic. Understanding what a feature is *for*, deciding what "correct" means, and
writing an assertion that captures it are not.

So the pipeline separates them. Everything deterministic is a TypeScript file that runs
with `tsx` and costs nothing. Claude is invoked for exactly one phase, its conclusions are
written to disk as data, and a script turns that data into a permanent test suite. After
that the suite runs forever with no model in the loop.

The practical consequence: **the AI cost is per feature, not per run.** A nightly job
executes only scripts.

## Components

```
                    qa.config.json
                          |
        +-----------------+------------------+
        |                 |                  |
   src/crawl.ts      src/report.ts     tests/*.spec.ts
   (inventory)        (render)          (assertions)
        |                 ^                  ^
        v                 |                  |
  output/pages.jsonl -----+                  |
  output/pages.auth.jsonl |                  |
  output/screenshots/     |                  |
        |                 |                  |
        v                 |                  |
   Claude, Phase 5 -------+                  |
        |                 |                  |
        v                 |                  |
  output/findings.jsonl --+                  |
  output/features.jsonl                      |
  output/progress.json ----------------------+
                              (Phase 6 writes the specs)
```

| File | Role |
|---|---|
| `src/config.ts` | Config schema and **the two guards**: `isAllowedUrl` (scope) and `isDenied`/`isDeniedUrl` (destructive controls). Single source of truth — everything else imports these rather than re-implementing the rule. |
| `src/crawl.ts` | Parallel crawler. Produces the page inventory, screenshots, and the discovered-link graph. |
| `src/http-history.ts` | Optional proxy capture. Reconstructs raw HTTP messages and serialises Burp proxy-history XML. |
| `src/report.ts` | Renders one self-contained HTML file from everything on disk. |
| `src/qa.ts` | The pipeline runner. Ordering and exit-code policy live here. |
| `src/export-burp.ts` | Re-serialises the XML from an existing capture without re-crawling. |
| `src/guards.test.ts` | Offline regression tests for all of the above. No browser, no network. |
| `src/email/` | Mailbox providers and the read-only Email MCP server. |
| `tests/fixtures.ts` | The shared Playwright fixture, the off-origin block, and `safeClick`/`safeClickLink`/`safeGoto`. |

## The crawler

`src/crawl.ts`, run as `npm run crawl` (anonymous) or `npm run crawl:auth` (logged in).

### Worker pool

A fixed number of workers (`concurrency`) share one queue and one browser context.

```ts
for (;;) {
  if (fatal) return;                                  // a write failed; stop everything
  if (Date.now() > deadline) return;                  // maxRuntimeMs wall clock
  if (done.size + recorded.size >= maxPages) return;  // budget

  const job = queue.shift();
  if (!job) {
    if (active === 0) return;                         // genuinely finished
    await sleep(50);                                  // peers are still discovering
    continue;
  }
  ...
}
```

Two details that are load-bearing:

- **An empty queue is not the end of the crawl.** Peers that are mid-visit are about to
  enqueue what they find. Exiting on an empty queue collapses a concurrency of N to 1,
  because every worker but one leaves on the first tick. Hence the `active` counter.
- **There is a wall-clock deadline.** `active` only decrements in a `finally`, so a visit
  that hangs past every per-step timeout would otherwise keep every other worker polling
  forever. `maxRuntimeMs` bounds the whole run and the summary says the inventory is
  incomplete when it fires.

### Order of operations inside a job

```
visit(url)
  -> enqueue(discovered)      FIRST. A write failure must not lose the link subtree.
  -> records.push(record)
  -> appendFileSync(...)      A failure here is FATAL, not a logged warning.
  -> log the line
```

This ordering is deliberate and was a real bug: with the append first and inside the same
`try`, one `ENOSPC` dropped the page *and every page reachable only through it*, logged a
single `CRASH` line, and exited 0.

### Per-page work (`visit`)

1. `page.goto(url, { waitUntil: "domcontentloaded" })`. Not `"load"` — that waits for
   every image and third-party script, so one unresolvable tracker reads as a navigation
   timeout that has nothing to do with your site.
2. A bounded 2.5s `networkidle` quiet period. Never unbounded; `networkidle` can hang
   indefinitely on a page with polling.
3. `harvest()` — one `page.evaluate` that returns title, anchors (href + text), forms,
   controls and the link count. One round trip, not one per selector. Wrapped in a 20s
   timeout because `page.evaluate` has none of its own.
4. A full-page JPEG screenshot, 20s timeout. A failure here never loses the record.
5. Classification: controls, links and forms are split into safe and denied. See
   [safety.md](safety.md).

### Scope and dedup

Three distinct ideas that are easy to conflate:

| Function | Question it answers |
|---|---|
| `normalizeUrl(raw, base)` | *What URL should I actually request?* Drops the hash, tracking params and credentials; sorts the query; **keeps** the trailing slash, path case and `%2F`. |
| `dedupKey(url)` | *Have I already seen this page?* `normalizeUrl` plus trailing-slash folding. |
| `templateOf(url)` | *What shape of page is this?* Collapses path ids (`/users/1` → `/users/:id`) but **keeps query values**, so `?page=1` and `?page=2` stay distinct. |

The trailing slash is preserved in `normalizeUrl` on purpose: plenty of sites serve
`/x/` and 404 `/x`. The URL that gets fetched must stay as the site published it.
`dedupKey` is what folds them together for identity.

`templateOf` feeds a cap of **3 samples per page shape**, so a list of 10,000 products
costs three page loads. Query values are part of the shape because folding them away
capped every paginated and faceted section at three pages — the crawler would report
"covered" having seen 3 of 50.

### Resume

Every page is appended to the JSONL the moment it is done, so an interrupted run leaves a
usable file. On restart `previousUrls()` reads it back and seeds:

- `queued` — so finished pages are not re-fetched;
- `perTemplate` — so a resumed run does not collect 3 *more* samples of every shape.

**Records whose navigation failed are excluded from that seed.** A page that timed out
once is retried on the next run rather than being marked permanently done and silently
vanishing from the inventory.

`maxPages` is a cap on the **inventory**, not on one invocation: the check is
`done.size + recorded.size >= maxPages`.

## The report

`src/report.ts` reads everything in `output/` and writes one self-contained
`report.html` — no external assets, screenshots inlined as data URIs, openable from a
file:// URL or an artifact download.

Every value that reaches the HTML is escaped with `esc()`, and every value that reaches an
`href` additionally goes through `safeHref()`, which permits only `http`, `https` and
relative paths. Screenshot paths are confined to `output/screenshots`. This matters
because `findings.jsonl` is written from what a model read off the target site — the
report renders attacker-influenced strings by design.

Pages are deduped by URL keeping the last record, so a retried page shows its successful
attempt rather than the earlier failure.

## The pipeline

`src/qa.ts`, run as `npm run qa`:

| # | Step | Soft? | Notes |
|---|---|---|---|
| 1 | `crawl (anon)` | no | A failure here means there is nothing to report on. |
| 2 | `playwright test` | yes | Runs **before** the auth crawl: its `setup` project is what writes `output/auth/state.json`. |
| 3 | `crawl (auth)` | yes | Skipped cleanly when there is no saved session. |
| 4 | `report` | no | Always reached, even when step 2 failed — a failing suite is when you most want the report. |

Step 2 and 3 used to be the other way round. A fresh checkout has no `state.json`, so the
authenticated crawl reported a clean skip on every single run and CI never crawled a
logged-in page. Ordering is the fix; the `when` guard alone was not enough.

**Exit code:** non-zero if a non-soft step failed, or if `findings.jsonl` records a
critical/high finding. Note that `output/` is gitignored, so on a fresh CI checkout there
is no findings file and the gate has nothing to read — the runner says so explicitly
rather than printing a reassuring `0`.

## Why it is written the way it is

A few decisions that look odd until you hit the failure they prevent:

- **Route with a predicate, not `"**/*"`.** A catch-all route that ends in
  `route.continue()` proxies every same-origin request through Node. Measured at
  356s → 727s on the same crawl. With a predicate only the blocked requests are
  intercepted and everything else goes direct.
- **Block *all* off-origin requests, not a named list.** A block-list only catches the
  trackers you thought of. Any third-party host whose DNS stalls holds the page open for
  tens of seconds. Took test setup from a 120s timeout to 26s.
- **An init script defines `__name`.** `tsx`/esbuild rewrites functions with a `__name()`
  helper that does not exist inside the page, so every `page.evaluate` throws
  `ReferenceError: __name is not defined` without it.
- **`submitAndWait`, not `waitForURL`.** A rejected login re-renders the *same* URL, so
  `waitForURL` matches instantly and the following assertion races the in-flight
  navigation. Waiting on the form's POST response is the signal that actually means
  "the server has answered".
- **An entry-point guard at the bottom of `crawl.ts`.** Without it, importing
  `normalizeUrl` from a test starts a real crawl.
