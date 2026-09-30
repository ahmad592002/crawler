/**
 * Coverage gaps: what did the crawl find that nothing tests?
 *
 *   npm run coverage
 *
 * The crawler produces an inventory of every page, form and control. The suite exercises
 * some subset of it. This compares the two and prints what is left over, so "we have
 * tests" can be replaced with "here is exactly what is untested".
 *
 * Three levels, because they fail differently:
 *   templates - a page shape nothing visits
 *   forms     - a form nothing submits (the highest-value gap)
 *   controls  - a button nothing clicks
 *
 * Reads only files already on disk. No browser, no network.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.js";
import type { PageRecord } from "./crawl.js";

const OUT = resolve(ROOT, "output");
const TESTS = resolve(ROOT, "tests");

export interface FeatureEntry {
  feature: string;
  template?: string;
  url?: string;
  casesPassed?: string[];
  spec?: string;
}

export interface CoverageGap {
  kind: "template" | "form" | "control";
  url: string;
  detail: string;
  /** Why this one matters more or less than its siblings. */
  weight: "high" | "medium" | "low";
}

export interface CoverageReport {
  generatedAt: string;
  templates: { total: number; covered: number; uncovered: string[] };
  forms: { total: number; covered: number };
  controls: { total: number; covered: number };
  specCount: number;
  gaps: CoverageGap[];
}

function readJsonl<T>(name: string): T[] {
  const file = resolve(OUT, name);
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* partial line */
    }
  }
  return out;
}

/**
 * Everything the specs actually reference, as one lowercased haystack.
 *
 * Deliberately crude: matching a URL path or a control label as a substring of the spec
 * source is a weaker signal than parsing the AST, but it never claims coverage that is not
 * literally written down somewhere, and it cannot be fooled into silence by a refactor.
 */
/**
 * Strip comments, so a path named only in a `// todo: test /checkboxes` cannot be counted
 * as coverage. A metric that credits an unwritten test is worse than no metric.
 */
export function stripComments(src: string): string {
  // A regex-based strip is not safe here. A `/*` inside a string literal pairs with the
  // next real `*/` and silently deletes everything between - which deletes coverage
  // EVIDENCE, so the metric under-reports and hides real gaps behind noise. This walks the
  // source tracking whether it is inside a string, so comment markers in data are data.
  let out = "";
  let i = 0;
  type Mode = "code" | "'" | '"' | "`" | "//" | "/*";
  let mode: Mode = "code";

  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];

    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "//";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        mode = "/*";
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") mode = c;
      out += c;
      i++;
      continue;
    }

    if (mode === "//") {
      if (c === "\n") {
        mode = "code";
        out += c;
      }
      i++;
      continue;
    }

    if (mode === "/*") {
      if (c === "*" && next === "/") {
        mode = "code";
        out += " ";
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    // Inside a string literal: copy verbatim, honour escapes, close on the same quote.
    out += c;
    if (c === "\\") {
      if (next !== undefined) out += next;
      i += 2;
      continue;
    }
    if (c === mode) mode = "code";
    i++;
  }

  return out;
}

function specHaystack(): { text: string; files: string[] } {
  if (!existsSync(TESTS)) return { text: "", files: [] };
  const files = readdirSync(TESTS).filter((f) => f.endsWith(".ts"));
  const text = files
    .map((f) => stripComments(readFileSync(resolve(TESTS, f), "utf8")))
    .join("\n")
    .toLowerCase();
  return { text, files };
}

/**
 * Does a spec actually NAVIGATE to this path, rather than merely contain the string?
 *
 * A bare substring test credited `/notification_message` to a spec that only ever visits
 * `/notification_message_rendered`, because the shorter path is a substring of the longer -
 * and once the anonymous-form fallback keys off the same signal, that laundered straight
 * into forms.covered. Requiring a quoted, terminated occurrence fixes both.
 */
