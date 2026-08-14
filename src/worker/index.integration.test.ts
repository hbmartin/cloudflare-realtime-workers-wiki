import {
  applyD1Migrations,
  createExecutionContext,
  createScheduledController,
  env,
  reset,
  runInDurableObject,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { joinBytes } from "../shared/bytes";
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
  const me = await (await SELF.fetch(authenticatedRequest(cookie!, "/api/me"))).json<{
    user: { id: string };
    workspace: { id: string };
  }>();
  const tree = await (await SELF.fetch(authenticatedRequest(cookie!, "/api/pages/tree"))).json<{
    pages: Array<{ id: string }>;
  }>();
  return {
    cookie: cookie!,
    pageId: tree.pages[0].id,
    userId: me.user.id,
    workspaceId: me.workspace.id,
  };
}

async function createPage(cookie: string, kind: "document" | "table" = "document", parentId: string | null = null) {
  const response = await SELF.fetch(authenticatedRequest(cookie, "/api/pages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, parentId }),
  }));
  expect(response.status).toBe(201);
  return (await response.json<{ page: { id: string } }>()).page;
}

type TestDocument = {
  document: Y.Doc;
  onSave(): Promise<void>;
  compact(forceVersion?: boolean): Promise<void>;
  scheduleAlarm(when: number): Promise<void>;
  bindings: Cloudflare.Env;
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
    const upload = await SELF.fetch(authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/attachments`, {
      method: "POST",
      body: form,
    }));
    expect(upload.status).toBe(201);
    const attachmentId = (await upload.json<{ attachment: { id: string } }>()).attachment.id;
    const path = `/api/attachments/${attachmentId}`;

    const normal = await SELF.fetch(authenticatedRequest(installed.cookie, path));
    expect(normal.status).toBe(200);
    expect(await normal.text()).toBe("0123456789");
    expect(normal.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    const etag = normal.headers.get("etag");
    expect(etag).toBeTruthy();

    for (const [range, contentRange, body] of [
      ["bytes=2-5", "bytes 2-5/10", "2345"],
      ["bytes=6-", "bytes 6-9/10", "6789"],
      ["bytes=-3", "bytes 7-9/10", "789"],
      ["bytes=-500", "bytes 0-9/10", "0123456789"],
    ]) {
      const response = await SELF.fetch(authenticatedRequest(installed.cookie, path, {
        headers: { range },
      }));
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(contentRange);
      expect(response.headers.get("content-length")).toBe(String(body.length));
      expect(await response.text()).toBe(body);
    }

    const unchanged = await SELF.fetch(authenticatedRequest(installed.cookie, path, {
      headers: { "if-none-match": etag! },
    }));
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("etag")).toBe(etag);

    const changed = await SELF.fetch(authenticatedRequest(installed.cookie, path, {
      headers: { "if-none-match": '"not-this-object"' },
    }));
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe("0123456789");
  });

  it("coalesces document updates and never reuses a drained sequence", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(new Request("https://document.internal/noop", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
    }));

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const content = document.document.getMap<number>("test-content");
      content.set("first", 1);
      content.set("second", 2);
      await document.onSave();

      const events = state.storage.sql.exec<{ seq: number }>(
        `SELECT seq FROM update_events ORDER BY seq`,
      ).toArray();
      expect(events).toHaveLength(1);
      const chunks = state.storage.sql.exec<{ data: ArrayBuffer }>(
        `SELECT data FROM update_chunks WHERE seq = ? ORDER BY chunk_index`,
        events[0].seq,
      ).toArray();
      const replica = new Y.Doc();
      Y.applyUpdate(replica, joinBytes(chunks.map((chunk) => new Uint8Array(chunk.data))));
      expect(replica.getMap("test-content").toJSON()).toEqual({ first: 1, second: 2 });
      replica.destroy();

      await document.compact();
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM update_events`).one().count).toBe(0);

      content.set("third", 3);
      await document.onSave();
      const next = state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM update_events`).one().seq;
      expect(next).toBeGreaterThan(events[0].seq);
    });
  });

  it("preserves updates and alarms that arrive while compaction is awaiting storage", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(new Request("https://document.internal/noop", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
    }));

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

      const meta = state.storage.sql.exec<{ dirty: number; snapshot_seq: number }>(
        `SELECT dirty, snapshot_seq FROM document_meta WHERE id = 1`,
      ).one();
      const remaining = state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM update_events`).toArray();
      expect(meta).toEqual({ dirty: 1, snapshot_seq: capturedSequence });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].seq).toBeGreaterThan(capturedSequence);

      const firstAlarm = Date.now() + 20_000;
      await state.storage.deleteAlarm();
      await document.scheduleAlarm(firstAlarm);
      await document.scheduleAlarm(firstAlarm + 20_000);
      expect(await state.storage.getAlarm()).toBe(firstAlarm);
      await document.scheduleAlarm(firstAlarm - 10_000);
      expect(await state.storage.getAlarm()).toBe(firstAlarm - 10_000);
    });
  });

  it("re-dirties and reschedules a document after failed compaction", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(new Request("https://document.internal/noop", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
    }));

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("failure-content").set("value", 1);
      await document.onSave();
      const originalBindings = document.bindings;
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "BUCKET") return { put: async () => { throw new Error("R2 unavailable"); } };
          return Reflect.get(target, property, receiver);
        },
      });
      await expect(document.compact()).rejects.toThrow("R2 unavailable");
      document.bindings = originalBindings;

      expect(state.storage.sql.exec<{ dirty: number }>(
        `SELECT dirty FROM document_meta WHERE id = 1`,
      ).one().dirty).toBe(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("materializes only same-workspace references and applies mention read cursors", async () => {
    const installed = await bootstrap();
    const target = await createPage(installed.cookie);
    const foreignWorkspace = crypto.randomUUID();
    const foreignUser = crypto.randomUUID();
    const foreignPage = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Foreign', 'foreign@example.test', 1, ?, ?)`)
        .bind(foreignUser, timestamp, timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES (?, 'Foreign workspace', ?)`).bind(foreignWorkspace, timestamp),
      env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`)
        .bind(foreignWorkspace, foreignUser, timestamp),
      env.DB.prepare(
        `INSERT INTO pages (id, workspace_id, kind, position, title, created_by, created_at, updated_at)
         VALUES (?, ?, 'document', 'a0', 'Foreign page', ?, ?, ?)`,
      ).bind(foreignPage, foreignWorkspace, foreignUser, timestamp, timestamp),
    ]);

    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(new Request("https://document.internal/noop", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
    }));
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
      ]) {
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

    const pageTargets = await env.DB.prepare(
      `SELECT target_page_id FROM page_references WHERE source_page_id = ?`,
    ).bind(installed.pageId).all<{ target_page_id: string }>();
    expect(pageTargets.results).toEqual([{ target_page_id: target.id }]);
    const userTargets = await env.DB.prepare(
      `SELECT target_user_id, first_seen_at FROM member_mentions WHERE source_page_id = ?`,
    ).bind(installed.pageId).all<{ target_user_id: string; first_seen_at: number }>();
    expect(userTargets.results.map((row) => row.target_user_id)).toEqual([installed.userId]);
    const firstSeen = userTargets.results[0].first_seen_at;

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("unrelated").set("change", 1);
      await document.onSave();
      await document.compact();
    });
    expect((await env.DB.prepare(
      `SELECT first_seen_at FROM member_mentions WHERE source_page_id = ? AND target_user_id = ?`,
    ).bind(installed.pageId, installed.userId).first<{ first_seen_at: number }>())?.first_seen_at).toBe(firstSeen);

    await env.DB.prepare(`UPDATE member_mentions SET first_seen_at = ? WHERE source_page_id = ?`)
      .bind(Date.now() - 1_000, installed.pageId).run();
    const unread = await SELF.fetch(authenticatedRequest(installed.cookie, "/api/mentions/unread-count"));
    expect(await unread.json()).toEqual({ unreadCount: 1 });
    const inbox = await (await SELF.fetch(authenticatedRequest(installed.cookie, "/api/mentions"))).json<{
      asOf: number;
      mentions: Array<{ page: { id: string }; unread: boolean }>;
    }>();
    expect(inbox.mentions).toMatchObject([{ page: { id: installed.pageId }, unread: true }]);
    await SELF.fetch(authenticatedRequest(installed.cookie, "/api/mentions/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ through: inbox.asOf }),
    }));
    expect(await (await SELF.fetch(authenticatedRequest(installed.cookie, "/api/mentions/unread-count"))).json())
      .toEqual({ unreadCount: 0 });

    const laterSource = await createPage(installed.cookie);
    await env.DB.prepare(
      `INSERT INTO member_mentions
        (workspace_id, source_page_id, target_user_id, excerpt, first_seen_at, projection_seq)
       VALUES (?, ?, ?, 'Later mention', ?, 1)`,
    ).bind(installed.workspaceId, laterSource.id, installed.userId, inbox.asOf + 1).run();
    expect(await (await SELF.fetch(authenticatedRequest(installed.cookie, "/api/mentions/unread-count"))).json())
      .toEqual({ unreadCount: 1 });

    const backlinks = await (await SELF.fetch(authenticatedRequest(installed.cookie, `/api/pages/${target.id}/backlinks`)))
      .json<{ backlinks: Array<{ page: { id: string } }> }>();
    expect(backlinks.backlinks.map((item) => item.page.id)).toEqual([installed.pageId]);
    expect((await SELF.fetch(authenticatedRequest(installed.cookie, `/api/pages/${foreignPage}/preview`))).status).toBe(404);

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
    expect((await env.DB.prepare(
      `SELECT COUNT(*) count FROM page_references WHERE source_page_id = ?`,
    ).bind(installed.pageId).first<{ count: number }>())?.count).toBe(0);
  });

  it("queues subtree deletion, purges every document epoch, and retries unfinished targets on cron", async () => {
    const installed = await bootstrap();
    const child = await createPage(installed.cookie, "document", installed.pageId);
    await env.DB.prepare(`UPDATE pages SET content_epoch = 3 WHERE id = ?`).bind(installed.pageId).run();
    await env.DB.prepare(`UPDATE pages SET content_epoch = 2 WHERE id = ?`).bind(child.id).run();

    const rooms = [
      `${installed.pageId}~1`, `${installed.pageId}~2`, `${installed.pageId}~3`,
      `${child.id}~1`, `${child.id}~2`,
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

    expect((await SELF.fetch(authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}`, {
      method: "DELETE",
    }))).status).toBe(200);
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
    expect((await env.DB.prepare(`SELECT COUNT(*) count FROM deletion_jobs`).first<{ count: number }>())?.count).toBe(0);
    for (const pageId of [installed.pageId, child.id]) {
      expect((await env.BUCKET.list({ prefix: `documents/${pageId}/` })).objects).toHaveLength(0);
    }
    for (const room of rooms) {
      const sentinel = await runInDurableObject(env.DOCUMENT.getByName(room), async (_instance, state) => (
        state.storage.get("sentinel")
      ));
      expect(sentinel).toBeUndefined();
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
      env.DB.prepare(
        `INSERT INTO deletion_targets (job_id, kind, target) VALUES (?, 'r2_prefix', ?)`,
      ).bind(retryJob, retryPrefix),
    ]);
    const scheduledContext = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, scheduledContext);
    await waitOnExecutionContext(scheduledContext);
    expect(await env.BUCKET.get(`${retryPrefix}current.bin`)).toBeNull();
    expect(await env.DB.prepare(`SELECT id FROM deletion_jobs WHERE id = ?`).bind(retryJob).first()).toBeNull();
  });
});
