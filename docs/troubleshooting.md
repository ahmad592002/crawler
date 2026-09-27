# Troubleshooting

Known causes first, in rough order of how often they are the answer.

## The crawl

### "Seeded 1 URL(s)" and then it stops

The seed is in scope but nothing it links to is. Almost always `allowedOrigins`.

It is an **exact origin match** — scheme, host and port. `https://site.com` does not cover
`https://www.site.com` or `http://site.com`. List every origin the site actually links to:

```json
"allowedOrigins": ["https://site.com", "https://www.site.com"]
```

Check what is being rejected:

```bash
npx tsx -e "import {isAllowedUrl,loadConfig} from './src/config.ts';
            const c=loadConfig(); console.log(isAllowedUrl('https://www.site.com/x', c))"
```

### Concurrency 4 but it behaves like 1

Was a real bug (workers exiting on an empty queue while peers were still discovering) and
is fixed. If you see it now, the queue genuinely is empty — check `maxDepth`, `include`
and the per-template cap below.

### Far fewer pages than `maxPages`

In order of likelihood:

1. **The 3-samples-per-template cap.** `templateOf` collapses path ids, so `/users/1`,
   `/users/2`, `/users/3` fill the quota and `/users/4` is never queued. This is intended.
   Check what collapsed:
   ```bash
   jq -r .template output/pages.jsonl | sort | uniq -c | sort -rn | head
   ```
2. **`maxDepth`.** Deep sections are simply out of reach.
3. **`exclude` too broad.** A regex like `/user` matches `/users`, `/user-guide`, …
4. **`maxPages` counts previous runs.** It caps the inventory, not the invocation. Delete
   `output/pages.jsonl` to start fresh.
5. **Destructive links are withheld.** Check `deniedLinks`; if something legitimate was
   caught, add a `denyUrlExceptions` entry.

### A page I need was withheld as destructive

```bash
jq -r 'select(.deniedLinks != []) | .deniedLinks[]' output/pages.jsonl | sort -u
```

Add a narrow regex to `denyUrlExceptions`. **Do not remove the term from `denyList`** —
that disables it everywhere, not just here.

### Everything reports `status: null`

Navigation never completed. Check `pageErrors` on a record — it carries the real message.

```bash
jq -r 'select(.ok == false) | "\(.url)\t\(.pageErrors[0])"' output/pages.jsonl | head
```

`Timeout ... exceeded` with the site fine in a browser usually means DNS or proxy trouble
on the machine running the crawl. Confirm independently:

```bash
curl -s -o /dev/null -w "%{http_code} in %{time_total}s\n" https://your-site/
```

`curl` exit 6 means the host does not resolve; that is not a tool problem.

Failed pages are **retried on the next run** — they are excluded from the resume set on
purpose.

### "Cannot write output/pages.jsonl" and the crawl stops

Intentional. A crawl that cannot persist its output stops rather than finishing with a
truncated inventory and exit 0. Disk full, permissions, or a virus scanner holding the
file open.

### "WARNING: hit maxRuntimeMs"

The wall-clock cap fired and **the inventory is incomplete**. Either the target is very
slow (raise `maxRuntimeMs`, lower `maxPages`) or something hung. Check the slowest pages
in the summary.

### Chromium processes left behind

Should not happen — teardown is in a `finally`. If it does, it is a crash before the pool
started. `pkill -f chromium` / `taskkill /IM chrome.exe /F`.

## Authenticated crawling

### "No saved session at output/auth/state.json"

Run the setup first — `npx playwright test --project=setup`, or just `npm run qa`, which
orders the test run before the authenticated crawl for exactly this reason.

### `pages.auth.jsonl` looks identical to the anonymous crawl

The session expired. The crawler warns:

```
WARNING: N of M pages redirected to a login page.
This run's pages.auth.jsonl reflects an ANONYMOUS view.
```

It also warns up front when the state file is over 30 minutes old and contains
browser-session cookies (`expires: -1`), which are usually dead server-side. Re-run the
auth setup and crawl again.

### The authenticated crawl is always skipped in CI

