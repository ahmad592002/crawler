/**
 * Extra tests for the persona store's offline readers. No network: loadPersonas (which
 * creates mailboxes) is not called. The store lives in a temp QA_OUT so the real
 * output/auth/personas.json - which holds passwords - is never touched.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const box = mkdtempSync(join(tmpdir(), "qa-personas-"));
process.env.QA_OUT = box;
const p = await import("./personas.js");

after(() => rmSync(box, { recursive: true, force: true }));

const authDir = resolve(box, "auth");
const store = resolve(authDir, "personas.json");

const SECRET_PW = "Qa-alice-pw!7-do-not-print";
const SECRET_MB = "mailbox-secret-do-not-print";

function writeStore(content: string): void {
  mkdirSync(authDir, { recursive: true });
  writeFileSync(store, content);
}

test("statePathFor puts each persona's session under QA_OUT/auth", () => {
  assert.equal(p.statePathFor("alice"), resolve(authDir, "state.alice.json"));
  assert.notEqual(p.statePathFor("alice"), p.statePathFor("bob"));
});

test("knownPersonas is empty with no store, and with a corrupt store", () => {
  rmSync(store, { force: true });
  assert.deepEqual(p.knownPersonas(), []);
  writeStore("{ not json");
  assert.deepEqual(p.knownPersonas(), []);
});

test("knownPersonas and personaById read what is on disk", () => {
  writeStore(
    JSON.stringify({
      baseUrl: "https://example.test",
      provider: "mailtm",
      personas: {
        alice: {
          id: "alice",
          role: "owner",
          email: "alice@example.test",
          password: SECRET_PW,
          mailboxSecret: SECRET_MB,
          statePath: p.statePathFor("alice"),
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }),
  );
  assert.deepEqual(p.knownPersonas().map((x) => x.id), ["alice"]);
  assert.equal(p.personaById("alice").email, "alice@example.test");
});

test("personaById names the missing id and says how to fix it", () => {
  assert.throws(
    () => p.personaById("mallory"),
    (err: Error) => /"mallory"/.test(err.message) && /personas/.test(err.message) && /setup/.test(err.message),
  );
});

test("describePersona never prints the password or mailbox secret", () => {
  const alice = p.personaById("alice");
  const s = p.describePersona(alice);
  assert.ok(!s.includes(SECRET_PW), "password leaked");
  assert.ok(!s.includes(SECRET_MB), "mailbox secret leaked");
  assert.match(s, /^alice \(owner\) <alice@example\.test> session=none$/);
});

test("describePersona reports a saved session when the state file exists", () => {
  const alice = p.personaById("alice");
  writeFileSync(alice.statePath, "{}");
  assert.match(p.describePersona(alice), /session=saved$/);
});
