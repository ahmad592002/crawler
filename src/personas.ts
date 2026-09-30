/**
 * Test personas - the identities a multi-user test drives.
 *
 * Plenty of features only exist between two people: sharing a document, inviting a
 * teammate, sending a message, an admin suspending a member, a seller and a buyer. One
 * logged-in session cannot exercise any of them.
 *
 * A persona is a durable identity: a stable email address, a password, and its own saved
 * browser session. Durable matters - if the address changed every run, yesterday's invite
 * would arrive at a mailbox nobody is reading, and "accept the invitation" could never be
 * tested end to end.
 *
 * Identities live in output/auth/personas.json, which is git-ignored. It contains mailbox
 * passwords, so treat it exactly like output/auth/state.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, loadConfig, env, type PersonaConfig } from "./config.js";
import { getProvider } from "./email/lib.js";

const AUTH_DIR = resolve(ROOT, "output", "auth");
const STORE = resolve(AUTH_DIR, "personas.json");

export interface Persona {
  /** Stable handle used in config, specs and filenames: "alice", "bob". */
  id: string;
  /** What this identity is for, e.g. "owner" or "member". Free text. */
  role: string;
  /** The mailbox this persona receives at. Stable across runs. */
  email: string;
  /** Password used to sign up to the SITE under test. */
  password: string;
  /** Secret for re-opening the mailbox. Never log this. */
  mailboxSecret?: string;
  /** Where this persona's logged-in browser session is saved. */
  statePath: string;
  createdAt: string;
}

interface Store {
  /** Personas are tied to a target; pointing at a new site must not reuse old identities. */
  baseUrl: string;
  provider: string;
  personas: Record<string, Persona>;
}

function readStore(): Store | null {
  if (!existsSync(STORE)) return null;
  try {
    return JSON.parse(readFileSync(STORE, "utf8")) as Store;
  } catch {
    return null;
  }
}

function writeStore(store: Store): void {
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(STORE, `${JSON.stringify(store, null, 2)}\n`);
}

export function statePathFor(id: string): string {
  return resolve(AUTH_DIR, `state.${id}.json`);
}

/** A password that satisfies the usual "upper, lower, digit, symbol" signup rule. */
function sitePassword(id: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `Qa-${id}-${rand}!7`;
}

/**
 * Load the configured personas, creating any that do not exist yet.
 *
 * Existing identities are reused as-is so an invitation sent yesterday still lands
 * somewhere readable. The store is discarded wholesale when the target or the email
 * provider changes, because identities from another site are meaningless here.
 */
export async function loadPersonas(): Promise<Persona[]> {
  const cfg = loadConfig();
  const configured: PersonaConfig[] = cfg.personas ?? [];
  if (configured.length === 0) return [];

  const provider = getProvider();
  let store = readStore();

  if (store && (store.baseUrl !== cfg.baseUrl || store.provider !== provider.name)) {
    console.log(
      `personas: target or provider changed (${store.baseUrl} -> ${cfg.baseUrl}); starting fresh`,
    );
    store = null;
  }
  store ??= { baseUrl: cfg.baseUrl, provider: provider.name, personas: {} };

  const out: Persona[] = [];
  let created = 0;

  for (const want of configured) {
    const existing = store.personas[want.id];

    if (existing) {
      // Re-open the mailbox so waitForEmail can poll it in THIS process.
      if (existing.mailboxSecret && provider.restoreInbox) {
        try {
          await provider.restoreInbox(existing.email, existing.mailboxSecret);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`personas: ${want.id}'s mailbox could not be re-opened (${msg}); re-creating`);
          delete store.personas[want.id];
        }
      }
      if (store.personas[want.id]) {
        out.push({ ...existing, role: want.role ?? existing.role });
        continue;
      }
    }

    const tag = `${want.id}-${Date.now().toString(36)}`;
    const inbox = await provider.createInbox(tag);
    const persona: Persona = {
      id: want.id,
      role: want.role ?? want.id,
      email: inbox.address,
      password: want.password || env("TEST_PASSWORD") || sitePassword(want.id),
      ...(inbox.secret === undefined ? {} : { mailboxSecret: inbox.secret }),
      statePath: statePathFor(want.id),
      createdAt: new Date().toISOString(),
    };
    store.personas[want.id] = persona;
    out.push(persona);
    created++;
  }

  writeStore(store);
  if (created) console.log(`personas: created ${created}, reusing ${out.length - created}`);
  return out;
}

/** The personas already on disk, without touching the network. For specs and reporting. */
export function knownPersonas(): Persona[] {
  const store = readStore();
  if (!store) return [];
  return Object.values(store.personas);
}

export function personaById(id: string): Persona {
  const p = knownPersonas().find((x) => x.id === id);
  if (!p) {
    throw new Error(
      `No persona "${id}". Add it to "personas" in qa.config.json and run the auth setup ` +
        `(npx playwright test --project=setup) to create its identity and session.`,
    );
  }
  return p;
}

/** Redacted view - safe to print. Never dump a Persona directly. */
export function describePersona(p: Persona): string {
  return `${p.id} (${p.role}) <${p.email}> session=${existsSync(p.statePath) ? "saved" : "none"}`;
}
