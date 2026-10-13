import { describe, expect, it, vi } from "vitest";
import { unstable_readConfig } from "wrangler";
import {
  configurationHash,
  createGeneratedResources,
  deployPrepared,
  deploymentErrorMessage,
  portableDatabase,
  portableOverrides,
  portablePreparation,
  portableResources,
  preflightGeneratedResources,
  verifyBuild,
} from "./deploy.mjs";
import { freshDatabase, queryRows } from "./migrate-d1.mjs";

const databaseID = "11111111-1111-1111-1111-111111111111";
const root = () => unstable_readConfig({ config: "wrangler.jsonc", env: "" }, { hideWarnings: true });
const pages = (result = [], page = 1, total = 1) => ({ result, result_info: { page, total_pages: total } });
const generated = (type, name) => ({
  type,
  binding: type === "bucket" ? "BUCKET" : "DELIVERY_QUEUE",
  name,
  provenance: "generated",
});

describe("portable resource intent", () => {
  it.each([false, true])("preserves provisioned source names, including template defaults (custom=%s)", (custom) => {
    const config = root();
    config.d1_databases[0].database_id = databaseID;
    if (custom) {
      config.r2_buckets[0].bucket_name = "chosen-attachments";
      config.queues.producers[0].queue = config.queues.consumers[0].queue = "chosen-delivery";
      config.queues.producers[1].queue = config.queues.consumers[0].dead_letter_queue = "chosen-dlq";
    }
    const resources = portableResources(config, null, "renamed-worker");
    expect(resources.map((r) => r.name)).toEqual([
      config.r2_buckets[0].bucket_name,
      ...config.queues.producers.map((r) => r.queue),
    ]);
    expect(resources.every((r) => r.provenance === "configured")).toBe(true);
    const overrides = portableOverrides(config, null, "renamed-worker", "https://example.test", {}, resources);
    expect(overrides.queues.consumers[0]).toMatchObject({
      queue: config.queues.producers[0].queue,
      dead_letter_queue: config.queues.producers[1].queue,
    });
  });
  it("does not infer source intent from a resolved database ID", () => {
    const config = root();
    const overrides = portableOverrides(config, null, "new-worker", "https://example.test", {
      database_id: databaseID,
    });
    expect(overrides.r2_buckets[0].bucket_name).toBe("new-worker-attachments");
    expect(portableResources(config, null, "new-worker").every((r) => r.provenance === "generated")).toBe(true);
  });
  it.each(["bucket", "queue"])("uses saved %s bindings for templates and rejects explicit conflicts", (type) => {
    const config = root();
    const saved =
      type === "bucket"
        ? { name: "BUCKET", type: "r2_bucket", bucket_name: "saved-bucket" }
        : { name: "DELIVERY_QUEUE", type: "queue", queue_name: "saved-queue" };
    const settings = { bindings: [saved] };
    expect(portableResources(config, settings, "worker").find((r) => r.binding === saved.name)).toMatchObject({
      name: type === "bucket" ? "saved-bucket" : "saved-queue",
      provenance: "saved",
    });
    config.d1_databases[0].database_id = databaseID;
    expect(portableResources(config, settings, "worker").find((r) => r.binding === saved.name)).toMatchObject({
      name: type === "bucket" ? "saved-bucket" : "saved-queue",
      provenance: "saved",
    });
    if (type === "bucket") config.r2_buckets[0].bucket_name = "custom-bucket";
    else config.queues.producers[0].queue = "custom-queue";
    expect(() => portableResources(config, settings, "worker")).toThrow("differs");
    config.d1_databases[0].database_id = "00000000-0000-0000-0000-000000000000";
    if (type === "bucket") config.r2_buckets[0].bucket_name = "custom-bucket";
    else config.queues.producers[0].queue = "custom-queue";
    expect(() => portableResources(config, settings, "worker")).toThrow("differs");
  });
  it("omits unconfigured dead-letter destinations without a producer", () => {
    const config = root();
    config.queues.producers = config.queues.producers.slice(0, 1);
    delete config.queues.consumers[0].dead_letter_queue;
    const overrides = portableOverrides(config, null, "worker", "https://example.test", {});
    expect(overrides.queues.consumers[0].queue).toBe("worker-delivery");
    expect(Object.hasOwn(overrides.queues.consumers[0], "dead_letter_queue")).toBe(false);
  });
  it("retains all #248 generated bindings with concrete source D1 and template names", () => {
    const config = root();
    config.d1_databases[0].database_id = databaseID;
    const bindings = [
      { name: "BUCKET", type: "r2_bucket", bucket_name: "wiki-attachments" },
      { name: "DELIVERY_QUEUE", type: "queue", queue_name: "wiki-delivery" },
      { name: "DELIVERY_DEAD_LETTER_QUEUE", type: "queue", queue_name: "wiki-delivery-dlq" },
    ];
    const resources = portableResources(config, { bindings }, "wiki");
    expect(resources.map((r) => [r.name, r.provenance])).toEqual([
      ["wiki-attachments", "saved"],
      ["wiki-delivery", "saved"],
      ["wiki-delivery-dlq", "saved"],
    ]);
    const overrides = portableOverrides(
      config,
      { bindings },
      "wiki",
      "https://example.test",
      { database_id: databaseID },
      resources,
    );
    expect(overrides.queues.consumers[0]).toMatchObject({
      queue: "wiki-delivery",
      dead_letter_queue: "wiki-delivery-dlq",
    });
  });
  it.each(
    ["queue", "dead_letter_queue"].flatMap((role) =>
      ["missing", "existing", "malformed", "ambiguous", "unavailable"].map((state) => ({ role, state })),
    ),
  )("strictly validates consumer-only custom $role queues ($state) before D1", async ({ role, state }) => {
    const config = root();
    config.queues.producers = config.queues.producers.filter(
      (producer) => producer.binding !== (role === "queue" ? "DELIVERY_QUEUE" : "DELIVERY_DEAD_LETTER_QUEUE"),
    );
    config.queues.consumers[0][role] = "custom-dlq";
    const api = vi.fn(async (path, options) => {
      if (path.startsWith("/r2/")) return null;
      if (path.startsWith("/queues?")) {
        if (!path.includes("name=custom-dlq")) return pages();
        if (state === "unavailable") throw new Error("lookup unavailable");
        if (state === "malformed") return {};
        const page = Number(new URL(`https://example.test${path}`).searchParams.get("page"));
        if (page === 1) return pages([{ queue_id: "one", queue_name: "custom-dlq-near-match" }], 1, 2);
        return pages(
          state === "existing"
            ? [{ queue_id: "two", queue_name: "custom-dlq" }]
            : state === "ambiguous"
              ? [
                  { queue_id: "two", queue_name: "custom-dlq" },
                  { queue_id: "three", queue_name: "custom-dlq" },
                ]
              : [],
          2,
          2,
        );
      }
      if (path.startsWith("/d1/database?")) return [];
      if (options?.method === "POST") return { uuid: databaseID };
      throw new Error("Unexpected request");
    });
    const outcome = await portablePreparation(config, null, "worker", api).then(
      (prepared) => ({
        resource: prepared.resources.at(-1),
        destination: portableOverrides(
          config,
          null,
          "worker",
          "https://example.test",
          prepared.database,
          prepared.resources,
        ).queues.consumers[0][role],
      }),
      (error) => ({ error: error.message }),
    );
    const expectedResource = expect.objectContaining({
      name: "custom-dlq",
      provenance: "configured",
      consumerOnly: true,
      role,
    });
    const expectedError = expect.stringMatching(/does not exist|ambiguous|lookup unavailable/);
    expect(outcome).toEqual(
      state === "existing" ? { resource: expectedResource, destination: "custom-dlq" } : { error: expectedError },
    );
    expect(api.mock.calls.some(([path]) => path.startsWith("/d1/"))).toBe(state === "existing");
  });
  it.each(["DELIVERY_QUEUE", "DELIVERY_DEAD_LETTER_QUEUE"])(
    "rejects missing template %s before API requests",
    async (binding) => {
      const config = root();
      config.queues.producers = config.queues.producers.filter((producer) => producer.binding !== binding);
      const api = vi.fn();
      await expect(portablePreparation(config, null, "worker", api)).rejects.toThrow(`Restore ${binding}`);
      expect(api).not.toHaveBeenCalled();
    },
  );
  it.each(["provision", "upload"])("prints the original %s failure together with adoption guidance", async (stage) => {
    const cause = new Error("Cloudflare POST request failed (403). Check account permissions.");
    const failure = await deployPrepared(
      { target: "production", resources: [generated("bucket", "worker-attachments")] },
      {
        migrateDatabase: () => 0,
        provisionResources: async () => {
          if (stage === "provision") throw cause;
        },
        upload: async () => {
          if (stage === "upload") throw cause;
        },
        health: vi.fn(),
      },
    ).catch((error) => error);
    expect(failure.cause).toBe(cause);
    expect(deploymentErrorMessage(failure)).toContain(cause.message);
    expect(deploymentErrorMessage(failure)).toContain("explicitly configure");
    expect(deploymentErrorMessage(cause)).toBe(cause.message);
  });
  it("fingerprints provenance and rejects obsolete manifests", () => {
    const context = { origin: "https://example.test", resources: [generated("bucket", "worker-attachments")] };
    const manifest = { ...context, configurationHash: configurationHash(context) };
    expect(() => verifyBuild(manifest, context)).not.toThrow();
    expect(() =>
      verifyBuild(manifest, { ...context, resources: [{ ...context.resources[0], provenance: "configured" }] }),
    ).toThrow("Run the build again");
    const consumer = { ...generated("queue", "existing"), consumerOnly: true, role: "queue", provenance: "configured" };
    const consumerContext = { origin: context.origin, resources: [consumer] };
    const consumerManifest = { ...consumerContext, configurationHash: configurationHash(consumerContext) };
    expect(() =>
      verifyBuild(consumerManifest, { ...consumerContext, resources: [{ ...consumer, role: "dead_letter_queue" }] }),
    ).toThrow("Run the build again");
    const obsolete = { ...context, configurationHash: configurationHash({ origin: context.origin }) };
    expect(() => verifyBuild(obsolete, context)).toThrow("Run the build again");
  });
});

