import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.NOTES_E2E_BASE_URL ?? "http://127.0.0.1:4173";
const useLocalServer = !process.env.NOTES_E2E_BASE_URL;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  ...(useLocalServer
    ? {
        webServer: {
          command: "pnpm dev:e2e",
          url: `${baseURL}/api/health`,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }
    : {}),
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
});
