/**
 * Extra tests for the email surface's offline helpers: provider selection and the
 * plus-addressed test-email builder. No network: no inbox is created.
 *
 * GMAIL_USER is overridden with a fake address for the duration of each test and
 * restored afterwards; its real value (from .env) is never read into an assertion message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestEmail, getProvider } from "./email/lib.js";

function withGmailUser<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env["GMAIL_USER"];
  if (value === undefined) delete process.env["GMAIL_USER"];
  else process.env["GMAIL_USER"] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env["GMAIL_USER"];
    else process.env["GMAIL_USER"] = prev;
  }
}

const PATTERN = "{GMAIL_LOCAL}+{runId}-{n}@gmail.com";

test("buildTestEmail fills the qa.config.json pattern from the local part", () => {
  const got = withGmailUser("qa.tester@gmail.com", () => buildTestEmail(PATTERN, "r42", 3));
  assert.equal(got, "qa.tester+r42-3@gmail.com");
});

test("buildTestEmail accepts a numeric run id and n=0", () => {
  const got = withGmailUser("qa.tester@gmail.com", () => buildTestEmail(PATTERN, 1700000000, 0));
  assert.equal(got, "qa.tester+1700000000-0@gmail.com");
});

test("buildTestEmail refuses to guess when GMAIL_USER is unset or empty", () => {
  for (const v of [undefined, ""]) {
    assert.throws(
      () => withGmailUser(v, () => buildTestEmail(PATTERN, "r", 1)),
      /GMAIL_USER/,
      `GMAIL_USER=${JSON.stringify(v)}`,
    );
  }
});

test(
  "buildTestEmail does not interpret $ sequences in the local part",
  { todo: "T-04: buildTestEmail uses String.replace with a string replacement, so '$&' in GMAIL_USER is expanded" },
  () => {
    // `$` is legal in an email local part; String.replace with a string replacement treats
    // "$&" / "$'" specially, which splices the placeholder back into the address
    // (observed: "a{GMAIL_LOCAL}b+r-1@gmail.com").
    const got = withGmailUser("a$&b@gmail.com", () => buildTestEmail(PATTERN, "r", 1));
    assert.equal(got, "a$&b+r-1@gmail.com");
  },
);

test("getProvider resolves the known providers by name", () => {
  assert.equal(getProvider("mailtm").name, "mailtm");
  assert.equal(getProvider("imap").name, "imap");
});

test("getProvider rejects an unknown name with the list of valid ones", () => {
  assert.throws(() => getProvider("smtp"), /Unknown email provider "smtp".*imap.*mailtm/);
});

test(
  "getProvider rejects names that only exist on Object.prototype",
  { todo: "T-03: PROVIDERS lookup is a plain object, so 'constructor'/'toString' resolve to a function, not an error" },
  () => {
    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      assert.throws(() => getProvider(name), /Unknown email provider/, name);
    }
  },
);
