# Development

## Setup

```bash
npm install
npx playwright install chromium
```

Node 22+. TypeScript runs through `tsx`; nothing is compiled to disk (`noEmit: true`).

## The checks

```bash
npm run typecheck     # tsc --noEmit
npm run test:unit     # offline: guards, URLs, XML, email parsing. No browser, no network.
npm test              # the Playwright suite (needs the target to be up)
```

`typecheck` and `test:unit` are the ones to run constantly — together they take a couple
of seconds and cover every pure function in the codebase.

`tsconfig.json` is strict, including `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. Those two are why you will see `?? ""` after array indexing
and `...(x === undefined ? {} : { x })` instead of `{ x }`. Leave them on; they catch a
genuine class of bug in code that parses untrusted JSON.

## The regression suite

`src/guards.test.ts` — 17 tests, plain `node:test`, no framework.

**Every case in that file is a bug that was actually found, not a hypothetical.** It is
organised by the guarantee it protects:

| Group | Protects |
|---|---|
| deny matching | Unicode/spacing bypasses, and the false positives that silently withhold safe controls |
| destructive URLs | The link-following hole |
| `isAllowedUrl` | Lookalike hosts, userinfo, scheme downgrade |
| URL handling | Credential stripping, `%2F`, path case, pagination templates |
| Burp XML | Illegal characters, attribute injection, numeric coercion, `]]>` |
| email | Digits inside URLs, the null threshold, link ranking |

### The workflow for a new bug

1. **Add the failing case first.** A bug report that is a test is worth ten that are
   prose.
2. Fix it.
3. Leave the test in. That is how the file got useful.

```ts
test("deny-list survives the ways real UIs spell a word", () => {
  for (const label of ["Delete", "Ｄelete", "Dele​te", "Rem ove"]) {
    assert.equal(isDenied(label, cfg), true, `should be denied: ${JSON.stringify(label)}`);
  }
});
```

Note the message argument — with a loop, the assertion is useless without it.

## Writing tests for a slow site

Three patterns in `tests/fixtures.ts` exist because of real failures, not theory.

**Every off-origin request is blocked.** A named block-list only catches the trackers you
thought of; any other third-party host whose DNS stalls holds the page open for tens of
seconds. Nothing outside `allowedOrigins` is under test. This took setup from a 120s
timeout to 26s.

The implementation detail matters: the route uses a **URL predicate**, not `"**/*"`. A
catch-all that ends in `route.continue()` proxies every same-origin request through Node
and costs more than the trackers did — measured at 356s → 727s on the same crawl.

**Navigations default to `domcontentloaded`.** Playwright's default `load` waits for every
image and third-party script; one unresolvable tracker becomes a navigation timeout that
has nothing to do with your site. Assertions provide the real waiting, so nothing is lost.

**`submitAndWait(page, click, "/endpoint")`** waits for the form's POST response.
`waitForURL` is unreliable for form errors: a rejected login re-renders the *same* URL, so
it matches instantly and the assertion then races the in-flight navigation.

### Clicking

Use the guards. A bare `.click()` in a spec is a bug:

```ts
import { test, expect, safeClick, safeClickLink, safeGoto, submitAndWait } from "./fixtures.js";

