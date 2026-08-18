import {
  applyD1Migrations,
  abortAllDurableObjects,
  createExecutionContext,
  createScheduledController,
  env,
  reset,
  runInDurableObject,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { joinBytes } from "../shared/bytes";
import type { TableLeaseResponse, TableLeaseTiming } from "../shared/types";
import { processDeletionJob } from "./cleanup";
import worker from "./index";

type InstalledWorkspace = {
  cookie: string;
  pageId: string;
  userId: string;
  workspaceId: string;
};

function authenticatedRequest(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", "http://example.test");
  return new Request(`http://example.test${path}`, { ...init, headers });
}

function internalWarmupRequest() {
  return new Request("https://document.internal/noop", {
    headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
  });
}

async function bootstrap(): Promise<InstalledWorkspace> {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Test Notes",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const me = await (
    await SELF.fetch(authenticatedRequest(cookie!, "/api/me"))
  ).json<{
    user: { id: string };
    workspace: { id: string };
  }>();
  const tree = await (
    await SELF.fetch(authenticatedRequest(cookie!, "/api/pages/tree"))
  ).json<{
    pages: Array<{ id: string }>;
  }>();
  return {
    cookie: cookie!,
    pageId: tree.pages[0]!.id,
    userId: me.user.id,
    workspaceId: me.workspace.id,
  };
}

