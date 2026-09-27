# QA Agent

Autonomous website tester. A plain Node/Playwright crawler does the repetitive work;
Claude is used only for judgment — understanding features, designing test cases, and
diagnosing bugs. Everything it learns is written back out as a normal Playwright suite
that runs with no AI cost.

```
crawl (script)  ->  explore (Claude)  ->  suite (script)  ->  report (script)
   fast, free        the thinking         fast, free          fast, free
```

**Full documentation: [`docs/`](docs/README.md)** — [architecture](docs/architecture.md) ·
[configuration](docs/configuration.md) · [safety](docs/safety.md) ·
[data formats](docs/data-formats.md) · [email](docs/email.md) ·
[Burp export](docs/burp-export.md) · [CI](docs/ci.md) ·
[development](docs/development.md) · [troubleshooting](docs/troubleshooting.md)

> Read [docs/safety.md](docs/safety.md) before pointing this at anything you care about.
> It is specific about what the guardrails cover and what they provably do not.

## Setup

```bash
npm install
npx playwright install chromium
```

Then point `qa.config.json` at your site:

```json
{
  "baseUrl": "https://staging.example.com",
  "allowedOrigins": ["https://staging.example.com"]
}
```

Only test a site you own or have permission to test — ideally staging, with fake data.

### Email

Signup flows need a mailbox. Two backends, selected by `emailProvider` in
`qa.config.json` or `EMAIL_PROVIDER` in `.env`:

| Provider | Setup | When to use |
|---|---|---|
| `mailtm` (default) | none | Default. Real disposable addresses, no credentials. |
| `imap` | Gmail + App Password | When the site rejects disposable domains. |

For `imap`, use a **dedicated** Gmail account, not your personal one: the app password in
`.env` grants full IMAP read of that mailbox. Enable 2-Step Verification, create an App
Password, enable IMAP, then fill `.env`:

```
GMAIL_USER=
GMAIL_APP_PASSWORD=
TEST_PASSWORD=
```

Check it works:

```bash
npm run email:selftest      # connects, mints an address
npm run email:wait          # prints an address, waits for a real message
```

## Commands

