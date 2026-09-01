import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const isE2E = process.env.NOTES_E2E === "1";
const browserTargets = ["chrome116", "edge116", "firefox124", "safari17.4", "ios17.4"];

export default defineConfig(({ command }) => {
  // Vite writes the redirected Wrangler configuration used by deployment. Select the
  // production bindings while building so a later `wrangler deploy --env production`
  // cannot accidentally publish the top-level local origin and placeholder database.
  if (command === "build") process.env.CLOUDFLARE_ENV ??= "production";

  return {
    build: {
      // These targets define the documented JavaScript and CSS output baseline.
      // Runtime APIs are feature-checked before the client mounts; Vite does not polyfill them.
      target: browserTargets,
    },
    plugins: [
      react(),
      cloudflare({
        persistState: isE2E ? { path: ".wrangler/e2e" } : true,
        ...(isE2E
          ? {
              inspectorPort: false,
              config: {
                secrets: {
                  required: ["BETTER_AUTH_SECRET", "BOOTSTRAP_TOKEN"],
                },
                vars: {
                  BETTER_AUTH_SECRET: "e2e-secret-with-at-least-32-characters",
                  BETTER_AUTH_URL: "http://127.0.0.1:4173",
                  BOOTSTRAP_TOKEN: "e2e-bootstrap-token",
                },
              },
            }
          : {}),
      }),
    ],
  };
});
