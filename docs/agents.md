# The QA agent team

Each pipeline step has a dedicated Claude Code subagent in `.claude/agents/`. A subagent
starts with a clean context, does one job, writes its results to `output/`, and returns a
short summary. The main session coordinates them, either by hand or through `/qa-team`
(`.claude/commands/qa-team.md`).

Subagents cannot start other subagents. The main session is always the coordinator.

## Roster

| Step | Agent | Browser? | What it adds |
|---|---|---|---|
| 0 | `qa-preflight` | no | Target health, tech profile, a config sanity check, and a deny-list fitted to this site's vocabulary |
| 3 | `qa-crawler` | no | Runs the crawls, reads the verdict, tunes `exclude`/limits, and retries failed pages |
| 4 | `qa-auth` | yes | Signup, verification and login; saved sessions; persona setup |
| 5 | `qa-explorer` | yes | Core features: what each template is for, plus happy-path and negative cases |
| 5 | `qa-forms` | yes | Input validation: boundaries, empty, unicode, long input, type mismatch, double submit |
| 5 | `qa-security` | yes | Passive and non-destructive checks: headers, cookies, output escaping, session handling, authz |
| 5 | `qa-multi-user` | yes | Two-user features and data isolation between personas |
| 5 | `qa-accessibility` | yes | Labels, names, headings, landmarks, keyboard reachability, focus, alt text |
| 5 | `qa-visual` | yes | Layout at mobile, tablet and desktop widths: overflow, overlap, clipped text |
| 5 | `qa-performance` | no | Load times, failed subresources, page weight, slow outliers (from crawl data) |
| 5 | `qa-content` | no | Titles, broken links, console errors, typos, missing meta (from crawl data) |
| 6 | `qa-spec-writer` | no | Turns `findings.jsonl` and `features.jsonl` into `tests/*.spec.ts` |
| 6 | `qa-spec-reviewer` | no | Reviews specs for guard bypasses, weak assertions and flakiness |
| 6 | `qa-coverage` | no | `npm run coverage`, then a prioritised backlog of what nothing tests yet |
| 7 | `qa-triage` | no | Runs the suite and sorts each failure into real bug, flaky test, target down or test bug |
| 7 | `qa-reporter` | no | Merges duplicate findings, calibrates severity, checks every finding is reproducible, builds the report |
| 8 | `qa-ci` | no | Checks the pipeline and CI hygiene, especially that no artifact leaks credentials |

## Improving the tool itself

The agents above test a *target website*. A second loop improves *this repository*, and
runs one round at a time with `/improve` (`.claude/commands/improve.md`):

```
qa-improve-test  ─┐
                  ├─> qa-improve-filter ─> qa-improve-enhance
qa-improve-check ─┘
```

| Agent | Writes | Job |
|---|---|---|
| `qa-improve-test` | new `src/*.extra.test.ts`, report | Typecheck, unit tests, lint, and new tests for untested risky logic |
| `qa-improve-check` | report only | Guard gaps, politeness bypasses, secret leaks, bugs, docs vs code |
| `qa-improve-filter` | report + `backlog.jsonl` | Re-verifies every finding; rejects false positives, by-design items and duplicates; ranks the rest |
| `qa-improve-enhance` | product code, tests, docs | Fixes backlog items test-first; never weakens a guard; never commits |

Reports go to `output/improve/round-<N>/` (git-ignored). The filter is the most important
step: a finding goes nowhere unless the filter has re-checked it against the code.

## Autopilot: run, read, retry

`qa-autopilot` (`.claude/agents/qa-autopilot.md`, driven by `/autorun`) points the pipeline at
one authorized target and loops until the run is as good as it will get:

```
preflight → crawl → npm run diagnose → apply ONE safe change → re-run → … → summary + report
```

`src/diagnose.ts` (`npm run diagnose`) is the deterministic core: it reads crawl-status, the
inventory and the status files and returns the verdict, whether the run is complete, and
ranked retry actions (slow down, raise a budget, set up auth, widen include, run the scanners,
…). The agent applies the top action, one per attempt, and stops when diagnose reports
`settled`, the attempt budget is spent, or two attempts make no progress. It only ever makes
safe config nudges — it never widens `allowedOrigins` or the deny-list, never invents
credentials, and never scans an unauthorized target. `src/diagnose.test.ts` pins both the
rankings and that no suggested action touches a safety guard.

## Rules every agent follows

`CLAUDE.md` applies to every agent. Three extra rules exist only because there are
several agents.

### 1. Only one browser agent at a time

The Playwright MCP drives one shared browser. Two browser agents running together would
navigate each other's tab. Agents marked "browser" above run **one after another**. Agents
without the browser can run in parallel with each other and alongside a browser agent.

### 2. Finding IDs come from the file

Immediately before appending, read `output/findings.jsonl`, take the highest `F-NNN`, and
add one. Never reserve a block of IDs, and never reuse one. Each finding also carries two
optional fields the report ignores:

```json
{"id":"F-011","area":"accessibility","agent":"qa-accessibility", "...": "..."}
```

`area` is one of `functional`, `forms`, `security`, `authz`, `accessibility`, `visual`,
`performance`, `content`, `harness`.

Before writing a finding, check it is not already there (same `url` and same `actual`).
If it is, add evidence to the existing one in your summary rather than writing a duplicate.

### 3. Each agent tracks its own progress

`output/progress.json` keeps its top-level shape for compatibility. Each agent writes its
own section under `agents`:

```json
{
  "phase": 5,
  "completedTemplates": ["..."],
  "agents": {
    "qa-accessibility": {
      "updatedAt": "2026-10-13T10:00:00Z",
      "completedTemplates": ["https://site/login"],
      "notes": "Stopped: context budget. Next: /dropdown onwards."
    }
  }
}
```

Read the file, change only your own section, and write it back. Update it after **each**
template, not at the end. `notes` must say *why* you stopped, so a resumed session can
tell "finished" from "ran out of room".

## Where results go

| Output | Written by |
|---|---|
| `output/findings.jsonl` | Every Phase 5 agent, plus `qa-triage` for bugs confirmed by the suite |
| `output/features.jsonl` | `qa-explorer`, `qa-forms`, `qa-multi-user`, `qa-auth` |
| `output/agents/<agent>.md` | Each agent's working notes and backlog, readable by the next agent |
| `tests/*.spec.ts` | `qa-spec-writer` only. Other agents propose specs in their notes |