describe("generated resource provisioning", () => {
  it("checks exact bucket and all queue pages before creating D1", async () => {
    const api = vi.fn(async (path, options) => {
      if (path.startsWith("/r2/buckets/")) return null;
      if (path.startsWith("/queues?"))
        return pages(
          [{ queue_id: path, queue_name: "near-match" }],
          Number(new URL(`https://example.test${path}`).searchParams.get("page")),
          2,
        );
      if (path.startsWith("/d1/database?")) return [];
      if (options?.method === "POST") return { uuid: databaseID };
      throw new Error("Unexpected request");
    });
    const result = await portablePreparation(root(), null, "worker", api);
    expect(result.database.database_id).toBe(databaseID);
    const calls = api.mock.calls;
    expect(calls.slice(0, 5).every(([path]) => path.startsWith("/r2/") || path.startsWith("/queues?"))).toBe(true);
    expect(calls[5][0]).toContain("/d1/database?");
  });
  it.each(["bucket", "queue"])("rejects generated %s collisions before D1 preparation", async (type) => {
    const api = vi.fn(async (path) =>
      path.startsWith("/r2/")
        ? type === "bucket"
          ? { name: "worker-attachments" }
          : null
        : pages([{ queue_name: "worker-delivery", queue_id: "existing" }]),
    );
    await expect(portablePreparation(root(), null, "worker", api)).rejects.toThrow(
      "configure its name and the D1 ID explicitly",
    );
    expect(api.mock.calls.some(([path]) => path.startsWith("/d1/"))).toBe(false);
  });
  it("finds a queue collision on a short non-final page", async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce(pages([{ queue_name: "other", queue_id: "one" }], 1, 2))
      .mockResolvedValueOnce(pages([{ queue_name: "worker-delivery", queue_id: "two" }], 2, 2));
    await expect(preflightGeneratedResources([generated("queue", "worker-delivery")], api)).rejects.toThrow(
      "already exists",
    );
    expect(api).toHaveBeenCalledTimes(2);
  });
  it.each([
    null,
    {},
    { result: [], result_info: {} },
    pages([{}]),
    pages([], 2),
    pages([], 1, -1),
    pages([
      { queue_name: "worker-delivery", queue_id: "a" },
      { queue_name: "worker-delivery", queue_id: "b" },
    ]),
  ])("rejects malformed or ambiguous queue responses %#", async (response) => {
    await expect(
      preflightGeneratedResources([generated("queue", "worker-delivery")], vi.fn().mockResolvedValue(response)),
    ).rejects.toThrow("ambiguous queue");
  });
  it("rejects repeated pagination and unexpected exact bucket results", async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce(pages([{ queue_id: "a", queue_name: "other" }], 1, 2))
      .mockResolvedValueOnce(pages([{ queue_id: "a", queue_name: "other" }], 2, 2));
    await expect(preflightGeneratedResources([generated("queue", "worker-delivery")], api)).rejects.toThrow(
      "ambiguous queue",
    );
    await expect(
      preflightGeneratedResources(
        [generated("bucket", "worker-attachments")],
        vi.fn().mockResolvedValue({ name: "other" }),
      ),
    ).rejects.toThrow("ambiguous R2");
  });
  it("propagates lookup failures without creating D1", async () => {
    const api = vi.fn().mockRejectedValue(new Error("lookup unavailable"));
    await expect(portablePreparation(root(), null, "worker", api)).rejects.toThrow("lookup unavailable");
    expect(api).toHaveBeenCalledOnce();
  });
  it.each([null, "conflict", "partial"])(
    "creates only after migrations, stops on races/partial creation (%s)",
    async (failure) => {
      const resources = [
        generated("bucket", "worker-attachments"),
        generated("queue", "worker-delivery"),
        { ...generated("queue", "worker-delivery-dlq"), binding: "DELIVERY_DEAD_LETTER_QUEUE" },
      ];
      const operations = [];
      const api = vi.fn(async (path, { method, body }) => {
        operations.push(body.name ?? body.queue_name);
        expect(method).toBe("POST");
        if (failure === "conflict" || (failure === "partial" && path === "/queues"))
          throw new Error("creation conflict");
        return path === "/r2/buckets" ? body : { ...body, queue_id: body.queue_name };
      });
      const deps = {
        migrateDatabase: () => {
          operations.push("migrate");
          return 0;
        },
        provisionResources: () => createGeneratedResources(resources, api),
        upload: vi.fn(() => operations.push("upload")),
        health: vi.fn(),
        isInitialized: vi.fn(),
        inspectSecrets: vi.fn(),
      };
      const error = await deployPrepared({ target: "production", resources }, deps).then(
        () => null,
        (cause) => cause,
      );
      const expectedError = expect.objectContaining({
        message: expect.stringContaining("explicitly configure"),
        cause: expect.objectContaining({ message: "creation conflict" }),
      });
      expect(error).toEqual(failure ? expectedError : null);
      expect(deps.upload).toHaveBeenCalledTimes(failure ? 0 : 1);
      expect(deps.health).toHaveBeenCalledTimes(failure ? 0 : 1);
      expect(operations).toEqual(
        failure === "conflict"
          ? ["migrate", "worker-attachments"]
          : failure === "partial"
            ? ["migrate", "worker-attachments", "worker-delivery"]
            : ["migrate", "worker-attachments", "worker-delivery", "worker-delivery-dlq", "upload"],
      );
      expect(operations[0]).toBe("migrate");
    },
  );
  it("requires explicit adoption after a failed first upload and then uses saved bindings", async () => {
    const config = root();
    const resources = portableResources(config, null, "worker");
    const api = vi.fn(async (path, options) => {
      if (options?.method === "POST")
        return path === "/r2/buckets" ? options.body : { ...options.body, queue_id: options.body.queue_name };
      if (path.startsWith("/r2/")) return { name: "worker-attachments" };
      return pages();
    });
    await expect(
      deployPrepared(
        { target: "production", resources },
        {
          migrateDatabase: () => 0,
          provisionResources: () => createGeneratedResources(resources, api),
          upload: () => {
            throw new Error("upload unavailable");
          },
          health: vi.fn(),
        },
      ),
    ).rejects.toThrow("populated D1 database ID");
    await expect(portablePreparation(config, null, "worker", api)).rejects.toThrow("already exists");
    config.d1_databases[0].database_id = databaseID;
    config.r2_buckets[0].bucket_name = "worker-attachments";
    config.queues.producers[0].queue = config.queues.consumers[0].queue = "worker-delivery";
    config.queues.producers[1].queue = config.queues.consumers[0].dead_letter_queue = "worker-delivery-dlq";
    api.mockClear();
    expect(
      (await portablePreparation(config, null, "worker", api)).resources.every((r) => r.provenance === "configured"),
    ).toBe(true);
    expect(api).not.toHaveBeenCalled();
    const bindings = resources.map((r) => ({
      name: r.binding,
      type: r.type === "bucket" ? "r2_bucket" : "queue",
      [r.type === "bucket" ? "bucket_name" : "queue_name"]: r.name,
    }));
    expect(portableResources(root(), { bindings }, "worker").every((r) => r.provenance === "saved")).toBe(true);
  });
  it("leaves saved/configured provisioning to Wrangler and rejects malformed creation", async () => {
    const api = vi.fn();
    await createGeneratedResources(
      [
        { ...generated("bucket", "chosen"), provenance: "configured" },
        { ...generated("queue", "saved"), provenance: "saved" },
      ],
      api,
    );
    expect(api).not.toHaveBeenCalled();
    api.mockResolvedValue({});
    await expect(createGeneratedResources([generated("bucket", "worker-attachments")], api)).rejects.toThrow(
      "invalid bucket creation",
    );
  });
});

