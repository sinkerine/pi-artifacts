import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "journey.spec.mjs",
  workers: 1,
  retries: 0,
  timeout: 300000,
  expect: { timeout: 10000 },
  outputDir: `${process.env.ARTIFACTS_E2E_ROOT}/test-results`,
  reporter: [["list"], ["json", { outputFile: `${process.env.ARTIFACTS_E2E_ROOT}/playwright.json` }]],
  use: {
    headless: true,
    launchOptions: { executablePath: process.env.PI_ARTIFACTS_CHROMIUM },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
