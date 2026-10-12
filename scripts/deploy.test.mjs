import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_readConfig } from "wrangler";
import {
  deployPrepared,
  initializedDatabase,
  installationOrigin,
  missingSecrets,
  outputConfig,
  portableOverrides,
  selectTarget,
  verifyBuild,
  withSecretsFile,
} from "./deploy.mjs";

afterEach(() => vi.unstubAllEnvs());
const production = { name: "legacy-notes", d1_databases: [{ binding: "DB", database_id: "legacy-db" }] };
const binding = { name: "DB", type: "d1", id: "legacy-db" };
const selection = { name: "legacy-notes", workersCI: true, production, settings: { bindings: [binding] } };
const queryResult = (rows) => ({ status: 0, stdout: JSON.stringify([{ success: true, results: rows }]) });
const dependencies = () => ({
  isInitialized: vi.fn().mockReturnValue(false),
  inspectSecrets: vi.fn().mockReturnValue(["BOOTSTRAP_TOKEN"]),
  migrateDatabase: vi.fn().mockReturnValue(0),
  upload: vi.fn(),
  health: vi.fn(),
});

describe("deployment targets and portable configuration", () => {
  it("recognizes a legacy Workers Builds deployment by name and database", () => {
    expect(selectTarget(selection)).toBe("production");
    expect(selectTarget({ ...selection, name: "new-notes" })).toBe("");
    expect(selectTarget({ ...selection, settings: { bindings: [{ ...binding, id: "new-db" }] } })).toBe("");
    expect(selectTarget({ ...selection, settings: null })).toBe("");
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
  it.each(["source", "buildUUID", "revision", "target", "name", "account"])(
    "rejects artifacts with mismatched %s",
    (key) => {
      const manifest = {
        source: "hash",
        buildUUID: "run",
        revision: "sha",
        target: "",
        name: "notes",
        account: "account",
      };
      expect(() => verifyBuild(manifest, manifest)).not.toThrow();
      expect(() => verifyBuild(manifest, { ...manifest, [key]: "different" })).toThrow(`match ${key}`);
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
