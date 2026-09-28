/**
 * mail.tm disposable-inbox provider.
 *
 * Needs no credentials and no setup: each test registers a throwaway mailbox on a real,
 * publicly-deliverable domain, so a hosted site can actually send to it. Read-only in the
 * sense that matters here - it receives and reads, and never sends.
 *
 * Trade-offs vs IMAP, deliberately accepted: it is a third-party free service, so it can
 * rate-limit (HTTP 429) or be down, mailboxes are short-lived, and some sites block
 * disposable domains at signup. Use the imap provider when any of that bites.
 */
import type { EmailProvider, FoundEmail, TestInbox, WaitForEmailOptions } from "./types.js";

const API = "https://api.mail.tm";

interface Account {
  address: string;
  password: string;
  token: string;
}

interface MessageStub {
  id: string;
  subject?: string;
  from?: { address?: string; name?: string };
  to?: { address?: string }[];
  createdAt: string;
}

interface MessageFull extends MessageStub {
  text?: string;
  html?: string[] | string;
}

/** Accounts created this process, keyed by address, so polling can reuse the token. */
const accounts = new Map<string, Account>();

/** Thrown on 401/403 so a caller can re-authenticate instead of polling to a timeout. */
class AuthExpired extends Error {}

async function api<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (res.status === 429) {
    throw new Error("mail.tm rate limit (429). Wait a few seconds, or switch to the imap provider.");
  }
  if (res.status === 401 || res.status === 403) {
    // mail.tm tokens expire. This used to surface as a generic error that waitForEmail
    // stored in `lastError` and swallowed, so an expired token looked exactly like "the
    // site never sent the email" - after a full 90-second timeout.
    throw new AuthExpired(`mail.tm token rejected (${res.status})`);
  }
  if (!res.ok) {
    // The body carries the actual validation reason; without it a 422 is unguessable.
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(
      `mail.tm ${init.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

async function firstDomain(): Promise<string> {
  const domains = await api<{ domain: string; isActive: boolean }[]>("/domains");
  const active = domains.find((d) => d.isActive);
  if (!active) throw new Error("mail.tm reported no active domains.");
  return active.domain;
}

/** Random password for a throwaway mailbox; never printed, never reused elsewhere. */
function randomPassword(): string {
  return `Qa-${Math.random().toString(36).slice(2, 12)}-${Date.now().toString(36)}`;
}

/**
 * Reduce a caller-supplied tag to something that is legal in the local part of an
 * address. An unsanitised tag produced an invalid address and a bare mail.tm 422 that
 * said nothing about which character was at fault.
 */
function sanitizeTag(tag: string): string {
  const clean = tag
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!clean) throw new Error(`Tag ${JSON.stringify(tag)} contains no usable characters.`);
  return clean;
}

/** Mint a token for an address we already hold the password for. */
async function mintToken(address: string, password: string): Promise<string> {
  const { token } = await api<{ token: string }>("/token", {
    method: "POST",
    body: JSON.stringify({ address, password }),
  });
  return token;
}

async function createAccount(tag: string): Promise<Account> {
  const domain = await firstDomain();
  const base = sanitizeTag(tag);

  // Two runs with the same tag - or a tag someone else already used on this public
  // service - collided on a 422 that read as "mail.tm is broken". Retry with a suffix so
  // a tag collision is not a test failure.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const suffix = attempt === 0 ? "" : `-${Math.random().toString(36).slice(2, 7)}`;
    const address = `qa-${base}${suffix}@${domain}`.toLowerCase();
    const password = randomPassword();
    try {
      await api("/accounts", { method: "POST", body: JSON.stringify({ address, password }) });
      const token = await mintToken(address, password);
      const account: Account = { address, password, token };
      accounts.set(address, account);
      return account;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Only an "already exists" style rejection is worth retrying under a new name.
      if (!/422|already|exist|unique/i.test(msg)) throw err;
    }
  }
  throw new Error(
    `Could not register a mail.tm address for tag "${base}" after 4 attempts: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function bodyOf(msg: MessageFull): { text: string; html: string } {
  const html = Array.isArray(msg.html) ? msg.html.join("\n") : (msg.html ?? "");
  return { text: msg.text ?? "", html };
}

export const mailtmProvider: EmailProvider = {
  name: "mailtm",

  async createInbox(tag) {
    const account = await createAccount(tag);
    // The password goes back to the caller so a persona can persist it and re-open this
    // same mailbox tomorrow. It is never logged, and never returned through the MCP tool.
    return { address: account.address, token: account.token, secret: account.password };
  },

  async restoreInbox(address, secret) {
    const key = address.toLowerCase();
    const known = accounts.get(key);
    if (known) return { address: known.address, token: known.token, secret: known.password };

    // Minting a token is also the check that the mailbox still exists: mail.tm expires
    // idle accounts, and a 401 here means this persona needs a fresh inbox.
    const token = await mintToken(address, secret);
    accounts.set(key, { address, password: secret, token });
    return { address, token, secret };
  },

  async waitForEmail(opts: WaitForEmailOptions): Promise<FoundEmail> {
    const timeoutSec = opts.timeoutSec ?? 90;
    const pollMs = opts.pollMs ?? 3000;
    const deadline = Date.now() + timeoutSec * 1000;

    const account = accounts.get(opts.to.toLowerCase());
    if (!account) {
      throw new Error(
        `No mail.tm account known for ${opts.to} in this process. ` +
          `Call createInbox (or the create_test_inbox tool) first - disposable mailboxes cannot be re-opened without their password.`,
      );
    }

    let lastError: unknown = null;
    for (;;) {
      try {
        let page: { "hydra:member": MessageStub[] };
        try {
          page = await api<{ "hydra:member": MessageStub[] }>("/messages?page=1", {}, account.token);
        } catch (err) {
          if (!(err instanceof AuthExpired)) throw err;
          // Re-authenticate in place and retry this poll. We still hold the password, so
          // an expired token is recoverable and must not cost the caller a timeout.
          account.token = await mintToken(account.address, account.password);
          page = await api<{ "hydra:member": MessageStub[] }>("/messages?page=1", {}, account.token);
        }
        const stubs = page["hydra:member"] ?? [];

        let best: FoundEmail | null = null;
        for (const stub of stubs) {
          const created = new Date(stub.createdAt);
          if (!(created.getTime() > opts.since.getTime())) continue;
          if (
            opts.subjectContains &&
            !(stub.subject ?? "").toLowerCase().includes(opts.subjectContains.toLowerCase())
          ) {
            continue;
          }

          const full = await api<MessageFull>(`/messages/${stub.id}`, {}, account.token);
          const { text, html } = bodyOf(full);
          const found: FoundEmail = {
            subject: full.subject ?? "",
            from: full.from?.address ?? "",
            receivedAt: created,
            text,
            html,
            mailbox: "mailtm",
          };
          if (!best || found.receivedAt > best.receivedAt) best = found;
        }
        if (best) return best;
      } catch (err) {
        lastError = err;
      }

      if (Date.now() + pollMs >= deadline) {
        const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
        const subj = opts.subjectContains ? ` with subject containing "${opts.subjectContains}"` : "";
        throw new Error(
          `Timed out after ${timeoutSec}s waiting for an email to ${opts.to}${subj} ` +
            `received after ${opts.since.toISOString()}.${detail}`,
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  },

  async check() {
    const domain = await firstDomain();
    return `mailtm: reachable, active domain "${domain}", no credentials needed`;
  },

  async close() {
    accounts.clear();
  },
};
