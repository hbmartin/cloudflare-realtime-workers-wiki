import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          BETTER_AUTH_SECRET: "worker-test-secret-with-at-least-32-characters",
          BETTER_AUTH_URL: "http://example.test",
          BOOTSTRAP_TOKEN: "worker-bootstrap-token",
        },
      },
    }),
  ],
  test: {
    include: ["src/worker/**/*.integration.test.ts"],
    testTimeout: 20_000,
  },
});
