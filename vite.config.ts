import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const isE2E = process.env.NOTES_E2E === "1";

export default defineConfig({
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
});
