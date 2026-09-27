# Email

Signup and verification flows need a mailbox. Two backends behind one interface, plus a
read-only MCP server that exposes three narrow tools to Claude.

Every provider is **receive-only**. There is no send, delete, move, flag or append call
anywhere in `src/email/`.

## Choosing a provider

Set `emailProvider` in `qa.config.json`, or `EMAIL_PROVIDER` in `.env` (which wins).

| | `mailtm` (default) | `imap` |
|---|---|---|
| Setup | none | Gmail account + app password |
| Addresses | real disposable mailboxes on a public domain | plus-addressing on one real mailbox |
| Credentials | none | full IMAP read of that mailbox |
| Works when the site blocks disposable domains | no | yes |
| Survives process restart | **no** | yes |
| Third-party dependency | yes — can rate-limit (429) or be down | your own mailbox |

Start with `mailtm`. Move to `imap` when the target rejects disposable domains.

### mailtm

Each `createInbox(tag)` registers a throwaway mailbox on a real, publicly-deliverable
domain, so a hosted site can genuinely send to it.

The important constraint: **the account exists only inside the running process.** The
password is generated at random, held in memory, and never written anywhere. So
`waitForEmail` can only poll a mailbox that `createInbox` created in the *same* process.
Calling `create_test_inbox` in one command and waiting in another does not work — which
is why `npm run email:wait` does both in one script.

Behaviour worth knowing:

- **Tags are sanitised.** Anything outside `[a-z0-9-]` is folded to a hyphen and the
  result is capped at 40 characters. An unsanitised tag produced an invalid address and a
  bare `422` that named nothing.
- **Address collisions retry.** The domain is public and shared, so a tag someone else
  already used would otherwise be a hard failure. Four attempts, each with a random
  suffix.
- **Token expiry is handled.** mail.tm tokens expire; on a `401`/`403` the provider
  re-authenticates with the stored password and retries the poll. Previously an expired
  token was indistinguishable from "the site never sent the email" — after a full 90s
  timeout.

### imap

One real Gmail mailbox, addresses via plus-addressing, driven by `emailPattern`:

```json
"emailPattern": "{GMAIL_LOCAL}+{runId}-{n}@gmail.com"
```

`{GMAIL_LOCAL}` is the local part of `GMAIL_USER`; `{runId}` and `{n}` make it unique.

Setup: enable 2-Step Verification, create an App Password, enable IMAP, then fill `.env`.

> **Use a dedicated account.** The app password in `.env` grants full IMAP read of that
> mailbox. Not your personal one.

Implementation notes:

- One shared connection per process, reconnecting automatically when it drops.
- Mailboxes are opened `readOnly: true`.
- **Both `INBOX` and `[Gmail]/Spam` are searched** — verification mail lands in spam more
  often than you would like.
- IMAP `SINCE` has day granularity, so the search widens by a day and filters precisely on
  `internalDate` locally.
- If a `TO` search returns nothing (Gmail does not always match a plus-address that way)
  it widens to everything since and filters locally, comparing canonical addresses
  (`a+b@gmail.com` and `ab@gmail.com` are the same box).
- The scan is capped at 40 messages, newest first, so a busy mailbox cannot stall a poll.

## The MCP server

`src/email/mcp-server.ts`, registered in `.mcp.json`. Responses are deliberately small: a
code, a link, or a truncated body. Raw messages and headers are never returned, and the
mailbox token never leaves the process.

### `create_test_inbox`

| Param | Type | Notes |
|---|---|---|
| `tag` | string | 3–40 chars, letters/digits/hyphens. Unique per test. |

Returns `{ address, provider }`. Call it **before** submitting the signup form.

### `get_verification_code`

| Param | Type | Notes |
|---|---|---|
| `to` | string | The recipient address. |
| `since_iso` | string | ISO timestamp recorded **before** the action that triggers the email. |
| `timeout_sec` | number? | 5–300, default 90. |
| `subject_contains` | string? | |

Returns `{ code, subject, received_at }`, or throws if no code is found — in which case
try `get_verification_link`.

