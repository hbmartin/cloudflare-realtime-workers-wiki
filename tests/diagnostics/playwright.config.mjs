import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

// Run the client-only diagnostic harness without clearing the main E2E D1 state.
export default defineConfig({
  testDir: "../e2e",
  testMatch: "diagnostics.spec.ts",
  use: { baseURL: "http://127.0.0.1:4174" },
  webServer: {
    command: "pnpm exec vite --config tests/diagnostics/vite.config.mjs",
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    url: "http://127.0.0.1:4174/tests/diagnostics/login.html",
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
