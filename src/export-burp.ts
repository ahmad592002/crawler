/**
 * Serialize the captured HTTP exchanges to Burp proxy-history XML.
 *
 *   npm run export:burp
 *
 * Reads output/http-history.jsonl (written during the crawl) and writes
 * output/http-history.xml, importable via Burp's Proxy > HTTP history > Import,
 * or anything else that reads that schema.
 */
import { statSync } from "node:fs";
import { HISTORY_XML, readHistory, writeBurpXml } from "./http-history.js";

const items = readHistory();
if (items.length === 0) {
  console.error(
    "No exchanges in output/http-history.jsonl. Run a crawl first with captureHttpHistory enabled in qa.config.json.",
  );
  process.exit(1);
}

const count = writeBurpXml();
const mb = (statSync(HISTORY_XML).size / 1024 / 1024).toFixed(1);

const hosts = new Set(items.map((i) => i.host));
const withBody = items.filter((i) => i.response.length > 0).length;
const statuses = new Map<number, number>();
for (const i of items) statuses.set(i.status, (statuses.get(i.status) ?? 0) + 1);

console.log(`Wrote ${HISTORY_XML} (${mb} MB)`);
console.log(`  ${count} exchanges across ${hosts.size} host(s); ${withBody} with a response body`);
console.log(
  `  status codes: ${[...statuses.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s}×${n}`)
    .join("  ")}`,
);
