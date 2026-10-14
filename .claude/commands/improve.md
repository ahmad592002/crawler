---
description: Run one round of the self-improvement loop on this QA tool (test ∥ check → filter → enhance)
argument-hint: "[round number]"
---

Run one round of the improvement loop described in `docs/agents.md`. Round: $ARGUMENTS
(if empty, use one more than the highest `output/improve/round-N/` that exists, or 1).

Use folder `output/improve/round-<N>/`. Pass it, and the previous round's folder if there
is one, in every agent's prompt.

1. Start `qa-improve-test` and `qa-improve-check` **in parallel**. The tester only adds
   new test files and the checker is read-only, so they can't collide.
2. When both are done, run `qa-improve-filter`.
3. If the backlog has no items with `status: "todo"`, stop and report that this round
   found nothing worth changing.
4. Otherwise run `qa-improve-enhance`.
5. Verify yourself: `npm run typecheck` and `npm run test:unit` are green, and
   `git diff --stat` shows only the files `enhance.md` lists.
6. Report:
   - per agent, one line with its counts
   - the backlog items done, with their files
   - what was rejected by the filter and why, in one line each
   - a reminder that nothing was committed

Never commit. Ask before starting a second round.
