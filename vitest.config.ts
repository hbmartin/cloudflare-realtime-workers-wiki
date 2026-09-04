import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    exclude: ["src/worker/**/*.integration.test.ts"],
    environment: "node",
    setupFiles: ["src/client/test-setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary"],
      reportsDirectory: "coverage/unit",
      include: ["src/client/**/*.{ts,tsx}", "src/shared/**/*.ts", "src/worker/{archive,cleanup,http,r2}.ts"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/client/main.tsx", "src/client/test-setup.ts"],
      thresholds: {
        lines: 41,
        functions: 30,
        statements: 40,
        branches: 37,
      },
    },
  },
});
