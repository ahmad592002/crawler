/**
 * End-to-end receive check: mints an address, prints it, then waits for a real message
 * and reports what the extractors found in it.
 *
 *   npm run email:wait               # 180s window
 *   npm run email:wait -- 300        # longer window
 *
 * A disposable mailbox only exists inside this process, so the wait has to happen here
 * rather than in a second command.
 */
import { getProvider, closeEmail, extractCode, extractLinks } from "./lib.js";

async function main(): Promise<void> {
  const timeoutSec = Number(process.argv[2] ?? 180);
  const provider = getProvider();
  const since = new Date();

  const inbox = await provider.createInbox(`wait-${Date.now().toString(36)}`);
  console.log(`Provider: ${provider.name}`);
  console.log(`\n  Send an email to:  ${inbox.address}\n`);
  console.log(`Waiting up to ${timeoutSec}s ...`);

  const mail = await provider.waitForEmail({ to: inbox.address, since, timeoutSec });
  const body = `${mail.text}\n${mail.html}`;

  console.log(`\nReceived at ${mail.receivedAt.toISOString()} (${mail.mailbox})`);
  console.log(`  from:    ${mail.from}`);
  console.log(`  subject: ${mail.subject}`);
  console.log(`  code:    ${extractCode(body) ?? "(none found)"}`);
  const links = extractLinks(body).slice(0, 5);
  console.log(`  links:   ${links.length ? links.join("\n           ") : "(none found)"}`);
}

main()
  .catch((err: unknown) => {
    console.error(`\nFailed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => void closeEmail());
