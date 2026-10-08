import { abortAllDurableObjects, applyD1Migrations, env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Env } from "./env";

type TestDocument = {
  document: Y.Doc;
  onRequest(request: Request): Promise<Response>;
  compact(forceVersion?: boolean): Promise<void>;
  flushPendingUpdates(): void;
  bindings: Env;
  metadata: { retired: number };
};

function internalWarmupRequest() {
  return new Request("https://document.internal/noop", { headers: { "x-notes-internal": env.BETTER_AUTH_SECRET } });
}

async function fixture() {
  const pageId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('response-owner','Owner','response-owner@example.test',1,1)",
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('response-workspace','Responses',1)"),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('response-workspace','response-owner','owner',1)",
    ),
    env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
      VALUES(?,'response-workspace','response-workspace-general','document','a0','Response barrier','response-owner',1,1)`).bind(
      pageId,
    ),
  ]);
  return { userId: "response-owner", pageId };
}

function documentBlock(id: string, value: string) {
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", id);
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("backgroundColor", "default");
  paragraph.setAttribute("textColor", "default");
  paragraph.setAttribute("textAlignment", "left");
  const text = new Y.XmlText();
  text.insert(0, value);
  paragraph.insert(0, [text]);
  container.insert(0, [paragraph]);
  return { container, text };
}

function installDocumentBlocks(document: Y.Doc, ...containers: Y.XmlElement[]) {
  const fragment = document.getXmlFragment("document-store");
  if (fragment.length) fragment.delete(0, fragment.length);
  const group = new Y.XmlElement("blockGroup");
  group.insert(0, containers);
  fragment.insert(0, [group]);
}

const protectedOperationId = "mcp:v2:response-grant:protected-operation";
const protectedInputHash = "a".repeat(64);

function protectedMutation(userId: string, overrides: Record<string, unknown> = {}) {
  return new Request("https://document.internal/api-mutate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-notes-internal": env.BETTER_AUTH_SECRET },
    body: JSON.stringify({
      actorId: userId,
      operationId: protectedOperationId,
      mcpInputHash: protectedInputHash,
      operations: [
        {
          type: "append_children",
          children: [
            {
              type: "blockContainer",
              attrs: { id: "protected-block" },
              content: [{ type: "paragraph", content: [{ type: "text", text: "Protected append" }] }],
            },
          ],
        },
      ],
      ...overrides,
    }),
  });
}

function protectedLookup(hash?: unknown, operationId = protectedOperationId) {
  const url = new URL("https://document.internal/api-mutate-receipt");
  url.searchParams.set("operationId", operationId);
  if (hash !== undefined && hash !== null) url.searchParams.set("mcpInputHash", String(hash));
  return new Request(url, { headers: { "x-notes-internal": env.BETTER_AUTH_SECRET } });
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  await env.DB.batch([env.DB.prepare("DELETE FROM workspaces"), env.DB.prepare("DELETE FROM user")]);
});
afterEach(async () => {
  await abortAllDurableObjects();
  await env.DB.batch([env.DB.prepare("DELETE FROM workspaces"), env.DB.prepare("DELETE FROM user")]);
  await reset();
});

describe("document mutation response barriers", () => {
  it.each([
    "fresh",
    "existing",
    "receipt",
    "fresh authorization",
    "existing authorization",
    "fresh receipt-only authorization",
    "existing receipt-only authorization",
    "receipt receipt-only",
  ])("returns a captured mutation revision after compaction: %s", async (mode) => {
    const receiptOnly = mode.includes("receipt-only");
    const receiptLookup = mode.startsWith("receipt");
    const denied = mode.includes("authorization") && !receiptOnly;
    const installed = await fixture();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      installDocumentBlocks(room.document, documentBlock("response-block", "Before").container);
      const originalDb = room.bindings.DB;
      let permitted = true;
      room.bindings.DB = new Proxy(originalDb, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) =>
              sql.includes("SELECT 1 FROM slack_product_sessions")
                ? {
                    bind() {
                      return this;
                    },
                    async first() {
                      return permitted ? { allowed: 1 } : null;
                    },
                  }
                : target.prepare(sql);
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const mutation = () =>
        new Request("https://document.internal/api-mutate", {
          method: "POST",
          headers: { "content-type": "application/json", "x-notes-internal": env.BETTER_AUTH_SECRET },
          body: JSON.stringify({
            actorId: installed.userId,
            operationId: "captured-operation",
            ...(receiptOnly ? { responseMode: "receipt" } : {}),
            ...(mode.includes("authorization") ? { slackProductSessionId: "test-session" } : {}),
            operations: [
              {
                type: "update_block",
                internalId: "response-block",
                node: {
                  type: "paragraph",
                  content: [{ type: "text", text: "Mutation result" }],
                },
              },
            ],
          }),
        });
      const originalCompact = room.compact.bind(room);
      let capturedSequence = 0;
      let restoreCompact: (() => void) | undefined;
      try {
        let seedStatus = 200;
        if (mode.startsWith("existing") || receiptLookup) {
          seedStatus = (await room.onRequest(mutation())).status;
          room.document.getMap("test-dirty").set("value", 1);
        }
        expect(seedStatus).toBe(200);
        const spy = vi.spyOn(room, "compact").mockImplementation(async (forceVersion) => {
          capturedSequence = state.storage.sql
            .exec<{ seq: number }>("SELECT MAX(seq) seq FROM update_events")
            .one().seq;
          // A websocket deletion arrives after the response revision was captured.
          const group = room.document.getXmlFragment("document-store").get(0) as Y.XmlElement;
          group.delete(0, 1);
          permitted = false;
          await originalCompact(forceVersion);
        });
        restoreCompact = () => spy.mockRestore();
        const request = receiptLookup
          ? new Request(
              `https://document.internal/api-mutate-receipt?operationId=captured-operation${receiptOnly ? "&responseMode=receipt" : ""}`,
              {
                headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
              },
            )
          : mutation();
        const response = await room.onRequest(request);
        const result = await response.json<{ document?: unknown; sequence?: number; error?: string }>();
        expect(response.status).toBe(denied ? 403 : 200);
        expect(Object.keys(result).sort()).toEqual(
          denied
            ? ["error"]
            : receiptOnly
              ? receiptLookup
                ? ["committed", "found", "operationId"]
                : ["committed", "operationId"]
              : receiptLookup
                ? ["document", "found", "sequence"]
                : ["document", "sequence"],
        );
        expect(JSON.stringify(result)).toContain(
          denied ? "slack_identity_required" : receiptOnly ? "captured-operation" : "Mutation result",
        );
        expect(result.sequence ?? capturedSequence).toBe(capturedSequence);
        expect(
          state.storage.sql.exec<{ snapshot_seq: number }>("SELECT snapshot_seq FROM document_meta").one().snapshot_seq,
        ).toBeGreaterThan(capturedSequence);
        expect(room.document.getMap("api-operation-receipts").size).toBe(1);
        expect((room.document.getXmlFragment("document-store").get(0) as Y.XmlElement).length).toBe(0);
      } finally {
        restoreCompact?.();
        room.bindings.DB = originalDb;
      }
    });
  });

  it.each([
    "included",
    "behind",
    "retired",
    "purged",
    "active failure",
    "retry failure",
    "retired failure",
    "purged failure",
  ])("waits for active mutation compaction: %s", async (mode) => {
    const installed = await fixture();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      const block = documentBlock("barrier-block", "Captured content");
      installDocumentBlocks(room.document, block.container);
      room.document.getMap("api-operation-receipts").set("barrier-operation", "hash");
      room.flushPendingUpdates();
      let started!: () => void;
      const arrived = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const originalBucket = room.bindings.BUCKET;
      let writes = 0;
      room.bindings.BUCKET = new Proxy(originalBucket, {
        get(target, key) {
          if (key === "put")
            return async (...args: Parameters<R2Bucket["put"]>) => {
              if (writes++ === 0) {
                started();
                await held;
                if (mode.includes("failure")) throw new Error("Compaction write unavailable");
              }
              if (mode === "retry failure") throw new Error("Compaction retry unavailable");
              return target.put(...args);
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const compact = vi.spyOn(room, "compact");
      const active = room.compact();
      await arrived;
      if (mode === "behind") block.text.insert(block.text.length, " before response");
      room.flushPendingUpdates();
      const captured = state.storage.sql.exec<{ seq: number }>("SELECT MAX(seq) seq FROM update_events").one().seq;
      const response = room.onRequest(
        new Request("https://document.internal/api-mutate-receipt?operationId=barrier-operation", {
          headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
        }),
      );
      const settledResponse = response.catch((error: unknown) => error);
      await Promise.resolve();
      if (mode.startsWith("retired")) room.metadata.retired = 1;
      if (mode.startsWith("purged"))
        await room.onRequest(
          new Request("https://document.internal/purge", {
            method: "POST",
            headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
          }),
        );
      release();
      try {
        await active.catch((error) => {
          if (!mode.startsWith("purged") && !mode.includes("failure")) throw error;
        });
        const result = await settledResponse;
        const failed = mode === "retry failure";
        const retired = mode.startsWith("retired") || mode.startsWith("purged");
        expect(result instanceof Error ? result.message : null).toBe(failed ? "Compaction retry unavailable" : null);
        expect(result instanceof Response ? result.status : null).toBe(failed ? null : retired ? 410 : 200);
        const body = result instanceof Response ? await result.json<{ document?: unknown; sequence?: number }>() : {};
        expect(body.sequence ?? null).toBe(retired || failed ? null : captured);
        expect(JSON.stringify(body.document) ?? "").toContain(
          retired || failed ? "" : mode === "behind" ? "Captured content before response" : "Captured content",
        );
        const compactions = ["behind", "active failure", "retry failure"].includes(mode) ? 2 : 1;
        expect(compact).toHaveBeenCalledTimes(compactions);
        const lookup =
          retired || failed
            ? null
            : await room.onRequest(
                new Request(
                  "https://document.internal/api-mutate-receipt?operationId=barrier-operation&responseMode=receipt",
                  {
                    headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
                  },
                ),
              );
        expect(lookup ? await lookup.json() : null).toEqual(
          retired || failed ? null : { found: true, committed: true, operationId: "barrier-operation" },
        );
        expect(compact).toHaveBeenCalledTimes(compactions);
        expect(room.document.getMap("api-operation-receipts").size).toBe(1);
      } finally {
        room.bindings.BUCKET = originalBucket;
        compact.mockRestore();
      }
    });
  });

  it("requires an operation ID and returns idempotent content-free mutation receipts", async () => {
    const installed = await fixture();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const room = instance as unknown as TestDocument;
      installDocumentBlocks(room.document, documentBlock("existing", "Before").container);
      const headers = { "content-type": "application/json", "x-notes-internal": env.BETTER_AUTH_SECRET };
      const mutation = (operationId: unknown, text = "Append once") =>
        room.onRequest(
          new Request("https://document.internal/api-mutate", {
            method: "POST",
            headers,
            body: JSON.stringify({
              actorId: installed.userId,
              responseMode: "receipt",
              operationId,
              operations: [
                {
                  type: "append_children",
                  position: { type: "end" },
                  children: [
                    {
                      type: "blockContainer",
                      attrs: { id: "receipt-block" },
                      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
                    },
                  ],
                },
              ],
            }),
          }),
        );
      for (const invalid of [null, 123, "invalid operation"]) expect((await mutation(invalid)).status).toBe(400);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await mutation("receipt-operation");
        expect(result.status).toBe(200);
        expect(await result.json()).toEqual({ committed: true, operationId: "receipt-operation" });
      }
      const mismatch = await mutation("receipt-operation", "Changed body");
      expect(mismatch.status).toBe(409);
      expect(await mismatch.json()).toEqual({ error: "idempotency_key_reused" });
      expect((room.document.getXmlFragment("document-store").get(0) as Y.XmlElement).length).toBe(2);
      const receipt = await room.onRequest(
        new Request("https://document.internal/api-mutate-receipt?operationId=receipt-operation&responseMode=receipt", {
          headers,
        }),
      );
      expect(await receipt.json()).toEqual({ found: true, committed: true, operationId: "receipt-operation" });
    });
  });

  it("returns 410 for a retained mutation receipt after a warm purge", async () => {
    const installed = await fixture();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const room = instance as unknown as TestDocument;
      room.document.getMap("api-operation-receipts").set("purged-operation", "hash");
      const headers = { "x-notes-internal": env.BETTER_AUTH_SECRET };
      expect(
        (await room.onRequest(new Request("https://document.internal/purge", { method: "POST", headers }))).status,
      ).toBe(200);
      for (const mode of ["content", "receipt"]) {
        const result = await room.onRequest(
          new Request(
            `https://document.internal/api-mutate-receipt?operationId=purged-operation&responseMode=${mode}`,
            { headers },
          ),
        );
        expect(result.status).toBe(410);
      }
    });
  });
});

