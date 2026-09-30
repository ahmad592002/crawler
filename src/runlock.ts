/**
 * Exclusive run lock for the crawler.
 *
 * The crawler appends to output/pages*.jsonl with no coordination whatsoever. Two crawls
 * running at once interleave their writes into one file, and nothing detects it: the
 * inventory ends up holding duplicate URLs, a record count that exceeds maxPages, and a
 * resume ledger that disagrees with itself.
 *
 * That is not hypothetical. output/pages.jsonl once held 64 records against maxPages 60,
 * with four URLs recorded twice - each pair a failed attempt followed by a clean 200 about
 * thirty seconds later, inside a single continuous run. The mechanism was never isolated,
 * and "two writers" remains the best explanation: killing an `npm run` wrapper does not
 * necessarily kill the tsx grandchild, which keeps appending while the next run starts.
 *
 * A lock does not prove that diagnosis. It does make the failure impossible going forward
 * and, if the duplicates ever recur while a lock is held, it rules the theory out - which
 * is worth as much.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "./config.js";

const OUT = resolve(ROOT, "output");

export interface LockInfo {
  pid: number;
  mode: string;
  startedAt: string;
  host: string;
}

/** A lock older than this is assumed to be from a process that died without cleaning up. */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

function lockPath(name: string): string {
  return resolve(OUT, `${name}.lock`);
}

/** Is this PID still alive? signal 0 tests for existence without touching the process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else - still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(name: string): LockInfo | null {
  const file = lockPath(name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LockInfo;
  } catch {
    // An unreadable lock file is still a lock; treat it as held by an unknown process.
    return { pid: -1, mode: "unknown", startedAt: new Date(0).toISOString(), host: "unknown" };
  }
}

export class LockHeldError extends Error {
  constructor(public readonly info: LockInfo, name: string) {
    super(
      `Another crawl is already running (pid ${info.pid}, mode ${info.mode}, started ` +
        `${info.startedAt}).\n` +
        `  Two crawlers appending to the same .jsonl corrupt the inventory silently.\n` +
        `  If that process is gone, remove output/${name}.lock and run again.`,
    );
    this.name = "LockHeldError";
  }
}

/**
 * Take the lock, or throw. Returns a release function.
 *
 * Uses O_EXCL so creation is atomic: two processes racing here cannot both succeed, which
 * a check-then-write would allow.
 */
export function acquireLock(name: string, mode: string): () => void {
  mkdirSync(OUT, { recursive: true });
  const file = lockPath(name);

  const existing = readLock(name);
  if (existing) {
    const age = Date.now() - Date.parse(existing.startedAt);
    const dead = existing.pid > 0 && !alive(existing.pid);
    const stale = Number.isFinite(age) && age > STALE_AFTER_MS;

    if (dead || stale) {
      console.log(
        `  clearing a ${dead ? "dead" : "stale"} lock from pid ${existing.pid}` +
          `${stale ? ` (${Math.round(age / 60000)} min old)` : ""}`,
      );
      rmSync(file, { force: true });
    } else {
      throw new LockHeldError(existing, name);
    }
  }

  const info: LockInfo = {
    pid: process.pid,
    mode,
    startedAt: new Date().toISOString(),
    host: process.env["COMPUTERNAME"] ?? process.env["HOSTNAME"] ?? "local",
  };

  let fd: number;
  try {
    // wx: create exclusively, fail if it already exists. Atomic on Windows and POSIX.
    fd = openSync(file, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LockHeldError(readLock(name) ?? info, name);
    }
    throw err;
  }
  closeSync(fd);
  writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`);

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    rmSync(file, { force: true });
    held.delete(release);
    // Drop the signal handlers once nothing is locked. Leaving them attached keeps the
    // Node event loop referenced, so a process with no other work will not exit - which
    // made the unit suite sit for 37 minutes after its last assertion instead of 2 seconds.
    if (held.size === 0) detachHandlers();
  };

  held.add(release);
  attachHandlers();
  return release;
}

// ---------------------------------------------------------------- crash safety

/**
 * Every lock this process currently holds.
 *
 * Handlers are attached once for the whole set rather than once per lock: registering a
 * fresh SIGINT listener on every acquire both leaks listeners and, because a signal
 * listener keeps the event loop alive, stops the process from ever exiting on its own.
 */
const held = new Set<() => void>();

const releaseAll = (): void => {
  for (const release of [...held]) release();
};

const onSignal = (): void => {
  releaseAll();
  process.exit(130);
};

let attached = false;

function attachHandlers(): void {
  if (attached) return;
  attached = true;
  process.on("exit", releaseAll);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

function detachHandlers(): void {
  if (!attached) return;
  attached = false;
  process.off("exit", releaseAll);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
}
