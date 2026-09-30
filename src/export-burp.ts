/**
 * Serialize a captured HTTP history to Burp proxy-history XML.
 *
 *   npm run export:burp            # each capture to its own XML
 *   npm run export:burp -- auth     # only the authenticated capture
 *   npm run export:burp -- merged   # one combined file, cookies from both runs
 *
 * Importable via Burp's Proxy > HTTP history > right-click > Import items, or anything else
 * that reads that schema.
 *
 * Per-capture is the default deliberately. The previous version always merged, so an
 * anonymous crawl produced a file containing every authenticated exchange - which is a
 * secret-handling problem, not a convenience one.
 */
import { statSync } from "node:fs";
import { historyFiles, historyJsonl, historyXml, readHistory, writeBurpXml } from "./http-history.js";

type Mode = "anon" | "auth";

const arg = (process.argv[2] ?? "").toLowerCase();
const merged = arg === "merged" || arg === "all";
const only: Mode | null = arg === "auth" ? "auth" : arg === "anon" ? "anon" : null;

if (historyFiles().length === 0) {
  console.error(
    "No capture found. Run a crawl with captureHttpHistory enabled in qa.config.json:\n" +
      "  npm run crawl        -> output/http-history.jsonl\n" +
      "  npm run crawl:auth   -> output/http-history.auth.jsonl",
  );
  process.exit(1);
}

function describe(label: string, file: string, count: number, items: ReturnType<typeof readHistory>): void {
  const mb = (statSync(file).size / 1024 / 1024).toFixed(1);
  const hosts = new Set(items.map((i) => i.host));
  const withCookie = items.filter((i) =>
    /(?:^|\r\n)cookie:/i.test(Buffer.from(i.request, "base64").toString("utf8")),
  ).length;
  const statuses = new Map<number, number>();
  for (const i of items) statuses.set(i.status, (statuses.get(i.status) ?? 0) + 1);

  console.log(`\n${label}: ${file} (${mb} MB)`);
  console.log(`  ${count} exchanges across ${hosts.size} host(s)`);
  console.log(
    `  status codes: ${[...statuses.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => `${s}x${n}`)
      .join("  ")}`,
  );
  if (withCookie > 0) {
    console.log(`  ${withCookie} request(s) carry a Cookie header - treat this file as a credential.`);
  }
}

const modes: Mode[] = only ? [only] : ["anon", "auth"];

if (merged) {
  const count = writeBurpXml("all");
  describe("merged", historyXml("all"), count, readHistory());
  console.log(
    `\nThis file contains BOTH captures. If either crawl was authenticated it carries a live\n` +
      `session cookie - do not attach it to a ticket or upload it as a CI artifact.`,
  );
} else {
  let wrote = 0;
  for (const mode of modes) {
    const items = readHistory(historyJsonl(mode));
    if (items.length === 0) continue;
    const count = writeBurpXml(mode);
    describe(mode, historyXml(mode), count, items);
    wrote++;
  }
  if (wrote === 0) {
    console.error(`No exchanges recorded for: ${modes.join(", ")}`);
    process.exit(1);
  }
}
