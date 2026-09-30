/**
 * Run-lock tests. Offline, and they clean up after themselves.
 *
 * The property that matters: a second crawl must be refused while a first is running, and
 * a lock left behind by a dead process must not block every future run forever.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
  writeFileSync(
    FILE,
    JSON.stringify({ pid: 999999, mode: "anon", startedAt: new Date().toISOString(), host: "gone" }),
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
      host: "old",
    }),
  );

  const release = acquireLock(NAME, "anon");
  try {
    assert.ok(Date.now() - Date.parse(readLock(NAME)!.startedAt) < 60_000, "lock was not refreshed");
  } finally {
    release();
  }
});

test("a corrupt lock file is treated as held, not ignored", () => {
  clean();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(FILE, "{ this is not json");
  try {
    // pid -1 never looks alive, so it is cleared - but readLock must not throw first.
    const info = readLock(NAME);
    assert.equal(info?.pid, -1);
    acquireLock(NAME, "anon")();
  } finally {
    clean();
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
