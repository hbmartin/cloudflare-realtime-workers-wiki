import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Run the client-only diagnostic harness without clearing the main E2E D1 state.
export default defineConfig({
  testDir: "../e2e",
  testMatch: "diagnostics.spec.ts",
  outputDir: fileURLToPath(new URL("../../test-results/diagnostics", import.meta.url)),
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [
        ["line"],
        [
          "html",
          {
            outputFolder: fileURLToPath(new URL("../../playwright-report/diagnostics", import.meta.url)),
            open: "never",
          },
        ],
      ]
    : "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec vite --config tests/diagnostics/vite.config.mjs",
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    url: "http://127.0.0.1:4174/tests/diagnostics/login.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
