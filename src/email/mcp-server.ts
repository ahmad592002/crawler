/**
 * Read-only Email MCP server (stdio).
 *
 * Exposes three narrow tools. Every response is deliberately small: a code, a link,
 * or a truncated body. Raw messages and headers are never returned.
 */
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { waitForEmail, extractCode, extractLinks, closeEmail, createInbox, getProvider, type FoundEmail } from "./lib.js";

const MAX_TEXT = 3000;
const MAX_LINKS = 20;

const base = {
  to: z.string().describe("Recipient address the email was sent to (usually a plus-address)"),
  since_iso: z
    .string()
    .describe("ISO timestamp recorded BEFORE the action that triggers the email; older mail is ignored"),
  timeout_sec: z.number().int().min(5).max(300).optional().describe("How long to poll (default 90)"),
};

function parseSince(sinceIso: string): Date {
  const d = new Date(sinceIso);
  if (Number.isNaN(d.getTime())) throw new Error(`since_iso is not a valid ISO timestamp: ${sinceIso}`);
  return d;
}

async function find(args: {
  to: string;
  since_iso: string;
  timeout_sec?: number | undefined;
  subject_contains?: string | undefined;
}): Promise<FoundEmail> {
  return waitForEmail({
    to: args.to,
    since: parseSince(args.since_iso),
    ...(args.timeout_sec === undefined ? {} : { timeoutSec: args.timeout_sec }),
    ...(args.subject_contains === undefined ? {} : { subjectContains: args.subject_contains }),
  });
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

const server = new McpServer({ name: "qa-email", version: "0.1.0" });

server.registerTool(
  "create_test_inbox",
  {
    title: "Create test inbox",
    description:
      "Create a fresh address to sign up with, and return it. Call this BEFORE submitting a signup form. " +
      "With the mailtm provider this registers a real disposable mailbox; with imap it returns a plus-address.",
    inputSchema: {
      tag: z
        .string()
        .regex(/^[a-z0-9-]{3,40}$/i, "tag must be 3-40 chars of letters, digits or hyphens")
        .describe("Unique per test, e.g. a run id plus an index"),
    },
  },
  async ({ tag }) => {
    const inbox = await createInbox(tag);
    // The token stays inside this process; only the address goes back to the caller.
    return json({ address: inbox.address, provider: getProvider().name });
  },
);

server.registerTool(
  "get_verification_code",
  {
    title: "Get verification code",
    description:
      "Wait for a verification email and return only the one-time code. Record since_iso before submitting the form.",
    inputSchema: { ...base, subject_contains: z.string().optional() },
  },
  async (args) => {
    const mail = await find(args);
    const code = extractCode(`${mail.text}\n${mail.html}`);
    if (!code) {
      throw new Error(`Found email "${mail.subject}" but no 4-8 digit code in it. Try get_verification_link.`);
    }
    return json({ code, subject: mail.subject, received_at: mail.receivedAt.toISOString() });
  },
);

server.registerTool(
  "get_verification_link",
  {
    title: "Get verification link",
    description:
      "Wait for a verification email and return only the confirmation link. Record since_iso before submitting the form.",
    inputSchema: { ...base, link_contains: z.string().optional() },
  },
  async (args) => {
    const mail = await find(args);
    const links = extractLinks(mail.html || mail.text, args.link_contains);
    const link = links[0];
    if (!link) {
      const filter = args.link_contains ? ` matching "${args.link_contains}"` : "";
      throw new Error(`Found email "${mail.subject}" but no link${filter} in it.`);
    }
    return json({ link, subject: mail.subject, received_at: mail.receivedAt.toISOString() });
  },
);

server.registerTool(
  "read_latest_email",
  {
    title: "Read latest email",
    description:
      "Wait for the newest email to an address and return a truncated summary. Use only when the code/link tools do not fit.",
    inputSchema: base,
  },
  async (args) => {
    const mail = await find(args);
    return json({
      subject: mail.subject,
      from: mail.from,
      received_at: mail.receivedAt.toISOString(),
      text: mail.text.slice(0, MAX_TEXT),
      links: extractLinks(mail.html || mail.text).slice(0, MAX_LINKS),
    });
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void closeEmail().finally(() => process.exit(0)));
}

await server.connect(new StdioServerTransport());