export function visitsPath(haystack: string, path: string): boolean {
  if (path.length <= 1) return false;

  // Collapse an :id / :uuid segment so a template matches an interpolated navigation:
  // goto(`/users/${id}/invoice`) is a visit to /users/:id/invoice.
  const p = path
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:id|:uuid|:hash/g, "[^/\"'`]+");

  // Where the path may END: a closing quote, a trailing slash, a query/hash, or - inside a
  // template literal - an interpolation.
  const ends = `(?:/?["'\\\`]|[?#][^"'\\\`]*["'\\\`]|\\$\\{)`;

  // Requiring a NAVIGATION context is what separates a visit from a mention. Anchoring on
  // a quote alone credited `expect(text).toBe("/upload")` and bare array membership, while
  // rejecting goto(`${baseURL}/upload`) and every absolute URL - wrong in both directions.
  const nav = new RegExp(
    `(?:goto|tohaveurl|waitforurl|href\\s*=|request\\.(?:get|post|fetch))[^;\\n]{0,100}?${p}${ends}`,
    "i",
  );
  return nav.test(haystack);
}

/** The path part, which is what a spec realistically contains. */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname + u.search).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export function computeCoverage(
  pages: PageRecord[],
  features: FeatureEntry[],
  specs: { text: string; files: string[] },
): CoverageReport {
  // One entry per template; keep the record with the most to test.
  const byTemplate = new Map<string, PageRecord>();
  for (const p of pages) {
    if (p.ok === false) continue;
    // A page that does not EXIST is not an untested page - 404 and 410 are absent, and
    // counting them made coverage read 16% when the real figure over reachable pages was
    // far higher. A 5xx is different: the page exists and is broken, which is precisely
    // what you want counted. Excluding it let a site erroring under load RAISE its own
    // coverage score, and dropped the very page F-010 was found on.
    const status = p.status ?? 0;
    if (status === 404 || status === 410) continue;
    const prev = byTemplate.get(p.template);
    const score = (r: PageRecord): number => r.forms.length * 10 + r.buttons.length;
    if (!prev || score(p) > score(prev)) byTemplate.set(p.template, p);
  }

  const featureTemplates = new Set(features.map((f) => f.template ?? f.url ?? ""));
  const gaps: CoverageGap[] = [];
  const uncovered: string[] = [];

  let formsTotal = 0;
  let formsCovered = 0;
  let controlsTotal = 0;
  let controlsCovered = 0;
  let templatesCovered = 0;

  for (const [template, page] of byTemplate) {
    const path = pathOf(page.url);
    // A template counts as covered if a spec mentions its path, or Phase 5 mapped it.
    const inSpec = visitsPath(specs.text, path);
    const inFeatures = featureTemplates.has(template) || featureTemplates.has(page.url);
    const covered = inSpec || inFeatures;

    if (covered) templatesCovered++;
    else {
      uncovered.push(template);
      // A page with a form is a far more serious gap than a static page.
      gaps.push({
        kind: "template",
        url: page.url,
        detail:
          page.forms.length > 0
            ? `no test touches this page, and it has ${page.forms.length} form(s)`
            : page.buttons.length > 0
              ? `no test touches this page (${page.buttons.length} control(s))`
              : "no test touches this page",
        weight: page.forms.length > 0 ? "high" : page.buttons.length > 0 ? "medium" : "low",
      });
    }

    for (const form of page.forms) {
      formsTotal++;
      const action = (form.action || "").toLowerCase();
      const fieldsNamed = form.fields.filter((f) => f.name).map((f) => f.name.toLowerCase());

      // A form is covered when the spec references its action, or names a field of it.
      let hit =
        (action.length > 1 && specs.text.includes(action)) ||
        fieldsNamed.some((n) => n.length > 2 && specs.text.includes(n));

      // An anonymous form - no action, no named fields - offers nothing to key on, so the
      // rules above can NEVER credit it no matter how thoroughly it is tested. /checkboxes
      // is exactly that shape, and it stayed listed as untested after a spec was written
      // for it. Fall back to the page: if a spec visits this page, the form on it counts.
      if (!hit && action.length <= 1 && fieldsNamed.length === 0) {
        hit = inSpec;
      }
      if (hit) formsCovered++;
      else {
        gaps.push({
          kind: "form",
          url: page.url,
          detail: `form ${form.action || "(no action)"} [${form.method}] with ${form.fields.length} field(s): ${form.fields.map((f) => f.name || f.type).join(", ")}`,
          weight: "high",
        });
      }
    }

    for (const label of page.buttons) {
      controlsTotal++;
      if (specs.text.includes(label.toLowerCase())) controlsCovered++;
      else {
        gaps.push({
          kind: "control",
          url: page.url,
          detail: `button "${label}" is never clicked by any spec`,
          weight: "medium",
        });
      }
    }
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  gaps.sort((a, b) => order[a.weight] - order[b.weight]);

  return {
    generatedAt: new Date().toISOString(),
    templates: { total: byTemplate.size, covered: templatesCovered, uncovered },
    forms: { total: formsTotal, covered: formsCovered },
    controls: { total: controlsTotal, covered: controlsCovered },
    specCount: specs.files.length,
    gaps,
  };
}

function pct(n: number, d: number): string {
  if (d === 0) return "  n/a";
  return `${String(Math.round((n / d) * 100)).padStart(3)}%`;
}

function bar(n: number, d: number, width = 24): string {
  if (d === 0) return " ".repeat(width);
  const filled = Math.round((n / d) * width);
  return "#".repeat(filled) + "-".repeat(width - filled);
}

function main(): void {
  const pages = [...readJsonl<PageRecord>("pages.jsonl"), ...readJsonl<PageRecord>("pages.auth.jsonl")];
  const features = readJsonl<FeatureEntry>("features.jsonl");
  const specs = specHaystack();

  if (pages.length === 0) {
    console.error("No crawl data. Run `npm run crawl` first.");
    process.exit(1);
  }

  const cov = computeCoverage(pages, features, specs);
  writeFileSync(resolve(OUT, "coverage.json"), `${JSON.stringify(cov, null, 2)}\n`);

  console.log(`Coverage against ${cov.specCount} spec file(s)\n`);
  console.log(`  templates  ${bar(cov.templates.covered, cov.templates.total)}  ${pct(cov.templates.covered, cov.templates.total)}   ${cov.templates.covered}/${cov.templates.total}`);
  console.log(`  forms      ${bar(cov.forms.covered, cov.forms.total)}  ${pct(cov.forms.covered, cov.forms.total)}   ${cov.forms.covered}/${cov.forms.total}`);
  console.log(`  controls   ${bar(cov.controls.covered, cov.controls.total)}  ${pct(cov.controls.covered, cov.controls.total)}   ${cov.controls.covered}/${cov.controls.total}`);

  const high = cov.gaps.filter((g) => g.weight === "high");
  if (high.length) {
    console.log(`\nUNTESTED, AND THEY SUBMIT OR MUTATE SOMETHING (${high.length}):`);
    for (const g of high.slice(0, 20)) console.log(`  ${g.url}\n    ${g.detail}`);
    if (high.length > 20) console.log(`  ... and ${high.length - 20} more`);
  }

  const med = cov.gaps.filter((g) => g.weight === "medium");
  if (med.length) {
    console.log(`\nUNTESTED CONTROLS AND INTERACTIVE PAGES (${med.length}):`);
    for (const g of med.slice(0, 12)) console.log(`  ${g.url} - ${g.detail}`);
    if (med.length > 12) console.log(`  ... and ${med.length - 12} more`);
  }

  const low = cov.gaps.filter((g) => g.weight === "low").length;
  if (low) console.log(`\n${low} static page(s) untested (lower value - nothing to interact with).`);

  console.log(`\nwrote ${resolve(OUT, "coverage.json")}`);
  if (high.length) {
    console.log(`\nStart with the ${high.length} high-value gap(s): a form nobody submits is a feature nobody tests.`);
  }
}

if (process.argv[1]?.endsWith("coverage.ts")) main();
