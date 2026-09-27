/**
 * Connectivity check for the configured email provider.
 * Sends nothing and changes nothing. Never prints credentials.
 *
 *   npm run email:selftest              # provider from qa.config.json / EMAIL_PROVIDER
 *   npm run email:selftest -- mailtm    # force one
 */
import { getProvider, closeEmail } from "./lib.js";

async function main(): Promise<void> {
  const provider = getProvider(process.argv[2]);
  console.log(`Provider: ${provider.name}`);
  console.log(await provider.check());

  // Prove an address can actually be minted, since that is what Phase 4 depends on.
  const inbox = await provider.createInbox(`selftest-${Date.now().toString(36)}`);
  console.log(`Test address: ${inbox.address}`);
}

main()
  .catch((err: unknown) => {
    console.error(`Self-test failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => void closeEmail());
