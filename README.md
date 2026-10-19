# QA Agent

Autonomous website tester. A plain Node/Playwright crawler does the repetitive work;
Claude is used only for judgment — understanding features, designing test cases, and
diagnosing bugs. Everything it learns is written back out as a normal Playwright suite
that runs with no AI cost.

```
crawl (script)  ->  explore (Claude)  ->  suite (script)  ->  report (script)
   fast, free        the thinking         fast, free          fast, free
```

> **Only point this at a site you own or have written permission to test**, ideally a
> staging copy with disposable data. The guardrails are real but incomplete — read
> [docs/safety.md](docs/safety.md) before the first run against anything you care about.

## Quickstart

```bash
npm install
npx playwright install chromium
```

Point `qa.config.json` at your target:

```json
{
  "baseUrl": "https://staging.example.com",
  "allowedOrigins": ["https://staging.example.com"]
}
```

Then:

```bash
npm run crawl        # inventory the site
npm test             # run the suite
npm run report       # open output/report.html
```

Signup flows need a mailbox. The default provider (`mailtm`) needs no credentials at all —
see [docs/email.md](docs/email.md) if your site rejects disposable domains.

## Commands

| Command | What it does |
|---|---|
| `npm run crawl` | Crawl anonymously → `output/pages.jsonl` + screenshots |
| `npm run crawl:auth` | Crawl logged in → `output/pages.auth.jsonl` |
| `npm test` | Playwright suite |
| `npm run test:unit` | Offline regression tests — no browser, no network |
| `npm run predeploy` | Pre-deploy hygiene scan — what you forgot to remove |
| `npm run authz` | Cross-user authorization scan — IDOR and signed-out access |
| `npm run coverage` | What the crawl found that nothing tests |
| `npm run panel` | **Control panel** at `http://127.0.0.1:7777` — edit every setting, run the crawler from buttons, watch pages stream in live (and optionally the browser window), and see the MCP tools Claude uses |
| `npm run summary` | Write `output/summary.md` + a scoped nuclei command plan per endpoint category |
| `npm run diagnose` | Read a finished run and print the verdict + ranked retry actions (the core of `/autorun`) |
| `npm run report` | Build `output/report.html` (now opens with an executive summary and the nuclei plan) |
| `npm run export:burp` | Rebuild `output/http-history.xml` from the capture |
| `npm run deepscan` | Nuclei deep scan. `--engine official` (default) prints the scoped official-template plan; `--engine custom`/`both` feed the capture to the CyberSecurity generator for target-specific templates + triage (see below) |
| `npm run qa` | Everything, in order |
| `npm run typecheck` | `tsc --noEmit` |

### Deep scan — official templates, your own generated ones, or both

`npm run deepscan` picks the nuclei engine with `--engine`:

| `--engine` | What runs | Needs |
|---|---|---|
| `official` *(default)* | The built-in scoped per-category plan — **official nuclei templates only, no custom generation.** Prints the commands; never executes them. | nothing extra |
| `custom` | Feeds this run's `output/http-history.xml` to the **CyberSecurity** template-generator project to build target-specific attack templates (BOLA/auth/JWT/injection/XSS/…), scans with **only those**, then triages with confidence scoring. | `customEngine.projectPath` in `qa.config.json` |
| `both` | `custom` **+** the official library together, triaged as one set. | same |

```jsonc
// qa.config.json
"customEngine": { "projectPath": "C:/path/to/CyberSecurity/...pentesting-config-context" }
```

```bash
npm run crawl && npm run export:burp      # produce output/http-history.xml
npm run deepscan -- --engine both         # crawl → custom templates + official → scan → triage
npm run deepscan -- --engine official     # or just the official plan, unchanged
npm run deepscan -- --engine custom --dry-run   # show the exact commands without running
```

Only `baseUrl` (which must be in `allowedOrigins`) is handed to the scanner, and the capture is
passed by path — its contents (live cookies) are never printed into reports. The triage report
lands under the CyberSecurity project; `output/deepscan.md` points to it.

`npm run qa` continues to the report even when tests fail — a failing suite is when you
most want the report — and exits non-zero on any critical/high finding.

## The phases

Each phase is its own Claude session; `/clear` between them. Only Phase 5 costs real
tokens, and it checkpoints so it can be resumed across sessions.

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

For each finding, Phase 6 writes a test asserting the **correct** behaviour and marks it
`test.fail()`. It reads as expected-to-fail while the bug exists and starts failing —
correctly — the day someone fixes it. Nothing to remember to re-enable.

## Documentation

| Page | Read it when |
|---|---|
| [docs/architecture.md](docs/architecture.md) | You want to know what runs, in what order, and why |
| [docs/agents.md](docs/agents.md) | Running the Claude agent team (`/qa-team`), one agent per step |
| [docs/configuration.md](docs/configuration.md) | Pointing at a new site, or a knob isn't behaving |
| [docs/safety.md](docs/safety.md) | **Before running against anything you care about** |
| [docs/data-formats.md](docs/data-formats.md) | Reading `output/*.jsonl` or writing a consumer |
| [docs/multi-user.md](docs/multi-user.md) | Two-user features, personas, and the authorization scan |
| [docs/email.md](docs/email.md) | Testing a signup or verification flow |
| [docs/burp-export.md](docs/burp-export.md) | Loading the HTTP capture into Burp or ZAP |
| [docs/ci.md](docs/ci.md) | Wiring this into a pipeline — read the artifact section |
| [docs/development.md](docs/development.md) | Changing the code |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Something is failing |
| [CHANGELOG.md](CHANGELOG.md) | What changed, and which audit finding drove it |

## Two things that will bite you

**The HTTP capture contains credentials.** With `captureHttpHistory` on,
`output/http-history.*` is a verbatim record of every request including `Cookie` and
`Authorization` headers. On an authenticated crawl that is your live session. Never attach
it to a ticket, upload it as a CI artifact, or commit it. Details in
[docs/burp-export.md](docs/burp-export.md).

**The site is usually the bottleneck, not your machine.** Six Playwright workers against a
small demo host made every test time the others out; two finished the same suite. Tune
`testWorkers` and `navTimeoutMs`, not your CPU count — see
[docs/configuration.md](docs/configuration.md).

## When to rerun what

| Situation | Run |
|---|---|
| Nightly / every deploy | `npm run qa` — no AI |
| New feature shipped | Phase 5 for that feature, then Phase 6 |
| Specs broke after a UI change | Ask Claude to update the locators in that spec |
| New site | Start from Phase 0 with a fresh config |
