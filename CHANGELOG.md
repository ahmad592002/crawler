# Changelog

## Unreleased — Fixed — improvement round 3

- **Control panel Host/CSRF interlock (`src/control-panel.ts`).** Every request must now name
  this loopback origin (`Host: 127.0.0.1:PORT` or `localhost:PORT`) or it is refused with 403,
  and the side-effecting routes (`/save`, `/run`, `/stop`) additionally refuse any `Origin`/
  `Referer` that is present and not the panel's own origin. A web page the user is merely
  browsing (including a DNS-rebinding attacker) can no longer start crawls or rewrite
  `qa.config.json`. The panel's own `fetch()`/`EventSource` still work. New exported
  `isLocalRequest(headers, port, { checkOrigin })`, pinned in `src/control-panel.extra.test.ts`.
- **Control panel no longer leaves secrets in `os.tmpdir()` (`src/control-panel.ts`).**
  `saveConfig` validated the merged config — login/persona passwords included — by writing it
  to a world-readable `os.tmpdir()` file it never deleted. It now writes a fixed-name,
  `0o600` copy under `OUT` (project-local, gitignored) and always removes it in a `finally`.
- **nuclei baseUrl is shell-escaped and scope-checked (`src/nuclei.ts`).** `buildRecommendations`
  interpolated `baseUrl` into the whole-site `-u '…'` commands with a bare single-quote wrap and
  no scope check. A quote in the value could break out of the argument. The base is now wrapped
  as one POSIX-escaped shell argument (`' → '\''`) and a `-u` command is emitted only when the
  base is a real, in-scope http(s) URL; otherwise a clear note replaces the command.

## Unreleased — autopilot: run, read, retry

- **`src/diagnose.ts` (`npm run diagnose`).** Reads a finished run — crawl-status, the page
  inventory, the status files — and returns the verdict, whether the run is complete, and
  ranked, concrete retry actions (slow down when rate-limited, raise a budget at the ceiling,
  set up auth on a login-wall, widen include / seed sitemap on too-few-pages, run the
  scanners once the inventory is usable). Every action is a safe nudge or a next step; none
  ever widens `allowedOrigins` or the deny-list. `src/diagnose.test.ts` pins the rankings and
  that guarantee.
- **`qa-autopilot` agent + `/autorun` command.** Points the pipeline at one authorized target
  and loops run → `diagnose` → apply ONE safe change → re-run, until the run is `settled`, the
  attempt budget is spent, or two attempts make no progress, then writes a run report. It only
  makes safe config nudges, never invents credentials, and refuses an unauthorized target.

## Unreleased — control panel, live view, watch mode

- **Control panel (`npm run panel`).** A local page at `http://127.0.0.1:7777`: every config
  variable as a labelled field (from `config-meta.ts`), **Save** writes `qa.config.json` after
  validating it against the real schema (a bad value is refused with a field-named message and
  nothing is written), and buttons run the crawler and the other steps with their output
  streaming live. Bound to `127.0.0.1`; only the fixed set of npm scripts can be started;
  passwords are never shown or edited. `src/control-panel.test.ts` covers the save gate, the
  run allow-list, and that no password field is rendered.
