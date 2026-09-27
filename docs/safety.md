# Safety

This page is deliberately blunt. An honest account of where a guard stops is worth more
than a confident one, because the confident version is what gets someone to point this at
production.

## Threat model

Two things can go wrong, and they are not the same problem.

**1. The tool does something destructive to the target.** It clicks Delete, submits a
payment, closes an account, or follows a link that does any of those. This is what
`denyList` is for.

**2. The target does something to you.** It serves a page whose title, button label or URL
is crafted to attack whatever renders them — the HTML report, your terminal, a downstream
tool. This is what the escaping and path-confinement in `src/report.ts` are for. It is a
real threat: `findings.jsonl` is written by a model transcribing strings it read off the
site.

A third thing is not a "threat" but causes the most actual damage in practice:
**leaking your own credentials** into a file someone else can read. See
[ci.md](ci.md#what-must-never-be-uploaded).

## Scope: `isAllowedUrl`

The only thing in this codebase that is a genuine interlock.

```ts
export function isAllowedUrl(url: string, cfg: QaConfig): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;   // https://target.com@evil.com
    return cfg.allowedOrigins.includes(u.origin);
  } catch {
    return false;
  }
}
```

Called at every point where a URL could be acted on: queueing a discovered link, the
crawler's route predicate, the test fixture's route predicate, the capture filter and
`safeGoto`. There is exactly one copy of the rule.

Verified behaviour (`src/guards.test.ts`):

| URL | Result |
|---|---|
| `https://target.test/x` | allowed |
| `https://target.test.evil.com/x` | rejected — suffix lookalike |
| `https://target.test@evil.com/x` | rejected — origin is `evil.com` |
| `https://evil.com@target.test/x` | rejected — userinfo refused outright |
| `http://target.test/x` | rejected — scheme downgrade |
| `javascript:alert(1)` | rejected |

## Destructive controls: `isDenied` / `isDeniedUrl`

### Where it is applied

Four places, not one. The single-point version is what let destructive links through.

| Point | File | Effect |
|---|---|---|
| **Buttons** | `crawl.ts` | Split out of `buttons` into `deniedButtons`. Phase 5 plans clicks from `buttons`, so a denied label is never a candidate in the first place. |
| **Links** | `crawl.ts` | Checked by anchor text **and** URL before queueing. Recorded in `deniedLinks` and never fetched. |
| **Forms** | `crawl.ts` | `destructive: true` derived from the action URL and every submit label. |
| **Clicks and navigation** | `tests/fixtures.ts` | `safeClick`, `safeClickLink`, `safeGoto` throw. |

The links case is the one that mattered most. `<a href="/users/7/delete">Delete</a>` is
not a button, so it was inventoried as an ordinary link and then **fetched by the crawler
itself** — the destructive action fired with nothing having "clicked" anything.

### How matching works

`isDenied` folds the text before comparing:

```
NFKD  ->  strip diacritics  ->  NFKC  ->  remove zero-width  ->  collapse whitespace  ->  lowercase
```

and then tests each deny term with **word boundaries**, plus a second pass with all
internal spacing removed.

| Input | Result | Why |
|---|---|---|
| `Delete`, `DELETE` | denied | |
| `Ｄelete` | denied | fullwidth → NFKC |
| `Délete` | denied | diacritic stripped |
| `Dele<ZWSP>te` | denied | zero-width removed |
| `Rem ove` | denied | space-squashed pass |
| `Repay loan` | **allowed** | word boundary — `pay` does not match inside `repay` |
| `Payment history` | **allowed** | word boundary |
| `Undelete` | **allowed** | word boundary |
| `Removal notes` | **allowed** | word boundary |

Those last four matter as much as the first four. A deny-list that silently withholds safe
controls means nobody ever tests them and nobody notices why.

Multi-word terms match **in any order within a window**, because word order is not
reliable: the term `close account` has to catch the route `/account/close`, which reads as
"account close" once separators become spaces.

`isDeniedUrl` turns `/_-+.=&?` into spaces, decodes percent-encoding, runs the same
matcher, and additionally checks a fixed verb list (`delete|destroy|remove|purge|drop|
wipe|erase|revoke|deactivate|unsubscribe|terminate`) for routes the label-oriented
deny-list would not know about.

### `safeClick` checks the element, not the selector

```ts
await safeClick(page, /Dele.e/);   // throws
```

The guard resolves the locator and inspects what it actually matched — `aria-label`,
`textContent`, `title`, `value`, `href`, and the enclosing `<form action>`. Checking the
*selector text* meant any regex that did not literally spell the word sailed through, and
regex locators are exactly what generated specs use.

It also refuses to act on an ambiguous locator: if two buttons match, it throws rather
than guessing which one.

Verified against a live page — every one of these is refused, and only `Enable` is
actually clicked:

```
CLICKED  Enable (safe)
REFUSED  Delete (plain)
REFUSED  /^Dele.e$/                    resolved element matches denyList
REFUSED  button aria-label="Confirm" with text "Delete"
REFUSED  "Continue" submitting to /account/close
REFUSED  link "Details" pointing at /users/7/delete
```

Both candidate names are checked — `aria-label` *and* visible text. Checking only one let
a `Delete` button labelled `aria-label="Confirm"` pass as safe, and in the other direction
produced false positives.

## What the deny-list does NOT cover

Stated plainly, because every one of these is reachable.

**It is a vocabulary, not a concept.** It knows the words you configured. It will not
catch `Supprimer`, `Löschen`, `删除`, or any label in a language you have not listed. If
your target is not in English, the default list is empty in practice until you fill it in.
It also will not catch a phrasing you did not anticipate — `Yes, I'm sure`, `Empty cart`,
`Wipe all data` are in the shipped config only because they were thought of.

**It is evaluated at harvest time.** `harvest()` runs one `page.evaluate` against the DOM
as it stands after `domcontentloaded` plus a short quiet period. A control rendered later
— inside a modal, behind a click, by a late script, by an infinite scroll — is never
classified, because it was not there to classify.

**It does not understand intent.** A button reading `Submit` that posts to an endpoint
which happens to delete something is invisible unless the *action URL* gives it away. The
form check helps here, but only when the action is on the `<form>` element.

**It does not wrap the MCP browser.** During Phase 5 the model drives Playwright through
MCP directly. Nothing intercepts that tool call. Withholding destructive labels from the
inventory removes the realistic path to one — the model plans from `buttons`, and the
label is not there — but it is **not a hard interlock**. A model that decides to click
something by coordinate, or navigates to a URL it constructed, is not stopped by anything
in this repo.

**Crawling is not free of side effects even when nothing is clicked.** A `GET` that
changes state is a design flaw in the target, not something this tool can detect in
advance. `isDeniedUrl` catches the obvious names; it cannot catch `/api/v2/items/7?op=x`.

### The one-line summary

> Withholding destructive labels from the inventory makes the deny-list a property of the
> data rather than advice in a prompt. That is a meaningful reduction in risk. It is not
> a guarantee, and this tool does not offer one.
>
> **Run against staging, with disposable data, on a site you own.**

## Report injection

`src/report.ts` renders strings that came from the target site. Three defences:

1. **`esc()` on every interpolation** — `& < > " '`. Numeric fields are coerced in
   `normalizePage` before they get near the template, because `?? 0` on a value that is
   actually a string leaves the string in place.
2. **`safeHref()` on every `href`** — permits `http`, `https` and relative paths only.
   `esc()` alone is no defence here: it leaves `javascript:alert(1)` completely intact,
   and finding URLs and evidence links are both rendered as anchors.
3. **Path confinement in `thumb()`** — a screenshot path must resolve inside
   `output/screenshots` and carry an image extension. Without it a record reading
   `"screenshot": "../.env"` caused the report to base64 your `.env` into
   `report.html` — which CI then uploaded as an artifact.

All three are regression-tested in `src/guards.test.ts`.

## Reporting a problem

If you find a way past any of this, the useful bug report is the **input**: the label, the
URL, the JSONL line. Add it to `src/guards.test.ts` as a failing case first — every test
in that file is a real bug that was found this way.
