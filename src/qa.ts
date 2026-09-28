/**
 * One-command pipeline: crawl -> authenticated crawl -> tests -> report.
 *
 *   npm run qa
 *
 * Written as a script rather than a chain of && so it behaves the same on Windows and
 * POSIX, and so the report is still produced when the test step fails - a failing suite
 * is exactly when you most want to look at the report.
 *
 * Exit code: non-zero if any critical/high finding is present, or a step other than the
 * test step failed. Test failures alone do not mask the report.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.js";

const OUT = resolve(ROOT, "output");

interface Step {
  name: string;
  argv: string[];
  /** A failure here is reported but does not stop the pipeline. */
  soft?: boolean;
  /** Skip when this returns false. */
  when?: () => boolean;
}

const steps: Step[] = [
  { name: "crawl (anon)", argv: ["tsx", "src/crawl.ts", "--mode=anon"] },
  // The test run comes FIRST, because its `setup` project is what logs in and writes
  // output/auth/state.json. With the authenticated crawl ordered ahead of it, a fresh
  // checkout never had a session yet, the `when` guard reported a clean skip, and CI
  // silently never crawled a single authenticated page - on every run, forever.
  { name: "playwright test", argv: ["playwright", "test"], soft: true },
  {
    name: "crawl (auth)",
    argv: ["tsx", "src/crawl.ts", "--mode=auth"],
    soft: true,
    // Needs a saved session; skip cleanly rather than failing the run.
    when: () => existsSync(resolve(OUT, "auth", "state.json")),
  },
  // Soft: a dirty build should still produce a report saying so, rather than stopping
  // here. The gate at the end is what turns critical/high findings into a non-zero exit.
  {
    name: "authorization scan",
    argv: ["tsx", "src/authz-check.ts"],
    soft: true,
    // Needs the authenticated crawl above to have produced something to probe.
    when: () => existsSync(resolve(OUT, "pages.auth.jsonl")),
  },
  { name: "pre-deploy scan", argv: ["tsx", "src/deploy-check.ts"], soft: true },
  { name: "coverage", argv: ["tsx", "src/coverage.ts"], soft: true },
  { name: "report", argv: ["tsx", "src/report.ts"] },
];

function run(step: Step): number {
  console.log(`\n${"=".repeat(60)}\n> ${step.name}\n${"=".repeat(60)}`);
  const res = spawnSync("npx", step.argv, {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd: ROOT,
  });
  if (res.error) {
    // Distinguish "could not start npx at all" from "the step ran and failed".
    console.error(`Could not run "${step.name}": ${res.error.message}`);
    return 127;
  }
  return res.status ?? 1;
}

interface Finding {
  severity?: string;
}

function highSeverityCount(): number {
  let n = 0;
  // Exploration findings and pre-deploy findings both gate the build.
  for (const name of ["findings.jsonl", "deploy-findings.jsonl", "authz-findings.jsonl"]) {
    const file = resolve(OUT, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const sev = (JSON.parse(line) as Finding).severity;
        if (sev === "critical" || sev === "high") n++;
      } catch {
        // ignore a partial line
      }
    }
  }
  return n;
}

const failures: string[] = [];
const skipped: string[] = [];

for (const step of steps) {
  if (step.when && !step.when()) {
    skipped.push(step.name);
    console.log(`\n- skipped: ${step.name} (no saved session at output/auth/state.json)`);
    continue;
  }
  const code = run(step);
  if (code !== 0) {
    failures.push(step.name);
    if (!step.soft) {
      console.error(`\nStep "${step.name}" failed (exit ${code}) and is required. Stopping.`);
      process.exit(code);
    }
    console.error(`\nStep "${step.name}" failed (exit ${code}); continuing so the report is still built.`);
  }
}

const blocking = highSeverityCount();
const findingsFile = resolve(OUT, "findings.jsonl");
console.log(`\n${"=".repeat(60)}`);
console.log(`steps failed:  ${failures.length ? failures.join(", ") : "none"}`);
if (skipped.length) console.log(`steps skipped: ${skipped.join(", ")}`);
if (!existsSync(findingsFile)) {
  // output/ is gitignored, so on a fresh CI checkout this file does not exist and the
  // "fail the build on a critical finding" gate can never fire. Say so out loud rather
  // than printing a reassuring "0".
  console.log(
    `critical/high findings: n/a - no output/findings.jsonl in this workspace.\n` +
      `  Findings come from the Phase 5 exploration session and are not produced by this\n` +
      `  pipeline. A CI run cannot gate on them unless that file is restored first.`,
  );
} else {
  console.log(`critical/high findings: ${blocking}`);
}
console.log(`report: output/report.html`);

if (blocking > 0) {
  console.error(`\nExiting non-zero: ${blocking} critical/high finding(s).`);
  process.exit(1);
}
process.exit(failures.length ? 1 : 0);