async function createPage(cookie: string, kind: "document" | "table" = "document", parentId: string | null = null) {
  const response = await SELF.fetch(
    authenticatedRequest(cookie, "/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, parentId }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json<{ page: { id: string } }>()).page;
}

type TestDocument = {
  document: Y.Doc;
  onAlarm(): Promise<void>;
  onSave(): Promise<void>;
  onRequest(request: Request): Promise<Response>;
  compact(forceVersion?: boolean): Promise<void>;
  restoreVersion(versionId: string, userId: string): Promise<Response>;
  finishTransition(): Promise<void>;
  scheduleAlarm(when: number): Promise<void>;
  deferAlarm(when: number): Promise<void>;
  flushPendingUpdates(): void;
  transition: "archive" | "restore" | null;
  transitionAlarmDeferred: boolean;
  transitionRetryAt: number | null;
  getConnections(): Array<{ close(code: number, reason: string): void }>;
  bindings: Cloudflare.Env;
  metadata: { retired: number; restore_pending: number };
};

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

describe("Worker integration", () => {
  it("reports a healthy empty installation", async () => {
    const [health, install] = await Promise.all([
      SELF.fetch("http://example.test/api/health"),
      SELF.fetch("http://example.test/api/install"),
    ]);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, version: "0.1.0" });
    expect(await install.json()).toEqual({ initialized: false });
  });

  it("blocks the raw Better Auth registration endpoint", async () => {
    const response = await SELF.fetch("http://example.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin: "http://example.test", "content-type": "application/json" },
      body: JSON.stringify({ name: "Bypass", email: "bypass@example.test", password: "password123" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "registration_closed", message: "Use the bootstrap screen or an invite to register." },
    });
    const count = await env.DB.prepare(`SELECT COUNT(*) count FROM user`).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("uses the shared JSON envelope for missing API routes", async () => {
    const response = await SELF.fetch("http://example.test/api/not-real");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "API route not found." } });
  });

  it("serves all byte-range forms and conditionally revalidates private attachments", async () => {
    const installed = await bootstrap();
    const form = new FormData();
    form.set("file", new File(["0123456789"], "sample.txt", { type: "text/plain" }));
    const upload = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/attachments`, {
        method: "POST",
        body: form,
      }),
    );
    expect(upload.status).toBe(201);
    const attachmentId = (await upload.json<{ attachment: { id: string } }>()).attachment.id;
    const path = `/api/attachments/${attachmentId}`;

    const normal = await SELF.fetch(authenticatedRequest(installed.cookie, path));
    expect(normal.status).toBe(200);
    expect(await normal.text()).toBe("0123456789");
    expect(normal.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    const etag = normal.headers.get("etag");
    expect(etag).toBeTruthy();
    await env.DB.prepare(`UPDATE attachments SET size = 999 WHERE id = ?`).bind(attachmentId).run();

    for (const [range, contentRange, body] of [
      ["bytes=2-5", "bytes 2-5/10", "2345"],
      ["bytes=6-", "bytes 6-9/10", "6789"],
      ["bytes=-3", "bytes 7-9/10", "789"],
      ["bytes=-500", "bytes 0-9/10", "0123456789"],
    ] as const) {
      const response = await SELF.fetch(
        authenticatedRequest(installed.cookie, path, {
          headers: { range },
        }),
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(contentRange);
      expect(response.headers.get("content-length")).toBe(String(body.length));
      expect(await response.text()).toBe(body);
    }

    const unchanged = await SELF.fetch(
      authenticatedRequest(installed.cookie, path, {
        headers: { "if-none-match": etag! },
      }),
    );
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("etag")).toBe(etag);

    const unchangedSince = await SELF.fetch(
      authenticatedRequest(installed.cookie, path, {
        headers: { "if-modified-since": new Date(Date.now() + 60_000).toUTCString() },
      }),
    );
    expect(unchangedSince.status).toBe(304);
    expect(await unchangedSince.text()).toBe("");

    const changed = await SELF.fetch(
      authenticatedRequest(installed.cookie, path, {
        headers: { "if-none-match": '"not-this-object"' },
      }),
    );
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe("0123456789");

    const failedPrecondition = await SELF.fetch(
      authenticatedRequest(installed.cookie, path, {
        headers: { "if-match": '"not-this-object"', "if-none-match": etag! },
      }),
    );
    expect(failedPrecondition.status).toBe(412);
    expect(await failedPrecondition.text()).toBe("");
  });

  it("rejects malformed internal workspace events", async () => {
    const installed = await bootstrap();
    const stub = env.WORKSPACE_EVENTS.getByName(installed.workspaceId);
    const malformed = await stub.fetch(
      new Request("https://workspace-events.internal/broadcast", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-notes-internal": env.BETTER_AUTH_SECRET,
        },
        body: JSON.stringify({ type: "pages-removed", permanently: false }),
      }),
    );
    expect(malformed.status).toBe(400);
  });

  it("allows JSON uploads, rejects executable extensions, and ignores punctuation-only search terms", async () => {
    const installed = await bootstrap();
    const jsonForm = new FormData();
    jsonForm.set("file", new File(["{}"], "settings.json", { type: "application/json" }));
    expect(
      (
        await SELF.fetch(
          authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/attachments`, {
            method: "POST",
            body: jsonForm,
          }),
        )
      ).status,
    ).toBe(201);

    const scriptForm = new FormData();
    scriptForm.set("file", new File(["alert(1)"], "payload.js", { type: "application/octet-stream" }));
    expect(
      (
        await SELF.fetch(
          authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/attachments`, {
            method: "POST",
            body: scriptForm,
          }),
        )
      ).status,
    ).toBe(415);

    const renamed = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "JSON Guide", revision: 1 }),
      }),
    );
    expect(renamed.status).toBe(200);
    const search = await SELF.fetch(authenticatedRequest(installed.cookie, "/api/search?q=JSON%20!!!"));
    expect(
      (await search.json<{ results: Array<{ page: { id: string } }> }>()).results.map((item) => item.page.id),
    ).toContain(installed.pageId);
    expect((await SELF.fetch(authenticatedRequest(installed.cookie, "/api/search?q=!!!"))).status).toBe(200);

    const backslashTitle = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Back\\Slash", revision: 2 }),
      }),
    );
    expect(backslashTitle.status).toBe(200);
    const suggestions = await (
      await SELF.fetch(
        authenticatedRequest(installed.cookie, `/api/mentions/suggestions?q=${encodeURIComponent("Back\\")}`),
      )
    ).json<{ suggestions: Array<{ entityId: string }> }>();
    expect(suggestions.suggestions.map((item) => item.entityId)).toContain(installed.pageId);
  });

  it("accepts a redundant invite for an existing workspace member without failing the membership constraint", async () => {
    const installed = await bootstrap();
    const inviteResponse = await SELF.fetch(
      authenticatedRequest(installed.cookie, "/api/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "viewer" }),
      }),
    );
    const invite = await inviteResponse.json<{ invite: { id: string; token: string } }>();
    const accepted = await SELF.fetch("http://example.test/api/invites/accept", {
      method: "POST",
      headers: { origin: "http://example.test", "content-type": "application/json" },
      body: JSON.stringify({
        token: invite.invite.token,
        email: "owner@example.test",
        password: "password123",
      }),
    });
    expect(accepted.status).toBe(200);
    expect(
      (
        await env.DB.prepare(`SELECT COUNT(*) count FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
          .bind(installed.workspaceId, installed.userId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      (
        await env.DB.prepare(`SELECT used_at FROM invites WHERE id = ?`)
          .bind(invite.invite.id)
          .first<{ used_at: number | null }>()
      )?.used_at,
    ).toBeNull();
  });

  it("coalesces document updates and never reuses a drained sequence", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const content = document.document.getMap<number>("test-content");
      content.set("first", 1);
      content.set("second", 2);
      await document.onSave();

      const events = state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM update_events ORDER BY seq`).toArray();
      expect(events).toHaveLength(1);
      const chunks = state.storage.sql
        .exec<{ data: ArrayBuffer }>(
          `SELECT data FROM update_chunks WHERE seq = ? ORDER BY chunk_index`,
          events[0]!.seq,
        )
        .toArray();
      const replica = new Y.Doc();
      Y.applyUpdate(replica, joinBytes(chunks.map((chunk) => new Uint8Array(chunk.data))));
      expect(replica.getMap("test-content").toJSON()).toEqual({ first: 1, second: 2 });
      replica.destroy();

      await document.compact();
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM update_events`).one().count).toBe(0);

      content.set("third", 3);
      await document.onSave();
      const next = state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM update_events`).one().seq;
      expect(next).toBeGreaterThan(events[0]!.seq);
    });
  });

  it("retires newly-created room state when its page no longer exists", async () => {
    const stub = env.DOCUMENT.getByName(`${crypto.randomUUID()}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql.exec<{ retired: number }>(`SELECT retired FROM document_meta WHERE id = 1`).one().retired,
      ).toBe(1);
    });
  });

  it("validates a restore before closing collaborators", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const close = vi.fn();
      const originalGetConnections = document.getConnections;
      document.getConnections = () => [{ close }];
      try {
        const response = await document.restoreVersion(crypto.randomUUID(), installed.userId);

        expect(response.status).toBe(404);
        expect(close).not.toHaveBeenCalled();
        expect(document.transition).toBeNull();
      } finally {
        document.getConnections = originalGetConnections;
      }
    });
  });

  it("claims archive validation before awaiting D1", async () => {
    const installed = await bootstrap();
    await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), installed.pageId).run();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const originalBindings = document.bindings;
      let releaseLookup!: () => void;
      let markLookupStarted!: () => void;
      const lookupGate = new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      const lookupStarted = new Promise<void>((resolve) => {
        markLookupStarted = resolve;
      });
      const database = new Proxy(originalBindings.DB, {
        get(target, property, receiver) {
          if (property !== "prepare") return Reflect.get(target, property, receiver);
          return (query: string) => {
            const statement = target.prepare(query);
            if (!query.includes("SELECT content_epoch, archived_at FROM pages")) return statement;
            return {
              bind: (...args: unknown[]) => {
                const bound = statement.bind(...args);
                return {
                  first: async <T>() => {
                    markLookupStarted();
                    await lookupGate;
                    return bound.first<T>();
                  },
                };
              },
            };
          };
        },
      });
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "DB") return database;
          return Reflect.get(target, property, receiver);
        },
      });

      const request = () =>
        new Request("https://document.internal/archive", {
          method: "POST",
          headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
        });
      try {
        const first = document.onRequest(request());
        await lookupStarted;
        expect((await document.onRequest(request())).status).toBe(409);
        expect((await document.restoreVersion(crypto.randomUUID(), installed.userId)).status).toBe(409);
        releaseLookup();
        expect((await first).status).toBe(200);
      } finally {
        document.bindings = originalBindings;
        releaseLookup();
      }
    });
  });

  it("releases an archive transition when flushing storage fails", async () => {
    const installed = await bootstrap();
    await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), installed.pageId).run();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const originalFlush = document.flushPendingUpdates;
      document.flushPendingUpdates = () => {
        throw new Error("storage unavailable");
      };
      try {
        await expect(
          document.onRequest(
            new Request("https://document.internal/archive", {
              method: "POST",
              headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
            }),
          ),
        ).rejects.toThrow("storage unavailable");
      } finally {
        document.flushPendingUpdates = originalFlush;
      }
      const retried = await document.onRequest(
        new Request("https://document.internal/archive", {
          method: "POST",
          headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
        }),
      );
      expect(retried.status).toBe(200);
    });
  });

  it("preserves updates and alarms that arrive while compaction is awaiting storage", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const content = document.document.getMap<number>("race-content");
      content.set("before", 1);
      await document.onSave();
      const capturedSequence = state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM update_events`).one().seq;

      const compacting = document.compact();
      content.set("during", 2);
      await document.onSave();
      await compacting;

      const meta = state.storage.sql
        .exec<{ dirty: number; snapshot_seq: number }>(`SELECT dirty, snapshot_seq FROM document_meta WHERE id = 1`)
        .one();
      const remaining = state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM update_events`).toArray();
      expect(meta).toEqual({ dirty: 1, snapshot_seq: capturedSequence });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.seq).toBeGreaterThan(capturedSequence);

      const firstAlarm = Date.now() + 20_000;
      await state.storage.deleteAlarm();
      await document.scheduleAlarm(firstAlarm);
      await document.scheduleAlarm(firstAlarm + 20_000);
      expect(await state.storage.getAlarm()).toBe(firstAlarm);
      await document.scheduleAlarm(firstAlarm - 10_000);
      expect(await state.storage.getAlarm()).toBe(firstAlarm - 10_000);
    });
  });

  it("serializes an archive compaction behind an in-flight alarm compaction", async () => {
    const installed = await bootstrap();
    await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), installed.pageId).run();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const content = document.document.getMap<number>("serialized-content");
      content.set("before", 1);
      await document.onSave();

      let releaseFirstPut!: () => void;
      let markFirstPutStarted!: () => void;
      const firstPutGate = new Promise<void>((resolve) => {
        releaseFirstPut = resolve;
      });
      const firstPutStarted = new Promise<void>((resolve) => {
        markFirstPutStarted = resolve;
      });
      const originalBindings = document.bindings;
      const bucket = originalBindings.BUCKET;
      let currentPuts = 0;
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property !== "BUCKET") return Reflect.get(target, property, receiver);
          return new Proxy(bucket, {
            get(bucketTarget, bucketProperty) {
              if (bucketProperty === "put")
                return async (...args: any[]) => {
                  if (String(args[0]).endsWith("/current.bin") && ++currentPuts === 1) {
                    markFirstPutStarted();
                    await firstPutGate;
                  }
                  return Reflect.apply(bucketTarget.put, bucketTarget, args);
                };
              const value = Reflect.get(bucketTarget, bucketProperty, bucketTarget);
              return typeof value === "function" ? value.bind(bucketTarget) : value;
            },
          });
        },
      });

      try {
        const firstCompaction = document.compact();
        await firstPutStarted;
        content.set("during", 2);
        await document.onSave();
        const archiving = document.onRequest(
          new Request("https://document.internal/archive", {
            method: "POST",
            headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
          }),
        );
        await Promise.resolve();
        expect(currentPuts).toBe(1);
        releaseFirstPut();
        const [, archived] = await Promise.all([firstCompaction, archiving]);
        expect(archived.status).toBe(200);
      } finally {
        document.bindings = originalBindings;
        releaseFirstPut();
      }

      const stored = await env.BUCKET.get(`documents/${installed.pageId}/epochs/1/current.bin`);
      expect(stored).toBeTruthy();
      const replica = new Y.Doc();
      Y.applyUpdate(replica, new Uint8Array(await stored!.arrayBuffer()));
      expect(replica.getMap("serialized-content").toJSON()).toEqual({ before: 1, during: 2 });
      replica.destroy();
    });
  });

  it("re-dirties and reschedules a document after failed compaction", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("failure-content").set("value", 1);
      await document.onSave();
      const originalBindings = document.bindings;
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "BUCKET")
            return {
              put: async () => {
                throw new Error("R2 unavailable");
              },
            };
          return Reflect.get(target, property, receiver);
        },
      });
      await expect(document.compact()).rejects.toThrow("R2 unavailable");
      document.bindings = originalBindings;

      expect(
        state.storage.sql.exec<{ dirty: number }>(`SELECT dirty FROM document_meta WHERE id = 1`).one().dirty,
      ).toBe(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("does not retire the current room when a restore commit fails, then retires it after a successful restore", async () => {
    const installed = await bootstrap();
    const room = `${installed.pageId}~1`;
    const stub = env.DOCUMENT.getByName(room);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const fragment = document.document.getXmlFragment("document-store");
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "Restorable content");
      paragraph.insert(0, [text]);
      fragment.insert(0, [paragraph]);
      await document.onSave();
      await document.compact(true);
    });
    const version = await env.DB.prepare(
      `SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(installed.pageId)
      .first<{ id: string }>();
    expect(version).toBeTruthy();

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const originalBindings = document.bindings;
      const failingDatabase = new Proxy(originalBindings.DB, {
        get(target, property) {
          if (property === "batch")
            return async () => {
              throw new Error("D1 unavailable");
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "DB") return failingDatabase;
          return Reflect.get(target, property, receiver);
        },
      });
      try {
        const failed = await document.restoreVersion(version!.id, installed.userId);
        expect(failed.status).toBe(503);
        expect(
          state.storage.sql.exec<{ retired: number }>(`SELECT retired FROM document_meta WHERE id = 1`).one().retired,
        ).toBe(0);
      } finally {
        document.bindings = originalBindings;
      }
    });
    expect(
      (
        await env.DB.prepare(`SELECT content_epoch FROM pages WHERE id = ?`)
          .bind(installed.pageId)
          .first<{ content_epoch: number }>()
      )?.content_epoch,
    ).toBe(1);

    const restored = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/restore-version`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ versionId: version!.id }),
      }),
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ pageId: installed.pageId, contentEpoch: 2 });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql.exec<{ retired: number }>(`SELECT retired FROM document_meta WHERE id = 1`).one().retired,
      ).toBe(1);
    });
  });

  it("keeps the new snapshot when a restore batch commits before its response fails", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("ambiguous-restore").set("value", 1);
      await document.onSave();
      await document.compact(true);
    });
    const version = await env.DB.prepare(
      `SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(installed.pageId)
      .first<{ id: string }>();
    expect(version).toBeTruthy();

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const originalBindings = document.bindings;
      const ambiguousDatabase = new Proxy(originalBindings.DB, {
        get(target, property) {
          if (property === "batch")
            return async (statements: D1PreparedStatement[]) => {
              await target.batch(statements);
              throw new Error("D1 response lost after commit");
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "DB") return ambiguousDatabase;
          return Reflect.get(target, property, receiver);
        },
      });
      try {
        const response = await document.restoreVersion(version!.id, installed.userId);
        expect(response.status).toBe(503);
        expect(
          state.storage.sql
            .exec<{ retired: number; restore_pending: number }>(
              `SELECT retired, restore_pending FROM document_meta WHERE id = 1`,
            )
            .one(),
        ).toEqual({ retired: 1, restore_pending: 0 });
      } finally {
        document.bindings = originalBindings;
      }
    });

    expect(
      (
        await env.DB.prepare(`SELECT content_epoch FROM pages WHERE id = ?`)
          .bind(installed.pageId)
          .first<{ content_epoch: number }>()
      )?.content_epoch,
    ).toBe(2);
    expect(await env.BUCKET.get(`documents/${installed.pageId}/epochs/2/current.bin`)).toBeTruthy();
    const preRestore = await env.DB.prepare(
      `SELECT r2_key FROM page_versions WHERE page_id = ? AND epoch = 1 AND id <> ?`,
    )
      .bind(installed.pageId, version!.id)
      .first<{ r2_key: string }>();
    expect(preRestore).toBeTruthy();
    expect(await env.BUCKET.get(preRestore!.r2_key)).toBeTruthy();
  });

  it("reconciles an unresolved restore from an alarm", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("unknown-restore").set("value", 1);
      await document.onSave();
      await document.compact(true);
    });
    const version = await env.DB.prepare(
      `SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(installed.pageId)
      .first<{ id: string }>();
    expect(version).toBeTruthy();

    let recovery!: { new_key: string; pre_key: string | null };
    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const originalBindings = document.bindings;
      const unavailableDatabase = new Proxy(originalBindings.DB, {
        get(target, property, receiver) {
          if (property === "batch")
            return async () => {
              throw new Error("D1 batch unavailable");
            };
          if (property !== "prepare") return Reflect.get(target, property, receiver);
          return (query: string) => {
            const statement = target.prepare(query);
            if (!query.includes("SELECT content_epoch FROM pages WHERE id = ?")) return statement;
            return {
              bind: (...args: unknown[]) => {
                statement.bind(...args);
                return {
                  first: async () => {
                    throw new Error("D1 confirmation unavailable");
                  },
                };
              },
            };
          };
        },
      });
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "DB") return unavailableDatabase;
          return Reflect.get(target, property, receiver);
        },
      });
      try {
        const response = await document.restoreVersion(version!.id, installed.userId);
        expect(response.status).toBe(503);
        expect(
          state.storage.sql
            .exec<{ retired: number; restore_pending: number }>(
              `SELECT retired, restore_pending FROM document_meta WHERE id = 1`,
            )
            .one(),
        ).toEqual({ retired: 0, restore_pending: 1 });
        recovery = state.storage.sql
          .exec<{ new_key: string; pre_key: string | null }>(
            `SELECT new_key, pre_key FROM restore_recovery WHERE id = 1`,
          )
          .one();
        expect(await state.storage.getAlarm()).not.toBeNull();
        expect(await env.BUCKET.get(recovery.new_key)).toBeTruthy();
        expect(await env.BUCKET.get(recovery.pre_key!)).toBeTruthy();
      } finally {
        document.bindings = originalBindings;
      }

      await document.onAlarm();
      expect(
        state.storage.sql
          .exec<{ retired: number; restore_pending: number }>(
            `SELECT retired, restore_pending FROM document_meta WHERE id = 1`,
          )
          .one(),
      ).toEqual({ retired: 0, restore_pending: 0 });
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM restore_recovery`).one().count).toBe(
        0,
      );
    });

    expect(
      (
        await env.DB.prepare(`SELECT content_epoch FROM pages WHERE id = ?`)
          .bind(installed.pageId)
          .first<{ content_epoch: number }>()
      )?.content_epoch,
    ).toBe(1);
    expect(await env.BUCKET.get(recovery.new_key)).toBeNull();
    expect(await env.BUCKET.get(recovery.pre_key!)).toBeNull();
  });

  it("retries failed restore cleanup and then follows the authoritative epoch", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      state.storage.sql.exec(
        `INSERT INTO restore_recovery (id, old_epoch, new_epoch, new_key, pre_key)
         VALUES (1, 1, 2, 'restore-new', 'restore-pre')`,
      );
      state.storage.sql.exec(`UPDATE document_meta SET retired = 1, restore_pending = 1 WHERE id = 1`);
      document.metadata.retired = 1;
      document.metadata.restore_pending = 1;

      const originalBindings = document.bindings;
      const deleteObject = vi.fn(async () => {
        throw new Error("R2 delete unavailable");
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "BUCKET")
            return new Proxy(target.BUCKET, {
              get: (bucket, key) => (key === "delete" ? deleteObject : Reflect.get(bucket, key, bucket)),
            });
          return Reflect.get(target, property, receiver);
        },
      });
      try {
        await document.onAlarm();
      } finally {
        document.bindings = originalBindings;
        error.mockRestore();
      }

      expect(deleteObject).toHaveBeenCalledTimes(2);
      expect(
        state.storage.sql
          .exec<{ retired: number; restore_pending: number }>(
            `SELECT retired, restore_pending FROM document_meta WHERE id = 1`,
          )
          .one(),
      ).toEqual({ retired: 1, restore_pending: 1 });
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM restore_recovery`).one().count).toBe(
        1,
      );
      expect(await state.storage.getAlarm()).not.toBeNull();

      await document.onAlarm();
      expect(
        state.storage.sql
          .exec<{ retired: number; restore_pending: number }>(
            `SELECT retired, restore_pending FROM document_meta WHERE id = 1`,
          )
          .one(),
      ).toEqual({ retired: 0, restore_pending: 0 });
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM restore_recovery`).one().count).toBe(
        0,
      );
    });
  });

  it("does not query deleted Durable Object storage when an alarm follows a purge", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      state.storage.sql.exec(
        `INSERT INTO restore_recovery (id, old_epoch, new_epoch, new_key, pre_key)
         VALUES (1, 1, 2, 'restore-new', NULL)`,
      );
      state.storage.sql.exec(`UPDATE document_meta SET restore_pending = 1 WHERE id = 1`);
      document.metadata.restore_pending = 1;

      const purged = await document.onRequest(
        new Request("https://document.internal/purge", {
          method: "POST",
          headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
        }),
      );

      expect(purged.status).toBe(200);
      await expect(document.onAlarm()).resolves.toBeUndefined();
    });
  });

  it("deletes only the superseded epoch snapshot when restore recovery finds a later epoch", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    const newKey = `documents/${installed.pageId}/epochs/2/current.bin`;
    const preKey = `documents/${installed.pageId}/versions/pre-restore.bin`;
    await env.BUCKET.put(newKey, "new epoch");
    await env.BUCKET.put(preKey, "pre restore");
    await env.DB.prepare(`UPDATE pages SET content_epoch = 3 WHERE id = ?`).bind(installed.pageId).run();

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      state.storage.sql.exec(
        `INSERT INTO restore_recovery (id, old_epoch, new_epoch, new_key, pre_key)
         VALUES (1, 1, 2, ?, ?)`,
        newKey,
        preKey,
      );
      state.storage.sql.exec(`UPDATE document_meta SET restore_pending = 1 WHERE id = 1`);
      document.metadata.restore_pending = 1;

      await document.onAlarm();

      expect(
        state.storage.sql
          .exec<{ retired: number; restore_pending: number }>(
            `SELECT retired, restore_pending FROM document_meta WHERE id = 1`,
          )
          .one(),
      ).toEqual({ retired: 1, restore_pending: 0 });
    });

    expect(await env.BUCKET.get(newKey)).toBeNull();
    expect(await env.BUCKET.get(preKey)).toBeTruthy();
  });

  it("does not reconcile restore recovery while the restore is still committing", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("restore-alarm-race").set("value", 1);
      await document.onSave();
      await document.compact(true);
    });
    const version = await env.DB.prepare(
      `SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(installed.pageId)
      .first<{ id: string }>();
    expect(version).toBeTruthy();
    const newKey = `documents/${installed.pageId}/epochs/2/current.bin`;

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const originalBindings = document.bindings;
      const bucket = originalBindings.BUCKET;
      let releaseNewSnapshot!: () => void;
      let markNewSnapshotStored!: () => void;
      const newSnapshotGate = new Promise<void>((resolve) => {
        releaseNewSnapshot = resolve;
      });
      const newSnapshotStored = new Promise<void>((resolve) => {
        markNewSnapshotStored = resolve;
      });
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property !== "BUCKET") return Reflect.get(target, property, receiver);
          return new Proxy(bucket, {
            get(bucketTarget, bucketProperty) {
              if (bucketProperty === "put")
                return async (...args: any[]) => {
                  const result = await Reflect.apply(bucketTarget.put, bucketTarget, args);
                  if (args[0] === newKey) {
                    markNewSnapshotStored();
                    await newSnapshotGate;
                  }
                  return result;
                };
              const value = Reflect.get(bucketTarget, bucketProperty, bucketTarget);
              return typeof value === "function" ? value.bind(bucketTarget) : value;
            },
          });
        },
      });

      // Record every requested alarm time: reading storage after the restore
      // resolves races the runtime delivering the (immediately due) alarm,
      // which clears the stored value.
      const scheduled: number[] = [];
      const originalScheduleAlarm = document.scheduleAlarm.bind(document);
      document.scheduleAlarm = async (when: number) => {
        scheduled.push(when);
        await originalScheduleAlarm(when);
      };

      try {
        const restoring = document.restoreVersion(version!.id, installed.userId);
        await newSnapshotStored;
        expect(document.transition).toBe("restore");
        expect(
          state.storage.sql.exec<{ restore_pending: number }>(`SELECT restore_pending FROM document_meta`).one()
            .restore_pending,
        ).toBe(1);

        await state.storage.deleteAlarm();
        await document.onAlarm();
        expect(await env.BUCKET.get(newKey)).toBeTruthy();
        const deferredAlarm = await state.storage.getAlarm();
        expect(deferredAlarm).not.toBeNull();

        releaseNewSnapshot();
        expect((await restoring).status).toBe(200);
        expect(scheduled.at(-1)).toBeLessThan(deferredAlarm!);
      } finally {
        document.bindings = originalBindings;
        Reflect.deleteProperty(document, "scheduleAlarm");
        releaseNewSnapshot();
      }
    });

    expect(await env.BUCKET.get(newKey)).toBeTruthy();
  });

  it("keeps the reconciliation backoff when a deferred alarm resumes after a failed restore", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("restore-alarm-backoff").set("value", 1);
      await document.onSave();
      await document.compact(true);
    });
    const version = await env.DB.prepare(
      `SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(installed.pageId)
      .first<{ id: string }>();
    expect(version).toBeTruthy();
    const newKey = `documents/${installed.pageId}/epochs/2/current.bin`;

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const originalBindings = document.bindings;
      const bucket = originalBindings.BUCKET;
      let releaseNewSnapshot!: () => void;
      let markNewSnapshotStored!: () => void;
      const newSnapshotGate = new Promise<void>((resolve) => {
        releaseNewSnapshot = resolve;
      });
      const newSnapshotStored = new Promise<void>((resolve) => {
        markNewSnapshotStored = resolve;
      });
      // The commit fails and its confirmation lookup fails too, so the restore
      // ends with an unknown commit state and schedules a reconciliation retry.
      const unavailableDatabase = new Proxy(originalBindings.DB, {
        get(target, property, receiver) {
          if (property === "batch")
            return async () => {
              throw new Error("D1 batch unavailable");
            };
          if (property !== "prepare") return Reflect.get(target, property, receiver);
          return (query: string) => {
            const statement = target.prepare(query);
            if (!query.includes("SELECT content_epoch FROM pages WHERE id = ?")) return statement;
            return {
              bind: (...args: unknown[]) => {
                statement.bind(...args);
                return {
                  first: async () => {
                    throw new Error("D1 confirmation unavailable");
                  },
                };
              },
            };
          };
        },
      });
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "DB") return unavailableDatabase;
          if (property !== "BUCKET") return Reflect.get(target, property, receiver);
          return new Proxy(bucket, {
            get(bucketTarget, bucketProperty) {
              if (bucketProperty === "put")
                return async (...args: any[]) => {
                  const result = await Reflect.apply(bucketTarget.put, bucketTarget, args);
                  if (args[0] === newKey) {
                    markNewSnapshotStored();
                    await newSnapshotGate;
                  }
                  return result;
                };
              const value = Reflect.get(bucketTarget, bucketProperty, bucketTarget);
              return typeof value === "function" ? value.bind(bucketTarget) : value;
            },
          });
        },
      });
      const backoffs: number[] = [];
      const originalDeferAlarm = document.deferAlarm.bind(document);
      document.deferAlarm = async (when: number) => {
        backoffs.push(when);
        await originalDeferAlarm(when);
      };

      try {
        const restoring = document.restoreVersion(version!.id, installed.userId);
        await newSnapshotStored;
        expect(document.transition).toBe("restore");

        await state.storage.deleteAlarm();
        await document.onAlarm();
        expect(await state.storage.getAlarm()).not.toBeNull();
        // A restore that fails slowly leaves the alarm deferred by onAlarm
        // already overdue, so resuming it must move the alarm out to the
        // backoff rather than settle for the soonest pending time.
        await state.storage.setAlarm(Date.now() - 1_000);

        releaseNewSnapshot();
        expect((await restoring).status).toBe(503);
        const finishedAt = Date.now();
        expect(
          state.storage.sql.exec<{ restore_pending: number }>(`SELECT restore_pending FROM document_meta`).one()
            .restore_pending,
        ).toBe(1);
        const backoff = backoffs.at(-1);
        expect(backoff).toBeGreaterThan(finishedAt);
        expect(await state.storage.getAlarm()).toBe(backoff);
      } finally {
        document.bindings = originalBindings;
        Reflect.deleteProperty(document, "deferAlarm");
        releaseNewSnapshot();
      }
    });
  });

  it("keeps the reconciliation backoff when an earlier alarm has not fired", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const earlierAlarm = Date.now() + 1_000;
      const retryAt = Date.now() + 10_000;
      await state.storage.setAlarm(earlierAlarm);
      document.transition = "restore";
      document.transitionAlarmDeferred = false;
      document.transitionRetryAt = retryAt;

      await document.finishTransition();

      expect(await state.storage.getAlarm()).toBe(retryAt);
      expect(document.transitionRetryAt).toBeNull();
      expect(document.transition).toBeNull();
    });
  });

  it("rejects a concurrent restore before it can share the next epoch snapshot key", async () => {
    const installed = await bootstrap();
    const room = `${installed.pageId}~1`;
    const stub = env.DOCUMENT.getByName(room);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("restore-race").set("value", 1);
      await document.onSave();
      await document.compact(true);
    });
    const version = await env.DB.prepare(
      `SELECT id, r2_key FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(installed.pageId)
      .first<{ id: string; r2_key: string }>();
    expect(version).toBeTruthy();

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const originalBindings = document.bindings;
      const bucket = originalBindings.BUCKET;
      let releaseVersionRead!: () => void;
      let markVersionReadStarted!: () => void;
      const versionReadGate = new Promise<void>((resolve) => {
        releaseVersionRead = resolve;
      });
      const versionReadStarted = new Promise<void>((resolve) => {
        markVersionReadStarted = resolve;
      });
      let versionReads = 0;
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property !== "BUCKET") return Reflect.get(target, property, receiver);
          return new Proxy(bucket, {
            get(bucketTarget, bucketProperty) {
              if (bucketProperty === "get")
                return async (...args: any[]) => {
                  if (args[0] === version!.r2_key && ++versionReads === 1) {
                    markVersionReadStarted();
                    await versionReadGate;
                  }
                  return Reflect.apply(bucketTarget.get, bucketTarget, args);
                };
              const value = Reflect.get(bucketTarget, bucketProperty, bucketTarget);
              return typeof value === "function" ? value.bind(bucketTarget) : value;
            },
          });
        },
      });

      try {
        const first = document.restoreVersion(version!.id, installed.userId);
        await versionReadStarted;
        const second = await document.restoreVersion(version!.id, installed.userId);
        expect(second.status).toBe(409);
        releaseVersionRead();
        expect((await first).status).toBe(200);
      } finally {
        document.bindings = originalBindings;
        releaseVersionRead();
      }
    });
    expect(await env.BUCKET.get(`documents/${installed.pageId}/epochs/2/current.bin`)).toBeTruthy();
  });

  it("flushes an archived document without resurrecting its search row", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const fragment = document.document.getXmlFragment("document-store");
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "Tail edit before archive");
      paragraph.insert(0, [text]);
      fragment.insert(0, [paragraph]);
      await document.onSave();
    });

    const archived = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}`, {
        method: "DELETE",
      }),
    );
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ ok: true, cleanupPending: false, pendingPageIds: [] });
    expect(
      (
        await env.DB.prepare(`SELECT COUNT(*) count FROM page_search WHERE page_id = ?`)
          .bind(installed.pageId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare(`SELECT plain_text FROM pages WHERE id = ?`)
          .bind(installed.pageId)
          .first<{ plain_text: string }>()
      )?.plain_text,
    ).toContain("Tail edit before archive");
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql.exec<{ dirty: number }>(`SELECT dirty FROM document_meta WHERE id = 1`).one().dirty,
      ).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM update_events`).one().count).toBe(0);
    });
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) count FROM archive_disconnect_targets`).first<{ count: number }>())?.count,
    ).toBe(0);
  });

  it("keeps an archived page committed and retries a failed room disconnect", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    let originalBindings!: Cloudflare.Env;
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("archive-retry").set("value", 1);
      await document.onSave();
      originalBindings = document.bindings;
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "BUCKET") {
            return new Proxy(originalBindings.BUCKET, {
              get(bucket, bucketProperty, bucketReceiver) {
                if (bucketProperty === "put")
                  return async () => {
                    throw new Error("R2 unavailable");
                  };
                const value = Reflect.get(bucket, bucketProperty, bucketReceiver);
                return typeof value === "function" ? value.bind(bucket) : value;
              },
            });
          }
          return Reflect.get(target, property, receiver);
        },
      });
    });

    try {
      const archived = await SELF.fetch(
        authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}`, {
          method: "DELETE",
        }),
      );
      expect(archived.status).toBe(202);
      expect(await archived.json()).toEqual({
        ok: true,
        cleanupPending: true,
        pendingPageIds: [installed.pageId],
      });
      expect(
        (
          await env.DB.prepare(`SELECT archived_at FROM pages WHERE id = ?`)
            .bind(installed.pageId)
            .first<{ archived_at: number | null }>()
        )?.archived_at,
      ).not.toBeNull();
      expect(
        await env.DB.prepare(`SELECT page_id FROM archive_disconnect_targets WHERE page_id = ?`)
          .bind(installed.pageId)
          .first(),
      ).not.toBeNull();
    } finally {
      await runInDurableObject(stub, async (instance) => {
        const document = instance as unknown as TestDocument;
        // Recover the real test bindings after the injected R2 outage.
        document.bindings = originalBindings;
      });
    }
    await env.DB.prepare(`UPDATE archive_disconnect_targets SET next_attempt_at = 0 WHERE page_id = ?`)
      .bind(installed.pageId)
      .run();
    const scheduledContext = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, scheduledContext);
    await waitOnExecutionContext(scheduledContext);
    expect(
      await env.DB.prepare(`SELECT page_id FROM archive_disconnect_targets WHERE page_id = ?`)
        .bind(installed.pageId)
        .first(),
    ).toBeNull();
  });

  it("does not mutate rows or options belonging to another table through a held lease", async () => {
    const installed = await bootstrap();
    const tableA = await createPage(installed.cookie, "table");
    const tableB = await createPage(installed.cookie, "table");
    const columnA = crypto.randomUUID();
    const columnB = crypto.randomUUID();
    const rowB = crypto.randomUUID();
    const optionB = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO table_columns (id, page_id, name, type, position) VALUES (?, ?, 'Text', 'text', 0)`,
      ).bind(columnA, tableA.id),
      env.DB.prepare(
        `INSERT INTO table_columns (id, page_id, name, type, position) VALUES (?, ?, 'Choice', 'select', 0)`,
      ).bind(columnB, tableB.id),
      env.DB.prepare(
        `INSERT INTO table_rows (id, page_id, position, created_by, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)`,
      ).bind(rowB, tableB.id, installed.userId, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO table_select_options (id, column_id, label, position) VALUES (?, ?, 'Foreign', 0)`,
      ).bind(optionB, columnB),
    ]);
    const lease = await (
      await SELF.fetch(
        authenticatedRequest(installed.cookie, `/api/tables/${tableA.id}/lease`, {
          method: "POST",
        }),
      )
    ).json<TableLeaseResponse>();
    expect(lease.leaseDurationMs).toBe(60_000);
    expect(lease).not.toHaveProperty("expiresAt");
    const renewed = await (
      await SELF.fetch(
        authenticatedRequest(installed.cookie, `/api/tables/${tableA.id}/lease`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ leaseToken: lease.leaseToken }),
        }),
      )
    ).json<TableLeaseTiming>();
    expect(renewed).toEqual({ leaseDurationMs: 60_000 });
    const mutationBody = JSON.stringify({ leaseToken: lease.leaseToken, expectedRevision: 1 });

    const deleteOption = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/tables/${tableA.id}/columns/${columnB}/options/${optionB}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: mutationBody,
      }),
    );
    expect(deleteOption.status).toBe(404);
    const putCell = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/tables/${tableA.id}/cells/${rowB}/${columnA}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseToken: lease.leaseToken, expectedRevision: 1, value: "cross-table" }),
      }),
    );
    expect(putCell.status).toBe(404);
    expect(
      await env.DB.prepare(`SELECT id FROM table_select_options WHERE id = ?`).bind(optionB).first(),
    ).not.toBeNull();
    expect((await env.DB.prepare(`SELECT COUNT(*) count FROM table_cells`).first<{ count: number }>())?.count).toBe(0);
    expect(
      (
        await env.DB.prepare(`SELECT revision FROM table_state WHERE page_id = ?`)
          .bind(tableA.id)
          .first<{ revision: number }>()
      )?.revision,
    ).toBe(1);
  });

  it("rejects cell and option mutations after a table is archived", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const columnId = crypto.randomUUID();
    const rowId = crypto.randomUUID();
    const optionId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO table_columns (id, page_id, name, type, position) VALUES (?, ?, 'Choice', 'select', 0)`,
      ).bind(columnId, tablePage.id),
      env.DB.prepare(
        `INSERT INTO table_rows (id, page_id, position, created_by, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)`,
      ).bind(rowId, tablePage.id, installed.userId, timestamp, timestamp),
      env.DB.prepare(`INSERT INTO table_select_options (id, column_id, label, position) VALUES (?, ?, 'Open', 0)`).bind(
        optionId,
        columnId,
      ),
    ]);
    const lease = await (
      await SELF.fetch(authenticatedRequest(installed.cookie, `/api/tables/${tablePage.id}/lease`, { method: "POST" }))
    ).json<TableLeaseResponse>();
    await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(timestamp, tablePage.id).run();
    const mutationBody = { leaseToken: lease.leaseToken, expectedRevision: 1 };

    const putCell = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/tables/${tablePage.id}/cells/${rowId}/${columnId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...mutationBody, value: optionId }),
      }),
    );
    expect(putCell.status).toBe(404);
    expect(await putCell.json()).toMatchObject({ error: { code: "page_not_found" } });

    const deleteOption = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/tables/${tablePage.id}/columns/${columnId}/options/${optionId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutationBody),
      }),
    );
    expect(deleteOption.status).toBe(404);
    expect(await deleteOption.json()).toMatchObject({ error: { code: "page_not_found" } });
    expect(
      await env.DB.prepare(`SELECT 1 FROM table_select_options WHERE id = ?`).bind(optionId).first(),
    ).not.toBeNull();
    expect((await env.DB.prepare(`SELECT COUNT(*) count FROM table_cells`).first<{ count: number }>())?.count).toBe(0);
    expect(
      (
        await env.DB.prepare(`SELECT revision FROM table_state WHERE page_id = ?`)
          .bind(tablePage.id)
          .first<{ revision: number }>()
      )?.revision,
    ).toBe(1);
  });

  it("assigns append positions on the server without reusing gaps", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const lease = await (
      await SELF.fetch(authenticatedRequest(installed.cookie, `/api/tables/${tablePage.id}/lease`, { method: "POST" }))
    ).json<TableLeaseResponse>();
    let revision = 1;
    const mutate = async <T>(path: string, method: string, body: Record<string, unknown> = {}) => {
      const response = await SELF.fetch(
        authenticatedRequest(installed.cookie, path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, leaseToken: lease.leaseToken, expectedRevision: revision }),
        }),
      );
      expect(response.status).toBeLessThan(300);
      const result = await response.json<T & { revision: number }>();
      revision = result.revision;
      return result;
    };

    const firstColumn = await mutate<{ column: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/columns`,
      "POST",
      { name: "First", type: "text" },
    );
    const selectColumn = await mutate<{ column: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/columns`,
      "POST",
      { name: "Choice", type: "select" },
    );
    await mutate(`/api/tables/${tablePage.id}/columns/${firstColumn.column.id}`, "DELETE");
    const thirdColumn = await mutate<{ column: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/columns`,
      "POST",
      { name: "Third", type: "text" },
    );
    expect([firstColumn.column.position, selectColumn.column.position, thirdColumn.column.position]).toEqual([0, 1, 2]);

    const firstOption = await mutate<{ option: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/columns/${selectColumn.column.id}/options`,
      "POST",
      { label: "First" },
    );
    const secondOption = await mutate<{ option: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/columns/${selectColumn.column.id}/options`,
      "POST",
      { label: "Second" },
    );
    await mutate(
      `/api/tables/${tablePage.id}/columns/${selectColumn.column.id}/options/${firstOption.option.id}`,
      "DELETE",
    );
    const thirdOption = await mutate<{ option: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/columns/${selectColumn.column.id}/options`,
      "POST",
      { label: "Third" },
    );
    expect([firstOption.option.position, secondOption.option.position, thirdOption.option.position]).toEqual([0, 1, 2]);

    const firstRow = await mutate<{ row: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/rows`,
      "POST",
    );
    const secondRow = await mutate<{ row: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/rows`,
      "POST",
    );
    await mutate(`/api/tables/${tablePage.id}/rows/${firstRow.row.id}`, "DELETE");
    const thirdRow = await mutate<{ row: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/rows`,
      "POST",
    );
    expect([firstRow.row.position, secondRow.row.position, thirdRow.row.position]).toEqual([0, 1, 2]);
  });

  it("does not advance the revision when a guarded mutation affects no rows", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const rowId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.prepare(
      `INSERT INTO table_rows (id, page_id, position, created_by, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)`,
    )
      .bind(rowId, tablePage.id, installed.userId, timestamp, timestamp)
      .run();
    const lease = await (
      await SELF.fetch(authenticatedRequest(installed.cookie, `/api/tables/${tablePage.id}/lease`, { method: "POST" }))
    ).json<TableLeaseResponse>();
    const triggerName = `ignore_delete_${rowId.replaceAll("-", "")}`;
    await env.DB.prepare(
      `CREATE TRIGGER ${triggerName} BEFORE DELETE ON table_rows
       WHEN OLD.id = '${rowId}' BEGIN SELECT RAISE(IGNORE); END`,
    ).run();

    try {
      const response = await SELF.fetch(
        authenticatedRequest(installed.cookie, `/api/tables/${tablePage.id}/rows/${rowId}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ leaseToken: lease.leaseToken, expectedRevision: 1 }),
        }),
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "mutation_target_not_found" } });
      expect(await env.DB.prepare(`SELECT 1 FROM table_rows WHERE id = ?`).bind(rowId).first()).not.toBeNull();
      expect(
        (
          await env.DB.prepare(`SELECT revision FROM table_state WHERE page_id = ?`)
            .bind(tablePage.id)
            .first<{ revision: number }>()
        )?.revision,
      ).toBe(1);
    } finally {
      await env.DB.prepare(`DROP TRIGGER IF EXISTS ${triggerName}`).run();
    }
  });

  it("distinguishes a stale table revision from a lost editing lease", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const columnId = crypto.randomUUID();
    const rowId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO table_columns (id, page_id, name, type, position) VALUES (?, ?, 'Text', 'text', 0)`,
      ).bind(columnId, tablePage.id),
      env.DB.prepare(
        `INSERT INTO table_rows (id, page_id, position, created_by, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)`,
      ).bind(rowId, tablePage.id, installed.userId, timestamp, timestamp),
    ]);
    const lease = await (
      await SELF.fetch(
        authenticatedRequest(installed.cookie, `/api/tables/${tablePage.id}/lease`, {
          method: "POST",
        }),
      )
    ).json<TableLeaseResponse>();
    await env.DB.prepare(`UPDATE table_state SET revision = 2 WHERE page_id = ?`).bind(tablePage.id).run();
    const cellPath = `/api/tables/${tablePage.id}/cells/${rowId}/${columnId}`;

    const staleRevision = await SELF.fetch(
      authenticatedRequest(installed.cookie, cellPath, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseToken: lease.leaseToken, expectedRevision: 1, value: "stale" }),
      }),
    );

    expect(staleRevision.status).toBe(409);
    expect(await staleRevision.json()).toMatchObject({ error: { code: "table_revision_conflict" } });

    const retried = await SELF.fetch(
      authenticatedRequest(installed.cookie, cellPath, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseToken: lease.leaseToken, expectedRevision: 2, value: "saved" }),
      }),
    );
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ revision: 3 });

    const lostLease = await SELF.fetch(
      authenticatedRequest(installed.cookie, cellPath, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseToken: "wrong-token", expectedRevision: 3, value: "lost" }),
      }),
    );
    expect(lostLease.status).toBe(409);
    expect(await lostLease.json()).toMatchObject({ error: { code: "table_lease_lost" } });
  });

  it("paginates mention traversal before advancing the read watermark", async () => {
    const installed = await bootstrap();
    const extraPageIds = Array.from({ length: 100 }, () => crypto.randomUUID());
    const timestamp = Date.now() - 10_000;
    for (let offset = 0; offset < extraPageIds.length; offset += 50) {
      await env.DB.batch(
        extraPageIds.slice(offset, offset + 50).map((pageId, index) =>
          env.DB.prepare(
            `INSERT INTO pages
          (id, workspace_id, kind, position, title, created_by, created_at, updated_at)
         VALUES (?, ?, 'document', ?, ?, ?, ?, ?)`,
          ).bind(
            pageId,
            installed.workspaceId,
            `mention-${offset + index}`,
            `Mention page ${offset + index}`,
            installed.userId,
            timestamp,
            timestamp,
          ),
        ),
      );
    }
    const sourcePageIds = [installed.pageId, ...extraPageIds];
    for (let offset = 0; offset < sourcePageIds.length; offset += 50) {
      await env.DB.batch(
        sourcePageIds.slice(offset, offset + 50).map((pageId, index) =>
          env.DB.prepare(
            `INSERT INTO member_mentions
          (workspace_id, source_page_id, target_user_id, excerpt, first_seen_at, projection_seq)
         VALUES (?, ?, ?, 'Mention', ?, 1)`,
          ).bind(installed.workspaceId, pageId, installed.userId, timestamp + offset + index),
        ),
      );
    }

    const first = await (
      await SELF.fetch(authenticatedRequest(installed.cookie, "/api/mentions"))
    ).json<{
      asOf: number;
      mentions: Array<{ page: { id: string } }>;
      nextCursor: { firstSeenAt: number; pageId: string } | null;
    }>();
    expect(first.mentions).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    expect(
      await env.DB.prepare(`SELECT read_at FROM mention_reads WHERE workspace_id = ? AND user_id = ?`)
        .bind(installed.workspaceId, installed.userId)
        .first(),
    ).toBeNull();

    const query = new URLSearchParams({
      asOf: String(first.asOf),
      beforeAt: String(first.nextCursor!.firstSeenAt),
      beforeId: first.nextCursor!.pageId,
    });
    const second = await (
      await SELF.fetch(authenticatedRequest(installed.cookie, `/api/mentions?${query}`))
    ).json<{
      mentions: Array<{ page: { id: string } }>;
      nextCursor: { firstSeenAt: number; pageId: string } | null;
    }>();
    expect(second.mentions).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.mentions, ...second.mentions].map((item) => item.page.id)).size).toBe(101);

    const read = await SELF.fetch(
      authenticatedRequest(installed.cookie, "/api/mentions/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ through: first.asOf }),
      }),
    );
    expect(await read.json()).toEqual({ unreadCount: 0 });
  });

  it("materializes only same-workspace references and applies mention read cursors", async () => {
    const installed = await bootstrap();
    const target = await createPage(installed.cookie);
    const foreignWorkspace = crypto.randomUUID();
    const foreignUser = crypto.randomUUID();
    const foreignPage = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Foreign', 'foreign@example.test', 1, ?, ?)`,
      ).bind(foreignUser, timestamp, timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES (?, 'Foreign workspace', ?)`).bind(
        foreignWorkspace,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
      ).bind(foreignWorkspace, foreignUser, timestamp),
      env.DB.prepare(
        `INSERT INTO pages (id, workspace_id, kind, position, title, created_by, created_at, updated_at)
         VALUES (?, ?, 'document', 'a0', 'Foreign page', ?, ?, ?)`,
      ).bind(foreignPage, foreignWorkspace, foreignUser, timestamp, timestamp),
    ]);

    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const fragment = document.document.getXmlFragment("document-store");
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "Discuss ");
      paragraph.insert(0, [text]);
      for (const [entityType, entityId, label] of [
        ["page", target.id, "Target"],
        ["page", foreignPage, "Foreign page"],
        ["user", installed.userId, "Owner"],
        ["user", foreignUser, "Foreign"],
        ["page", target.id, "Target"],
      ] as const) {
        const mention = new Y.XmlElement("mention");
        mention.setAttribute("entityType", entityType);
        mention.setAttribute("entityId", entityId);
        mention.setAttribute("label", label);
        paragraph.insert(paragraph.length, [mention]);
      }
      fragment.insert(0, [paragraph]);
      await document.onSave();
      await document.compact();
    });

    const pageTargets = await env.DB.prepare(`SELECT target_page_id FROM page_references WHERE source_page_id = ?`)
      .bind(installed.pageId)
      .all<{ target_page_id: string }>();
    expect(pageTargets.results).toEqual([{ target_page_id: target.id }]);
    const userTargets = await env.DB.prepare(
      `SELECT target_user_id, first_seen_at FROM member_mentions WHERE source_page_id = ?`,
    )
      .bind(installed.pageId)
      .all<{ target_user_id: string; first_seen_at: number }>();
    expect(userTargets.results.map((row) => row.target_user_id)).toEqual([installed.userId]);
    const firstSeen = userTargets.results[0]!.first_seen_at;

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("unrelated").set("change", 1);
      await document.onSave();
      await document.compact();
    });
    expect(
      (
        await env.DB.prepare(
          `SELECT first_seen_at FROM member_mentions WHERE source_page_id = ? AND target_user_id = ?`,
        )
          .bind(installed.pageId, installed.userId)
          .first<{ first_seen_at: number }>()
      )?.first_seen_at,
    ).toBe(firstSeen);

    await env.DB.prepare(`UPDATE member_mentions SET first_seen_at = ? WHERE source_page_id = ?`)
      .bind(Date.now() - 1_000, installed.pageId)
      .run();
    const unread = await SELF.fetch(authenticatedRequest(installed.cookie, "/api/mentions/unread-count"));
    expect(await unread.json()).toEqual({ unreadCount: 1 });
    const inbox = await (
      await SELF.fetch(authenticatedRequest(installed.cookie, "/api/mentions"))
    ).json<{
      asOf: number;
      mentions: Array<{ page: { id: string }; unread: boolean }>;
    }>();
    expect(inbox.mentions).toMatchObject([{ page: { id: installed.pageId }, unread: true }]);
    const laterSource = await createPage(installed.cookie);
    await env.DB.prepare(
      `INSERT INTO member_mentions
        (workspace_id, source_page_id, target_user_id, excerpt, first_seen_at, projection_seq)
       VALUES (?, ?, ?, 'Later mention', ?, 1)`,
    )
      .bind(installed.workspaceId, laterSource.id, installed.userId, inbox.asOf + 1)
      .run();
    const read = await SELF.fetch(
      authenticatedRequest(installed.cookie, "/api/mentions/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ through: inbox.asOf }),
      }),
    );
    expect(await read.json()).toEqual({ unreadCount: 1 });
    expect(
      await (await SELF.fetch(authenticatedRequest(installed.cookie, "/api/mentions/unread-count"))).json(),
    ).toEqual({ unreadCount: 1 });

    const backlinks = await (
      await SELF.fetch(authenticatedRequest(installed.cookie, `/api/pages/${target.id}/backlinks`))
    ).json<{ backlinks: Array<{ page: { id: string } }> }>();
    expect(backlinks.backlinks.map((item) => item.page.id)).toEqual([installed.pageId]);
    expect((await SELF.fetch(authenticatedRequest(installed.cookie, `/api/pages/${foreignPage}/preview`))).status).toBe(
      404,
    );

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const fragment = document.document.getXmlFragment("document-store");
      fragment.delete(0, fragment.length);
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "References removed");
      paragraph.insert(0, [text]);
      fragment.insert(0, [paragraph]);
      await document.onSave();
      await document.compact();
    });
    expect(
      (
        await env.DB.prepare(`SELECT COUNT(*) count FROM page_references WHERE source_page_id = ?`)
          .bind(installed.pageId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });

  it("queues subtree deletion, purges every document epoch, and retries unfinished targets on cron", async () => {
    const installed = await bootstrap();
    const child = await createPage(installed.cookie, "document", installed.pageId);
    await env.DB.prepare(`UPDATE pages SET content_epoch = 3 WHERE id = ?`).bind(installed.pageId).run();
    await env.DB.prepare(`UPDATE pages SET content_epoch = 2 WHERE id = ?`).bind(child.id).run();

    const rooms = [
      `${installed.pageId}~1`,
      `${installed.pageId}~2`,
      `${installed.pageId}~3`,
      `${child.id}~1`,
      `${child.id}~2`,
    ];
    const emptySnapshot = Y.encodeStateAsUpdate(new Y.Doc());
    for (const room of rooms) {
      const stub = env.DOCUMENT.getByName(room);
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put("sentinel", room);
      });
    }
    for (const pageId of [installed.pageId, child.id]) {
      await env.BUCKET.put(`documents/${pageId}/epochs/1/current.bin`, emptySnapshot);
      await env.BUCKET.put(`documents/${pageId}/versions/old.bin`, emptySnapshot);
    }
    const attachmentKeys = Array.from({ length: 55 }, (_, index) => `assets/${installed.workspaceId}/batch-${index}`);
    await Promise.all(attachmentKeys.map((key) => env.BUCKET.put(key, "attachment")));
    await env.DB.batch(
      attachmentKeys.map((key, index) =>
        env.DB.prepare(
          `INSERT INTO attachments
        (id, workspace_id, page_id, r2_key, name, mime, size, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'text/plain', 10, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          installed.workspaceId,
          installed.pageId,
          key,
          `batch-${index}.txt`,
          installed.userId,
          Date.now(),
        ),
      ),
    );

    expect(
      (
        await SELF.fetch(
          authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}`, {
            method: "DELETE",
          }),
        )
      ).status,
    ).toBe(200);
    const context = createExecutionContext();
    const deleted = await worker.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/permanent-delete`, { method: "POST" }),
      env,
      context,
    );
    expect(deleted.status).toBe(202);
    expect(await deleted.json()).toEqual({ ok: true, cleanupPending: true });
    await waitOnExecutionContext(context);

    expect((await env.DB.prepare(`SELECT COUNT(*) count FROM pages`).first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare(`SELECT COUNT(*) count FROM page_search`).first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare(`SELECT COUNT(*) count FROM deletion_jobs`).first<{ count: number }>())?.count).toBe(
      0,
    );
    for (const pageId of [installed.pageId, child.id]) {
      expect((await env.BUCKET.list({ prefix: `documents/${pageId}/` })).objects).toHaveLength(0);
    }
    expect(await Promise.all(attachmentKeys.map((key) => env.BUCKET.get(key)))).toEqual(attachmentKeys.map(() => null));
    for (const room of rooms) {
      const stateAfterPurge = await runInDurableObject(env.DOCUMENT.getByName(room), async (_instance, state) => ({
        sentinel: await state.storage.get("sentinel"),
        alarm: await state.storage.getAlarm(),
      }));
      expect(stateAfterPurge.sentinel).toBeUndefined();
      expect(stateAfterPurge.alarm).toBeNull();
    }

    const retryJob = crypto.randomUUID();
    const retryPrefix = "documents/retry-me/";
    const retryTime = Date.now();
    await env.BUCKET.put(`${retryPrefix}current.bin`, "retry");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO deletion_jobs (id, workspace_id, root_page_id, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, 'deleted-root', ?, ?, ?)`,
      ).bind(retryJob, installed.workspaceId, retryTime - 1, retryTime, retryTime),
      env.DB.prepare(
        `INSERT INTO deletion_targets (job_id, kind, target, completed_at)
         VALUES (?, 'r2_object', 'already-complete', ?)`,
      ).bind(retryJob, retryTime),
      env.DB.prepare(`INSERT INTO deletion_targets (job_id, kind, target) VALUES (?, 'r2_prefix', ?)`).bind(
        retryJob,
        retryPrefix,
      ),
    ]);
    const scheduledContext = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, scheduledContext);
    await waitOnExecutionContext(scheduledContext);
    expect(await env.BUCKET.get(`${retryPrefix}current.bin`)).toBeNull();
    expect(await env.DB.prepare(`SELECT id FROM deletion_jobs WHERE id = ?`).bind(retryJob).first()).toBeNull();
  });

  it("claims a due deletion job only once across concurrent processors", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const target = `assets/${installed.workspaceId}/claim-once`;
    const timestamp = Date.now();
    await env.BUCKET.put(target, "delete me");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO deletion_jobs (id, workspace_id, root_page_id, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, 'claim-root', ?, ?, ?)`,
      ).bind(jobId, installed.workspaceId, timestamp, timestamp, timestamp),
      env.DB.prepare(`INSERT INTO deletion_targets (job_id, kind, target) VALUES (?, 'r2_object', ?)`).bind(
        jobId,
        target,
      ),
    ]);
    await Promise.all([processDeletionJob(env, jobId), processDeletionJob(env, jobId)]);
    expect(await env.BUCKET.get(target)).toBeNull();
    expect(await env.DB.prepare(`SELECT id FROM deletion_jobs WHERE id = ?`).bind(jobId).first()).toBeNull();
  });

  // abortAllDurableObjects simulates a crash rather than a graceful eviction and
  // intentionally invalidates the test isolate, so keep this destructive restart
  // scenario last in the file.
  it("recovers a pending update log when an instance restarts after dirty was cleared", async () => {
    const installed = await bootstrap();
    const room = `${installed.pageId}~1`;
    const stub = env.DOCUMENT.getByName(room);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("restart-content").set("value", 1);
      await document.onSave();
      state.storage.sql.exec(`UPDATE document_meta SET dirty = 0 WHERE id = 1`);
      await state.storage.deleteAlarm();
    });

    await abortAllDurableObjects();
    const restarted = env.DOCUMENT.getByName(room);
    await restarted.fetch(internalWarmupRequest());
    await runInDurableObject(restarted, async (_instance, state) => {
      expect(
        state.storage.sql.exec<{ dirty: number }>(`SELECT dirty FROM document_meta WHERE id = 1`).one().dirty,
      ).toBe(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});
