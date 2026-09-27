# Data formats

Everything in `output/` is either JSONL (one JSON object per line, appended as work
completes) or a rendered artefact. JSONL is used so an interrupted run still leaves a
readable file, and so a resumed run can read back what it already did.

Every reader in this repo **skips lines that fail to parse**, which is how a truncated
last line from a killed process is tolerated.

```
output/
├── pages.jsonl           PageRecord   anonymous crawl
├── pages.auth.jsonl      PageRecord   authenticated crawl
├── findings.jsonl        Finding      written by Claude (Phase 5)
├── features.jsonl        Feature      written by Claude (Phase 5)
├── progress.json         Progress     checkpoint for resuming Phase 5
├── http-history.jsonl    HttpExchange appended per exchange during capture
├── http-history.xml                   Burp proxy-history, serialised at the end
├── pw-results.json                    Playwright JSON reporter
├── pw-report/                         Playwright HTML report (contains traces)
├── screenshots/                       full-page JPEGs
├── auth/state.json                    saved session — TREAT AS A SECRET
└── report.html                        the deliverable
```

`output/` is gitignored in full.

## PageRecord — `pages.jsonl`, `pages.auth.jsonl`

Defined in `src/crawl.ts`.

| Field | Type | Notes |
|---|---|---|
| `url` | string | Exactly as requested — trailing slash, path case and `%2F` preserved. |
| `template` | string | `templateOf(dedupKey(url))`. Path ids collapsed, query values kept. |
| `depth` | number | Link hops from the seed. |
| `status` | number \| null | `null` means the navigation never completed. |
| `title` | string | `document.title`. |
| `loadMs` | number | Wall clock for `goto` + the quiet period. |
| `screenshot` | string \| null | Path relative to `output/`, or null if it failed. |
| `consoleErrors` | string[] | `console.error` texts, each capped at 300 chars. |
| `failedRequests` | `{url, status}[]` | Subresources that failed or returned ≥ 400. Capped at 20. |
| `pageErrors` | string[] | Uncaught page exceptions, plus `navigation:` / `harvest:` failures. |
| `forms` | FormInfo[] | See below. |
| `buttons` | string[] | **Safe** controls only. Deduped, capped at 40. |
| `deniedButtons` | string[] | Withheld by the deny-list. Never offered as targets. |
| `deniedLinks` | string[] | Links withheld by the deny-list. Never queued or fetched. |
| `links` | number | Count of `a[href]`. |
| `authRequired` | boolean | Redirected somewhere that looks like a login page. |
| `ok` | boolean | Navigation succeeded. **A resume only skips pages where this is true.** |
| `mode` | `"anon"` \| `"auth"` | |
| `crawledAt` | string | ISO 8601. |

```ts
interface FormInfo {
  action: string;
  method: string;              // lowercased; defaults to "get"
  fields: FormField[];         // hidden inputs excluded
  destructive: boolean;        // action URL or any submit label hits the deny-list
}

interface FormField {
  name: string;                // name, falling back to id
  type: string;                // input type, or the tag name for select/textarea
  label: string;               // <label for>, wrapping <label>, aria-label, placeholder, name
  required: boolean;           // required attribute or aria-required="true"
}
```

`buttons` and `deniedButtons` hold the **display** name. Classification considers both
`aria-label` and visible text; the display name is `aria-label` when present, else text.

### The `ok` field and resuming

`ok: false` records are written — you want to see that a page failed — but
`previousUrls()` excludes them from the resume set, so the page is retried. Older files
without the field fall back to `status !== null`.

## Finding — `findings.jsonl`

Written by Claude during Phase 5. Read by `src/report.ts` and by the exit gate in
`src/qa.ts`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | `F-001`, `F-002`, … Referenced from the generated spec. |
| `severity` | `critical`\|`high`\|`medium`\|`low` | yes | **`critical` and `high` fail `npm run qa`.** An unrecognised value renders as `medium` rather than being dropped. |
| `url` | string | yes | Rendered as a link only if `http`/`https`/relative. |
| `template` | string | no | |
| `feature` | string | no | Shown as the row title. |
| `steps` | string[] | no | Numbered reproduction steps. |
| `expected` | string | no | |
| `actual` | string | no | |
| `evidence` | string | no | A URL becomes a link; free text renders as text. |
| `details` / `notes` | string | no | |

