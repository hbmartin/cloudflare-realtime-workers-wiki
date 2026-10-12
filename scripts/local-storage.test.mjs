import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import viteConfig from "../vite.config.ts";

const plugin = vi.hoisted(() => vi.fn(() => ({ name: "cloudflare" })));
vi.mock("@cloudflare/vite-plugin", () => ({ cloudflare: plugin }));

afterEach(() => vi.unstubAllEnvs());

function development() {
  viteConfig({ command: "serve", mode: "development" });
  return plugin.mock.lastCall[0].config;
}

it("limits the legacy storage override to default development", () => {
  vi.stubEnv("CLOUDFLARE_ENV", "");
  vi.stubEnv("NOTES_DEPLOY_OVERRIDES", "");
  expect(development()).toMatchObject({
    name: "cloudflare-realtime-notes",
    r2_buckets: [
      { bucket_name: "cloudflare-realtime-notes", preview_bucket_name: "cloudflare-realtime-notes-preview" },
    ],
  });
  vi.stubEnv("CLOUDFLARE_ENV", "staging");
  expect(development()).not.toHaveProperty("name");
  expect(development()).not.toHaveProperty("r2_buckets");
  vi.stubEnv("NOTES_DEPLOY_OVERRIDES", JSON.stringify({ name: "portable" }));
  const config = {};
  development()(config);
  expect(config).toEqual({ name: "portable" });
});

it("reads D1, document, and attachment data seeded under the previous development identities", async () => {
  vi.stubEnv("CLOUDFLARE_ENV", "");
  vi.stubEnv("NOTES_DEPLOY_OVERRIDES", "");
  const current = development();
  const path = mkdtempSync(`${tmpdir()}/noteflare-storage-`);
  const options = (name, bucket) => ({
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
            DB: { type: "d1", id: "00000000-0000-0000-0000-000000000000" },
            BUCKET: { type: "r2", name: bucket },
            DOCUMENT: { type: "durable-object", worker: name, exportName: "Document" },
          },
        },
      },
    ],
  });
  let runtime;
  try {
    runtime = new Miniflare(options("cloudflare-realtime-notes", "cloudflare-realtime-notes"));
    await (
      await runtime.getD1Database("DB")
    ).exec("CREATE TABLE pages (title TEXT); INSERT INTO pages VALUES ('Saved page');");
    await (await runtime.getR2Bucket("BUCKET")).put("attachment", "Saved attachment");
    const oldDocuments = await runtime.getDurableObjectNamespace("DOCUMENT");
    await oldDocuments
      .get(oldDocuments.idFromName("page"))
      .fetch("http://local", { method: "POST", body: "Saved content" });
    await runtime.dispose();
    runtime = new Miniflare(options(current.name, current.r2_buckets[0].bucket_name));
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
