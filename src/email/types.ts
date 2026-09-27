/** Shared email types. Every provider is read-only: it receives mail, it never sends. */

export interface FoundEmail {
  subject: string;
  from: string;
  receivedAt: Date;
  text: string;
  html: string;
  /** Where it was found - "INBOX", "[Gmail]/Spam", or a provider name. */
  mailbox: string;
}

export interface WaitForEmailOptions {
  /** Recipient address to match. */
  to: string;
  /** Only messages received strictly after this are considered. */
  since: Date;
  subjectContains?: string;
  timeoutSec?: number;
  pollMs?: number;
}

export interface TestInbox {
  address: string;
  /** Opaque provider state (credentials, token). Never log this. */
  token?: string;
}

export interface EmailProvider {
  readonly name: string;
  /**
   * Produce a fresh address to sign up with. `tag` makes it unique per test.
   * IMAP does this with plus-addressing; disposable providers register a real mailbox.
   */
  createInbox(tag: string): Promise<TestInbox>;
  /** Poll until a matching message arrives, or throw a descriptive timeout error. */
  waitForEmail(opts: WaitForEmailOptions): Promise<FoundEmail>;
  /** Cheap connectivity check for the self-test. Returns a human-readable status line. */
  check(): Promise<string>;
  close(): Promise<void>;
}
