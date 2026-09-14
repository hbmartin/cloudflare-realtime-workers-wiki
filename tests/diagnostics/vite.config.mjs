import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Client-only harness: no Worker bindings, credentials, or production requests.
export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  plugins: [react()],
  optimizeDeps: { entries: ["tests/diagnostics/login.html"] },
  server: { host: "127.0.0.1", port: 4174, strictPort: true },
});
