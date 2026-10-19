# Running on another machine

A step-by-step runbook for setting up and running this QA agent on a fresh machine. The
core (crawl, scan, report) needs **no AI and no API key** — only Node and a browser. The AI
parts are optional and called out at the end.

> Only ever run this against a site you own or have written permission to test. See
> [safety.md](safety.md).

---

## 0. Prerequisites

| Need | Details |
|---|---|
| **Node.js 22+** | CI uses 22; 24 works too. Check with `node -v`. |
| **npm** | Ships with Node. |
| **git** | To get the code. |
| **Disk** | ~400 MB for the Chromium browser Playwright downloads. |
| **OS** | Windows, macOS or Linux. On Linux a headless browser needs system libs — see step 2. |

No database, no server to provision, no API key for the core tool.

---

## 1. Get the code and install dependencies

```bash
git clone <your-repo-url> qa-agent
cd qa-agent
npm install
```

If `npm install` warns about build scripts, that is expected — only `esbuild` is allow-listed
(see `allowScripts` in `package.json`). To mirror CI exactly (no package build scripts at
all), use `npm ci --ignore-scripts` instead, then step 2 installs the browser explicitly.

---

## 2. Install the browser

```bash
npx playwright install chromium
```

On Linux, also pull the system libraries the browser needs:

```bash
npx playwright install --with-deps chromium
```

---

## 3. Point it at your target

Edit `qa.config.json` — the only two fields you must set:

```json
{
  "baseUrl": "https://staging.example.com",
  "allowedOrigins": ["https://staging.example.com"]
}
```

- **`baseUrl`** — where the crawl starts.
- **`allowedOrigins`** — the hard scope gate. The tool will only ever contact these exact
  origins (scheme + host + port). List every origin you need (e.g. add `https://www.…` or an
  `https://api.…` separately).

Other useful keys: `exclude` (regexes to skip, e.g. `/logout`), `maxPages`, `maxDepth`,
`requestDelayMs` (politeness pacing), `denyList` (never-click words). Full reference:
[configuration.md](configuration.md).

> **Machine-specific setting to check:** if `qa.config.json` contains a `customEngine` block,
> its `projectPath` is an **absolute path from another machine**. Either delete the whole
> `customEngine` block (the core tool does not need it) or repoint `projectPath` to where the
> template-generator project lives on this machine. See step 9.

You don't have to edit the file by hand — step 7 (the control panel) has a form for every
setting with a Save button.

---

## 4. (Optional) Secrets for login / email flows

Only needed if you will crawl logged-in pages or test signup/verification. Copy the example
and fill in what applies:

```bash
cp .env.example .env
```

| Variable | For |
|---|---|
| `TEST_PASSWORD` | The site password the login setup uses |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Only if `EMAIL_PROVIDER=imap` (Gmail inbox for verification links) |
| `EMAIL_PROVIDER` | `mailtm` (default, no creds) or `imap` |

The default email provider (`mailtm`) needs no credentials. `.env` is git-ignored — never
commit it.

---

## 5. Verify the install (offline, no target needed)

```bash
npm run typecheck
```

```bash
npm run test:unit
```

Both are offline (no browser, no network) and take a few seconds. If they pass, the code is
healthy on this machine.

---

## 6. Run it — the no-AI path

Step by step:

```bash
npm run preflight      # 1. is the target up (and its assets)?
```

```bash
npm run crawl          # 2. inventory the site -> output/pages.jsonl (a few minutes)
```

```bash
npm run profile        # 3. tech stack, headers, cookies
```

```bash
npm run coverage       # 4. what nothing tests yet
```

```bash
npm run summary        # 5. output/summary.md + a scoped nuclei command plan
```

```bash
npm run report         # 6. output/report.html  <- open this
```

If a step goes wrong, ask what to do next:

```bash
npm run diagnose
```

**Or run the whole pipeline in order** (crawl → tests → scans → summary → report; still
builds the report even if a step fails, and exits non-zero on any critical/high finding):

```bash
npm run qa
```

Everything lands in `output/` (git-ignored). The deliverable is `output/report.html`.

---

## 7. Run it — the control panel (no terminal after launch)

```bash
npm run panel
```

Open **http://127.0.0.1:7777**. From the sidebar you can edit every setting (Save writes
`qa.config.json` after validating it), run each step from a button with live output, watch
the crawl fill in live, and open the report. It binds to `127.0.0.1` only. Change the port
with `PANEL_PORT=8080 npm run panel`.

---

## 8. Authenticated crawl (logged-in pages)

Easiest via the control panel's **Login** tab: enter the username/email and password and the
sign-in form details, click **Save login**, then **Set up login session**, then run **Crawl
(logged in)**. The password is written to `.env` (git-ignored) as `TEST_PASSWORD`, never to
`qa.config.json`, and is never shown back.

By hand:

1. Put the credentials in `.env` (`TEST_USERNAME`, `TEST_PASSWORD`) and a `login` block in
   `qa.config.json` (see [multi-user.md](multi-user.md) / [configuration.md](configuration.md)).
2. Save a session:
   ```bash
   npm run auth:setup
   ```
3. Crawl behind the login:
   ```bash
   npm run crawl:auth
   ```

---

## 9. (Optional) Deep scan — external template engine

`npm run deepscan` bridges the crawl to a separate **nuclei-template-generator** project.
It is optional and only runs when you ask for the `custom` or `both` engine:

```bash
npm run deepscan -- --engine official   # built-in plan only (no external project needed)
npm run deepscan -- --engine both       # also generate + run custom templates
```

For `custom`/`both` you must have that project on this machine and set
`customEngine.projectPath` in `qa.config.json` to its root (the directory holding
`bridge_scan.sh`). Without it, use `--engine official` or skip deep scan entirely — the rest
of the tool is unaffected.

---

## 10. (Optional) The AI parts

Two things use Claude and are not required for recon/scanning/reporting:

- **Exploration (Phase 5)** — Claude drives the browser via the **Playwright MCP** and reads
  a test inbox via the **Email MCP** to find feature-level bugs. These MCP servers are
  registered in `.mcp.json` and run under Claude Code, not the plain scripts.
- **Agent commands** — `/qa-team`, `/autorun`, `/improve` orchestrate the scripts from a
  Claude Code session.

If you are only running the scripts above, you can ignore MCP entirely.

---

## 11. Multiple targets

Keep a config per site in `targets/` and select it per run, instead of editing
`qa.config.json`:

```bash
QA_CONFIG=targets/saucedemo.json QA_OUT=output/saucedemo npm run crawl
```

`QA_OUT` keeps each target's results in its own folder.

---

## 12. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `crawl-status` says `login-wall` | The site is behind a login — set up auth (step 8). |
| `too-few-pages` / `no-links` | Scope too narrow, or a JS-only SPA — check `include`/`exclude`, raise `maxDepth`, confirm `/sitemap.xml`. |
| Crawl stopped, exit 3 | The target rate-limited it — raise `requestDelayMs`, lower `concurrency`. |
| Browser/Chromium errors | Re-run `npx playwright install --with-deps chromium`. |
| `deepscan` fails | `customEngine.projectPath` is missing/wrong, or you don't need it — use `--engine official`. |
| A config key error on start | The schema is strict; a typo'd or unknown key fails the run. Fix the named key. |

More: [troubleshooting.md](troubleshooting.md).

---

## One-line summary

```bash
npm install && npx playwright install chromium   # once
# edit qa.config.json (baseUrl + allowedOrigins)
npm run panel                                    # then drive from http://127.0.0.1:7777
```
