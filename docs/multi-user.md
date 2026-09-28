# Multi-user testing

Some features only exist between two people: sharing a document, inviting a teammate,
sending a message, an admin suspending a member, a seller and a buyer. A single logged-in
session cannot exercise any of them, and cannot detect the bug class that matters most —
one user reading another user's data.

## Personas

A **persona** is a durable identity: a stable mailbox, a site password, and its own saved
browser session.

```json
"personas": [
  { "id": "alice", "role": "owner" },
  { "id": "bob",   "role": "member" }
]
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable handle. Used in specs, filenames and the report. Lowercase, digits, hyphens. |
| `role` | no | Free text — `owner`, `member`, `admin`. Appears in findings. |
| `password` | no | Fixed site password. Omit to generate one. |
| `username` | no | For targets that log in by username rather than email. |

Create them and save a session for each:

```bash
npx playwright test --project=setup
```

Identities land in `output/auth/personas.json` and their sessions in
`output/auth/state.<id>.json`.

### Why identities persist

They are created once and reused. If the address changed every run, an invitation sent
yesterday would arrive at a mailbox nobody is reading, and "accept the invitation" could
never be tested end to end.

The store is discarded automatically when `baseUrl` or the email provider changes —
identities from another site are meaningless.

> `output/auth/personas.json` contains **mailbox passwords**. It is git-ignored. Treat it
> exactly like `state.json`: never commit it, never attach it to a ticket, never upload it
> as a CI artifact.

## Writing a two-user test

```ts
import { withTwoUsers, openAnonymous, expect } from "./fixtures.js";

test("what A creates, B cannot see", async ({ browser }) => {
  await withTwoUsers(browser, "alice", "bob", async (userA, userB) => {
    await userA.page.goto("/documents/new");
    await userA.page.getByLabel("Title").fill("private");
    await userA.page.getByRole("button", { name: "Create" }).click();
    const url = userA.page.url();

    await userB.page.goto("/documents");
    await expect(userB.page.getByText("private")).toHaveCount(0);

    // The check people forget: not in the listing is not the same as not reachable.
    const res = await userB.page.goto(url);
    expect(res?.status()).toBeGreaterThanOrEqual(400);
  });
});
```

| Helper | Use it for |
|---|---|
| `openAs(browser, "alice")` | One persona, its own session |
| `withTwoUsers(browser, "alice", "bob", fn)` | Both live at once, torn down together |
| `openAnonymous(browser)` | A signed-out stranger |

**Each persona gets its own `BrowserContext`**, not just its own page. Two pages in one
context share a cookie jar — the test would pass while proving nothing. `two-user.spec.ts`
asserts the two session cookies actually differ, which is the guard against exactly that.

**Always include the stranger.** Protected from other users but public to the internet is a
real and common bug, and `openAnonymous` is how you catch it.

## Four patterns worth copying

`tests/two-user.spec.ts` ships all four, in the order they usually matter:

1. **Isolation** — the two sessions really are different people
2. **Visibility** — what A creates, B can or cannot see
3. **Authorization** — B cannot reach A's resource by URL, and neither can a stranger
4. **Handoff** — A invites, the mail arrives in B's own inbox, B accepts, both sides agree

Patterns 2–4 ship as `test.skip` templates, because the demo target has no multi-user
features. The structure is the point; fill in the selectors for your app.

## The authorization scan

```bash
npm run authz
```

Takes every page the authenticated crawl reached, and re-requests each one:

- **with no cookies** — a protected page that answers is `critical`
- **as the other persona** — the same page coming back is `high` (IDOR / BOLA)

GET only, and any URL the deny-list considers destructive is skipped rather than requested.
One URL per template — probing sixty samples of the same page shape proves nothing extra.

### How it avoids lying to you

Two guards exist because both failures happened during development:

**It refuses to report a clean result it did not earn.** If more than 25% of requests fail,
it exits with `SCAN INCONCLUSIVE` instead of "no problems found". During development DNS
went down, every probe failed, and the scan cheerfully reported a clean bill of health for
a run that never reached the site once.

**It detects two personas that are secretly one account.** If they share a configured
`username`, every user-to-user finding would be true and worthless — of course B can read
A's page, B *is* A. The scan says so and skips that half rather than emitting a page of
confident false positives. Note that comparing session cookies is *not* enough: one account
logged in twice produces two different cookies.

### Reading a result

```
WARNING: alice and bob share one session identity - they are the same
account on the target. Skipping the user-to-user comparison.
```

Give each persona its own account on the target. On a site with real signup that happens
automatically, since each persona registers with its own mailbox.

Findings are written to `output/authz-findings.jsonl`, merged into the report, and counted
by the `npm run qa` gate.
