/**
 * Human-facing description of every config field: the single source of truth the config
 * editor renders from.
 *
 * It is kept beside the Zod schema rather than generated from it, because the schema knows
 * types and defaults but not what a field is FOR - and a config page whose help text is
 * "string" is no easier to use than editing the JSON by hand, which is the whole thing this
 * is meant to replace. A sanity test asserts this list and the schema name the same fields,
 * so the two cannot drift apart silently.
 */

export type FieldType = "url" | "string" | "number" | "boolean" | "stringList";

export interface FieldMeta {
  key: string;
  label: string;
  group: string;
  type: FieldType;
  help: string;
  default?: unknown;
  min?: number;
  max?: number;
  placeholder?: string;
  /** A field that moves money, deletes data or sends mail if set wrong. Flagged in the UI. */
  sensitive?: boolean;
}

export const GROUPS = [
  "Target",
  "Crawl budget",
  "Politeness & rate limits",
  "Capture",
  "Safety",
  "Testing",
  "Email",
] as const;

export const FIELDS: FieldMeta[] = [
  // ---- Target
  {
    key: "baseUrl",
    label: "Base URL",
    group: "Target",
    type: "url",
    help: "The site to test. Everything starts here. Only test a site you own or have written permission to test.",
    placeholder: "https://example.com",
  },
  {
    key: "allowedOrigins",
    label: "Allowed origins",
    group: "Target",
    type: "stringList",
    help: "The only origins the agent may ever contact. A request to anything not on this list is refused, not just skipped.",
    placeholder: "https://example.com",
  },
  {
    key: "include",
    label: "Include patterns",
    group: "Target",
    type: "stringList",
    help: "Regular expressions; if set, only URLs matching at least one are crawled. Leave empty to crawl everything in scope.",
  },
  {
    key: "exclude",
    label: "Exclude patterns",
    group: "Target",
    type: "stringList",
    help: "Regular expressions for URLs to skip even when in scope, e.g. a logout link or a huge media directory.",
  },

  // ---- Crawl budget
  { key: "maxPages", label: "Max pages", group: "Crawl budget", type: "number", min: 1, default: 60,
    help: "How many pages one crawl may fetch. The main brake on how long a run takes and how much it costs the target." },
  { key: "maxDepth", label: "Max depth", group: "Crawl budget", type: "number", min: 1, default: 4,
    help: "How many links deep from the start page the crawl will follow." },
  { key: "concurrency", label: "Concurrency", group: "Crawl budget", type: "number", min: 1, default: 2,
    help: "How many pages are fetched at once. Keep this low for someone else's site - 1 or 2. Four parallel crawls once knocked a demo site offline." },
  { key: "navTimeoutMs", label: "Navigation timeout (ms)", group: "Crawl budget", type: "number", min: 1000, default: 90000,
    help: "How long to wait for one page to load before giving up on it." },
  { key: "maxRuntimeMs", label: "Max runtime (ms)", group: "Crawl budget", type: "number", min: 1000, default: 1800000,
    help: "A hard wall-clock cap on one crawl, so a single hung page cannot stall the run forever." },

  // ---- Politeness & rate limits
  { key: "requestDelayMs", label: "Request delay (ms)", group: "Politeness & rate limits", type: "number", min: 0, default: 250,
    help: "Minimum gap between two requests to the SAME origin. This is the setting that PREVENTS rate limiting rather than reacting to it. Raise it for a fragile target; 0 removes spacing (only for a site you own)." },
  { key: "maxRequests", label: "Request budget", group: "Politeness & rate limits", type: "number", min: 0, default: 2000,
    help: "Hard ceiling on total requests for one step (crawl, pre-deploy scan, ...), counting page loads as well as fetches. Each step of npm run qa is its own process with its own budget, and the Playwright suite is not counted at all. 0 means no cap - use only against your own infrastructure." },
  { key: "rateLimitBreakAfter", label: "Break after N rate-limits", group: "Politeness & rate limits", type: "number", min: 1, default: 5,
    help: "After this many 429/503 answers in a row from one origin, the agent stops touching it - because everything after that point is the throttling, not the site." },
  { key: "rateLimitRetries", label: "Rate-limit retries", group: "Politeness & rate limits", type: "number", min: 0, default: 3,
    help: "How many times to back off and retry a single URL that answered 429 or a gateway error before giving up on it." },

  // ---- Capture
  { key: "savePageHtml", label: "Save rendered HTML", group: "Capture", type: "boolean", default: true,
    help: "Save each page's rendered DOM so the pre-deploy scan reuses it instead of fetching every page a second time. Halves the requests a full run makes." },
  { key: "savePageHtmlMaxBytes", label: "Saved HTML cap (bytes)", group: "Capture", type: "number", min: 1000, default: 300000,
    help: "Per-page limit on saved HTML. A 500KB page is not 500KB of interesting content." },
  { key: "captureHttpHistory", label: "Capture HTTP history", group: "Capture", type: "boolean", default: false,
    help: "Record full request/response pairs for the Burp XML export and the header audit. Off by default because the capture contains live session cookies - keep the output private." },
  { key: "captureMaxBodyBytes", label: "Capture body cap (bytes)", group: "Capture", type: "number", min: 0, default: 50000,
    help: "Per-exchange limit on captured response bodies when HTTP history is on." },
  { key: "captureOffOrigin", label: "Capture off-origin", group: "Capture", type: "boolean", default: false,
    help: "Let the browser load third-party scripts, fonts and analytics. Off by default: blocking them is faster and keeps a slow CDN from hanging a page." },

  // ---- Safety
  { key: "denyList", label: "Deny list", group: "Safety", type: "stringList", sensitive: true,
    help: "Words and phrases the agent will never click, submit or navigate: delete, transfer, pay, cancel... Treated as a vocabulary for a concept - a control that destroys or spends something is withheld even if its exact word is not listed." },
  { key: "denyUrlExceptions", label: "Deny-list URL exceptions", group: "Safety", type: "stringList",
    help: "Regular expressions for URL paths that look destructive but are known-safe to visit, e.g. a demo's /add_remove_elements/ page. Matched against the path only, never the query string." },
  { key: "blockDomains", label: "Blocked domains", group: "Safety", type: "stringList",
    help: "Third-party domains to always block, used only when 'Capture off-origin' is on." },

  // ---- Testing
  { key: "testWorkers", label: "Test workers", group: "Testing", type: "number", min: 1, default: 1,
    help: "How many Playwright workers run the generated suite in parallel. 1 is kindest to a shared target and avoids the suite racing itself." },

  // ---- Email
  { key: "emailProvider", label: "Email provider", group: "Email", type: "string", default: "mailtm",
    help: "How test inboxes are created: 'mailtm' (disposable, no credentials) or 'imap' (a real mailbox via Gmail plus-addressing)." },
  { key: "emailPattern", label: "Email pattern", group: "Email", type: "string",
    help: "Template for test addresses, e.g. {GMAIL_LOCAL}+{runId}-{n}@gmail.com. Used by signup flows that verify by email." },
];