- **Watch the crawler.** `QA_HEADFUL=1` (or the panel's "Watch the browser window" toggle)
  launches the crawl with a visible Chromium and a small slow-mo. Default stays headless, so
  CI and the normal run are unchanged.
- **Live crawl view.** The panel tails `output/pages*.jsonl` and shows each page as it is
  inventoried — status, load time, forms, buttons, denied controls, URL — with errors flagged.
- **MCP tools panel.** Lists the `playwright` and `email` MCP servers from `.mcp.json` and
  their tools, so you can see what Claude drives in the exploration phase (the crawler and
  scanners use Playwright and HTTP directly, not MCP).

## Unreleased — run summary and nuclei plan

- **Full run summary (`npm run summary` → `output/summary.md`).** One place that reads every
  `output/` file and reports, in order: findings by severity, coverage, which scans actually
  ran and their verdicts, the target's security posture, and what was skipped as destructive.
  The same data drives a new executive-summary panel at the top of `output/report.html`.
- **Nuclei command recommendations.** Built from the inventory and tech profile, never run.
  Crawled endpoints are sorted into categories (auth, input forms, upload, API, plus
  whole-site baseline, missing headers and cookie flags), and each gets the best-fit
  template set, severity and a command — scoped to `allowedOrigins`, paced to the crawler's
  rate (`-rate-limit`), with active/fuzzing scans flagged so they are opt-in. Target lists
  are written to `output/nuclei/<category>.txt`. Shown in `summary.md` and the HTML report.
  `src/nuclei.test.ts` pins the scope guarantee: an off-origin or deny-listed URL can never
  reach a target list or a command.

## Unreleased — adversarial audit remediation

An adversarial review of the whole codebase. Each item below is a defect that was
**demonstrated by running code**, not a theoretical concern, and each has a regression
test in `src/guards.test.ts` (17 tests, offline, wired into CI as `npm run test:unit`).

### Fixed — improvement round 2

- **The pre-deploy scan reported clean when it reached nothing.** Every probe error and
  every limiter refusal was swallowed like a 404, so a run against a target that was down
  (or whose request budget was spent) printed "No critical or high findings." and exited 0.
  The scan now counts attempted and failed probes and records a refusal; if the limiter
  refused or more than 25% of probes failed it prints `SCAN INCONCLUSIVE`, exits 2, and
  writes `output/deploy-status.json` with `verdict: "inconclusive"` - as `npm run authz`
  already did.

- **`denyUrlExceptions` matched the tail of a path.** The patterns were unanchored, so the
  shipped `/add_remove_elements/?$` also exempted `/account/delete/add_remove_elements/`,
  `/account/delete.php/add_remove_elements/` and `/account/delete;/add_remove_elements/`.
  Each pattern must now match the whole path (`^(?:pattern)$`), and a path containing `;`
  or a `.ext/` segment is never exempted. Existing configs are safe without edits; the
  shipped exception still exempts `/add_remove_elements` with or without the slash.

- **A literal `page.goto` in a spec was neither linted nor guarded.** The fixture's `goto`
  wrapper only set `waitUntil`, and the lint exempted any literal starting with `/` -
  including `"//evil.test/x"` and `"/users/7/delete"`. The fixture page and every
  `harden()`ed page now run `guardNavigation` (the same scope + deny check as `safeGoto`)
  before navigating, and the lint flags protocol-relative and deny-listed literals and
  `goto?.(` / `goto.bind|call|apply`. Consequence: `interactions.spec.ts`'s drag-and-drop
  test is now skipped as destructive, because `/drag_and_drop` matches the built-in `drop`
  route verb; it runs again if a reviewed `denyUrlExceptions` entry is added.

- **Icon links and long labels escaped the crawl's deny check.** Only `aria-label` and
  `textContent` were read, each cut to 80 characters in the page, so `<a title="Delete
  order">` or `<a><img alt="Delete"></a>` was queued and fetched, and a label padded past
  80 characters hid its last word. Links and controls now carry every candidate name
  (`title`, `aria-labelledby`, descendant `img[alt]`, `<svg><title>`) untruncated, and are
  denied if any matches; only the display label is shortened (`namesFrom()` in `crawl.ts`).

- **The report's stale-results warning vanished under `QA_OUT`.** It looked for specs at
  `OUT/../tests` (`output/tests` for `QA_OUT=output/shop`) and read that directory flat,
  so `tests/generated/` was never checked. It now reads the checkout's `tests/` recursively.

- **A crawl stopped by the limiter kept going and exited 0.** A `PolitenessError` (budget
  spent, breaker open) was caught as a navigation failure, so every remaining queued job
  was written as an `ok:false` record and `npm run qa` carried on against a throttling
  target. The worker pool (`runPool()` in `crawl.ts`) now stops every worker on the first
  refusal and writes no record for it; `crawl-status.<mode>.json` carries `refused`, the
  crawl exits 3, and `qa.ts` then skips the remaining network steps (tests, auth crawl,
  authz, pre-deploy) while still building coverage and the report.

- **Docs misstated the gate.** `ci.md`/`architecture.md` described a 4-step pipeline and a
  findings-only gate. They now list all 7 steps, state that any failed step (soft or not)
  fails the run, that deploy and authz critical/high findings do gate CI, and that
  `requestDelayMs`/`maxRequests`/the breaker are per step and do not apply to the
  Playwright suite (`config.ts` and the config editor help said "for one run").

- **Preflight requested destructive-looking assets and followed their redirects.** Page
  assets were filtered by `isAllowedUrl` only, so `<script src="/session/logout.js">` was
  fetched. Assets are now also `isDeniedUrl`-checked and probed with `redirect: "manual"`.

- **The crawl frontier enforced the deny-list but not the origin scope.** `enqueue()` relied
  on every caller to filter by origin, and `baseUrl` was enqueued unchecked. It now refuses
  anything `isAllowedUrl` rejects, so the queue is the single scope gate it claims to be.

- **Concurrent crawl navigations overspent the budget and outran the breaker.**
  `gate()` checked the budget and breaker only before waiting for the origin's slot, so N
  workers all passed while `sent` was under `maxRequests`, and a navigation queued behind
  the spacing went out after the breaker had opened. It now re-checks after the wait and
  counts in the same synchronous section, as `fetch()` already did.

### Fixed — improvement round 1

- **Crawl seeds bypassed the deny-list.** Only harvested links were deny-checked; baseUrl,
  the saved auth landing and every sitemap `<loc>` went straight into the queue, so a
  sitemap listing `/account/delete` was GET-ted. The check now sits in the queue itself
  (`createFrontier().enqueue`), and refused seeds are listed in the crawl summary.

- **The authorization scan bypassed the politeness limiter.** Its probes went out through
  a raw request context with no spacing, budget or breaker. `probe()` now waits on the
  shared client, and a refusal (breaker open, budget spent) stops the scan with an
  `inconclusive` verdict instead of comparing throttled bodies.

- **Crawler navigations never fed 429/503 back to the limiter.** They were spaced by
  `gate()` but nobody looked at the answer, so the breaker and backoff could not trip
  during a crawl. New `PoliteClient.report(url, status, retryAfter)` applies the same
  strike/breaker/backoff bookkeeping as `fetch()` without retrying; the crawler and the
  authorization probe both call it.

- **A `denyUrlExceptions` entry could exempt any route through its query string.**
  Exceptions were tested against the whole URL, so the shipped `/add_remove_elements/?$`
  exempted `/account/delete?next=/add_remove_elements/`. They now match the path only.

- **Links kept only one accessible name.** `<a aria-label="Details">Delete</a>` was judged
  on "Details" and followed. Links now carry both names, as buttons already did, and are
  withheld if either matches the deny-list.

- **The pre-deploy content scan re-fetched destructive URLs and followed redirects.** It
  checked only the origin, so a recorded `/account/delete` was requested again, and a page
  that 302s to `/logout` was followed. It now skips `isDeniedUrl` matches and fetches with
  `redirect: "manual"`; a 3xx is counted as "not followed", not scanned.

- **Email-supplied links were followed with a bare `page.goto`.** `personas.setup.ts` and
  `two-user.spec.ts` navigated to verification/invite links and other computed URLs past
  the guard. They now use `safeGoto`/`safeGotoResponse`. The persona setup's hand-built
  page gets the fixture's off-origin routing (`harden()`, now exported), and
  `lint-specs.test.ts` fails on any `goto` whose target is not a literal relative path.

- **Nested deny envelopes were read as data.** `isDenyEnvelope` counted any populated
  nested value as returned data, so `{"error":{"message":"Unauthenticated"}}` and
  JSON:API `{"errors":[{"title":"Unauthorized"}]}` were treated as the resource, which can
  fabricate IDOR findings. `error`/`errors` keys are now read as the envelope, and their
  string leaves are checked for denial wording.

- **A typo'd config key was silently ignored.** The schema stripped unknown keys, so
  `requestDelayMS` parsed cleanly and the run used the default spacing.
  `loadConfig` is now strict at the top level and in `login` and `personas[]`, which makes
  `docs/configuration.md`'s "an unknown key fails the run" true. Every shipped config
  (`qa.config.json`, `targets/*.json`) still loads.

### Fixed — safety

- **The deny-list was never applied to links.** `<a href="/users/7/delete">Delete</a>` is
  not a button, so it was inventoried as an ordinary link and then **fetched by the
  crawler itself** — the destructive action fired with nothing having "clicked" anything.
  Links are now checked by anchor text *and* URL before queueing, and recorded in a new
  `deniedLinks` field. Added `isDeniedUrl` for route-level matching.

- **`safeClick()` was dead code and bypassable.** It was called from zero specs — every
  click site used `page.getByRole(...).click()` directly — and it checked `name.source`
  rather than the element, so `safeClick(page, /Dele.e/)` sailed through and clicked
  Delete. It now resolves the locator and inspects what it actually matched
  (`aria-label`, text, `title`, `value`, `href`, enclosing `<form action>`), refuses
  ambiguous locators, and **all seven click sites in the suite now route through it**.
  Added `safeClickLink()` and `safeGoto()`.

- **Forms were never classified.** An innocuous "Continue" submitting to `/account/close`
  was inventoried as safe. `FormInfo` now carries `destructive`, derived from the action
  URL and every submit label.

- **Only one of two accessible names was checked.** `harvest()` read
  `aria-label ?? textContent`, so a `Delete` button labelled `aria-label="Confirm"` passed
  as safe. Both are now checked.

- **Unicode and spacing bypassed the deny-list.** `Ｄelete` (fullwidth), `Délete`,
  `Dele<ZWSP>te` and `Rem ove` all passed. Matching now folds NFKD → strip diacritics →
  NFKC → remove zero-width → collapse whitespace, with a second space-squashed pass.

- **False positives silently withheld safe controls.** Substring matching meant `pay`
  rejected "Repay loan" and "Payment history", and `delete` rejected "Undelete". Single-word
  terms now match on word boundaries. Multi-word terms match in any order within a window,
  so `close account` catches the route `/account/close`.

- **`isAllowedUrl` accepted userinfo.** Any URL carrying `user:pass@` is now refused
  outright, and `normalizeUrl` strips credentials — they were previously written into
  `pages.jsonl`, into screenshot *filenames* on disk, and into the CI-uploaded report.

- Added `denyUrlExceptions` so URL-level false positives are handled by narrowing one URL
  shape rather than by deleting a deny term.

### Fixed — report (stored XSS and arbitrary file read)

- **Path traversal in `thumb()`.** A record reading `"screenshot": "../.env"` caused the
  report to base64 the file into `report.html`, which CI uploaded as a 30-day artifact.
  Demonstrated end to end. Screenshot paths are now confined to `output/screenshots` and
  must carry an image extension.

- **`javascript:` URLs rendered as live links.** `esc()` escapes `&<>"` and does nothing
  to a scheme. Finding `url` and `evidence` are both rendered as anchors, and
  `findings.jsonl` is written from strings a model read off the target site. Added
  `safeHref()` — `http`, `https` and relative paths only.

- **Unescaped numeric interpolations.** `p.status` and `p.loadMs` were interpolated raw on
  the assumption they were numbers, while `normalizePage` only defaulted them with `??`.
  A `loadMs` of `0</td><td><img src=x onerror=...>` was live HTML injection. Every field
  is now coerced to its declared type and every interpolation escaped.

- Findings with an unrecognised `severity` matched no bucket and vanished from the report
  entirely; they now render as `medium`. Pages are deduped by URL keeping the last record.
  `esc()` now also escapes `'`.

### Fixed — Burp export

- **`responselength` was wrong on every item.** Measured against a real Burp export:
  Burp writes the length of the **whole raw message** (`rl=460, msg=460, body=43`); this
  wrote the body length. The README's "matches it exactly" claim was false. Now corrected,
  and `readHistory()` recomputes the value for existing captures so nothing needs
  re-recording.

- **One illegal byte destroyed the entire export.** A control character in a URL made the
  whole file unparseable (`System.Xml: hexadecimal value 0x01, is an invalid character`)
  with no partial recovery. Control characters and lone surrogates are now stripped.

- **Attribute injection.** `xmlText()` does not escape quotes but was used for the
  `host@ip` attribute, so an ip of `1" evil="y` produced a second attacker-chosen
  attribute. Added a separate `xmlAttr()`.

- **Numeric fields were interpolated raw.** `export:burp` reads a file this process may
  not have written; a status of `200</status><x>` landed in the document verbatim. All
  numeric fields are coerced.

- **Truncated bodies kept their original `Content-Length`**, producing a message no HTTP
  parser can read. Truncation now rewrites the header and adds an `X-QA-Agent-Truncated`
  marker; `Content-Encoding` is dropped since Playwright returns a decoded body. The JSONL
  records `truncated` and `fullBodyLength`.

- **In-flight captures were lost at teardown.** `response.body()` throws once the context
  closes and the failure was swallowed by design, so the last exchanges of every run went
  missing silently. Added `drainHistory()`, awaited before teardown.

- `extensionOf` now returns `"null"` for a path ending in a bare dot.

### Fixed — crawler correctness

- **A write failure dropped an entire link subtree.** `appendFileSync` ran before the
  enqueue loop inside the same `try`, so one `ENOSPC` lost the page *and every page
  reachable only through it*, logged a single `CRASH` line, and exited 0. Discovered links
  are now enqueued first, and a write failure is fatal.

- **Failed navigations poisoned the resume ledger.** A page that timed out once was
  recorded as done and never retried — silently gone from the inventory for good. Records
  now carry `ok`, and only successful visits seed the resume set.

- **`templateOf` collapsed query values**, so `?page=1` … `?page=50` were one shape and
  the 3-samples cap crawled three of them — every paginated and faceted section reported
  as covered. Query values are now part of the template.

- The record's `template` used `templateOf(url)` while the budget counted
  `templateOf(dedupKey(url))`, so the two disagreed on any trailing slash. Unified.

- Added `maxRuntimeMs` (default 30 min). `active` only decrements in a `finally`, so a
  hung visit kept every other worker polling indefinitely. Added 20s timeouts to
  `harvest()` and the screenshot, and a duplicate-record guard.

### Fixed — email

- **`extractCode` returned digits from the verification URL.** On the single most common
  email shape — `<a href="https://x/verify/998877">Verify</a> … Your code: 314159` — it
  returned `998877`, because "verify" sits one character before the wrong digits. HTML,
  attributes, URLs, entities and CSS lengths are now stripped before scoring.

- **`extractCode` could never say "I don't know."** Any 4–8 digit run won, so
  `123456 Main Street` in a footer came back as a verification code. Added a minimum
  score threshold; it returns `null` below it.

- **`extractLinks` returned the tracking pixel.** Document order meant `links[0]` — which
  is exactly what `get_verification_link` returns — was reliably the header logo or open
  tracker. Links are now ranked: action words up, unsubscribe/tracking/image down, ties
  fall back to document order. Anchor text is parsed alongside the href so it can score.

- **mail.tm token expiry looked like "no email ever arrived."** A `401` was swallowed into
  `lastError` and surfaced only as a 90-second timeout. The provider now re-authenticates
  and retries. Tags are sanitised (an invalid tag produced an unexplained `422`) and
  address collisions retry with a suffix.

### Fixed — CI and pipeline

- **The authenticated crawl was skipped on every CI run, forever.** `crawl (auth)` was
  ordered before `playwright test`, whose `setup` project is what writes
  `output/auth/state.json` — so a fresh checkout always reported a clean skip. Reordered.

- **Playwright traces were uploaded as an artifact.** Traces record every request headers
  included, so they carry the session cookie; `retain-on-failure` plus `if: always()`
  means they are produced exactly when they are uploaded. `output/test-results` and
  `pw-report/data` are now excluded, retention cut to 14 days.

- **Secrets were job-scoped**, so they were also in the environment of `npm ci` where any
  dependency's install script could read them. Scoped to the step that needs them, and
  `npm ci --ignore-scripts` added. (`allowScripts` in `package.json` has no effect under
  plain `npm ci`.)

- The findings gate reads a gitignored file that never exists in CI, so it could never
  fire while printing a reassuring `0`. It now says so explicitly.

- Cache key gained `runner.arch`; `playwright install` runs unconditionally so a partial
  cached browser directory repairs itself. Added a `concurrency` group and read-only
  `permissions`.

- Pinned `@playwright/mcp@0.0.82` — it was `@latest` with `-y`, executed automatically at
  session start in a browser holding a live session.

### Documentation

- Added `docs/` — architecture, configuration, safety, data formats, email, Burp export,
  CI, development, troubleshooting.
- Corrected the Burp parity claim in the README to state what was actually measured.
- Documented that the HTTP capture and traces contain live credentials. The README
  previously discussed the capture at length and worried only about file size.
- `safety.md` states the deny-list's real limits: it is a vocabulary (no `Supprimer`, no
  `Löschen`), it is evaluated at harvest time only, and it does not wrap the MCP browser.