Fixed — `playwright test` now runs before `crawl (auth)` in `src/qa.ts`. If you reordered
the steps, put it back: a fresh checkout has no `state.json`, so the `when` guard reports
a clean skip and CI never crawls a logged-in page.

## Tests

### Every test times out at ~120s

Usually one unresolvable third-party host. The fixture blocks everything off-origin by
default; if you set `captureOffOrigin: true`, you turned that off.

### Too many workers

Six workers against a small shared host made every test time the others out; two finished
the same suite. **The site is usually the bottleneck, not your machine.** Set
`testWorkers: 2`.

### An assertion races the navigation

Use `submitAndWait`, not `waitForURL`. A rejected login re-renders the same URL, so
`waitForURL` matches instantly.

### A test that should fail is passing

Check for a stale `test.fail()`. When the underlying bug is fixed, Playwright reports the
test as an unexpected *pass* — that is the signal to delete the `.fail()` and the finding.

### `safeClick: 2 buttons match ...`

Deliberate — it refuses to guess. Narrow the locator (`getByRole` within a container, an
exact name, or `.first()` if you are certain).

### `Refusing to click ...: the resolved element matches denyList`

Working as intended: the *resolved element* is destructive even if your selector looked
innocuous. Check its `aria-label`, `href` and enclosing `<form action>`. If it is a false
positive, fix the deny term or add a URL exception; do not bypass the guard.

### `ReferenceError: __name is not defined`

`tsx`/esbuild rewrites functions with a helper that does not exist inside the page. The
crawler installs an init script for this. If you added a `page.evaluate` somewhere without
that context, inline the function rather than referencing an outer one.

## Email

### "No mail.tm account known for ... in this process"

Disposable mailboxes exist only in the process that created them — the password is random
and never persisted. `createInbox` and `waitForEmail` must happen in the same run. That is
why `npm run email:wait` does both.

### mail.tm 429

Public free service. Wait a few seconds, or switch to the `imap` provider.

### The email never arrives

1. **`since_iso` recorded after the action.** Record it *before*. This is the most common
   cause by a distance.
2. The site rejects disposable domains — switch to `imap`.
3. It went to spam. The `imap` provider checks `[Gmail]/Spam`; mail.tm has one folder.
4. `subject_contains` too strict.

### The wrong code comes back

`extractCode` scores digit runs by proximity to hint words. It strips HTML, URLs and CSS
first, so the usual traps are handled — but with two codes in one message the scoring is
genuinely ambiguous. Pass an explicit `pattern`, or narrow with `subject_contains`.

If it returns `null`, that is deliberate: nothing scored above the minimum. Use
`get_verification_link` or `read_latest_email` to see what actually arrived.

### The wrong link comes back

Links are ranked, not returned in document order. If the ranking still picks wrong, pass
`link_contains` with a substring of your real verification URL — the most reliable option.

## Report and export

### `report.html` is enormous

Screenshots are inlined. Images over 400 KB are skipped, but 120 pages still adds up.
Lower `maxPages`, or drop the screenshot quality in `crawl.ts`.

### A finding is missing from the report

Check the line parses: `jq -c . output/findings.jsonl`. Unparseable lines are skipped
silently. An unrecognised `severity` now renders as `medium` rather than vanishing.

### A URL in the report is plain text instead of a link

`safeHref()` rejected it — it permits `http`, `https` and relative paths only. Working as
intended.

### The Burp XML will not import

Validate it first:

```bash
xmllint --noout output/http-history.xml && echo OK
```

Illegal characters are now stripped at serialisation, so a rejection points at something
else. Check `burpVersion` in the `<items>` element and see
[burp-export.md](burp-export.md).

### "No exchanges in output/http-history.jsonl"

`captureHttpHistory` was `false` for that crawl. It is off by default.

## Getting more detail

```bash
jq -c 'select(.consoleErrors != [] or .pageErrors != [])' output/pages.jsonl
DEBUG=pw:api npx playwright test --grep "the one test"
npx playwright show-trace output/test-results/<dir>/trace.zip
npm run typecheck && npm run test:unit
```

If `test:unit` fails, fix that before anything else — it means a guard is broken, and
everything downstream is untrustworthy.
