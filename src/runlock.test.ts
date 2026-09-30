/**
 * Run-lock tests. Offline, and they clean up after themselves.
 *
 * The property that matters: a second crawl must be refused while a first is running, and
 * a lock left behind by a dead process must not block every future run forever.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { acquireLock, readLock, LockHeldError } from "./runlock.js";
import { ROOT } from "./config.js";

const OUT = resolve(ROOT, "output");
const NAME = "unit-test-lock";
const FILE = resolve(OUT, `${NAME}.lock`);

const clean = (): void => rmSync(FILE, { force: true });

test("acquiring writes a lock naming this process", () => {
  clean();
  const release = acquireLock(NAME, "anon");
  try {
    const info = readLock(NAME);
    assert.ok(info, "no lock file written");
    assert.equal(info.pid, process.pid);
    assert.equal(info.mode, "anon");
  } finally {
    release();
  }
});

test("releasing removes the lock", () => {
  clean();
  acquireLock(NAME, "anon")();
  assert.equal(existsSync(FILE), false);
});

test("a second acquire is refused while the first is held", () => {
  clean();
  const release = acquireLock(NAME, "anon");
  try {
    assert.throws(() => acquireLock(NAME, "auth"), LockHeldError);
  } finally {
    release();
  }
});

test("the refusal explains what to do about it", () => {
  clean();
  const release = acquireLock(NAME, "anon");
  try {
    acquireLock(NAME, "auth");
    assert.fail("expected a LockHeldError");
  } catch (err) {
    const msg = (err as Error).message;
    assert.match(msg, /already running/i);
    assert.match(msg, new RegExp(`output/${NAME}\\.lock`));
  } finally {
    release();
  }
});

test("releasing twice is harmless", () => {
  clean();
  const release = acquireLock(NAME, "anon");
  release();
  release();
  assert.equal(existsSync(FILE), false);
});

test("a lock from a dead process is cleared, not obeyed forever", () => {
  clean();
  mkdirSync(OUT, { recursive: true });
  // PID 999999 is above the default Linux pid_max and not a live Windows process.
    // Same host, so the pid is trusted and its absence means dead.
  writeFileSync(
    FILE,
    JSON.stringify({
      pid: 999999,
      mode: "anon",
      startedAt: new Date().toISOString(),
      host: hostname(),
    }),
  );

  const release = acquireLock(NAME, "anon");
  try {
    assert.equal(readLock(NAME)?.pid, process.pid, "did not take over the dead lock");
  } finally {
    release();
  }
});

test("a lock older than the stale window is cleared even if the pid looks alive", () => {
  clean();
  mkdirSync(OUT, { recursive: true });
  // Our own pid, so the liveness check passes - only age can clear this one.
  writeFileSync(
    FILE,
    JSON.stringify({
      pid: process.pid,
      mode: "anon",
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      host: hostname(),
    }),
  );

  const release = acquireLock(NAME, "anon");
  try {
    assert.ok(Date.now() - Date.parse(readLock(NAME)!.startedAt) < 60_000, "lock was not refreshed");
  } finally {
    release();
  }
});


test("holding a lock does not keep the process alive after release", () => {
  // Regression: handlers were attached per-acquire, and a signal listener keeps the Node
  // event loop referenced. The unit suite passed but then sat for 37 minutes before
  // exiting. Assert the listeners are actually gone once nothing is held.
  clean();
  const before = process.listenerCount("SIGINT");

  const a = acquireLock(NAME, "anon");
  const b = acquireLock(`${NAME}-2`, "auth");
  assert.ok(process.listenerCount("SIGINT") > before, "handlers were never attached");

  a();
  b();
  rmSync(resolve(OUT, `${NAME}-2.lock`), { force: true });

  assert.equal(
    process.listenerCount("SIGINT"),
    before,
    "signal listeners survived release - the process will not exit on its own",
  );
});

test("many acquire/release cycles do not accumulate listeners", () => {
  clean();
  const before = process.listenerCount("SIGINT");
  for (let i = 0; i < 20; i++) acquireLock(NAME, "anon")();
  assert.equal(process.listenerCount("SIGINT"), before);
});

// ------------------------------------------------- audit round 1 regressions

test("an EMPTY lock file reads as held, not as stale", () => {
  // A process that died between creating the file and writing to it left an empty lock.
  // readLock used to return startedAt=epoch, which the age check saw as 29 million minutes
  // old and cleared - so the lock was silently stolen and two crawls ran.
  clean();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(FILE, "");
  try {
    assert.throws(() => acquireLock(NAME, "anon"), LockHeldError);
  } finally {
    clean();
  }
});

test("a corrupt lock file reads as held", () => {
  clean();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(FILE, "{ this is not json");
  try {
    assert.throws(() => acquireLock(NAME, "anon"), LockHeldError);
  } finally {
    clean();
  }
});

test("release does not delete a lock that is no longer ours", () => {
  // After our lock is retired, whatever replaced it belongs to someone else. Removing by
  // path unlocked a live crawl and cascaded to the next one.
  clean();
  const release = acquireLock(NAME, "anon");
  writeFileSync(
    FILE,
    JSON.stringify({ pid: 424242, mode: "auth", startedAt: new Date().toISOString(), host: "other" }),
  );
  release();
  try {
    assert.equal(existsSync(FILE), true, "release deleted someone else's lock");
    assert.equal(readLock(NAME)?.pid, 424242);
  } finally {
    clean();
  }
});

test("a lock from another host is never judged dead by pid", () => {
  // output/ can live in a synced folder; pid 1234 elsewhere says nothing about pid 1234
  // here. Only the age window may retire a foreign lock.
  clean();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    FILE,
    JSON.stringify({ pid: 999999, mode: "anon", startedAt: new Date().toISOString(), host: "some-other-machine" }),
  );
  try {
    assert.throws(() => acquireLock(NAME, "anon"), LockHeldError);
  } finally {
    clean();
  }
});

test("the lock written is complete, not an empty file", () => {
  clean();
  const release = acquireLock(NAME, "anon");
  try {
    const raw = readFileSync(FILE, "utf8");
    assert.ok(raw.trim().length > 0, "lock file is empty");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.pid, process.pid);
    assert.ok(parsed.host);
  } finally {
    release();
  }
});

// ------------------------------------------------- audit round 3 regressions

test("an unreadable lock ages out instead of blocking forever", () => {
  // Round 1 made an empty lock instantly stale (stealable). Round 2 over-corrected to a
  // timestamp recomputed on every read, so age was always ~0 and the lock was IMMORTAL -
  // one truncated byte meant the crawler refused forever. mtime is the honest age.
  clean();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(FILE, "");

  // Held while fresh.
  assert.throws(() => acquireLock(NAME, "anon"), LockHeldError);

  // Backdate the file past the stale window; it must now be retired.
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(FILE, old, old);
  const release = acquireLock(NAME, "anon");
  try {
    assert.equal(readLock(NAME)?.pid, process.pid, "stale unreadable lock was not retired");
  } finally {
    release();
    clean();
  }
});

test("readLock reports a STABLE age for an unreadable lock", () => {
  clean();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(FILE, "not json");
  try {
    const a = readLock(NAME)?.startedAt;
    const b = readLock(NAME)?.startedAt;
    assert.equal(a, b, "age is recomputed per read, so the lock can never go stale");
  } finally {
    clean();
  }
});

test("an owner CAN release its own lock after the file is truncated under it", () => {
  // Otherwise the owner leaves an unreadable lock behind, which is then immortal.
  clean();
  const release = acquireLock(NAME, "anon");
  writeFileSync(FILE, "");
  release();
  assert.equal(existsSync(FILE), false, "owner could not clear its own corrupted lock");
});

test("retiring a lock that changed under us does not steal it", () => {
  // Two processes both decide a lock is stale; the first retires it and acquires. The
  // second's retire must NOT move the first's live lock aside - that produced two holders.
  clean();
  mkdirSync(OUT, { recursive: true });
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  writeFileSync(
    FILE,
    JSON.stringify({ pid: 999999, mode: "anon", startedAt: old.toISOString(), host: hostname() }),
  );

  // P1 takes it legitimately.
  const release = acquireLock(NAME, "anon");
  try {
    // P2 now decides based on the OLD info it had already read. Simulated by asking again:
    // the live lock is fresh and ours, so it must be refused, not retired.
    assert.throws(() => acquireLock(NAME, "auth"), LockHeldError);
    assert.equal(readLock(NAME)?.pid, process.pid, "a live lock was retired out from under us");
  } finally {
    release();
    clean();
  }
});

test("retiring leaves no litter behind", () => {
  clean();
  mkdirSync(OUT, { recursive: true });
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  writeFileSync(
    FILE,
    JSON.stringify({ pid: 999999, mode: "anon", startedAt: old.toISOString(), host: hostname() }),
  );
  acquireLock(NAME, "anon")();

  const litter = readdirSync(OUT).filter((f) => f.startsWith(NAME) && /retir/.test(f));
  assert.deepEqual(litter, [], `retire left files behind: ${litter.join(", ")}`);
});