- `CLAUDE.md` gained rules matching the new code paths.

### Known issues

- **`output/pages.jsonl` holds 64 records for `maxPages: 60`, with 4 URLs recorded
  twice** — each pair a `status: null` failure followed by a clean 200 ~30s later, inside
  a single run. The `queued` set should make that impossible and the mechanism was not
  isolated. A duplicate-suppression guard was added and the budget now counts records
  written rather than attempts, but the root cause is **unresolved**.

- The Playwright suite could not be run during remediation: the demo target
  (`the-internet.herokuapp.com`) was unresolvable. Specs are typechecked and the guards
  are verified against a local page; the suite needs one green run when the host returns.

## Multi-user testing and the authorization scan

Added after the deploy-readiness work, to cover the bug class a single session cannot
reach at all.

### Personas

Durable test identities. Each has a stable mailbox, a site password and its own saved
browser session (`output/auth/state.<id>.json`), declared in `qa.config.json`:

```json
"personas": [
  { "id": "alice", "role": "owner" },
  { "id": "bob",   "role": "member" }
]
```

Identities persist in `output/auth/personas.json` and are reused across runs. That is not
an optimisation: if the address changed every run, an invitation sent yesterday would
arrive at a mailbox nobody reads, and "accept the invitation" could never be tested end to
end. The store self-discards when `baseUrl` or the email provider changes.