await safeClick(page, "Login");
await safeClickLink(page, "Details");
await safeGoto(page, "/settings");
await submitAndWait(page, safeClick(page, /Retrieve password/i), "/forgot_password");
```

`safeClick` refuses an ambiguous locator rather than guessing, so if two buttons match you
will get a clear error telling you to narrow it.

### Known-bug tests

Phase 6 writes a test for every finding that asserts the **correct** behaviour and marks
it `test.fail()` with the finding id in a comment:

```ts
// F-003: two of the three images reference assets that do not exist.
test.fail("every image resolves to a real asset", async ({ page }) => {
  ...
  expect(broken).toBe(0);
});
```

Playwright reports it as expected-to-fail while the bug exists, and **the suite starts
failing the moment someone fixes it** — at which point you delete the `.fail()`. You never
have to remember to go back and re-enable anything. Against the demo target that is 9 such
tests out of 28.

## Code conventions

**Guards live in `src/config.ts` and nowhere else.** `isAllowedUrl`, `isDenied`,
`isDeniedUrl` have exactly one implementation each. A second copy of a security rule is a
second thing to forget to update. The crawler, the test fixture and the capture filter all
import them.

**Comments explain *why*, and name the failure.** The codebase is dense with comments like
"Exiting here is what collapses a concurrency of N to 1" and "this used to sit after the
append, so a single write error dropped the whole subtree". Those are the ones worth
writing. Do not comment what the code already says.

**Swallowed errors get a reason.** Every bare `catch {}` in this codebase has a comment
saying what is being tolerated and why it is safe. If you cannot write that comment, do
not swallow the error.

**Untrusted input is coerced at the boundary.** Anything read from JSONL is typed
`Partial<T>` and normalised through a function that coerces every field, because `?? 0` on
a value that is actually a string leaves the string in place.

## Adding a new site

1. Point `baseUrl` and `allowedOrigins` at it. Staging, with disposable data.
2. Fill `exclude` with anything that logs you out, costs money, or is a rabbit hole.
3. **Extend `denyList` for your domain and your language.** The default list is English
   and generic. See [safety.md](safety.md#what-the-deny-list-does-not-cover).
4. `npm run crawl` with a small `maxPages` first. Read `pages.jsonl`. Check
   `deniedButtons` and `deniedLinks` caught what you expected, and that nothing you need
   was withheld — add `denyUrlExceptions` entries rather than removing deny terms.
5. Adapt `tests/auth.setup.ts` to the real login. If it verifies by email, insert
   `createInbox()` before the signup submit and `extractCode`/`extractLinks` after; the
   rest is identical.
6. Then run Phase 5.

## Adding an email provider

Implement `EmailProvider` from `src/email/types.ts` and register it in the `PROVIDERS` map
in `src/email/lib.ts`:

```ts
interface EmailProvider {
  readonly name: string;
  createInbox(tag: string): Promise<TestInbox>;
  waitForEmail(opts: WaitForEmailOptions): Promise<FoundEmail>;
  check(): Promise<string>;     // cheap connectivity check for the self-test
  close(): Promise<void>;
}
```

Requirements: **receive-only** — no send, delete, move or flag. Never return or log the
token. `waitForEmail` must respect `since` strictly and throw a descriptive timeout naming
the address, the subject filter and the window.

## Extending the report

`src/report.ts` builds one string. To add a section:

- run every value through `esc()`, including numbers;
- run every `href` through `safeHref()`;
- if you read a file from disk, confine the path the way `thumb()` does.

Then add a case to `src/guards.test.ts` proving a hostile value in your new field cannot
escape. The report renders strings that came from the target site — that is its job, and
it is why this is not optional.

## Repository layout

```
src/
├── config.ts          schema + the guards
├── crawl.ts           crawler
├── http-history.ts    capture + Burp XML
├── report.ts          HTML report
├── qa.ts              pipeline runner
├── export-burp.ts     re-serialise XML from an existing capture
├── guards.test.ts     offline regression tests
└── email/
    ├── types.ts       the provider interface
    ├── lib.ts         provider selection, extractCode, extractLinks
    ├── mailtm.ts      disposable mailboxes
    ├── imap.ts        Gmail/IMAP
    ├── mcp-server.ts  read-only MCP server
    ├── selftest.ts    connectivity check
    └── waittest.ts    end-to-end receive check
tests/
├── fixtures.ts        shared fixture + safeClick/safeClickLink/safeGoto
├── auth.setup.ts      logs in once, saves the session
└── *.spec.ts          generated from findings
docs/                  this documentation
```
