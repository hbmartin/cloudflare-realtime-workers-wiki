import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_readConfig } from "wrangler";
import {
  deployPrepared,
  configurationHash,
  initializedDatabase,
  installationOrigin,
  missingSecrets,
  outputConfig,
  portableDatabase,
  portableOverrides,
  selectTarget,
  verifyBuild,
  withSecretsFile,
} from "./deploy.mjs";

afterEach(() => vi.unstubAllEnvs());
const existingDB = "11111111-1111-1111-1111-111111111111";
const newDB = "22222222-2222-2222-2222-222222222222";
const placeholderID = "00000000-0000-0000-0000-000000000000";
const production = { name: "legacy-notes", d1_databases: [{ binding: "DB", database_id: existingDB }] };
const binding = { name: "DB", type: "d1", id: existingDB };
const selection = { name: "legacy-notes", workersCI: true, production, settings: { bindings: [binding] } };
const queryResult = (rows) => ({ status: 0, stdout: JSON.stringify([{ success: true, results: rows }]) });
const dependencies = () => ({
  isInitialized: vi.fn().mockReturnValue(false),
  inspectSecrets: vi.fn().mockReturnValue(["BOOTSTRAP_TOKEN"]),
  migrateDatabase: vi.fn().mockReturnValue(0),
  upload: vi.fn(),
  health: vi.fn(),
});