**This required fixing a real limitation.** A mail.tm mailbox previously died with the
process that created it — the password only ever lived in memory — so a persona could have
received exactly one email, ever. `createInbox()` now returns the mailbox secret and
`restoreInbox()` reopens it.

### Fixtures

`openAs()`, `withTwoUsers()` and `openAnonymous()` in `tests/fixtures.ts`. Each persona
gets its own `BrowserContext`, not merely its own page — two pages in one context share a
cookie jar, and the test would pass while proving nothing. `two-user.spec.ts` asserts the
two session cookies actually differ, which is the guard against that.

`openAnonymous()` covers the third identity every permission test needs. Protected from
other users but public to the internet is a real and common bug.

### Authorization scan — `npm run authz`

Re-requests every page the authenticated crawl reached, with no cookies and as the other
persona. A protected page answering a signed-out request is `critical`; the same page
coming back for a different user is `high`. GET only; deny-listed URLs are skipped.

Two guards exist because both failures happened while building it:

- **It will not report a clean result it did not earn.** Above 25% request failures it
  exits `SCAN INCONCLUSIVE`. DNS went down mid-development, every probe failed, and the
  scan reported "No cross-user access problems found" for a run that never reached the
  site once. Silence must never read as safety.
- **It detects two personas that are secretly one account.** Comparing session cookies is
  not sufficient — one account logged in twice yields two different cookies — so the check
  is on the configured `username`. Without it the demo target produced a page of confident
  false positives: every "bob can reach alice's page" true, and all of them worthless.

