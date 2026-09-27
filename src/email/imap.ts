/**
 * Gmail (or any IMAP host) provider. Read-only: mailboxes are opened with readOnly and
 * there is no delete / move / flag / append call anywhere in this file.
 *
 * Addresses come from plus-addressing, so one real mailbox serves every test.
 */
import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { EmailProvider, FoundEmail, TestInbox, WaitForEmailOptions } from './types.js';

const HOST = "imap.gmail.com";
const PORT = 993;
const INBOX = "INBOX";
const SPAM = "[Gmail]/Spam";

let client: ImapFlow | null = null;
let connecting: Promise<ImapFlow> | null = null;

function credentials(): { user: string; pass: string } {
  const user = process.env["GMAIL_USER"];
  const pass = process.env["GMAIL_APP_PASSWORD"];
  if (!user || !pass) {
    throw new Error(
      "GMAIL_USER and GMAIL_APP_PASSWORD must be set in .env (see .env.example)",
    );
  }
  return { user, pass };
}

/** One shared connection per process; reconnects automatically if it drops. */
export async function getClient(): Promise<ImapFlow> {
  if (client && client.usable) return client;
  if (connecting) return connecting;

  const { user, pass } = credentials();
  connecting = (async () => {
    const c = new ImapFlow({
      host: HOST,
      port: PORT,
      secure: true,
      auth: { user, pass },
      logger: false,
      emitLogs: false,
    });
    // A dropped connection must not take the process down; the next call reconnects.
    c.on("error", () => {
      if (client === c) client = null;
    });
    c.on("close", () => {
      if (client === c) client = null;
    });
    await c.connect();
    client = c;
    return c;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function closeClient(): Promise<void> {
  const c = client;
  client = null;
  if (c?.usable) {
    try {
      await c.logout();
    } catch {
      c.close();
    }
  }
}

/** imapflow types internalDate as string | Date depending on the server reply. */
function toDate(value: string | Date | undefined): Date {
  if (value instanceof Date) return value;
  const d = value ? new Date(value) : new Date(0);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

/** Every address the message was delivered to, lowercased. */
function recipients(mail: ParsedMail): string[] {
  const out: string[] = [];
  for (const field of [mail.to, mail.cc, mail.bcc]) {
    const list = Array.isArray(field) ? field : field ? [field] : [];
    for (const addrObj of list) {
      for (const a of addrObj.value) if (a.address) out.push(a.address.toLowerCase());
    }
  }
  const delivered = mail.headers.get("delivered-to");
  if (typeof delivered === "string") out.push(delivered.toLowerCase());
  return out;
}

/** Gmail treats a+b@gmail.com and ab@gmail.com as the same box; compare loosely too. */
function canonical(address: string): string {
  const [localRaw = "", domain = ""] = address.toLowerCase().split("@");
  const local = localRaw.split("+")[0] ?? "";
  return `${local.replace(/\./g, "")}@${domain}`;
}

function addressMatches(mail: ParsedMail, to: string): boolean {
  const want = to.toLowerCase();
  const got = recipients(mail);
  if (got.includes(want)) return true;
  // Fall back to the canonical form: some providers rewrite the visible To header.
  return got.some((g) => canonical(g) === canonical(want));
}

async function searchMailbox(
  c: ImapFlow,
  mailbox: string,
  opts: { to: string; since: Date; subjectContains?: string },
): Promise<FoundEmail | null> {
  const lock = await c.getMailboxLock(mailbox, { readOnly: true });
  try {
    // IMAP SINCE has day granularity, so widen by a day and filter precisely below.
    const sinceDay = new Date(opts.since.getTime() - 24 * 60 * 60 * 1000);
    let uids = await c.search({ to: opts.to, since: sinceDay }, { uid: true });
    if (!uids || uids.length === 0) {
      // Gmail sometimes will not match a plus-address in a TO search; widen and filter locally.
      uids = await c.search({ since: sinceDay }, { uid: true });
    }
    if (!uids || uids.length === 0) return null;

    let best: FoundEmail | null = null;
    // Newest first, and cap the scan so a busy mailbox cannot stall a poll.
    for (const uid of [...uids].sort((a, b) => b - a).slice(0, 40)) {
      const msg = await c.fetchOne(String(uid), { source: true, internalDate: true }, { uid: true });
      if (!msg || !msg.source) continue;

      const internal = toDate(msg.internalDate);
      if (internal.getTime() <= opts.since.getTime()) continue;

      const mail = await simpleParser(msg.source);
      if (!addressMatches(mail, opts.to)) continue;

      const subject = mail.subject ?? "";
      if (opts.subjectContains && !subject.toLowerCase().includes(opts.subjectContains.toLowerCase())) {
        continue;
      }

      const found: FoundEmail = {
        subject,
        from: mail.from?.text ?? "",
        receivedAt: mail.date ?? internal,
        text: mail.text ?? "",
        html: typeof mail.html === "string" ? mail.html : "",
        mailbox,
      };
      if (!best || found.receivedAt > best.receivedAt) best = found;
    }
    return best;
  } finally {
    lock.release();
  }
}

/**
 * Poll INBOX then Spam until a message addressed to `to` and newer than `since` appears.
 * Throws a descriptive error on timeout.
 */
async function waitForEmailImap(opts: WaitForEmailOptions): Promise<FoundEmail> {
  const timeoutSec = opts.timeoutSec ?? 90;
  const pollMs = opts.pollMs ?? 3000;
  const deadline = Date.now() + timeoutSec * 1000;
  const query = {
    to: opts.to,
    since: opts.since,
    ...(opts.subjectContains === undefined ? {} : { subjectContains: opts.subjectContains }),
  };

  let lastError: unknown = null;
  for (;;) {
    try {
      const c = await getClient();
      for (const mailbox of [INBOX, SPAM]) {
        const hit = await searchMailbox(c, mailbox, query);
        if (hit) return hit;
      }
    } catch (err) {
      // A dropped connection or a transient IMAP error retries on the next tick.
      lastError = err;
      client = null;
    }

    if (Date.now() + pollMs >= deadline) {
      const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
      const subj = opts.subjectContains ? ` with subject containing "${opts.subjectContains}"` : "";
      throw new Error(
        `Timed out after ${timeoutSec}s waiting for an email to ${opts.to}${subj} ` +
          `received after ${opts.since.toISOString()} (checked INBOX and Spam).${detail}`,
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}


/** Plus-addressed inbox: everything lands in the one real mailbox. */
function imapInbox(tag: string): TestInbox {
  const user = process.env['GMAIL_USER'];
  if (!user) throw new Error('GMAIL_USER must be set in .env');
  const [local = '', domain = 'gmail.com'] = user.split('@');
  return { address: `${local}+${tag}@${domain}` };
}

export const imapProvider: EmailProvider = {
  name: 'imap',
  async createInbox(tag) {
    return imapInbox(tag);
  },
  waitForEmail: waitForEmailImap,
  async check() {
    const c = await getClient();
    const lock = await c.getMailboxLock(INBOX, { readOnly: true });
    try {
      const total = c.mailbox && typeof c.mailbox !== 'boolean' ? c.mailbox.exists : 0;
      return `imap: connected to ${HOST}, INBOX holds ${total} message(s)`;
    } finally {
      lock.release();
    }
  },
  close: closeClient,
};