describe("protected MCP operation identity", () => {
  it.each([undefined, null, 123, "A".repeat(64), "a".repeat(63)])(
    "requires a lowercase SHA-256 input identity: %s",
    async (hash) => {
      const installed = await fixture();
      const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
      await stub.fetch(internalWarmupRequest());
      await runInDurableObject(stub, async (instance, state) => {
        const room = instance as unknown as TestDocument;
        for (const request of [protectedMutation(installed.userId, { mcpInputHash: hash }), protectedLookup(hash)]) {
          const rejected = await room.onRequest(request);
          expect(rejected.status).toBe(409);
          expect(await rejected.json()).toEqual({ error: "operation_id_reused" });
        }
        expect(room.document.getMap("api-operation-receipts").size).toBe(0);
        expect(state.storage.sql.exec("SELECT * FROM api_operation_inputs").toArray()).toEqual([]);
      });
    },
  );

  it("returns the original revision after later edits, compaction and restart", async () => {
    const installed = await fixture();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    let sequence = 0;
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      const written = await room.onRequest(protectedMutation(installed.userId));
      expect(written.status).toBe(200);
      sequence = (await written.json<{ sequence: number }>()).sequence;
      expect(state.storage.sql.exec("SELECT * FROM api_operation_inputs").toArray()).toEqual([
        { operation_id: protectedOperationId, input_hash: protectedInputHash, sequence },
      ]);
      const group = room.document.getXmlFragment("document-store").get(0) as Y.XmlElement;
      group.insert(group.length, [documentBlock("later-edit", "Later edit").container]);
      await room.compact();
      expect(
        state.storage.sql.exec<{ snapshot_seq: number }>("SELECT snapshot_seq FROM document_meta").one().snapshot_seq,
      ).toBeGreaterThan(sequence);
      expect(state.storage.sql.exec("SELECT * FROM update_events").toArray()).toEqual([]);
      for (const request of [protectedLookup(protectedInputHash), protectedMutation(installed.userId)]) {
        const replay = await room.onRequest(request);
        expect(replay.status).toBe(200);
        expect((await replay.json<{ sequence: number }>()).sequence).toBe(sequence);
      }
      expect(group.length).toBe(2);
    });
    await abortAllDurableObjects();
    const restarted = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    const replay = await restarted.fetch(protectedLookup(protectedInputHash));
    expect(replay.status).toBe(200);
    expect((await replay.json<{ sequence: number }>()).sequence).toBe(sequence);
  });

  it("rejects missing or changed identities for a committed receipt", async () => {
    const installed = await fixture();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    expect((await stub.fetch(protectedMutation(installed.userId))).status).toBe(200);
    for (const hash of [undefined, "b".repeat(64)]) {
      for (const request of [protectedLookup(hash), protectedMutation(installed.userId, { mcpInputHash: hash })]) {
        const rejected = await stub.fetch(request);
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toEqual({ error: "operation_id_reused" });
      }
    }
    const changedOperations = await stub.fetch(
      protectedMutation(installed.userId, { operations: [{ type: "delete_block", internalId: "protected-block" }] }),
    );
    expect(changedOperations.status).toBe(409);
    expect(await changedOperations.json()).toEqual({ error: "idempotency_key_reused" });
  });

  it.each(["identity", "receipt"])("rejects one-sided %s loss instead of treating it as absent", async (lost) => {
    const installed = await fixture();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    expect((await stub.fetch(protectedMutation(installed.userId))).status).toBe(200);
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      if (lost === "identity") state.storage.sql.exec("DELETE FROM api_operation_inputs");
      else room.document.getMap("api-operation-receipts").delete(protectedOperationId);
      for (const request of [protectedLookup(protectedInputHash), protectedMutation(installed.userId)]) {
        const rejected = await room.onRequest(request);
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toEqual({ error: "operation_receipt_unverifiable" });
      }
      expect((room.document.getXmlFragment("document-store").get(0) as Y.XmlElement).length).toBe(1);
      expect((await room.onRequest(protectedLookup(protectedInputHash, "mcp:v2:response-grant:absent"))).status).toBe(
        404,
      );
    });
  });

  it("does not downgrade a protected receipt inherited by version restore", async () => {
    const installed = await fixture();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    expect((await stub.fetch(protectedMutation(installed.userId))).status).toBe(200);
    const version = await env.DB.prepare("SELECT id FROM page_versions WHERE page_id=? ORDER BY created_at DESC")
      .bind(installed.pageId)
      .first<{ id: string }>();
    expect(version).not.toBeNull();
    const restored = await stub.fetch(
      new Request("https://document.internal/restore-version", {
        method: "POST",
        headers: { "content-type": "application/json", "x-notes-internal": env.BETTER_AUTH_SECRET },
        body: JSON.stringify({ versionId: version!.id, userId: installed.userId }),
      }),
    );
    expect(restored.status).toBe(200);
    const current = env.DOCUMENT.getByName(`${installed.pageId}~2`);
    for (const request of [protectedLookup(protectedInputHash), protectedMutation(installed.userId)]) {
      const rejected = await current.fetch(request);
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual({ error: "operation_receipt_unverifiable" });
    }
  });

  it("rolls back identity and update logging together, then flushes retained work on lookup", async () => {
    const installed = await fixture();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      state.storage.sql.exec(`CREATE TRIGGER reject_operation_input BEFORE INSERT ON api_operation_inputs
        BEGIN SELECT RAISE(ABORT, 'identity storage unavailable'); END`);
      await expect(room.onRequest(protectedMutation(installed.userId))).rejects.toThrow("identity storage unavailable");
      expect(state.storage.sql.exec("SELECT * FROM update_events").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT * FROM update_chunks").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT * FROM api_operation_inputs").toArray()).toEqual([]);
      state.storage.sql.exec("DROP TRIGGER reject_operation_input");
      const recovered = await room.onRequest(protectedLookup(protectedInputHash));
      expect(recovered.status).toBe(200);
      const { sequence } = await recovered.json<{ sequence: number }>();
      expect(state.storage.sql.exec("SELECT sequence FROM api_operation_inputs").one()).toEqual({ sequence });
      expect((await room.onRequest(protectedMutation(installed.userId))).status).toBe(200);
      expect((room.document.getXmlFragment("document-store").get(0) as Y.XmlElement).length).toBe(1);
    });
  });

  it("retries once after restart discards an uncommitted flush", async () => {
    const installed = await fixture();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      state.storage.sql.exec(`CREATE TRIGGER reject_operation_input BEFORE INSERT ON api_operation_inputs
        BEGIN SELECT RAISE(ABORT, 'identity storage unavailable'); END`);
      await expect(room.onRequest(protectedMutation(installed.userId))).rejects.toThrow("identity storage unavailable");
    });
    await abortAllDurableObjects();
    const restarted = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    expect((await restarted.fetch(protectedLookup(protectedInputHash))).status).toBe(404);
    await runInDurableObject(restarted, async (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER reject_operation_input");
    });
    expect((await restarted.fetch(protectedMutation(installed.userId))).status).toBe(200);
    await runInDurableObject(restarted, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      expect((room.document.getXmlFragment("document-store").get(0) as Y.XmlElement).length).toBe(1);
      expect(state.storage.sql.exec("SELECT * FROM api_operation_inputs").toArray()).toHaveLength(1);
    });
  });

  it("recovers a durable identity after response compaction fails and the room restarts", async () => {
    const installed = await fixture();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    let sequence = 0;
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      const compact = vi.spyOn(room, "compact").mockRejectedValueOnce(new Error("Snapshot unavailable"));
      try {
        await expect(room.onRequest(protectedMutation(installed.userId))).rejects.toThrow("Snapshot unavailable");
        sequence = state.storage.sql
          .exec<{ sequence: number }>("SELECT sequence FROM api_operation_inputs")
          .one().sequence;
        expect(state.storage.sql.exec("SELECT * FROM update_events").toArray()).toHaveLength(1);
      } finally {
        compact.mockRestore();
      }
    });
    await abortAllDurableObjects();
    const restarted = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    const recovered = await restarted.fetch(protectedLookup(protectedInputHash));
    expect(recovered.status).toBe(200);
    expect((await recovered.json<{ sequence: number }>()).sequence).toBe(sequence);
    expect((await restarted.fetch(protectedMutation(installed.userId))).status).toBe(200);
  });

  it.each([{ expectedSequence: 1 }, { operations: [{ type: "delete_block", internalId: "missing-block" }] }])(
    "leaves no receipt identity for a rejected mutation: %j",
    async (overrides) => {
      const installed = await fixture();
      const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
      const rejected = await stub.fetch(protectedMutation(installed.userId, overrides));
      expect([404, 409]).toContain(rejected.status);
      await runInDurableObject(stub, async (instance, state) => {
        const room = instance as unknown as TestDocument;
        expect(room.document.getMap("api-operation-receipts").has(protectedOperationId)).toBe(false);
        expect(state.storage.sql.exec("SELECT * FROM api_operation_inputs").toArray()).toEqual([]);
      });
    },
  );
});
