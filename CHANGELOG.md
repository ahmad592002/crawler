# Changelog

## Unreleased — adversarial audit remediation

An adversarial review of the whole codebase. Each item below is a defect that was
**demonstrated by running code**, not a theoretical concern, and each has a regression
test in `src/guards.test.ts` (17 tests, offline, wired into CI as `npm run test:unit`).

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