### Also

- `auth.setup.ts` login given a 180s budget and the per-test timeout raised to 240s. The
  setup project gates every other spec, so one slow response reported as "27 tests did not
  run" and looked like a broken suite.
- Unit tests: 48, up from 38.

## Coverage: 17% -> 56%, and the bug that was blocking every run

### The suite could not run, and it was never the host

`.env` contained `TEST_PASSWORD=` — an empty string — and `??` only falls back on `null`
or `undefined`. The login therefore submitted a **blank password**, sat on `/login`, and
`waitForURL(/\/secure$/)` timed out. The setup project gates every other spec, so this
reported as "32 tests did not run".

It was misdiagnosed twice as a slow demo host and survived two timeout increases (90s ->
180s, per-test 120s -> 240s). Neither could ever have fixed it. The persona setup passed
throughout, because personas take their password from `qa.config.json`, not the environment
— that contrast was the clue.

The same pattern existed in four places, including `src/email/lib.ts`, where an empty
`EMAIL_PROVIDER` would have selected no provider at all. All now go through `env()` in
`src/config.ts`, which treats empty as absent.

### Two measurement bugs were inflating the gap

- **404s counted in the denominator.** `/about`, `/gallery`, `/users/:id` are pages the
  crawler followed from a randomised menu and that do not exist. A page that 404s is not an
  untested page. Denominator 64 -> 54.
