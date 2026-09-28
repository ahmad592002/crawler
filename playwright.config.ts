import { defineConfig, devices } from "@playwright/test";
import { cpus } from "node:os";
import { loadConfig } from "./src/config.js";

const cfg = loadConfig();

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  // Half the CPUs by default; testWorkers overrides it. Against a slow shared host, more
  // workers means every test times the others out rather than finishing sooner.
  workers: cfg.testWorkers ?? Math.max(1, Math.floor(cpus().length / 2)),
  retries: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/pw-report", open: "never" }],
    // src/report.ts reads this to show per-spec results in the HTML report.
    ["json", { outputFile: "output/pw-results.json" }],
  ],
  outputDir: "output/test-results",
  timeout: 240_000,
  // This target regularly needs ~8s to navigate; the 5s default fires mid-navigation.
  expect: { timeout: 15_000 },
  use: {
    baseURL: cfg.baseUrl,
    headless: true,
    viewport: { width: 1366, height: 768 },
    navigationTimeout: cfg.navTimeoutMs,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "output/auth/state.json",
      },
    },
  ],
});