### `get_verification_link`

Same params plus `link_contains`. Returns `{ link, subject, received_at }` — the
**best-ranked** link, not the first one in the document.

### `read_latest_email`

Escape hatch. Returns subject, from, timestamp, the first 3000 chars of text, and up to
20 links.

### Using them correctly

`since_iso` is the whole ballgame. Record it **before** the action, not after:

```
1. create_test_inbox(tag)          -> address
2. note the current ISO timestamp  <- BEFORE submitting
3. fill and submit the signup form
4. get_verification_code(to=address, since_iso=<step 2>)
```

Recorded afterwards, a fast-arriving email is filtered out and you wait for the full
timeout for a message that already arrived.

## Extraction

### `extractCode(text, pattern?)`

Pass a `pattern` to bypass the heuristic entirely — it is rebuilt without `g`/`y` flags so
a shared module-level regex does not carry `lastIndex` between calls.

Without one, the heuristic:

1. **Strips everything a code cannot live in** — `<script>`/`<style>` bodies, all tags and
   their attributes, bare URLs, HTML entities, hex colours, CSS lengths. This runs first
   and matters most. The MCP server passes raw HTML, and the canonical verification email
   looks like `<a href="https://x/verify/998877">Verify</a> … Your code: 314159` — where
   "verify" sits one character before the *wrong* digits.
2. Finds every `\b\d{4,8}\b` in what is left.
3. Scores each by proximity to a hint word (`code`, `verification`, `verify`, `otp`,
   `passcode`, `pin`, `confirm`). A hint **before** the digits scores much higher than one
   after — a label reads "your code: 1234", so a hint after the number is weak evidence.
4. Breaks ties on shape: 6 digits > 4 > 8 > anything else.
5. **Returns `null` below a minimum score.** A digit run with no hint anywhere near it is
   a street number, not a passcode.

Verified behaviour:

| Input | Result |
|---|---|
| `Order #48213 confirmed. Your verification code is 903112.` | `903112` |
| `Total: 129900 USD. Your code: 4471` | `4471` |
| `Call 18005551234. Your OTP is 5566` | `5566` |
| `<a href="https://x/verify/998877">Verify</a> Your code: 314159` | `314159` |
| `<td style="width:600px"><b>Verification code</b> 246810</td>` | `246810` |
| `123456 Main Street\nSuite 400\nUnsubscribe.` | **`null`** |

Known limitation: with two codes and a hint adjacent to each
(`Your code is 111111. Ignore the old code 222222.`) the scoring is genuinely ambiguous.
Use `subject_contains` or an explicit `pattern` when a site does this.

### `extractLinks(content, contains?)`

Returns unique `http(s)` links, **best candidate first**. Document order is the wrong
order: every templated email opens with a logo link and an open-tracking pixel, so
`links[0]` used to be reliably the tracker.

Ranking:

| Signal | Score |
|---|---|
| Action word in the URL (`verify`, `confirm`, `activate`, `reset`, `token`, …) | +40 |
| Action word in the anchor text | +30 |
| A long opaque query value — what a one-time token looks like | +15 |
| Boilerplate in the URL (`unsubscribe`, `opt-out`, `track`, `utm_`, social, …) | −50 |
| Boilerplate in the anchor text | −40 |
| Image extension — a pixel, never an action link | −60 |

Ties fall back to document order. Anchor text is parsed with the href so it can be scored;
bare URLs in plain-text bodies are picked up too, and HTML entities are decoded.

Pass `contains` when you know the shape of your verification URL. It is a substring
filter applied after ranking, and it is the most reliable option available.

## Checking it works

```bash
npm run email:selftest             # connects, mints an address, prints nothing secret
npm run email:selftest -- mailtm   # force a provider
npm run email:wait                 # prints an address, waits 180s for a real message
npm run email:wait -- 300          # longer window
```

`email:wait` prints what the extractors found in whatever arrives, which is the fastest
way to see how your target's emails are actually shaped before writing a test against
them.
