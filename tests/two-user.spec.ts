/**
 * Two-user tests: the shapes that a single session cannot check at all.
 *
 * Four patterns worth copying, in the order they usually matter:
 *
 *   1. ISOLATION  - A's session and B's session really are different people
 *   2. VISIBILITY - what A creates, B can (or cannot) see
 *   3. AUTHORIZATION - B cannot reach A's resource by URL, and neither can a stranger
 *   4. HANDOFF   - A invites/shares, B receives it in their own mailbox
 *
 * The demo target has no multi-user features, so 2 and 4 are written against it as
 * skipped templates rather than removed - the structure is the point, and it is the part
 * that is easy to get subtly wrong.
 */
import {
  test,
  expect,
  safeClick,
  safeGoto,
  safeGotoResponse,
  withTwoUsers,
  openAs,
  openAnonymous,
} from "./fixtures.js";
import { knownPersonas } from "../src/personas.js";

const personas = knownPersonas();
const haveTwo = personas.length >= 2;
const [A, B] = personas.map((p) => p.id);

test.describe("two users", () => {
  test.skip(!haveTwo, 'Needs two personas in qa.config.json, then: npx playwright test --project=setup');

  // ---------------------------------------------------------------- 1. isolation
  test("the two sessions are genuinely different identities", async ({ browser }) => {
    await withTwoUsers(browser, A!, B!, async (userA, userB) => {
      await Promise.all([userA.page.goto("/secure"), userB.page.goto("/secure")]);

      // Separate contexts mean separate cookie jars. If these ever match, the personas
      // are sharing one session and every test below is silently proving nothing.
      const [cookiesA, cookiesB] = await Promise.all([
        userA.context.cookies(),
        userB.context.cookies(),
      ]);
      const sid = (list: { name: string; value: string }[]): string | undefined =>
        list.find((c) => /session|sid|auth|token/i.test(c.name))?.value;

      expect(cookiesA.length).toBeGreaterThan(0);
      expect(cookiesB.length).toBeGreaterThan(0);
      if (sid(cookiesA) && sid(cookiesB)) {
        expect(sid(cookiesA), "both personas hold the same session cookie").not.toBe(sid(cookiesB));
      }
    });
  });

  test("each persona has its own mailbox", () => {
    const emails = personas.map((p) => p.email).filter(Boolean);
    expect(new Set(emails).size, "two personas share one mailbox").toBe(emails.length);
  });

  // ---------------------------------------------------------------- 2. visibility
  test.skip("what A creates, B cannot see", async ({ browser }) => {
    await withTwoUsers(browser, A!, B!, async (userA, userB) => {
      // A creates something private.
      await userA.page.goto("/documents/new");
      await userA.page.getByLabel("Title").fill(`private-${Date.now()}`);
      await safeClick(userA.page, "Create");
      const url = userA.page.url();

      // B, signed in as themselves, must not find it in their own listing.
      await userB.page.goto("/documents");
      await expect(userB.page.getByText("private-")).toHaveCount(0);

      // And must not reach it by URL either - the check people forget.
      const res = await safeGotoResponse(userB.page, url);
      expect(res?.status(), "B could open A's document directly").toBeGreaterThanOrEqual(400);
    });
  });

  // ---------------------------------------------------------------- 3. authorization
  test.skip("a stranger cannot reach a resource either", async ({ browser }) => {
    const userA = await openAs(browser, A!);
    const stranger = await openAnonymous(browser);
    try {
      await userA.page.goto("/documents/new");
      await safeClick(userA.page, "Create");
      const url = userA.page.url();

      const res = await safeGotoResponse(stranger.page, url);
      // 200 here is the bug that matters: protected from other users, public to the world.
      expect(res?.status(), "signed-out visitor could open the resource").toBeGreaterThanOrEqual(400);
    } finally {
      await Promise.allSettled([userA.close(), stranger.close()]);
    }
  });

  // ---------------------------------------------------------------- 4. handoff
  test.skip("A invites B, and B receives it", async ({ browser }) => {
    await withTwoUsers(browser, A!, B!, async (userA, userB) => {
      // Recorded before the invite is sent, so an older invite cannot satisfy this test.
      const { waitForEmail, extractLinks } = await import("../src/email/lib.js");
      const since = new Date();

      await userA.page.goto("/team/invite");
      await userA.page.getByLabel(/email/i).fill(userB.persona.email);
      await safeClick(userA.page, /invite|send/i);
      await expect(userA.page.getByText(/invitation sent/i)).toBeVisible();

      // The invite must arrive in B's OWN mailbox - this is why personas own real inboxes.
      const mail = await waitForEmail({ to: userB.persona.email, since, timeoutSec: 120 });
      const [link] = extractLinks(`${mail.text}\n${mail.html}`, "invite");
      expect(link, "no invitation link in the email B received").toBeTruthy();

      await safeGoto(userB.page, link!);
      await safeClick(userB.page, /accept/i);

      // Both sides must agree afterwards, which is the half that usually breaks.
      await expect(userB.page.getByText(/you (have )?joined/i)).toBeVisible();
      await userA.page.goto("/team");
      await expect(userA.page.getByText(userB.persona.email)).toBeVisible();
    });
  });
});
