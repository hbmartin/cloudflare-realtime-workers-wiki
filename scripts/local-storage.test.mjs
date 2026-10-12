import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { resolveConfig } from "vite";
import { unstable_convertConfigBindingsToStartWorkerBindings } from "wrangler";

const plugin = vi.hoisted(() => vi.fn(() => ({ name: "cloudflare" })));
vi.mock("@cloudflare/vite-plugin", () => ({ cloudflare: plugin }));

afterEach(() => vi.unstubAllEnvs());

async function development() {
  vi.resetModules();
  const { default: viteConfig } = await import("../vite.config.ts");
  viteConfig({ command: "serve", mode: "development" });
  const options = plugin.mock.lastCall[0];
  const { cloudflare } = await vi.importActual("@cloudflare/vite-plugin");
  let name, config;
  // Capture the effective entry configuration through the real plugin's public
  // auxiliary-worker context, after its merge and environment selection.
  await resolveConfig(
    {
      configFile: false,
      plugins: cloudflare({
        ...options,
        inspectorPort: false,
        remoteBindings: false,
        config: (current) => {
          const result = typeof options.config === "function" ? options.config(current) : options.config;
          name = result?.name ?? current.name;
          return result;
        },
        auxiliaryWorkers: [
          {
            config: (auxiliary, { entryWorkerConfig }) => {
              config = entryWorkerConfig;
              auxiliary.name = "storage-test-probe";
              auxiliary.main = "./src/worker/index.ts";
              auxiliary.compatibility_date = entryWorkerConfig.compatibility_date;
              auxiliary.compatibility_flags = entryWorkerConfig.compatibility_flags;
            },
          },
        ],
      }),
    },
    "serve",
  );
  return { name, config, bindings: unstable_convertConfigBindingsToStartWorkerBindings(config) };
}

it("limits the legacy storage override to default development", async () => {
  vi.stubEnv("CLOUDFLARE_ENV", "");
  vi.stubEnv("NOTES_DEPLOY_OVERRIDES", "");
  vi.stubEnv("NOTES_E2E", "");
  const current = await development();
  expect(current.name).toBe("cloudflare-realtime-notes");
  expect(current.config.r2_buckets).toEqual([
    {
      binding: "BUCKET",
      bucket_name: "cloudflare-realtime-notes",
      preview_bucket_name: "cloudflare-realtime-notes-preview",
    },
  ]);
  expect(current.bindings.BUCKET.bucket_name).toBe("cloudflare-realtime-notes-preview");
  expect(current.config.vars.OFFLINE_EDITING_ENABLED).toBe("true");
  vi.stubEnv("CLOUDFLARE_ENV", "production");
  const production = await development();
  expect(production.config.vars.OFFLINE_EDITING_ENABLED).toBe("false");
  expect(production.config.r2_buckets).toMatchObject([
    { bucket_name: "cloudflare-realtime-notes", preview_bucket_name: "cloudflare-realtime-notes-preview" },
  ]);
  vi.stubEnv("CLOUDFLARE_ENV", "");
  vi.stubEnv(
    "NOTES_DEPLOY_OVERRIDES",
    JSON.stringify({ name: "portable", r2_buckets: [{ binding: "BUCKET", bucket_name: "portable-attachments" }] }),
  );
  const portable = await development();
  expect(portable.name).toBe("portable");
  expect(portable.config.r2_buckets).toEqual([{ binding: "BUCKET", bucket_name: "portable-attachments" }]);
  vi.stubEnv("NOTES_DEPLOY_OVERRIDES", "");
  vi.stubEnv("NOTES_E2E", "1");
  vi.stubEnv("CLOUDFLARE_ENV", "notes-checks-e2e");
  const e2e = await development();
  expect(e2e.name).toBe("noteflare-notes-checks-e2e");
  expect(e2e.bindings.BUCKET.bucket_name).toBe("cloudflare-realtime-notes-e2e");
  expect(e2e.config.vars.BETTER_AUTH_URL).toBe("http://127.0.0.1:4173");
});

it("reads D1, document, and attachment data seeded under the previous development identities", async () => {
  vi.stubEnv("CLOUDFLARE_ENV", "");
  vi.stubEnv("NOTES_DEPLOY_OVERRIDES", "");
  vi.stubEnv("NOTES_E2E", "");
  const current = await development();
  const path = mkdtempSync(`${tmpdir()}/noteflare-storage-`);
  const options = (name, bucket, database = "00000000-0000-0000-0000-000000000000") => ({
    resourcePersistencePath: path,
    workers: [
      {
        config: {
          name,
          compatibilityDate: "2026-07-07",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: `
        export class Document {
          constructor(state) { this.state = state; }
          async fetch(request) {
            if (request.method === "POST") await this.state.storage.put("content", await request.text());
            return new Response(await this.state.storage.get("content"));
          }
        }
        export default { fetch() { return new Response("ok"); } };
      `,
              },
            },
          },
          exports: { Document: { type: "durable-object", storage: "sqlite" } },
          env: {
            DB: { type: "d1", id: database },
            BUCKET: { type: "r2", name: bucket },
            DOCUMENT: { type: "durable-object", worker: name, exportName: "Document" },
          },
        },
      },
    ],
  });
  let runtime;
  try {
    runtime = new Miniflare(options("cloudflare-realtime-notes", "cloudflare-realtime-notes-preview"));
    await (
      await runtime.getD1Database("DB")
    ).exec("CREATE TABLE pages (title TEXT); INSERT INTO pages VALUES ('Saved page');");
    await (await runtime.getR2Bucket("BUCKET")).put("attachment", "Saved attachment");
    const oldDocuments = await runtime.getDurableObjectNamespace("DOCUMENT");
    await oldDocuments
      .get(oldDocuments.idFromName("page"))
      .fetch("http://local", { method: "POST", body: "Saved content" });
    await runtime.dispose();
    runtime = new Miniflare(
      options(current.name, current.bindings.BUCKET.bucket_name, current.bindings.DB.database_id),
    );
    expect(await (await runtime.getD1Database("DB")).prepare("SELECT title FROM pages").first("title")).toBe(
      "Saved page",
    );
    expect(await (await (await runtime.getR2Bucket("BUCKET")).get("attachment")).text()).toBe("Saved attachment");
    const documents = await runtime.getDurableObjectNamespace("DOCUMENT");
    expect(await (await documents.get(documents.idFromName("page")).fetch("http://local")).text()).toBe(
      "Saved content",
    );
  } finally {
    await runtime?.dispose();
    rmSync(path, { recursive: true, force: true });
  }
}, 20_000);
