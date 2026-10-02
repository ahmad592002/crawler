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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, closeSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { ROOT, OUT } from "./config.js";


export interface LockInfo {
  pid: number;
  mode: string;
  startedAt: string;
  host: string;
}

/** A lock older than this is assumed to be from a process that died without cleaning up. */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** Identifies the machine, so a pid is only trusted where it was recorded. */
function hostName(): string {
  // os.hostname() is always defined. COMPUTERNAME/HOSTNAME are not: HOSTNAME is a shell
  // variable, absent under systemd units, Docker CMD, cron and most CI runners - so every
  // such machine reported "local", making sameHost true across machines and re-enabling
  // the cross-machine pid trust this function exists to prevent.
  try {
    return hostname() || "local";
  } catch {
    return process.env["COMPUTERNAME"] || "local";
  }
}

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
    // An unreadable lock file is still a lock and must READ as held - but it must also be
    // able to AGE OUT, or one truncated byte blocks every future crawl forever.
    //
    // Both wrong answers have now been shipped. epoch 0 made it instantly stale, so the
    // lock could be stolen. `new Date()` recomputed on every read made age always ~0, so
    // it was immortal and only a human deleting the file could recover. The file's mtime
    // is the honest answer to "how old is this lock", and it is stable across reads.
    let startedAt: string;
    try {
      startedAt = new Date(statSync(file).mtimeMs).toISOString();
    } catch {
      startedAt = new Date().toISOString();
    }
    return { pid: -1, mode: "unknown (unreadable lock)", startedAt, host: UNREADABLE_HOST };
  }
}

/** Marks a lock whose contents could not be parsed. Never a real hostname. */
export const UNREADABLE_HOST = "\u0000unreadable";

/** Read a lock from an explicit path. Used to verify what a retire actually moved. */
function readLockFrom(path: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockInfo;
  } catch {
    return null;
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

  const thisHost = hostName();
  const existing = readLock(name);
  if (existing) {
    const age = Date.now() - Date.parse(existing.startedAt);
    // A pid only means something on the machine that recorded it. output/ can live in a
    // synced folder (this repo sits under OneDrive), where pid 1234 on another machine is
    // unrelated to pid 1234 here - so liveness is only consulted for our own host.
    const sameHost = existing.host === thisHost;
    const dead = sameHost && existing.pid > 0 && !alive(existing.pid);
    const stale = Number.isFinite(age) && age > STALE_AFTER_MS;

    if (dead || stale) {
      console.log(
        `  retiring a ${dead ? "dead" : "stale"} lock from pid ${existing.pid}` +
          `${sameHost ? "" : ` on host ${existing.host}`}` +
          `${stale ? ` (${Math.round(age / 60000)} min old)` : ""}`,
      );
      // Retire by rename, then VERIFY what we moved.
      //
      // An unconditional rename does not close the double-acquire window, it relocates it:
      // two processes both decide a lock is stale, the first renames it aside and acquires,
      // and the second's rename then moves the FIRST's live lock out of the way - after
      // which both hold. Renaming to a private path and checking whose lock we actually
      // took means a loser detects it and puts it back instead of stealing.
      const aside = `${file}.retiring-${process.pid}-${Date.now().toString(36)}`;
      let moved = false;
      try {
        renameSync(file, aside);
        moved = true;
      } catch {
        // Someone else got there first; the `wx` create below decides between us.
      }

      if (moved) {
        const taken = readLockFrom(aside);
        // An unreadable lock has no owner to protect, and cannot be identity-checked at all -
        // requiring a match meant a corrupt lock could never be retired, which is the
        // immortal-lock bug by another route.
        const wasUnreadable = existing.host === UNREADABLE_HOST;
        const sameLock =
          wasUnreadable ||
          (taken !== null && taken.pid === existing.pid && taken.startedAt === existing.startedAt);
        if (!sameLock) {
          // We moved somebody else's lock - almost certainly a live one that replaced the
          // stale one between our read and our rename. Put it back and stand down.
          try {
            renameSync(aside, file);
          } catch {
            // Cannot restore; leaving the file aside would silently unlock a live crawl,
            // so report it rather than proceeding.
            throw new Error(
              `Lock arbitration failed: retired ${aside} but could not restore it. ` +
                `Check output/ for *.retiring-* files before crawling again.`,
            );
          }
          throw new LockHeldError(taken ?? existing, name);
        }
        // It was the stale lock we decided about. Discard it.
        rmSync(aside, { force: true });
      }
    } else {
      throw new LockHeldError(existing, name);
    }
  }

  const info: LockInfo = {
    pid: process.pid,
    mode,
    startedAt: new Date().toISOString(),
    host: thisHost,
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

  // Write THROUGH the descriptor we just created exclusively, then close. Creating the
  // file and writing it in two steps leaves a window - and, if the process dies inside it,
  // a permanent empty lock file - in which the lock describes nobody.
  try {
    writeFileSync(fd, `${JSON.stringify(info, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    // Only remove a lock that is still OURS. Removing by path meant a process exiting
    // after its own lock had been retired would delete whichever lock had replaced it -
    // unlocking a live crawl and cascading to the next one.
    //
    // An unreadable file is the exception: it cannot name an owner, and declining to touch
    // it meant a process whose own lock got truncated under it left that lock behind
    // permanently. We created this path and never saw another owner take it, so clearing
    // it is correct and is the only way out of that state.
    const current = readLock(name);
    const ours = current !== null && current.pid === process.pid && current.host === thisHost;
    const unreadable = current !== null && current.host === UNREADABLE_HOST;
    if (ours || unreadable) {
      rmSync(file, { force: true });
    }
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
