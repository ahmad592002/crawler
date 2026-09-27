# CI

`.github/workflows/qa.yml` runs the pipeline nightly at 02:30 UTC and on
`workflow_dispatch`.

```yaml
concurrency:
  group: qa-${{ github.ref }}
permissions:
  contents: read
```

A nightly run and a manual dispatch would otherwise race for the same artifact name.
Permissions are read-only: this workflow publishes nothing back to the repo.

## What must never be uploaded

The most likely real-world harm from this tool is not a destructive click. It is a
credential in a file that someone else can download.

**Excluded from the artifact, deliberately. Do not add them back:**

| Path | Why |
|---|---|
| `output/auth/state.json` | The live session cookie, in plain text. |
| `output/test-results/` | **Playwright traces.** A trace records every request a test made, headers included — so it carries the session cookie and any `Authorization` header, plus screenshots of the authenticated UI. |
| `output/pw-report/data/` | The HTML report's attachments directory, which is where those trace zips live. |
| `output/http-history.*` | A verbatim capture of every request. See [burp-export.md](burp-export.md). |

This is not theoretical. `playwright.config.ts` sets `trace: "retain-on-failure"` and the
upload step is `if: always()` — so traces are produced *exactly* when the artifact is
uploaded, and GitHub artifacts are downloadable by anyone with read access to the repo.

The workflow uploads only:

```yaml
path: |
  output/report.html
  output/pw-report/index.html
retention-days: 14
```

`report.html` does embed screenshots of authenticated pages as data URIs. That is the
point of the report, but it is worth knowing before you share the link.

## Secret handling

Secrets are scoped to the **step** that needs them, not the job:

```yaml
- name: Run QA pipeline
  env:
    GMAIL_USER: ${{ secrets.GMAIL_USER }}
    GMAIL_APP_PASSWORD: ${{ secrets.GMAIL_APP_PASSWORD }}
    TEST_PASSWORD: ${{ secrets.TEST_PASSWORD }}
  run: npm run qa
```

At job level they are also in the environment of `npm ci`, where **every transitive
dependency's install script can read them**. Hence also:

```yaml
- run: npm ci --ignore-scripts
```

which skips lifecycle scripts entirely. Playwright's own postinstall is skipped along with
them, so browsers are installed explicitly in the next step. Anything else that genuinely
needs a build step has to be added deliberately rather than running arbitrary code by
default.

> The `allowScripts` key in `package.json` is a `@lavamoat/allow-scripts` convention. It
> has no effect under plain `npm ci` — `--ignore-scripts` is what actually enforces this.

`EMAIL_PROVIDER` comes from a repository **variable**, not a secret, defaulting to
`mailtm` (which needs no credentials at all). If you are on `mailtm` you can drop the
Gmail secrets entirely.

## Browser caching

```yaml
key: playwright-${{ runner.os }}-${{ runner.arch }}-${{ steps.pw.outputs.version }}
```

Keyed on the resolved Playwright version so a dependency bump fetches fresh browsers, and
on the architecture because a cache from a different arch is useless.

`npx playwright install --with-deps chromium` runs **unconditionally**, not gated on
`cache-hit`. It is a no-op when the browser is already present, so it costs nothing on a
hit — and it repairs a cache that was saved from a run where the install died half way.
The `actions/cache` post-step saves even when the job fails, so a partial browser
directory can otherwise be cached and then skipped forever, failing in a way that looks
like a Playwright bug.

## Step order

```
checkout → setup-node → npm ci → resolve version → cache → install chromium
        → tsc --noEmit → unit tests → npm run qa → upload
```

`tsc --noEmit` and the offline unit tests run **before** the pipeline, so a type error or
a broken guard fails in seconds rather than after a 20-minute crawl.

Inside `npm run qa`, `playwright test` runs before the authenticated crawl, because its
`setup` project is what writes `output/auth/state.json`. Ordered the other way, a fresh
checkout skipped the authenticated crawl on every single run and reported it as a clean
skip — which is exactly the kind of failure nobody notices.

## Exit codes and the findings gate

`npm run qa` exits non-zero when:

- a non-soft step failed (`crawl (anon)`, `report`), **or**
- `output/findings.jsonl` records a `critical` or `high` finding.

**In CI that second condition cannot fire, and you should know why.** `output/` is
gitignored, so a fresh checkout has no findings file; findings come from the Phase 5
exploration session, which is interactive and is not part of this pipeline. The runner
prints this explicitly rather than a reassuring `0`:

```
critical/high findings: n/a - no output/findings.jsonl in this workspace.
```

If you want a nightly run to gate on findings, restore that file into the workspace first
— cache it between runs, or keep a reviewed copy somewhere the job can fetch.

Test failures alone are **soft**: the pipeline continues so the report is still built. A
failing suite is when the report matters most.

## Timeouts

`timeout-minutes: 45` on the job, and `maxRuntimeMs` (default 30 min) inside the crawler.
The inner one exists so that a hung crawl exits with a written inventory and a warning
instead of being killed by the runner with nothing to show.

## Adapting it

- **A private target.** Add whatever network setup your runner needs before the QA step;
  nothing in the tool assumes public DNS.
- **Per-branch runs.** Add `pull_request` to `on:`. Consider lowering `maxPages`.
- **Notifications.** Add a step with `if: failure()`. Keep the artifact exclusions.
- **A second environment.** Parameterise `baseUrl`/`allowedOrigins` via a matrix and a
  small `jq` step that rewrites `qa.config.json` before the run.