- **Anonymous forms could never be credited.** Coverage keyed on a form's `action` or a
  field `name`; `/checkboxes` has neither, so it stayed listed as untested *after* a spec
  was written for it — permanently uncoverable. Such forms are now credited when a spec
  visits their page, with a test asserting that forms which DO offer something to match are
  still not credited that cheaply.

### 37 new tests

`tests/forms.spec.ts`, `tests/interactions.spec.ts`, `tests/structure.spec.ts`: upload
round-trip and unicode filenames, checkbox state and keyboard operation, hovers, HTML5
drag-and-drop, slider bounds, all three dialog types with explicit handlers, popup windows,
nested frames, shadow DOM, table sorting, async loading, infinite scroll, status codes,
flash-message lifecycle.

| | before | after |
|---|---|---|
| templates | 17% (9/54) | 56% (30/54) |
| forms | 43% (3/7) | 100% (7/7) |
| controls | 30% (9/30) | 50% (15/30) |
| Playwright tests | 28 | 72 |
| unit tests | 48 | 53 |

Suite: 68 passed, 4 skipped, 0 failed, 3.7 min.

### Two findings from writing the tests

- **F-010 (high)**: `/upload` with no file selected returns HTTP 500 rather than a
  validation message. Captured as `test.fail()`.
- `/notification_message_rendered` visited directly shows an empty flash container; the
  flash exists only via the redirect that sets it. Asserted both ways.

