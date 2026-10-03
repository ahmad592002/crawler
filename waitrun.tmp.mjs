/**
 * Wait for the target to recover, then run the suite once.
 *
 * Polls preflight every 4 minutes (8 cheap requests) rather than hammering, and gives up
 * after 40 minutes rather than looping forever. The suite is only started once preflight
 * says the target is healthy, because a run against a degraded box produces failures that
 * belong to the box.
 */
import { execFileSync, spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args) =>
  spawnSync(npm, args, { encoding: "utf8", shell: process.platform === "win32" });

const DEADLINE = Date.now() + 40 * 60_000;
let attempt = 0;

while (Date.now() < DEADLINE) {
  attempt++;
  const r = run(["run", "preflight"]);
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const healthy = /Target looks healthy/.test(out);
  const slowest = [...out.matchAll(/(\d+)ms/g)].map((m) => +m[1]).sort((a, b) => b - a)[0] ?? -1;
  console.log(`[attempt ${attempt}] healthy=${healthy} slowestProbe=${slowest}ms`);

  if (healthy) {
    console.log("--- target healthy, running the suite with testWorkers=1 ---");
    const suite = run(["test"]);
    const text = (suite.stdout ?? "") + (suite.stderr ?? "");
    console.log(text.split("\n").slice(-14).join("\n"));
    process.exit(0);
  }

  // Idle between checks without a foreground sleep: block this child process only.
  execFileSync(process.execPath, ["-e", "setTimeout(()=>{}, 240000)"], { stdio: "ignore" });
}

console.log("gave up waiting: the target did not recover within 40 minutes");
process.exit(1);
