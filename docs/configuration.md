# Configuration

Three files. `qa.config.json` is the one you edit; `.env` holds secrets; `.mcp.json`
registers the MCP servers Claude uses.

## qa.config.json

Validated by a Zod schema in `src/config.ts` at load time. **An unknown or malformed key
fails the run immediately** rather than being silently ignored — if the process starts,
the config parsed.

### Scope

| Key | Type | Default | What it does |
|---|---|---|---|
| `baseUrl` | string | *required* | Where the crawl starts and what `page.goto("/x")` resolves against. |
| `allowedOrigins` | string[] | *required* | **The scope gate.** Compared against `new URL(u).origin`, exactly — scheme, host and port all have to match. Nothing outside this is queued, visited, or captured. |
| `include` | string[] | *required* | Regexes; a URL must match at least one. `[".*"]` for everything. |
| `exclude` | string[] | *required* | Regexes; a URL matching any is skipped. Applied after `include`. |

`allowedOrigins` is an exact origin match, which has consequences worth knowing:

- `https://site.com` does **not** allow `http://site.com` (scheme) or
  `https://site.com:8443` (port). It does allow `https://site.com:443`, since that is the
  default port and `URL` normalises it away.
- It does **not** allow `https://www.site.com`. List both if you need both.
- `https://site.com.evil.com` and `https://site.com@evil.com` are correctly rejected. Any
  URL carrying userinfo is rejected outright.
- Sitemap seeds get one fix-up: if a seed differs from `baseUrl` **only** by scheme, the
  scheme is realigned. Sitemaps very often list `http://` URLs for an `https://` site, and
  without this every seed would be discarded.

Use `exclude` for anything that logs you out, costs money, or is a rabbit hole:

```json
"exclude": ["/logout", "/download", "\\.pdf$", "/status_codes/"]
```

### Budget

| Key | Type | Default | What it does |
|---|---|---|---|
| `maxPages` | int > 0 | *required* | Cap on the **inventory**, counting pages from previous runs. Not a cap per invocation. |
| `maxDepth` | int > 0 | *required* | Link hops from the seed. |
| `concurrency` | int > 0 | *required* | Crawler workers sharing one browser context. |
| `navTimeoutMs` | int > 0 | *required* | Per-navigation timeout. |
| `maxRuntimeMs` | int > 0 | `1800000` | **Wall-clock cap on the whole crawl.** Without it a single hung page keeps every worker polling indefinitely. |
| `testWorkers` | int > 0 | half the CPUs | Playwright workers. |

On `testWorkers`: **the site is usually the bottleneck, not your machine.** Six workers
against the demo host made every test time the others out; two finished the same suite.
More workers only helps when your machine is the constraint.