| Command | What it does |
|---|---|
| `npm run crawl` | Crawl anonymously → `output/pages.jsonl` + screenshots |
| `npm run crawl:auth` | Crawl logged in → `output/pages.auth.jsonl` |
| `npm test` | Run the Playwright suite |
| `npm run report` | Build `output/report.html` |
| `npm run export:burp` | Rebuild `output/http-history.xml` from the captured exchanges |
| `npm run qa` | All of the above, in order |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:unit` | Offline regression tests for the guards, URL handling, XML export and email parsing. No browser, no network. |

Tuning that matters against a small or slow target:

```json
"concurrency": 4,      // crawler workers
"testWorkers": 2,      // Playwright workers - the SITE is usually the bottleneck
"navTimeoutMs": 90000
```

Six Playwright workers against this demo host made every test time the others out; two
finished the same suite. More workers only helps when your machine is the constraint.

`npm run qa` continues to the report even when tests fail, and exits non-zero if any
critical/high finding is recorded in `output/findings.jsonl`.

Note what that does **not** mean in CI. `output/` is gitignored, so a fresh checkout has
no `findings.jsonl` and the gate has nothing to read — the pipeline says so explicitly
rather than printing a reassuring `0`. To gate a nightly run on findings, restore that
file into the workspace first (cache it, or commit a reviewed copy elsewhere).

Step order matters and is not arbitrary: `playwright test` runs **before** the
authenticated crawl, because its `setup` project is what writes
`output/auth/state.json`. Ordered the other way, a fresh checkout skipped the
authenticated crawl on every single run and reported it as a clean skip.

## HTTP history (Burp / ZAP)

With `captureHttpHistory` on, the crawl doubles as a proxy capture. Every
request/response pair is reconstructed as a raw HTTP message and written twice:

- `output/http-history.jsonl` — appended per exchange, so an interrupted crawl still
  leaves a readable file.
- `output/http-history.xml` — Burp Suite proxy-history schema, serialized at the end
  (XML needs its closing root tag, so it cannot be appended safely).

Import via Burp's **Proxy → HTTP history → right-click → Import items**, or load it in any
tool that reads that format.

The output was diffed against a real Burp export. What was verified, specifically:

- prolog and DOCTYPE are **byte-identical**, CRLF line endings included
- same 14 elements in Burp's order, same `host@ip` / `request@base64` / `response@base64`
  attributes
- CDATA on exactly the five fields Burp wraps (`url`, `method`, `path`, `request`,
  `response`); `time`, `host`, `protocol`, `extension`, `mimetype` are plain escaped text
- `<time>` and `exportTime` in Java's `Date.toString()` form — `Thu May 14 14:15:07 EEST
  2026`, local time with a zone abbreviation, not ISO 8601
- `<responselength>` is the length of the **whole raw response message**, headers
  included — which is what Burp writes. (This was wrong until it was measured against the
  reference file rather than assumed: it used to be the body length, short by the header
  block on every single item.)

Raw messages preserve what the server actually sent, including a missing reason phrase
(`HTTP/1.1 404 `) where one is absent.

Two places where the export deliberately does **not** reproduce the bytes on the wire,
because reproducing them would produce a message no parser can read:

- a body truncated at `captureMaxBodyBytes` gets its `Content-Length` rewritten to the
  truncated size and an `X-QA-Agent-Truncated` header recording the original;
- `Content-Encoding` is dropped, since Playwright hands back an already-decoded body.

Characters XML forbids (control bytes, lone surrogates) are stripped at serialisation
time. One such byte in one URL otherwise makes the entire file unparseable, with no
partial recovery — the failure lands at import, long after the crawl.

```json
{
  "captureHttpHistory": true,
  "captureMaxBodyBytes": 2000000,
  "captureOffOrigin": false
}
```

`captureOffOrigin: false` keeps the capture scoped to `allowedOrigins` — otherwise every
CDN and tracker ends up in the file. Bodies past `captureMaxBodyBytes` are truncated;
`truncated` and `fullBodyLength` in the JSONL record what was dropped.

> **The capture contains credentials.** It is a verbatim record of every request,
> including `Cookie` and `Authorization` headers — on a `crawl:auth` run that is your live
> session. Treat `output/http-history.*` exactly as you would treat the session itself:
> never attach it to a ticket, never upload it as a CI artifact, never commit it. The
> supplied workflow excludes it, and excludes Playwright traces for the same reason.

**Budget for the size.** A full 60-page crawl produced **469 exchanges → 70 MB**, about
152 KB each, and the JSONL and XML each hold a full copy. Capture is therefore off by
default: turn it on for a run you actually intend to analyse, and drop
`captureMaxBodyBytes` (say 200000) if you only need headers and small payloads. Don't
enable it in CI without also lowering that, or every nightly run uploads a 70 MB artifact.

## The phases

Each phase is its own Claude session — `/clear` between them.

| Phase | What happens | Output |
|---|---|---|
| 0 | Project, config, `CLAUDE.md` rules | scaffolding |
| 1 | Email provider + MCP server | `src/email/` |
| 2 | Register Playwright + Email MCP | `.mcp.json` |
| 3 | Crawler | `output/pages.jsonl` |
| 4 | Signup / verify / login, saved session | `output/auth/state.json` |
| 5 | Claude explores features and logs bugs | `findings.jsonl`, `features.jsonl` |
| 6 | Turn exploration into specs | `tests/*.spec.ts` |
| 7 | HTML report | `output/report.html` |
| 8 | One command + CI | `npm run qa` |

### Known-bug tests

Phase 6 writes a test for every finding that asserts the **correct** behaviour and marks it
`test.fail()` with the finding id in a comment. Playwright reports it as expected-to-fail
while the bug exists, and the suite starts failing — correctly — the moment someone fixes
it. You never have to remember to go back and re-enable anything.

Against the demo target that is 9 such tests out of 28.

Phase 5 is the only expensive one. It checkpoints to `output/progress.json`, so if a
session gets long you can `/clear` and rerun the same prompt to resume.

## Guardrails

`CLAUDE.md` holds the rules Claude follows every session. The two that matter most are
enforced by code, not just written down — both live in `src/config.ts` and are called at
the points where they can actually refuse something:

- **`isAllowedUrl`** — the crawler's scope gate; nothing outside `allowedOrigins` is
  queued or visited.
- **`isDenied` / `isDeniedUrl`** — applied at four points, not one:
  - **buttons** are split out of the inventory into `deniedButtons`. Both candidate names
    are checked — `aria-label` *and* visible text — so a "Delete" button labelled
    `aria-label="Confirm"` cannot pass as safe.
  - **links** are checked before they are queued, by anchor text *and* by URL. This is the
    one that matters most: `<a href="/users/7/delete">Delete</a>` is not a button, so it
    used to be inventoried as an ordinary link and then **fetched by the crawler itself**.
  - **forms** carry a `destructive` flag derived from the action URL and the submit
    labels, so an innocuous "Continue" posting to `/account/close` is visible as what it is.
  - **`safeClick()` / `safeClickLink()` / `safeGoto()`** in `tests/fixtures.ts` are what
    every spec uses; a raw `.click()` in a generated spec is a bug. The check runs against
    the element the locator *resolved to* — its aria-label, text, title, value, href and
    enclosing form action — not against the selector text. Checking the selector meant
    `safeClick(page, /Dele.e/)` sailed through and clicked Delete.

  Matching is Unicode-folded (NFKD + diacritic strip + NFKC), zero-width characters are
  removed and spacing is collapsed, so `Ｄelete`, `Délete`, `Dele‌te` and `Rem ove` all
  match. Single-word terms match on word boundaries, so `pay` no longer rejects "Repay
  loan" or "Payment history".

On the demo target this catches the **Remove** button on `/dynamic_controls` while
leaving **Enable** available.

Because URL matching has false positives (this target has a page genuinely called
`/add_remove_elements/`), `denyUrlExceptions` grants exemptions one URL shape at a time.
Use it rather than removing a term from `denyList`.

Residual gaps, stated plainly:

- The deny-list is a **vocabulary**, and it only knows the words in it. It will not catch
  `Supprimer`, `Löschen`, or any label in a language you have not configured. If your
  target is not in English, the list is empty in practice until you fill it in.
- It is evaluated against the DOM **at harvest time**. A control rendered later — inside a
  modal, behind a click, by a late script — is never classified.
- During Phase 5 the model drives the Playwright MCP browser directly and nothing wraps
  that tool call. Withholding destructive labels from the inventory removes the realistic
  path to one, but it is not a hard interlock.

Run against staging with disposable data. This is a guard rail, not a seat belt.

## Writing tests for a slow site

Three patterns in `tests/fixtures.ts` exist because of real failures, not theory:

- **Every off-origin request is blocked.** A named block-list only catches the trackers you
  thought of; any other third-party host whose DNS stalls holds the page open for tens of
  seconds. Nothing outside `allowedOrigins` is under test, so nothing outside it is worth
  waiting for. This took test setup from a 120s timeout to 26s. Set `captureOffOrigin: true`
  if you genuinely need third parties.

  Note the implementation detail: the route uses a **URL predicate**, not `"**/*"`. A
  catch-all that ends in `route.continue()` proxies every same-origin request through Node
  and costs more than the trackers did — measured at 356s → 727s on the same crawl.

- **Navigations default to `domcontentloaded`.** Playwright's default `load` waits for
  every image and third-party script; one unresolvable tracker turns into a navigation
  timeout that has nothing to do with your site.
- **`submitAndWait(page, click, "/endpoint")`** waits for the form's POST response.
  `waitForURL` is unreliable for form errors: a rejected login re-renders the *same* URL,
  so it matches instantly and the assertion then races the in-flight navigation.

## When to rerun what

| Situation | Run |
|---|---|
| Nightly / every deploy | `npm run qa` — no AI |
| New feature shipped | Phase 5 for that feature, then Phase 6 |
| Tests broke after a UI change | Ask Claude to update the locators in that spec |
| New site | Start from Phase 0 with a fresh config |
