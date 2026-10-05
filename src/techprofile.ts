/**
 * What is this site built on?
 *
 * Reads two things the pipeline already has - the response headers and the rendered HTML -
 * and names the server, the framework, the CDN, the analytics, the CMS and the security
 * posture. Every detector is a pure function over (headers, html), so the whole thing is
 * tested offline and the runner at the bottom is the only part that touches the network.
 *
 * A deliberate line, the same one drawn for CAPTCHA: this REPORTS a fingerprint, it does
 * not act on one. Naming "nginx, Next.js, Cloudflare" is analysis; using that to tailor an
 * attack is not what this file is for.
 *
 * Cookie and header VALUES are never recorded - only names and presence - because
 * output files are shareable and CLAUDE.md forbids session material leaving the machine.
 */

export interface Detected {
  name: string;
  /** How sure: a header is "confirmed", a markup guess is "likely". */
  confidence: "confirmed" | "likely";
  /** The signal that matched. Safe to show - never a header value that could be a secret. */
  evidence: string;
}

export interface TechProfile {
  url: string;
  server: Detected[];
  frameworks: Detected[];
  cdn: Detected[];
  cms: Detected[];
  analytics: Detected[];
  languages: Detected[];
  /** Security-relevant response headers, by presence. */
  securityHeaders: { name: string; present: boolean }[];
  /** Cookie NAMES set on the response, plus their flags - never the values. */
  cookies: { name: string; secure: boolean; httpOnly: boolean; sameSite: string | null }[];
  /** Raw headers worth showing, values redacted where they could carry a secret. */
  notableHeaders: { name: string; value: string }[];
}

/** Case-insensitive header lookup over a plain record or a Headers-like map. */
export function headerGet(headers: Record<string, string>, name: string): string | null {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return null;
}

interface HeaderRule {
  header: string;
  re: RegExp;
  name: string;
  /** When set, the capture group becomes part of the reported name (e.g. a version). */
  withMatch?: boolean;
}

const SERVER_RULES: HeaderRule[] = [
  { header: "server", re: /nginx(?:\/([\d.]+))?/i, name: "nginx", withMatch: true },
  { header: "server", re: /apache(?:\/([\d.]+))?/i, name: "Apache", withMatch: true },
  { header: "server", re: /microsoft-iis(?:\/([\d.]+))?/i, name: "IIS", withMatch: true },
  { header: "server", re: /caddy/i, name: "Caddy" },
  { header: "server", re: /\bgws\b/i, name: "Google Web Server" },
  { header: "server", re: /cowboy/i, name: "Cowboy (Erlang)" },
  { header: "server", re: /\bwerkzeug\b/i, name: "Werkzeug (Python dev server)" },
  { header: "server", re: /gunicorn/i, name: "Gunicorn" },
  { header: "server", re: /\bexpress\b/i, name: "Express" },
  { header: "server", re: /heroku/i, name: "Heroku" },
  { header: "via", re: /vegur|heroku-router/i, name: "Heroku (router)" },
  { header: "server", re: /railway/i, name: "Railway" },
  { header: "server", re: /fly\.io/i, name: "Fly.io" },
];

const POWERED_RULES: HeaderRule[] = [
  { header: "x-powered-by", re: /php(?:\/([\d.]+))?/i, name: "PHP", withMatch: true },
  { header: "x-powered-by", re: /asp\.net/i, name: "ASP.NET" },
  { header: "x-powered-by", re: /express/i, name: "Express" },
  { header: "x-powered-by", re: /next\.js/i, name: "Next.js" },
  { header: "x-powered-by", re: /servlet/i, name: "Java Servlet" },
];

const CDN_RULES: HeaderRule[] = [
  { header: "server", re: /cloudflare/i, name: "Cloudflare" },
  { header: "cf-ray", re: /.+/, name: "Cloudflare" },
  { header: "x-served-by", re: /cache-/i, name: "Fastly" },
  { header: "x-fastly-request-id", re: /.+/, name: "Fastly" },
  { header: "x-amz-cf-id", re: /.+/, name: "Amazon CloudFront" },
  { header: "x-akamai-transformed", re: /.+/, name: "Akamai" },
  { header: "x-vercel-id", re: /.+/, name: "Vercel" },
  { header: "x-nf-request-id", re: /.+/, name: "Netlify" },
  { header: "x-github-request-id", re: /.+/, name: "GitHub Pages" },
];

interface HtmlRule {
  re: RegExp;
  name: string;
}

