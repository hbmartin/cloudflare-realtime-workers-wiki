import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/worker/**/*.integration.test.ts"],
    environment: "node",
    coverage: { reporter: ["text", "json"] },
  },
});
