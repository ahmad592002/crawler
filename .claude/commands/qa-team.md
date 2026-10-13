---
description: Run the full QA agent team in order (preflight → crawl → auth → specialists → specs → triage → report)
argument-hint: "[resume | only <agent> | from <agent>]"
---

Coordinate the QA agent team defined in `.claude/agents/` and described in
`docs/agents.md`. Arguments: $ARGUMENTS

## Order

Run the stages in this order. Within a stage, agents marked **∥** may run in parallel
(they don't use the browser). Browser agents always run **one at a time**, because the
Playwright MCP is one shared browser.

1. `qa-preflight`. If it says NO-GO, stop and report why.
2. `qa-crawler`
3. `qa-auth` (browser)
4. Browser specialists, **sequentially**: `qa-explorer` → `qa-forms` → `qa-security` →
   `qa-multi-user` → `qa-accessibility` → `qa-visual`.
   Run `qa-performance` ∥ and `qa-content` ∥ in the background alongside the first one.
5. `qa-spec-writer`, then `qa-spec-reviewer`. If the reviewer reports must-fix issues,
   send them back to `qa-spec-writer` once.
6. `npm run test`, then `qa-triage` if anything is red. Run `qa-coverage` ∥ alongside.
7. `qa-reporter`
8. `qa-ci`, only if `src/qa.ts`, `package.json` or `.github/` changed during this run.

## Coordination rules

- Before each agent, read `output/progress.json`. If its section says its work is
  complete and nothing upstream changed, skip it (that's how `resume` works).
- Give each agent a short prompt naming the stage and pointing to the notes file of the
  agent before it. Don't paste their output into the prompt; they read `output/agents/`.
- After each agent, tell the user in one line what it found (counts and anything
  `critical`).
- If any agent reports a deny-list or scope change it wants but did not make, stop and ask
  the user before continuing.
- If the Playwright MCP isn't connected, run the non-browser agents and list the browser
  stages that were skipped.

Finish with the contents of `output/agents/summary.md` and the coverage percentage from
`qa-coverage`.
