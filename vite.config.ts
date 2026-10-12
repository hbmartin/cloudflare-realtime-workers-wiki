import { spawn } from "node:child_process";
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
      manifest: true,
    },
    plugins: [
      react(),
      {
        name: "noteflare-plugin-ui-development",
        apply: "serve",
        configureServer(server) {
          const bundler = spawn(process.execPath, ["scripts/build-plugin-ui.mjs", "--watch"], { stdio: "inherit" });
          server.httpServer?.once("close", () => bundler.kill());
        },
      },
      cloudflare({
        ...(process.env.NOTES_DEPLOY_OVERRIDES
          ? {
              config: (config) => {
                Object.assign(config, JSON.parse(process.env.NOTES_DEPLOY_OVERRIDES!));
              },
            }
          : command === "serve" && !isE2E
            ? {
                config: (config) => {
                  // Object overrides concatenate binding arrays. Replace the legacy
                  // development bucket in place so the template BUCKET cannot win.
                  if (!process.env.CLOUDFLARE_ENV) {
                    config.name = "cloudflare-realtime-notes";
                    config.workflows = config.workflows.map((workflow) => ({
                      ...workflow,
                      name:
                        workflow.binding === "NOTES_WORKFLOW" ? "cloudflare-realtime-notes-jobs-local" : workflow.name,
                    }));
                    const legacyQueues = {
                      "noteflare-delivery": "cloudflare-realtime-notes-delivery-local",
                      "noteflare-delivery-dlq": "cloudflare-realtime-notes-delivery-dlq-local",
                    };
                    config.queues.producers = (config.queues.producers ?? []).map((producer) => ({
                      ...producer,
                      queue: legacyQueues[producer.queue as keyof typeof legacyQueues] ?? producer.queue,
                    }));
                    config.queues.consumers = (config.queues.consumers ?? []).map((consumer) => ({
                      ...consumer,
                      queue: legacyQueues[consumer.queue as keyof typeof legacyQueues] ?? consumer.queue,
                      ...(consumer.dead_letter_queue
                        ? {
                            dead_letter_queue:
                              legacyQueues[consumer.dead_letter_queue as keyof typeof legacyQueues] ??
                              consumer.dead_letter_queue,
                          }
                        : {}),
                    }));
                    config.r2_buckets = [
                      {
                        binding: "BUCKET",
                        bucket_name: "cloudflare-realtime-notes",
                        preview_bucket_name: "cloudflare-realtime-notes-preview",
                      },
                    ];
                  }
                  Object.assign(config.vars, {
                    BETTER_AUTH_URL: "http://localhost:5173",
                    NOTION_MARKDOWN_WRITES_ENABLED: "true",
                  });
                },
              }
            : {}),
        persistState: process.env.NOTES_E2E_STATE
          ? { path: process.env.NOTES_E2E_STATE }
          : isE2E
            ? { path: ".wrangler/e2e" }
            : true,
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