There is also a hard cap of **3 samples per template** (see `templateOf` in
[architecture.md](architecture.md#scope-and-dedup)). It is not configurable, on the theory
that if you need a fourth sample of the same page shape you want a different test, not a
bigger crawl.

### Safety

| Key | Type | Default | What it does |
|---|---|---|---|
| `denyList` | string[] | *required* | Terms that mark a control or URL destructive. See [safety.md](safety.md). |
| `denyUrlExceptions` | string[] | `[]` | Regexes for paths that *look* destructive but are not. Matched against the URL's **path only** — never the host, query string or fragment. |
| `blockDomains` | string[] | *required* | Only consulted when `captureOffOrigin` is true; otherwise everything off-origin is blocked anyway. |

`denyUrlExceptions` exists because URL matching has false positives. The demo target has a
page genuinely called `/add_remove_elements/`, which contains "remove":

```json
"denyUrlExceptions": ["/add_remove_elements/?$"]
```

**Use this rather than deleting a term from `denyList`.** Narrowing one URL shape is a
decision you can review; removing "remove" from the deny-list disables it everywhere.

### HTTP capture

| Key | Type | Default | What it does |
|---|---|---|---|
| `captureHttpHistory` | bool | `false` | Record every request/response as Burp-importable proxy history. |
| `captureMaxBodyBytes` | int > 0 | `2000000` | Truncate any single body past this. |
| `captureOffOrigin` | bool | `false` | Also record (and load) third parties. |

Off by default because it is expensive and sensitive. A full 60-page crawl produced
**469 exchanges → 70 MB**, and the JSONL and XML each hold a full copy. See
[burp-export.md](burp-export.md).

`captureOffOrigin` does double duty: it is also what decides whether third-party requests
are **blocked**. With it `false`, nothing off-origin loads at all — which is the single
biggest speed win in this tool.

### Email

| Key | Type | Default | What it does |
|---|---|---|---|
| `emailProvider` | `"mailtm"` \| `"imap"` | `"mailtm"` | Mailbox backend. Overridden by `EMAIL_PROVIDER` in `.env`. |
| `emailPattern` | string | *required* | Plus-address template for the `imap` provider. Placeholders: `{GMAIL_LOCAL}`, `{runId}`, `{n}`. |

See [email.md](email.md).

### A complete example

```json
{
  "baseUrl": "https://staging.example.com",
  "allowedOrigins": ["https://staging.example.com"],
  "include": [".*"],
  "exclude": ["/logout", "/admin/danger", "\\.pdf$"],

  "maxPages": 60,
  "maxDepth": 6,
  "concurrency": 4,
  "navTimeoutMs": 90000,
  "maxRuntimeMs": 1800000,
  "testWorkers": 2,

  "denyList": ["delete", "remove", "deactivate", "close account", "pay", "checkout"],
  "denyUrlExceptions": [],
  "blockDomains": ["google-analytics.com", "googletagmanager.com"],

  "captureHttpHistory": false,
  "captureMaxBodyBytes": 2000000,
  "captureOffOrigin": false,

  "emailProvider": "mailtm",
  "emailPattern": "{GMAIL_LOCAL}+{runId}-{n}@gmail.com"
}
```

## .env

Never committed (`.gitignore` covers it), never printed. `CLAUDE.md` instructs the model
to refer to these by name only.

```
GMAIL_USER=              # only for the imap provider
GMAIL_APP_PASSWORD=      # only for the imap provider
TEST_PASSWORD=           # the login password used by tests/auth.setup.ts
EMAIL_PROVIDER=          # optional; overrides qa.config.json
```

`TEST_USERNAME` is also read by `tests/auth.setup.ts`, defaulting to the demo
credentials.

> The Gmail app password grants **full IMAP read** of that mailbox. Use a dedicated
> account, never your personal one.

## .mcp.json

Two MCP servers.

**playwright** — the browser Claude drives during Phase 5. Notable flags:

| Flag | Why |
|---|---|
| `--isolated` | No profile persistence between sessions. |
| `--storage-state=output/auth/state.json` | Starts logged in, using the session the test setup saved. |
| `--blocked-origins=...` | Tracker block-list for the MCP browser (the crawler and the test fixture block *everything* off-origin; the MCP browser uses a named list because the model may legitimately need to look at a third party). |
| `--image-responses=omit` | Screenshots are not returned into context unless asked for. Keeps the phase cheap. |
| `--block-service-workers` | Service workers make navigation non-deterministic. |

The package is **version-pinned** (`@playwright/mcp@0.0.82`). It is not `@latest`: this
runs automatically at session start with `-y`, in a browser holding a live session, so an
unpinned remote package is both a reproducibility and a supply-chain problem.

**email** — `tsx src/email/mcp-server.ts`, the read-only mailbox server. See
[email.md](email.md#the-mcp-server).

## CLAUDE.md

Not configuration exactly, but it is the rules file Claude loads every session: scope,
the deny-list, never echoing `.env`, preferring the accessibility tree over screenshots,
never re-discovering what a script already produced, and checkpointing to
`progress.json`. Edit it when you change a policy you want the model to follow.
