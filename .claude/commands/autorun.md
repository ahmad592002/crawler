---
description: Point the QA tool at an authorized target and loop run→diagnose→adjust→retry until settled
argument-hint: "<target: a targets/*.json name, a URL you own, or localhost> [attempts=4]"
---

Drive the `qa-autopilot` agent against the target in: $ARGUMENTS

1. **Resolve the target.**
   - A `targets/*.json` name → use `QA_CONFIG=targets/<name>.json`.
   - A URL or localhost the user owns or is authorized to test → confirm authorization in one
     line, then write a scope-locked config (allowedOrigins = exactly that origin) the agent
     will use. If authorization is unclear for a third-party site, ask before running.
2. Pick `QA_OUT=output/autopilot/<target>` so the user's main `output/` is untouched.
3. Launch `qa-autopilot` with the target, the output dir, and the attempt budget (default 4).
   The agent loops: preflight → crawl → `npm run diagnose` → apply ONE safe adjustment →
   re-run, until diagnose reports `settled`, the budget is spent, or there's no progress.
4. When it finishes, show the user: the final verdict, the attempt-by-attempt summary from
   `<dir>/autopilot-report.md`, and the single most useful next step (often "give credentials
   for an authenticated crawl" or "connect the MCP servers for exploration").

Never let the loop widen `allowedOrigins` or the deny-list, never invent credentials, and
never run against a target the user is not authorized to test. Don't commit.
