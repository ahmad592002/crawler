/**
 * Is the target healthy enough to test against?
 *
 * A full suite run once produced twenty red tests across eight unrelated spec files. The
 * cause was not the suite: the target's HTML was serving 200 in under a second while every
 * SUBRESOURCE - jquery.min.js, jquery-ui.js, foundation.js, the stylesheets, the images -
 * came back 503. Pages loaded and then did nothing, so assertions failed all over the map
 * and each one looked like a separate bug.
 *
 * Checking health by fetching the home page is not enough, and I got that wrong twice:
 * the document is cheap to serve and comes back fine while the dyno refuses everything
 * else. So this fetches the page AND the scripts and stylesheets it actually references.
 *
 * Run it before a suite. A red suite caused by someone else's overloaded demo box costs
 * more than the minute this takes, because it sends you looking for a regression that
 * is not there.
 */
import { loadConfig, isAllowedUrl, isDeniedUrl, type QaConfig } from "./config.js";
import { polite } from "./polite.js";

interface Probe {
  url: string;
  status: number | string;
  ms: number;
}

/** Same-origin scripts and stylesheets referenced by a page, in document order. */
export function subresources(html: string, base: string, limit = 10): string[] {
  const out: string[] = [];
  const add = (raw: string): void => {
    try {
      const u = new URL(raw, base).toString();
      if (!out.includes(u)) out.push(u);
    } catch {
      /* not a URL */
    }
  };

  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) add(m[1] ?? "");
  for (const m of html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)) {
    const href = /href=["']([^"']+)["']/i.exec(m[0]);
    if (href) add(href[1] ?? "");
  }
  return out.slice(0, limit);
}

async function probe(url: string, timeoutMs: number, redirect: RequestRedirect = "follow"): Promise<Probe> {
  const started = Date.now();
  try {
    const res = await polite().fetch(url, { redirect, signal: AbortSignal.timeout(timeoutMs) });
    // Drain the body: a server can answer with headers and then stall, which is exactly
    // the shape that makes a browser hang while a HEAD-only check looks healthy.
    await res.text();
    return { url, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return {
      url,
      status: err instanceof Error ? err.name : "error",
      ms: Date.now() - started,
    };
  }
}

export interface Health {
  healthy: boolean;
  reason: string;
  probes: Probe[];
}

/** Judge a set of probes. Exported so a test can drive it without a network. */
export function judgeHealth(probes: Probe[]): Health {
  const fifth = probes.filter((p) => typeof p.status === "number" && p.status >= 500).length;
  const broken = probes.filter((p) => typeof p.status !== "number").length;
  const bad = fifth + broken;

  if (probes.length === 0) {
    return { healthy: false, reason: "nothing could be probed at all", probes };
  }
  // The document alone is not the site. One 503 among the assets is enough to make a suite
  // fail in ways that look like code defects, so the bar here is deliberately low.
  if (bad > 0) {
    return {
      healthy: false,
      reason:
        `${bad} of ${probes.length} probe(s) failed or answered 5xx` +
        (fifth > 0
          ? ` - a target whose HTML serves fine while its scripts and stylesheets 503 will` +
            ` load pages that then do nothing, and the suite goes red everywhere at once`
          : ""),
      probes,
    };
  }

  const slow = probes.filter((p) => p.ms > 10_000).length;
  if (slow > 0) {
    return {
      healthy: false,
      reason: `${slow} of ${probes.length} probe(s) took over 10s - expect timeouts, not failures`,
      probes,
    };
  }
  return { healthy: true, reason: "", probes };
}

export async function checkHealth(cfg: QaConfig): Promise<Health> {
  const base = cfg.baseUrl;
  const timeoutMs = Math.min(cfg.navTimeoutMs, 30_000);

  const doc = await probe(base, timeoutMs);
  if (typeof doc.status !== "number" || doc.status >= 400) {
    return { healthy: false, reason: `the entry page answered ${doc.status}`, probes: [doc] };
  }

  let assets: string[] = [];
  try {
    const res = await polite().fetch(base, { signal: AbortSignal.timeout(timeoutMs) });
    // Deny-checked like every other requester: a <script src="/session/logout.js"> is as
    // much a GET as a followed link, and the scope check alone let it through.
    assets = subresources(await res.text(), base).filter(
      (u) => isAllowedUrl(u, cfg) && !isDeniedUrl(u, cfg),
    );
  } catch {
    /* already proved the document is reachable; carry on with none */
  }

  // Not followed: an asset's redirect target was never scope- or deny-checked. A 3xx is
  // an answer, and judgeHealth counts it as reachable.
  const probes = [doc, ...(await Promise.all(assets.map((u) => probe(u, timeoutMs, "manual"))))];
  return judgeHealth(probes);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`Preflight check of ${cfg.baseUrl}\n`);

  const health = await checkHealth(cfg);
  for (const p of health.probes) {
    const flag = typeof p.status === "number" && p.status < 400 ? " " : "!";
    console.log(`  ${flag} ${String(p.status).padEnd(8)} ${String(p.ms + "ms").padEnd(8)} ${p.url}`);
  }

  if (health.healthy) {
    console.log(`\nTarget looks healthy. ${health.probes.length} probe(s), no 5xx, none slow.`);
    return;
  }

  console.log(`\n${"!".repeat(60)}`);
  console.log(`TARGET IS NOT HEALTHY: ${health.reason}.`);
  console.log(`Running the suite now will produce failures that are not yours.`);
  console.log(`${"!".repeat(60)}`);
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("preflight.ts")) void main();
