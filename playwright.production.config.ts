import { defineConfig, devices } from "@playwright/test";

process.env.NOTES_E2E_COOKIES = ".wrangler/e2e-production/owner-cookies.json";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: ["phase1-production.spec.ts", "phase3-date-mentions.spec.ts", "phase4-offline-shell.spec.ts"],
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/e2e-production-server.mjs",
    url: "http://localhost:4173/api/health",
    reuseExistingServer: false,
    timeout: 300_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, grepInvert: /@touch/ },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] }, grep: /@touch/ },
  ],
});