### One honest non-finding

The TinyMCE editor on `/iframe` never initialises because it loads from `cdn.tiny.cloud`,
which fails with **and** without the off-origin block — unreachable from this network. That
test skips with a stated reason rather than failing red: an unmet precondition is not a
defect, and red tests that people learn to ignore are worse than no tests.

## The audit loop: rounds 1-7

A repeating build → audit → fix cycle, where each round's auditor is pointed at the
PREVIOUS round's fixes. It has been worth running, and the reason is uncomfortable: every
audit found real defects in code that had just been called done, and twice it found the
defects were *in the fixes*.

| Round | Found |
|---|---|
| 1 | 5 critical/high: crawler concurrency collapsed to 1, sitemap seeds all discarded, path traversal in the report, `javascript:` hrefs, CI auth crawl never ran |
| 3 | 3 of those 5 fixes had introduced NEW defects, 2 worse than the originals |
| 6 | the previous commit's headline fix had never been applied at all; the login classifier had regressed a second time; the new lint was evadable 4 ways out of 5 |

### What the loop actually exposed

**A fix is not evidence of a fix.** In round 6 a `node -e` string replacement failed
silently, so the per-mode capture split was assigned to a variable nothing read - while the
commit message described it as done. Worse than a no-op: the crawler then *printed* the new
filename while writing the old one, so the tool lied about where session cookies were
going. Three separate edits were silently corrupted by shell escaping across the session.
Nothing containing a regex or a quote goes through `node -e` any more, and every edit is
grepped before it is claimed.

**Overshooting is as likely as undershooting.** Round 1 found a lock that could be stolen
when its file was empty. The fix made an empty lock *immortal* - one truncated byte and the
crawler refused forever. Round 1 found a login classifier that suppressed most of a site;
the fix made it *fabricate* critical findings on any login page carrying a sign-up link.
Both replacements were confidently commented as correct.

**"Pinned by a test" was repeatedly false.** The login classifier regressed twice while its
commit messages claimed tests existed. There was exactly one fixture - a bare login form -
which happened to be the one shape that still worked. It now pins 19 shapes, taken from the
audit's own reproducing table.

**A guard with no compliant path gets bypassed.** CLAUDE.md forbids bare `.click()`, and ten
violations had accumulated - most of them because `safeClick` could only address a button by
role and name. A table header, a hot-spot div and a right-click had no guarded form at all.
Adding `safeClickLocator` and `safeRightClick` removed the incentive; a lint test now fails
the build on a new one, and its own evasions are tested.

### The practice that is working

Not the loop by itself - the narrower rule inside it: **every fix gets a test derived from
the audit's reproducing input, written before moving on.** That is why the classifier has 19
pinned shapes instead of one, why the lock has regression tests for both directions of its
two failures, and why the lint has tests for the evasions that defeated its first version.

Unit tests: 17 → 106 over the loop. All offline, no browser, no network, ~3s.