function buildFixture() {
  const path = mkdtempSync(resolve(tmpdir(), "noteflare-build-"));
  const queues = {
    producers: [{ binding: "DELIVERY_QUEUE", queue: "fixture-delivery" }],
    consumers: [{ queue: "fixture-delivery" }],
  };
  writeFileSync(
    resolve(path, "wrangler.jsonc"),
    JSON.stringify({
      name: "portable",
      vars: { BETTER_AUTH_URL: "auto" },
      queues,
      env: { production: { name: "legacy", vars: { BETTER_AUTH_URL: "https://legacy.example" }, queues } },
    }),
  );
  const stub = resolve(path, "build.cjs");
  writeFileSync(
    stub,
    `
      const fs = require("node:fs");
      fs.writeFileSync("command-ran", process.argv.slice(2).join(" "));
      fs.mkdirSync("dist/worker", { recursive: true });
      fs.mkdirSync(".wrangler/deploy", { recursive: true });
      fs.writeFileSync("dist/worker/wrangler.json", JSON.stringify({ name: "legacy", vars: { BETTER_AUTH_URL: "https://legacy.example" }, queues: ${JSON.stringify(queues)} }));
      fs.writeFileSync(".wrangler/deploy/config.json", JSON.stringify({ configPath: "../../dist/worker/wrangler.json" }));
    `,
  );
  const launcher = resolve(path, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  writeFileSync(
    launcher,
    process.platform === "win32"
      ? `@"${process.execPath}" "${stub}" %*\r\n`
      : `#!${process.execPath}\nrequire(${JSON.stringify(stub)});\n`,
  );
  chmodSync(launcher, 0o755);
  const env = { ...process.env, PATH: `${path}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` };
  for (const key of [
    "WORKERS_CI",
    "WORKERS_CI_BUILD_UUID",
    "WORKERS_CI_COMMIT_SHA",
    "CLOUDFLARE_ENV",
    "WRANGLER_CI_OVERRIDE_NAME",
    "CLOUDFLARE_ACCOUNT_ID",
  ])
    delete env[key];
  return { path, env };
}
describe("deployment entry point", () => {
  const entry = fileURLToPath(new URL("./deploy.mjs", import.meta.url));
  it.each(["missing", "disconnected", "generated"])(
    "rejects %s delivery wiring in named deployment dry runs",
    (mode) => {
      const { path, env } = buildFixture();
      try {
        const configPath = resolve(path, "wrangler.jsonc");
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        if (mode === "missing") config.env.production.queues.producers = [];
        if (mode === "disconnected") config.env.production.queues.consumers[0].queue = "another-queue";
        writeFileSync(configPath, JSON.stringify(config));
        if (mode === "generated") {
          const stubPath = resolve(path, "build.cjs");
          writeFileSync(
            stubPath,
            readFileSync(stubPath, "utf8").replace(
              '"consumers":[{"queue":"fixture-delivery"}]',
              '"consumers":[{"queue":"another-queue"}]',
            ),
          );
        }
        const result = spawnSync(process.execPath, [entry, "deploy", "--production", "--dry-run"], {
          cwd: path,
          env,
          encoding: "utf8",
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/DELIVERY_QUEUE|delivery consumer/);
        expect(existsSync(resolve(path, "command-ran"))).toBe(mode === "generated");
      } finally {
        rmSync(path, { recursive: true, force: true });
      }
    },
  );
  it("builds an archive without Git and removes obsolete reusable manifests", () => {
    const { path, env } = buildFixture();
    try {
      mkdirSync(resolve(path, ".wrangler"));
      writeFileSync(resolve(path, ".wrangler/noteflare-build.json"), "{}");
      expect(existsSync(resolve(path, ".git"))).toBe(false);
      const result = spawnSync(process.execPath, [entry, "build"], { cwd: path, env, encoding: "utf8" });
      expect(result.stderr).not.toContain("git");
      expect(result.status).toBe(0);
      expect(readFileSync(resolve(path, "command-ran"), "utf8")).toBe("run build:app");
      expect(existsSync(resolve(path, ".wrangler/noteflare-build.json"))).toBe(false);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
  it.each(["origin", "overrides", "old manifest"])("rejects a changed %s before migration or upload", (change) => {
    const { path, env } = buildFixture();
    try {
      const git = (args) => spawnSync("git", args, { cwd: path, encoding: "utf8" });
      expect(git(["init", "-q"]).status).toBe(0);
      writeFileSync(resolve(path, ".gitignore"), ".wrangler/\ndist/\ncommand-ran\n");
      git(["add", "."]);
      expect(
        git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"]).status,
      ).toBe(0);
      const hash = createHash("sha256").update(git(["rev-parse", "HEAD"]).stdout);
      for (const file of git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .stdout.split("\0")
        .filter(Boolean)
        .sort()) {
        hash.update(file).update(readFileSync(resolve(path, file)));
      }
      const context = { target: "production", name: "legacy", origin: "https://legacy.example", account: null };
      const manifest = {
        ...context,
        source: hash.digest("hex"),
        buildUUID: null,
        revision: null,
        configurationHash: configurationHash(context),
      };
      if (change === "origin") manifest.origin = "https://old.example";
      if (change === "overrides")
        manifest.configurationHash = configurationHash({ ...context, overrides: { vars: { FLAG: "false" } } });
      if (change === "old manifest") delete manifest.configurationHash;
      mkdirSync(resolve(path, ".wrangler"));
      writeFileSync(resolve(path, ".wrangler/noteflare-build.json"), JSON.stringify(manifest));
      const result = spawnSync(process.execPath, [entry, "deploy", "--production"], {
        cwd: path,
        env: { ...env, WORKERS_CI: "1" },
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Run the build again before deployment");
      expect(result.stderr).not.toContain("Wrangler");
      expect(existsSync(resolve(path, "command-ran"))).toBe(false);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});

describe("deployment targets and portable configuration", () => {
  it("recognizes a legacy Workers Builds deployment by name and database", () => {
    expect(selectTarget(selection)).toBe("production");
    expect(selectTarget({ ...selection, name: "new-notes" })).toBe("");
    expect(selectTarget({ ...selection, settings: { bindings: [{ ...binding, id: newDB }] } })).toBe("");
    expect(selectTarget({ ...selection, settings: null })).toBe("");
  });
  it("recognizes canonical D1 bindings and prefers database_id over the deprecated id", () => {
    expect(
      selectTarget({ ...selection, settings: { bindings: [{ name: "DB", type: "d1", database_id: existingDB }] } }),
    ).toBe("production");
    expect(selectTarget({ ...selection, settings: { bindings: [{ ...binding, database_id: newDB }] } })).toBe("");
  });
  it("preserves local production defaults and honors explicit profiles/environments", () => {
    expect(selectTarget({ ...selection, workersCI: false })).toBe("production");
    expect(selectTarget({ ...selection, environment: "staging" })).toBe("staging");
    expect(selectTarget({ ...selection, environment: "", workersCI: false })).toBe("");
    expect(selectTarget({ ...selection, environment: "production", forced: "portable" })).toBe("");
    expect(selectTarget({ ...selection, forced: "production", settings: null })).toBe("production");
  });
  it("resolves an exact origin and preserves custom domains", () => {
    expect(installationOrigin("auto", undefined, "notes", "my-account")).toBe("https://notes.my-account.workers.dev");
    expect(installationOrigin("auto", "auto", "notes", "my-account")).toBe("https://notes.my-account.workers.dev");
    expect(installationOrigin("auto", "https://wiki.example.com", "notes", "my-account")).toBe(
      "https://wiki.example.com",
    );
    expect(installationOrigin("https://new.example.com", "https://old.example.com")).toBe("https://new.example.com");
  });
  it.each([
    "http://example.com",
    "https://example.com/",
    "https://example.com/path",
    "https://user:password@example.com",
    "invalid",
  ])("rejects invalid remote origin %s", (value) => {
    expect(() => installationOrigin(value)).toThrow("exact HTTPS origin");
  });
  it.each([undefined, "", "auto"])("resolves an omitted origin %s without inventing a subdomain", (value) => {
    expect(installationOrigin(value, undefined, "notes", "account")).toBe("https://notes.account.workers.dev");
    expect(installationOrigin(value, "https://saved.example", "notes")).toBe("https://saved.example");
    expect(() => installationOrigin(value, undefined, "notes")).toThrow("valid workers.dev subdomain");
    expect(() => installationOrigin(value, undefined, "notes", "account/path")).toThrow("valid workers.dev subdomain");
  });
  it("keeps portable defaults distinct from the legacy production environment", () => {
    const root = unstable_readConfig({ config: "wrangler.jsonc", env: "" }, { hideWarnings: true });
    const legacy = unstable_readConfig({ config: "wrangler.jsonc", env: "production" }, { hideWarnings: true });
    expect(root.name).toBe("noteflare");
    expect(root.vars.BETTER_AUTH_URL).toBe("auto");
    expect(legacy.name).toBe("cloudflare-realtime-notes");
    expect(legacy.d1_databases[0].database_id).toBe("a1e3ebcb-6fb4-4cdb-8ccc-ef5821fb6fbc");
    for (const key of [
      "EXPANDED_EMBEDS_ENABLED",
      "OFFLINE_EDITING_ENABLED",
      "BLOCK_LINKS_ENABLED",
      "LIVE_DIAGRAM_EMBEDS_ENABLED",
      "DIFF_DIGESTS_ENABLED",
    ]) {
      expect(root.vars[key]).toBe("true");
      expect(legacy.vars[key]).toBe("false");
    }
    expect(root.vars.NOTION_MARKDOWN_WRITES_ENABLED).toBe("false");
    const overrides = portableOverrides(
      root,
      { bindings: [{ name: "OFFLINE_EDITING_ENABLED", type: "plain_text", text: "false" }] },
      "renamed-wiki",
      "https://wiki.example.com",
      { database_id: "new-db" },
    );
    expect(overrides.vars.OFFLINE_EDITING_ENABLED).toBe("false");
    expect(overrides.d1_databases[0].migrations_dir).toMatch(/\/migrations$/);
    expect(overrides.workflows[0].name).toBe("renamed-wiki-jobs");
    expect(root.durable_objects).toEqual(legacy.durable_objects);
  });
  it("rejects plaintext credentials and a changed bucket binding", () => {
    const root = unstable_readConfig({ config: "wrangler.jsonc", env: "" }, { hideWarnings: true });
    expect(() =>
      portableOverrides(
        root,
        { bindings: [{ name: "BETTER_AUTH_SECRET", type: "plain_text", text: "never-log-this" }] },
        "notes",
        "https://example.com",
        {},
      ),
    ).toThrow("plaintext variables");
    expect(() =>
      portableOverrides(
        { ...root, r2_buckets: [{ binding: "BUCKET", bucket_name: "configured-bucket" }] },
        { bindings: [{ name: "BUCKET", type: "r2_bucket", bucket_name: "unrelated-bucket" }] },
        "notes",
        "https://example.com",
        {},
      ),
    ).toThrow("BUCKET differs");
  });
  it("reuses names provisioned by Cloudflare and connects the consumer to both queues", () => {
    const root = unstable_readConfig({ config: "wrangler.jsonc", env: "" }, { hideWarnings: true });
    const overrides = portableOverrides(
      root,
      {
        bindings: [
          { name: "BUCKET", type: "r2_bucket", bucket_name: "chosen-bucket" },
          { name: "DELIVERY_QUEUE", type: "queue", queue_name: "chosen-queue" },
          { name: "DELIVERY_DEAD_LETTER_QUEUE", type: "queue", queue_name: "chosen-dlq" },
          { name: "NOTES_WORKFLOW", type: "workflow", workflow_name: "chosen-jobs" },
          { name: "OBSERVABILITY", type: "analytics_engine", dataset: "chosen_metrics" },
        ],
      },
      "notes",
      "https://example.com",
      {},
    );
    expect(overrides.r2_buckets[0].bucket_name).toBe("chosen-bucket");
    expect(overrides.queues.consumers[0]).toMatchObject({ queue: "chosen-queue", dead_letter_queue: "chosen-dlq" });
    expect(overrides.queues.producers.map((entry) => entry.queue)).toEqual(["chosen-queue", "chosen-dlq"]);
    expect(overrides.workflows[0].name).toBe("chosen-jobs");
    expect(overrides.analytics_engine_datasets[0].dataset).toBe("chosen_metrics");
  });
  it("isolates new rate-limit namespaces by Worker and binding and keeps them stable across retries", () => {
    const root = unstable_readConfig({ config: "wrangler.jsonc", env: "" }, { hideWarnings: true });
    const first = portableOverrides(root, null, "first-wiki", "https://example.com", {}).ratelimits;
    const second = portableOverrides(root, null, "second-wiki", "https://example.com", {}).ratelimits;
    expect(first).toEqual(portableOverrides(root, null, "first-wiki", "https://example.com", {}).ratelimits);
    const ids = [...first, ...second].map((entry) => entry.namespace_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(root.ratelimits.some((entry) => entry.namespace_id === id)).toBe(false);
      expect(Number.isSafeInteger(Number(id))).toBe(true);
      expect(Number(id)).toBeGreaterThan(0);
    }
    expect(first.map((entry) => entry.simple)).toEqual(root.ratelimits.map((entry) => entry.simple));
  });
  it.each([1, 50, 51, 52, 54, 55, 59, 63])(
    "isolates R2 and queues for a %s-character Worker and keeps retry names stable",
    (length) => {
      const root = unstable_readConfig({ config: "wrangler.jsonc", env: "" }, { hideWarnings: true });
      const name = "a".repeat(length);
      const resources = (worker, config = root, settings = null) => {
        const overrides = portableOverrides(config, settings, worker, "https://example.com", {});
        expect(overrides.queues.consumers[0]).toMatchObject({
          queue: overrides.queues.producers[0].queue,
          dead_letter_queue: overrides.queues.producers[1].queue,
        });
        return [overrides.r2_buckets[0].bucket_name, ...overrides.queues.producers.map((entry) => entry.queue)];
      };
      const first = resources(name);
      const other = resources(`${name.slice(0, -1)}b`);
      expect(first).toEqual(resources(name));
      expect(new Set([...first, ...other]).size).toBe(6);
      for (const resource of first) {
        expect(resource.length).toBeLessThanOrEqual(63);
        expect(resource).toMatch(/^[a-z0-9][a-z0-9-]+[a-z0-9]$/);
      }
      const suffixes = ["-attachments", "-delivery", "-delivery-dlq"];
      const unshortened = first.filter((_, index) => length + suffixes[index].length <= 63);
      expect(unshortened).toEqual(
        suffixes.filter((suffix) => length + suffix.length <= 63).map((suffix) => `${name}${suffix}`),
      );
      expect(
        resources(name, root, {
          bindings: [
            { name: "BUCKET", type: "r2_bucket", bucket_name: "noteflare" },
            { name: "DELIVERY_QUEUE", type: "queue", queue_name: "noteflare-delivery" },
            { name: "DELIVERY_DEAD_LETTER_QUEUE", type: "queue", queue_name: "noteflare-delivery-dlq" },
          ],
        }),
      ).toEqual(["noteflare", "noteflare-delivery", "noteflare-delivery-dlq"]);
    },
  );
  it("keeps explicit custom resource names on fresh installations", () => {
    const root = unstable_readConfig({ config: "wrangler.jsonc", env: "" }, { hideWarnings: true });
    const config = {
      ...root,
      r2_buckets: [{ binding: "BUCKET", bucket_name: "custom-attachments" }],
      queues: {
        ...root.queues,
        producers: root.queues.producers.map((entry, index) => ({
          ...entry,
          queue: index ? "custom-dlq" : "custom-delivery",
        })),
        consumers: [{ ...root.queues.consumers[0], queue: "custom-delivery", dead_letter_queue: "custom-dlq" }],
      },
    };
    const overrides = portableOverrides(config, null, "wiki", "https://example.com", {});
    expect(overrides.r2_buckets[0].bucket_name).toBe("custom-attachments");
    expect(overrides.queues.producers.map((entry) => entry.queue)).toEqual(["custom-delivery", "custom-dlq"]);
    expect(overrides.queues.consumers[0]).toMatchObject({ queue: "custom-delivery", dead_letter_queue: "custom-dlq" });
  });
  it("preserves existing rate-limit namespaces and allocates only missing bindings", () => {
    const root = unstable_readConfig({ config: "wrangler.jsonc", env: "" }, { hideWarnings: true });
    const settings = { bindings: [{ name: root.ratelimits[0].name, type: "ratelimit", namespace_id: "987654" }] };
    const overrides = portableOverrides(root, settings, "wiki", "https://example.com", {});
    expect(overrides.ratelimits[0].namespace_id).toBe("987654");
    expect(overrides.ratelimits.slice(1)).toEqual(
      portableOverrides(root, null, "wiki", "https://example.com", {}).ratelimits.slice(1),
    );
    settings.bindings[0].namespace_id = "invalid";
    expect(() => portableOverrides(root, settings, "wiki", "https://example.com", {})).toThrow("invalid namespace ID");
  });
  it.each([59, 60, 61, 62, 63])("bounds generated Workflow names for a %s-character Worker", (length) => {
    const root = unstable_readConfig({ config: "wrangler.jsonc", env: "" }, { hideWarnings: true });
    const name = "a".repeat(length);
    const generated = portableOverrides(root, null, name, "https://example.com", {}).workflows[0].name;
    expect(generated.length).toBeLessThanOrEqual(64);
    expect(generated).toMatch(/^[a-z0-9-]+-jobs$/);
    expect(generated).toBe(portableOverrides(root, null, name, "https://example.com", {}).workflows[0].name);
    const other = portableOverrides(root, null, `${name.slice(0, -1)}b`, "https://example.com", {}).workflows[0].name;
    expect(other).not.toBe(generated);
    expect(
      portableOverrides(
        root,
        { bindings: [{ name: "NOTES_WORKFLOW", type: "workflow", workflow_name: "saved-jobs" }] },
        name,
        "https://example.com",
        {},
      ).workflows[0].name,
    ).toBe("saved-jobs");
  });
  it("keeps the full generated Workflow name at the 64-character boundary", () => {
    const root = unstable_readConfig({ config: "wrangler.jsonc", env: "" }, { hideWarnings: true });
    const name = "a".repeat(59);
    expect(portableOverrides(root, null, name, "https://example.com", {}).workflows[0].name).toBe(`${name}-jobs`);
  });
  it("uses Vite's output pointer for renamed Workers and rejects output outside dist", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "noteflare-output-"));
    try {
      mkdirSync(resolve(directory, ".wrangler/deploy"), { recursive: true });
      const pointer = resolve(directory, ".wrangler/deploy/config.json");
      writeFileSync(pointer, JSON.stringify({ configPath: "../../dist/renamed_worker/wrangler.json" }));
      expect(outputConfig(directory)).toBe(resolve(directory, "dist/renamed_worker/wrangler.json"));
      writeFileSync(pointer, JSON.stringify({ configPath: "../../wrangler.jsonc" }));
      expect(() => outputConfig(directory)).toThrow("inside dist");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each(["source", "buildUUID", "revision", "target", "name", "account", "origin"])(
    "rejects artifacts with mismatched %s",
    (key) => {
      const manifest = {
        source: "hash",
        buildUUID: "run",
        revision: "sha",
        target: "",
        name: "notes",
        account: "account",
        origin: "https://notes.example",
      };
      manifest.configurationHash = configurationHash(manifest);
      expect(() => verifyBuild(manifest, manifest)).not.toThrow();
      expect(() => verifyBuild(manifest, { ...manifest, [key]: "different" })).toThrow(`match ${key}`);
    },
  );
  it("compares nested configuration without depending on object key order", () => {
    const context = {
      origin: "https://notes.example",
      overrides: {
        vars: { FIRST: "one", SECOND: "two" },
        queues: {
          producers: [
            { binding: "DELIVERY_QUEUE", queue: "first" },
            { binding: "DELIVERY_DEAD_LETTER_QUEUE", queue: "second" },
          ],
          consumers: [{ queue: "first" }],
        },
      },
    };
    const manifest = { ...context, configurationHash: configurationHash(context) };
    expect(() =>
      verifyBuild(manifest, {
        ...context,
        overrides: { queues: context.overrides.queues, vars: { SECOND: "two", FIRST: "one" } },
      }),
    ).not.toThrow();
    expect(() =>
      verifyBuild(manifest, { ...context, overrides: { ...context.overrides, vars: { FIRST: "changed" } } }),
    ).toThrow("configuration overrides");
    expect(() =>
      verifyBuild(manifest, {
        ...context,
        overrides: {
          ...context.overrides,
          queues: { ...context.overrides.queues, producers: context.overrides.queues.producers.toReversed() },
        },
      }),
    ).toThrow("configuration overrides");
    expect(() => verifyBuild(context, context)).toThrow("configuration overrides");
  });
});

describe("portable database selection", () => {
  const config = { d1_databases: [{ binding: "DB", database_name: "noteflare", database_id: placeholderID }] };
  it.each([{ database_id: existingDB }, { id: existingDB }, { database_id: existingDB, id: newDB }])(
    "preserves a saved D1 identity without provisioning %#",
    async (identity) => {
      const api = vi.fn();
      const settings = { bindings: [{ name: "DB", type: "d1", ...identity }] };
      expect((await portableDatabase(config, settings, "wiki", api)).database_id).toBe(existingDB);
      expect(api).not.toHaveBeenCalled();
    },
  );
  it("requires an explicitly configured database ID before reusing an application database", async () => {
    const explicit = { d1_databases: [{ ...config.d1_databases[0], database_id: existingDB }] };
    const api = vi.fn();
    expect((await portableDatabase(explicit, null, "wiki", api)).database_id).toBe(existingDB);
    await expect(
      portableDatabase(explicit, { bindings: [{ name: "DB", type: "d1", database_id: newDB }] }, "wiki", api),
    ).rejects.toThrow("DB differs");
    expect(api).not.toHaveBeenCalled();
  });
  it.each([{}, { database_id: "" }, { database_id: "invalid" }, { database_id: placeholderID }])(
    "rejects a malformed saved identity before provisioning %#",
    async (identity) => {
      const api = vi.fn();
      const settings = { bindings: [{ name: "DB", type: "d1", ...identity }] };
      await expect(portableDatabase(config, settings, "wiki", api)).rejects.toThrow("Existing DB binding");
      expect(api).not.toHaveBeenCalled();
    },
  );
  it.each(["", "invalid", null])("rejects an invalid configured database ID: %s", async (id) => {
    const api = vi.fn();
    await expect(
      portableDatabase({ d1_databases: [{ ...config.d1_databases[0], database_id: id }] }, null, "wiki", api),
    ).rejects.toThrow("Configured DB");
    expect(api).not.toHaveBeenCalled();
  });
  it.each(["noteflare", "team-wiki", "a".repeat(63)])("creates a Worker-specific database for %s", async (name) => {
    const api = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce({ uuid: newDB });
    const result = await portableDatabase(config, null, name, api);
    expect(result.database_id).toBe(newDB);
    expect(result.database_name).not.toBe("noteflare");
    expect(result.database_name.length).toBeLessThanOrEqual(64);
    expect(api).toHaveBeenNthCalledWith(1, `/d1/database?name=${result.database_name}&per_page=100&page=1`);
    expect(api).toHaveBeenNthCalledWith(2, "/d1/database", { method: "POST", body: { name: result.database_name } });
  });
  it("respects custom database names and keeps dry runs free of provisioning", async () => {
    const api = vi.fn();
    const custom = { d1_databases: [{ ...config.d1_databases[0], database_name: "chosen-db" }] };
    expect(await portableDatabase(custom, null, "wiki", api, true)).toEqual({
      database_name: "chosen-db",
      database_id: placeholderID,
    });
    expect(api).not.toHaveBeenCalled();
  });
  it("reuses only empty named databases when a build is retried before upload", async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce([{ name: "wiki-db", uuid: newDB }])
      .mockResolvedValueOnce([{ success: true, results: [{ name: "_cf_KV" }] }]);
    expect(await portableDatabase(config, null, "wiki", api)).toEqual({ database_id: newDB, database_name: "wiki-db" });
    expect(api).toHaveBeenNthCalledWith(2, `/d1/database/${newDB}/query`, {
      method: "POST",
      body: { sql: "SELECT name FROM sqlite_master WHERE type='table';" },
    });
  });
  it.each([0, 1])("checks migration history before reusing a database with %s applied migrations", async (applied) => {
    const api = vi
      .fn()
      .mockResolvedValueOnce([{ name: "wiki-db", uuid: newDB }])
      .mockResolvedValueOnce([{ success: true, results: [{ name: "d1_migrations" }, { name: "sqlite_sequence" }] }])
      .mockResolvedValueOnce([{ success: true, results: [{ applied }] }]);
    const result = await portableDatabase(config, null, "wiki", api).catch((error) => error.message);
    expect(result).toEqual(
      applied === 0
        ? { database_id: newDB, database_name: "wiki-db" }
        : "Existing D1 database requires an explicit database_id or saved Worker DB binding before reuse.",
    );
    expect(api).toHaveBeenNthCalledWith(3, `/d1/database/${newDB}/query`, {
      method: "POST",
      body: { sql: "SELECT count(*) applied FROM d1_migrations;" },
    });
  });
  it.each(
    [
      null,
      [],
      [{ success: false, results: [{ applied: 0 }] }],
      ...[
        [],
        [{}],
        [{ applied: "0" }],
        [{ applied: -1 }],
        [{ applied: 0.5 }],
        [{ applied: Number.MAX_SAFE_INTEGER + 1 }],
        [{ applied: 0 }, { applied: 0 }],
      ].map((results) => [{ success: true, results }]),
    ].map((history) => ({ history })),
  )("rejects malformed migration history %#", async ({ history }) => {
    const api = vi
      .fn()
      .mockResolvedValueOnce([{ name: "wiki-db", uuid: newDB }])
      .mockResolvedValueOnce([{ success: true, results: [{ name: "d1_migrations" }] }])
      .mockResolvedValueOnce(history);
    await expect(portableDatabase(config, null, "wiki", api)).rejects.toThrow(
      /Invalid migration history|invalid D1 query/,
    );
  });
  it("stops when the migration history query fails", async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce([{ name: "wiki-db", uuid: newDB }])
      .mockResolvedValueOnce([{ success: true, results: [{ name: "d1_migrations" }] }])
      .mockRejectedValueOnce(new Error("D1 unavailable"));
    await expect(portableDatabase(config, null, "wiki", api)).rejects.toThrow("D1 unavailable");
  });
  it.each(["install_state", "workspaces", "unrelated_table"])(
    "rejects implicit reuse of a database containing %s",
    async (table) => {
      const api = vi
        .fn()
        .mockResolvedValueOnce([{ name: "wiki-db", uuid: existingDB }])
        .mockResolvedValueOnce([{ success: true, results: [{ name: table }] }]);
      await expect(portableDatabase(config, null, "wiki", api)).rejects.toThrow("explicit database_id");
      expect(api).toHaveBeenCalledTimes(2);
    },
  );
  it.each([null, [{}], [{ name: "wiki-db" }, { name: "wiki-db" }]])(
    "rejects ambiguous database lookups %#",
    async (matches) => {
      const api = vi.fn().mockResolvedValue(matches);
      await expect(portableDatabase(config, null, "wiki", api)).rejects.toThrow("ambiguous D1 resources");
      expect(api).toHaveBeenCalledTimes(1);
    },
  );
  it("ignores partial matches and follows pagination before selecting a database", async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, i) => ({ name: `wiki-db-staging-${i}`, uuid: existingDB })),
      )
      .mockResolvedValueOnce([
        { name: "wiki-db", uuid: newDB },
        { name: "wiki-db-other", uuid: existingDB },
      ])
      .mockResolvedValueOnce([{ success: true, results: [] }]);
    expect((await portableDatabase(config, null, "wiki", api)).database_id).toBe(newDB);
    expect(api).toHaveBeenNthCalledWith(2, "/d1/database?name=wiki-db&per_page=100&page=2");
    expect(api.mock.calls.every(([, options]) => !options || options.body?.name === undefined)).toBe(true);
  });
  it("rejects exact duplicates across pages before querying or creating a database", async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce([
        { name: "wiki-db", uuid: existingDB },
        ...Array.from({ length: 99 }, () => ({ name: "wiki-db-staging" })),
      ])
      .mockResolvedValueOnce([{ name: "wiki-db", uuid: newDB }]);
    await expect(portableDatabase(config, null, "wiki", api)).rejects.toThrow("ambiguous D1 resources");
    expect(api).toHaveBeenCalledTimes(2);
  });
  it("creates a database when the search contains only partial names", async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce([{ name: "wiki-db-staging" }])
      .mockResolvedValueOnce({ uuid: newDB });
    expect((await portableDatabase(config, null, "wiki", api)).database_id).toBe(newDB);
    expect(api).toHaveBeenLastCalledWith("/d1/database", { method: "POST", body: { name: "wiki-db" } });
  });
  it.each([undefined, "invalid", placeholderID])("rejects invalid provisioning IDs: %s", async (id) => {
    const api = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce({ uuid: id });
    await expect(portableDatabase(config, null, "wiki", api)).rejects.toThrow("valid database ID");
  });
  it.each([null, [], [{ success: false, results: [] }], [{ success: true, results: null }]])(
    "rejects malformed database schema results %#",
    async (result) => {
      const api = vi
        .fn()
        .mockResolvedValueOnce([{ name: "wiki-db", uuid: existingDB }])
        .mockResolvedValueOnce(result);
      await expect(portableDatabase(config, null, "wiki", api)).rejects.toThrow("invalid D1 query");
    },
  );
});

describe("installation secrets and deployment ordering", () => {
  it("recognizes fresh remote D1 storage without accepting unknown internal tables", () => {
    const execute = vi.fn().mockReturnValue(queryResult([{ name: "_cf_KV" }]));
    expect(initializedDatabase("/build/wrangler.json", execute)).toBe(false);
    expect(execute.mock.calls[0][0]).toContain("/build/wrangler.json");
    execute.mockReturnValue(queryResult([{ name: "_cf_UNKNOWN" }]));
    expect(() => initializedDatabase("/build/wrangler.json", execute)).toThrow("unknown application tables");
  });
  it.each([0, 1])("reads the existing installation state: %s", (initialized) => {
    const execute = vi
      .fn()
      .mockReturnValueOnce(queryResult([{ name: "install_state" }, { name: "workspaces" }]))
      .mockReturnValueOnce(queryResult([{ initialized }]));
    expect(initializedDatabase("/build/wrangler.json", execute)).toBe(initialized === 1);
  });
  it.each([{ status: 1 }, { status: 0, stdout: "invalid" }, queryResult([{ name: null }])])(
    "rejects failed or malformed installation queries %#",
    (failure) => {
      expect(() => initializedDatabase("/build/wrangler.json", () => failure)).toThrow(
        /installation preflight|installation schema/,
      );
    },
  );
  it("generates only missing internal secrets before initialization", () => {
    expect(missingSecrets(["BETTER_AUTH_SECRET", "BOOTSTRAP_TOKEN"], false)).toEqual([
      "WEBHOOK_ENCRYPTION_KEY",
      "OBSERVABILITY_PROBE_TOKEN",
    ]);
    expect(missingSecrets(["BETTER_AUTH_SECRET"], true)).toEqual([]);
    expect(() => missingSecrets([], true)).toThrow("Restore the original secret");
  });
  it.each([false, true])("cleans up a private secret file when upload fails: %s", async (fails) => {
    let path;
    const operation = withSecretsFile({ WEBHOOK_ENCRYPTION_KEY: "private" }, (value) => {
      path = value;
      expect(statSync(value).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(value, "utf8"))).toEqual({ WEBHOOK_ENCRYPTION_KEY: "private" });
      if (fails) throw new Error("Upload failed");
    });
    const error = await operation.catch((failure) => failure.message);
    expect(error).toBe(fails ? "Upload failed" : undefined);
    expect(existsSync(path)).toBe(false);
  });
  it("uploads independent keys after migrations and checks health afterward", async () => {
    const calls = [];
    const deps = dependencies();
    deps.migrateDatabase.mockImplementation(() => {
      calls.push("migrate");
      return 0;
    });
    deps.upload.mockImplementation((path) => {
      calls.push("upload");
      const secrets = JSON.parse(readFileSync(path, "utf8"));
      expect(Object.keys(secrets)).toHaveLength(3);
      expect(new Set(Object.values(secrets)).size).toBe(3);
      expect(secrets.WEBHOOK_ENCRYPTION_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(secrets).not.toHaveProperty("BOOTSTRAP_TOKEN");
    });
    deps.health.mockImplementation(() => calls.push("health"));
    await deployPrepared({ target: "" }, deps);
    expect(calls).toEqual(["migrate", "upload", "health"]);
  });
  it("checks metadata before and after migration and preserves the applied migration on incomplete coverage", async () => {
    const deps = dependencies();
    const calls = [];
    deps.integrityCheck = vi.fn((stage) => {
      calls.push(stage);
      return { ok: true, complete: stage === "before migrations" };
    });
    deps.migrateDatabase.mockImplementation(() => {
      calls.push("migrate");
      return 0;
    });
    await expect(deployPrepared({ target: "production" }, deps)).rejects.toThrow(
      "applied migrations and resources were preserved",
    );
    expect(calls).toEqual(["before migrations", "migrate", "after migrations"]);
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.health).not.toHaveBeenCalled();
  });
  it("blocks migrations when the initial integrity scan finds a structural failure", async () => {
    const deps = dependencies();
    deps.integrityCheck = vi.fn(() => ({ ok: false, complete: true }));
    await expect(deployPrepared({ target: "production" }, deps)).rejects.toThrow("before migrations failed");
    expect(deps.migrateDatabase).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
  });
  it("does not rotate secrets or recreate a deleted setup key after initialization", async () => {
    const deps = dependencies();
    deps.isInitialized.mockReturnValue(true);
    deps.inspectSecrets.mockReturnValue(["BETTER_AUTH_SECRET", "WEBHOOK_ENCRYPTION_KEY", "OBSERVABILITY_PROBE_TOKEN"]);
    await deployPrepared({ target: "" }, deps);
    expect(deps.upload).toHaveBeenCalledWith(undefined);
  });
  it("stops before migration or upload when an initialized installation needs auth-secret recovery", async () => {
    const deps = dependencies();
    deps.isInitialized.mockReturnValue(true);
    deps.inspectSecrets.mockReturnValue(["WEBHOOK_ENCRYPTION_KEY", "OBSERVABILITY_PROBE_TOKEN"]);
    await expect(deployPrepared({ target: "" }, deps)).rejects.toThrow("Restore the original secret");
    expect(deps.migrateDatabase).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
  });
  it("stops upload and health checks after a failed migration", async () => {
    const deps = dependencies();
    deps.migrateDatabase.mockReturnValue(1);
    await expect(deployPrepared({ target: "" }, deps)).rejects.toThrow("upload was not started");
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.health).not.toHaveBeenCalled();
  });
  it("keeps the existing production path out of automatic secret management", async () => {
    const deps = dependencies();
    await deployPrepared({ target: "production" }, deps);
    expect(deps.isInitialized).not.toHaveBeenCalled();
    expect(deps.inspectSecrets).not.toHaveBeenCalled();
    expect(deps.upload).toHaveBeenCalledWith(undefined);
  });
  it("rejects a missing setup key without logging its value", async () => {
    const token = "private-short-key";
    vi.stubEnv("BOOTSTRAP_TOKEN", token);
    const deps = dependencies();
    deps.inspectSecrets.mockReturnValue([]);
    let failure;
    try {
      await deployPrepared({ target: "" }, deps);
    } catch (error) {
      failure = error.message;
    }
    expect(failure).toContain("at least 32 characters");
    expect(failure).not.toContain(token);
    expect(deps.migrateDatabase).not.toHaveBeenCalled();
  });
});