```json
{"id":"F-001","severity":"critical","url":"https://site/forgot_password",
 "feature":"Forgot password",
 "steps":["Open /forgot_password","Enter any value","Click 'Retrieve password'"],
 "expected":"A confirmation, or a validation error for a malformed address.",
 "actual":"HTTP 500 for every input tried.",
 "evidence":"probe: POST /forgot_password -> 500 in all 3 cases"}
```

## Feature — `features.jsonl`

The map of what has been understood and covered.

| Field | Type | Notes |
|---|---|---|
| `feature` | string | Name. |
| `template` / `url` | string | Where it lives. |
| `description` | string | What it does, in behavioural terms. |
| `casesPassed` | string[] | Cases verified to behave correctly. |
| `spec` | string | The spec file that encodes them. |

```json
{"feature":"Login","url":"https://site/login",
 "description":"Form login posting to /authenticate. Sets a session cookie, redirects to /secure.",
 "casesPassed":["valid credentials reach /secure","wrong password is rejected",
                "/secure is not reachable while signed out"],
 "spec":"tests/auth.spec.ts"}
```

## Progress — `progress.json`

A single object, rewritten after each unit of work so a `/clear`-ed session can resume.

```json
{
  "phase": 5,
  "updatedAt": "2026-09-27T14:29:46.489Z",
  "completedTemplates": ["https://site/login", "https://site/secure"],
  "skippedDestructive": [
    {"url": "https://site/dynamic_controls", "control": "Remove", "reason": "matches denyList"}
  ],
  "notes": "Remaining templates are widget demos with no server-side behaviour to assert."
}
```

`notes` is where the reason for stopping goes. "I stopped because the rest is
rendering-only" and "I stopped because I ran out of context" need to be distinguishable
by the next session.

## HttpExchange — `http-history.jsonl`

One line per response, appended as it completes. See [burp-export.md](burp-export.md).

| Field | Type | Notes |
|---|---|---|
| `time` | string | ISO 8601. Converted to Java `Date.toString()` form in the XML. |
| `url`, `host`, `ip`, `port`, `protocol`, `method`, `path` | | `ip` from `response.serverAddr()`, empty when unavailable. |
| `extension` | string | From the path only. The literal `"null"` when there is none, matching Burp. |
| `request` | string | base64 of the raw request message. |
| `status` | number | |
| `responseLength` | number | **Byte length of the whole raw response message** — status line + headers + body. Burp's semantics. |
| `mimeType` | string | Burp's short token: `HTML`, `JSON`, `script`, `CSS`, `XML`, `IMG`, `text`, `font`, `app`. |
| `response` | string | base64 of the raw response message. |
| `truncated` | boolean? | Present only when the body was cut. |
| `fullBodyLength` | number? | The original body length, present only when truncated. |

> **This file contains every `Cookie` and `Authorization` header that was sent.** On a
> `crawl:auth` run that is your live session. Treat it as a secret.

## Consuming this from your own tooling

The formats are stable and boring on purpose. A few things to rely on:

- **JSONL, one object per line, append-only.** Tail it live if you want.
- **Skip unparseable lines.** Do not assume the last line is complete.
- **Dedupe `pages.jsonl` by `url`, keeping the last.** A retried page appears twice.
- **`templateOf` is the grouping key**, not `url`.

```bash
# pages that errored
jq -c 'select(.ok == false or (.status // 0) >= 400)' output/pages.jsonl

# every destructive control the crawl found and withheld
jq -r 'select(.deniedButtons != []) | "\(.url)\t\(.deniedButtons | join(", "))"' output/pages.jsonl

# blocking findings
jq -c 'select(.severity == "critical" or .severity == "high")' output/findings.jsonl

# slowest ten
jq -s 'sort_by(-.loadMs)[:10] | .[] | "\(.loadMs)ms\t\(.url)"' -r output/pages.jsonl
```