const matrices = [
  { name: "no tables", schema: [], history: [], valid: true },
  { name: "internal tables", schema: [{ name: "_cf_KV" }, { name: "sqlite_sequence" }], history: [], valid: true },
  { name: "empty history", schema: [{ name: "d1_migrations" }], history: [{ applied: 0 }], valid: true },
  { name: "populated history", schema: [{ name: "d1_migrations" }], history: [{ applied: 1 }], valid: false },
  { name: "application tables", schema: [{ name: "pages" }], history: [], valid: false },
  { name: "malformed schema", schema: [{}], history: [], valid: false },
  ...[
    [],
    [{}],
    [{ applied: "0" }],
    [{ applied: -1 }],
    [{ applied: 0.5 }],
    [{ applied: Number.MAX_SAFE_INTEGER + 1 }],
    [{ applied: 0 }, { applied: 0 }],
  ].map((history, n) => ({ name: `malformed count ${n}`, schema: [{ name: "d1_migrations" }], history, valid: false })),
  { name: "query failure", schema: [{ name: "d1_migrations" }], history: [], valid: false, queryFailure: true },
];
for (const adapter of ["REST", "Wrangler"])
  describe(`${adapter} fresh D1 validation`, () => {
    it.each(matrices)("$name", async ({ schema, history, valid, queryFailure }) => {
      let succeeded;
      try {
        if (adapter === "REST") {
          const config = root();
          const api = vi.fn(async (path, options) => {
            if (path.includes("?name=")) return [{ name: "worker-db", uuid: databaseID }];
            if (queryFailure) throw new Error("query failed");
            return [{ success: true, results: options.body.sql.includes("sqlite_master") ? schema : history }];
          });
          await portableDatabase(config, null, "worker", api);
        } else
          freshDatabase(["0001_initial.sql"], (sql) => {
            const result = queryFailure
              ? { status: 1, stderr: "query failed" }
              : {
                  status: 0,
                  stdout: JSON.stringify([
                    { success: true, results: sql.includes("sqlite_master") ? schema : history },
                  ]),
                };
            return queryRows(result, "test");
          });
        succeeded = true;
      } catch {
        succeeded = false;
      }
      expect(succeeded).toBe(valid);
    });
  });