const FRAMEWORK_RULES: HtmlRule[] = [
  { re: /<[^>]+\bng-version=["']([\d.]+)/i, name: "Angular" },
  { re: /\bng-app\b|\bng-controller\b/i, name: "AngularJS (1.x)" },
  { re: /<div[^>]+id=["']root["'][^>]*>\s*<\/div>|\b__REACT_DEVTOOLS/i, name: "React (likely)" },
  { re: /data-reactroot|react(?:-dom)?(?:\.production)?(?:\.min)?\.js/i, name: "React" },
  { re: /\b__NEXT_DATA__\b|\/_next\//i, name: "Next.js" },
  { re: /\bdata-v-[0-9a-f]{8}\b|\bvue(?:\.min)?\.js/i, name: "Vue" },
  { re: /\b__NUXT__\b|\/_nuxt\//i, name: "Nuxt" },
  { re: /\bsvelte-[0-9a-z]{6}\b/i, name: "Svelte" },
  { re: /\b__sveltekit|\/_app\/immutable\//i, name: "SvelteKit" },
  { re: /jquery(?:-([\d.]+))?(?:\.min)?\.js/i, name: "jQuery" },
  { re: /foundation(?:\.min)?\.js|\bzurb\b/i, name: "Foundation" },
  { re: /bootstrap(?:\.bundle)?(?:\.min)?\.(?:js|css)/i, name: "Bootstrap" },
  { re: /\bember(?:\.min)?\.js|\bdata-ember/i, name: "Ember" },
  { re: /\bbackbone(?:\.min)?\.js/i, name: "Backbone" },
  { re: /\balpine(?:js)?(?:\.min)?\.js|\bx-data\b/i, name: "Alpine.js" },
  { re: /\bhtmx(?:\.min)?\.js|\bhx-get\b|\bhx-post\b/i, name: "htmx" },
];

const CMS_RULES: HtmlRule[] = [
  { re: /<meta[^>]+name=["']generator["'][^>]+content=["']wordpress[^"']*/i, name: "WordPress" },
  { re: /\/wp-content\/|\/wp-includes\//i, name: "WordPress" },
  { re: /<meta[^>]+name=["']generator["'][^>]+content=["']drupal[^"']*/i, name: "Drupal" },
  { re: /\/sites\/default\/files\//i, name: "Drupal (likely)" },
  { re: /<meta[^>]+name=["']generator["'][^>]+content=["']joomla[^"']*/i, name: "Joomla" },
  { re: /\bShopify\.theme\b|cdn\.shopify\.com/i, name: "Shopify" },
  { re: /\bwix\.com\b|static\.wixstatic\.com/i, name: "Wix" },
  { re: /\bsquarespace\b/i, name: "Squarespace" },
  { re: /\bGhost\b.{0,30}content=["']Ghost/i, name: "Ghost" },
];

const ANALYTICS_RULES: HtmlRule[] = [
  { re: /googletagmanager\.com\/gtm\.js|\bGTM-[A-Z0-9]+/i, name: "Google Tag Manager" },
  { re: /google-analytics\.com\/analytics\.js|gtag\/js\?id=|\bUA-\d+|\bG-[A-Z0-9]+/i, name: "Google Analytics" },
  { re: /connect\.facebook\.net\/.+\/fbevents\.js|\bfbq\(/i, name: "Meta Pixel" },
  { re: /cdn\.segment\.com|analytics\.min\.js.{0,40}segment/i, name: "Segment" },
  { re: /\bhotjar\b|static\.hotjar\.com/i, name: "Hotjar" },
  { re: /\bmixpanel\b/i, name: "Mixpanel" },
  { re: /optimizely\.com|\boptimizely\b/i, name: "Optimizely" },
  { re: /cdn\.amplitude\.com|\bamplitude\b/i, name: "Amplitude" },
  { re: /\bplausible\.io\b/i, name: "Plausible" },
];

/** Security headers the deploy scan also cares about; here it is presence, there it is depth. */
const SECURITY_HEADERS = [
  "content-security-policy",
  "strict-transport-security",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
];

/** Headers worth showing whose values are not secret. */
const NOTABLE_HEADERS = ["server", "x-powered-by", "via", "x-generator", "content-type"];

function runHeaderRules(headers: Record<string, string>, rules: HeaderRule[]): Detected[] {
  const out: Detected[] = [];
  for (const rule of rules) {
    const value = headerGet(headers, rule.header);
    if (!value) continue;
    const m = rule.re.exec(value);
    if (!m) continue;
    const version = rule.withMatch && m[1] ? ` ${m[1]}` : "";
    const name = `${rule.name}${version}`;
    if (out.some((d) => d.name === name)) continue;
    out.push({ name, confidence: "confirmed", evidence: `${rule.header}: ${value.slice(0, 60)}` });
  }
  return out;
}

function runHtmlRules(html: string, rules: HtmlRule[], confidence: Detected["confidence"]): Detected[] {
  const out: Detected[] = [];
  for (const rule of rules) {
    const m = rule.re.exec(html);
    if (!m) continue;
    if (out.some((d) => d.name === rule.name)) continue;
    out.push({ name: rule.name, confidence, evidence: m[0].replace(/\s+/g, " ").slice(0, 70) });
  }
  return out;
}

/** Parse Set-Cookie names and flags. Values are dropped on the floor on purpose. */
export function parseCookies(setCookie: string[]): TechProfile["cookies"] {
  const out: TechProfile["cookies"] = [];
  for (const line of setCookie) {
    const name = line.split("=")[0]?.trim();
    if (!name) continue;
    const lower = line.toLowerCase();
    const sameSite = /samesite=([a-z]+)/i.exec(line);
    out.push({
      name,
      secure: /;\s*secure(?:;|$)/i.test(lower),
      httpOnly: /;\s*httponly(?:;|$)/i.test(lower),
      sameSite: sameSite ? (sameSite[1] ?? null) : null,
    });
  }
  return out;
}

/**
 * Build a profile from headers and HTML.
 *
 * `setCookie` is separate because Set-Cookie legitimately repeats and a flat record would
 * collapse several cookies into one.
 */
export function buildProfile(
  url: string,
  headers: Record<string, string>,
  html: string,
  setCookie: string[] = [],
): TechProfile {
  const powered = runHeaderRules(headers, POWERED_RULES);

  // A framework confirmed by a header outranks the same name guessed from markup.
  const fromHtml = runHtmlRules(html, FRAMEWORK_RULES, "likely");
  const frameworks = [
    ...powered.filter((p) => ["Next.js", "ASP.NET", "Express", "Java Servlet"].includes(p.name)),
    ...fromHtml.filter((f) => !powered.some((p) => f.name.startsWith(p.name))),
  ];

  return {
    url,
    server: runHeaderRules(headers, SERVER_RULES),
    frameworks,
    cdn: runHeaderRules(headers, CDN_RULES),
    cms: runHtmlRules(html, CMS_RULES, "likely"),
    analytics: runHtmlRules(html, ANALYTICS_RULES, "likely"),
    // startsWith, not includes: the PHP rule appends a version, so the name is "PHP 8.2.4".
    languages: powered.filter((p) => p.name.startsWith("PHP") || p.name.startsWith("ASP.NET")),
    securityHeaders: SECURITY_HEADERS.map((h) => ({ name: h, present: headerGet(headers, h) !== null })),
    cookies: parseCookies(setCookie),
    notableHeaders: NOTABLE_HEADERS.map((h) => ({ name: h, value: headerGet(headers, h) ?? "" })).filter(
      (x) => x.value,
    ),
  };
}

// ---------------------------------------------------------------- runner

/**
 * Collect a profile for the configured target.
 *
 * Headers come from one polite GET of the base URL. The HTML prefers the rendered DOM the
 * crawler already saved under output/content/ - free, and it sees script-injected markers
 * the served bytes miss - and falls back to the fetched body when no crawl has run yet.
 */
async function main(): Promise<void> {
  const { loadConfig, OUT } = await import("./config.js");
  const { polite } = await import("./polite.js");
  const { slugify } = await import("./crawl.js");
  const { readFileSync, writeFileSync, existsSync, readdirSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const cfg = loadConfig();
  if (!cfg.baseUrl) throw new Error("Set baseUrl in the config first.");
  console.log(`Profiling ${cfg.baseUrl}\n`);

  let headers: Record<string, string> = {};
  let setCookie: string[] = [];
  let fetchedHtml = "";
  try {
    const res = await polite().fetch(cfg.baseUrl, { redirect: "manual" });
    headers = Object.fromEntries([...res.headers.entries()]);
    setCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    fetchedHtml = await res.text();
  } catch (err) {
    console.log(`  could not reach ${cfg.baseUrl}: ${err instanceof Error ? err.message : err}`);
  }

  // Prefer the richest saved page: the rendered DOM exposes frameworks the shell hides.
  let html = fetchedHtml;
  const contentDir = resolve(OUT, "content");
  const baseSaved = resolve(contentDir, `${slugify(cfg.baseUrl)}.html`);
  if (existsSync(baseSaved)) {
    html = readFileSync(baseSaved, "utf8");
  } else if (existsSync(contentDir)) {
    const biggest = readdirSync(contentDir)
      .filter((f) => f.endsWith(".html"))
      .map((f) => ({ f, size: readFileSync(resolve(contentDir, f), "utf8").length }))
      .sort((a, b) => b.size - a.size)[0];
    if (biggest) html = readFileSync(resolve(contentDir, biggest.f), "utf8");
  }

  const profile = buildProfile(cfg.baseUrl, headers, html, setCookie);
  writeFileSync(resolve(OUT, "techprofile.json"), `${JSON.stringify(profile, null, 2)}\n`);

  const line = (label: string, items: Detected[]): void => {
    if (items.length) console.log(`  ${label.padEnd(12)} ${items.map((i) => i.name).join(", ")}`);
  };
  line("server", profile.server);
  line("framework", profile.frameworks);
  line("cdn", profile.cdn);
  line("cms", profile.cms);
  line("analytics", profile.analytics);
  line("language", profile.languages);
  const missing = profile.securityHeaders.filter((h) => !h.present).map((h) => h.name);
  if (missing.length) console.log(`  ${"missing hdrs".padEnd(12)} ${missing.join(", ")}`);
  console.log(`\nwrote ${resolve(OUT, "techprofile.json")}`);
}

if (process.argv[1]?.endsWith("techprofile.ts")) void main();
