/**
 * Authorization-scan logic tests. Offline: no browser, no network.
 *
 * The danger with this scanner is not a false alarm, it is silence - reporting "no
 * problems" when it never actually reached anything, or when the two personas are the same
 * account. Both of those happened during development and both are tested here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, reachedResource, sameResource, sharedIdentity } from "./authz-check.js";
import type { QaConfig } from "./config.js";
import type { Persona } from "./personas.js";

const LOGIN_PAGE = `<form action="/login"><input name="password" type="password"></form>`;
const RESOURCE = `<h1>Invoice 4021</h1><p>${"x".repeat(2000)}</p>`;

test("a 200 that renders a login form has NOT reached the resource", () => {
  assert.equal(reachedResource(classify(200, LOGIN_PAGE)), false);
});

test("a 200 with real content has reached the resource", () => {
  assert.equal(reachedResource(classify(200, RESOURCE)), true);
});

test("redirects and errors have not reached the resource", () => {
  for (const status of [301, 302, 401, 403, 404, 500]) {
    assert.equal(reachedResource(classify(status, RESOURCE)), false, `status ${status}`);
  }
});

test("two responses of near-identical size are the same resource", () => {
  const a = classify(200, RESOURCE);
  const b = classify(200, RESOURCE + "  ");
  assert.equal(sameResource(a, b), true);
});

test("a much smaller response is a different page, not the resource", () => {
  const a = classify(200, RESOURCE);
  const b = classify(200, "<p>You do not have access to this invoice.</p>");
  assert.equal(sameResource(a, b), false);
});

test("a denied response never counts as the same resource, whatever its size", () => {
  const a = classify(200, RESOURCE);
  const b = classify(200, LOGIN_PAGE.padEnd(RESOURCE.length, " "));
  assert.equal(sameResource(a, b), false);
});

// ---------------------------------------------------------------- shared identity

const persona = (id: string): Persona => ({
  id,
  role: id,
  email: `${id}@t.test`,
  password: "x",
  statePath: `/nonexistent/${id}.json`,
  createdAt: "",
});

const cfgWith = (personas: QaConfig["personas"]): QaConfig => ({ personas }) as QaConfig;

test("two personas configured with the same username are one identity", () => {
  const shared = sharedIdentity(
    [persona("alice"), persona("bob")],
    cfgWith([
      { id: "alice", username: "tomsmith" },
      { id: "bob", username: "tomsmith" },
    ]),
  );
  assert.deepEqual(shared, ["alice", "bob"]);
});

test("distinct usernames are distinct identities", () => {
  const shared = sharedIdentity(
    [persona("alice"), persona("bob")],
    cfgWith([
      { id: "alice", username: "alice" },
      { id: "bob", username: "bob" },
    ]),
  );
  assert.deepEqual(shared, []);
});

test("personas with no username configured are not assumed to collide", () => {
  // They sign up for their own accounts by email; absence of a username proves nothing.
  const shared = sharedIdentity(
    [persona("alice"), persona("bob")],
    cfgWith([{ id: "alice" }, { id: "bob" }]),
  );
  assert.deepEqual(shared, []);
});

test("sharedIdentity tolerates a missing config", () => {
  assert.deepEqual(sharedIdentity([persona("alice")]), []);
});
