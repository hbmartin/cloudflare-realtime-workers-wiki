import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Job } from "../shared/types";
import { readZip } from "../shared/zip";
import type { Env } from "./env";
import {
  consumeDeliveryMessage,
  expireJobArtifacts,
  runCommentMigration,
  runTemplateClone,
  sweepOutbox,
  type JobRow,
} from "./jobs";
import worker from "./index";

type InstalledWorkspace = { cookie: string; pageId: string; userId: string; workspaceId: string };

function request(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", "http://example.test");
  return new Request(`http://example.test${path}`, { ...init, headers });
}

async function bootstrap(): Promise<InstalledWorkspace> {
  const response = await worker.fetch(
    new Request("http://example.test/api/install/bootstrap", {
      method: "POST",
      headers: { origin: "http://example.test", "content-type": "application/json" },
      body: JSON.stringify({
        bootstrapToken: "worker-bootstrap-token",
        workspaceName: "Jobs Notes",
        name: "Owner",
        email: "jobs-owner@example.test",
        password: "password123",
      }),
    }),
    env,
    createExecutionContext(),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  const me = await (
    await worker.fetch(request(cookie, "/api/me"), env, createExecutionContext())
  ).json<{
    user: { id: string };
    workspace: { id: string };
  }>();
  const tree = await (
    await worker.fetch(request(cookie, "/api/pages/tree"), env, createExecutionContext())
  ).json<{
    pages: Array<{ id: string }>;
  }>();
  return { cookie, pageId: tree.pages[0]!.id, userId: me.user.id, workspaceId: me.workspace.id };
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

describe("job execution", () => {
  it("keeps staged job pages out of every public page and search surface", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const pageId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO jobs (id, workspace_id, space_id, type, status, requested_by, created_at, updated_at)
         VALUES (?, ?, ?, 'template_clone', 'running', ?, ?, ?)`,
      ).bind(jobId, installed.workspaceId, `${installed.workspaceId}-general`, installed.userId, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO pages
          (id, workspace_id, space_id, parent_id, kind, position, title, is_template, import_job_id,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'document', 'z0', 'Hidden stage', 0, ?, ?, ?, ?)`,
      ).bind(
        pageId,
        installed.workspaceId,
        `${installed.workspaceId}-general`,
        jobId,
        installed.userId,
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO page_search (page_id, workspace_id, title, body) VALUES (?, ?, 'Hidden stage', '')`,
      ).bind(pageId, installed.workspaceId),
    ]);

    expect(
      (await worker.fetch(request(installed.cookie, `/api/pages/${pageId}`), env, createExecutionContext())).status,
    ).toBe(404);
    const tree = await worker.fetch(request(installed.cookie, "/api/pages/tree"), env, createExecutionContext());
    expect((await tree.json<{ pages: Array<{ id: string }> }>()).pages.map((page) => page.id)).not.toContain(pageId);
    const search = await worker.fetch(request(installed.cookie, "/api/search?q=Hidden"), env, createExecutionContext());
    expect((await search.json<{ results: unknown[] }>()).results).toEqual([]);
    const suggestions = await worker.fetch(
      request(installed.cookie, "/api/mentions/suggestions?q=Hidden"),
      env,
      createExecutionContext(),
    );
    expect((await suggestions.json<{ suggestions: Array<{ entityId: string }> }>()).suggestions).toEqual([]);
  });

  it("starts a coalesced search reindex and exposes it only through the requester feed", async () => {
    const installed = await bootstrap();
    const create = vi.fn(async ({ id }: { id?: string }) => ({ id: id ?? "created" }));
    const bindings = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "NOTES_WORKFLOW") return { create };
        return Reflect.get(target, property, receiver);
      },
    });
    const context = createExecutionContext();
    const started = await worker.fetch(
      request(installed.cookie, "/api/jobs/search-reindex", { method: "POST" }),
      bindings,
      context,
    );
    expect(started.status).toBe(202);
    const first = await started.json<{ job: Job; coalesced: boolean }>();
    expect(first.coalesced).toBe(false);
    expect(first.job).toMatchObject({ type: "search_reindex", status: "queued", hasDownload: false });
    await waitOnExecutionContext(context);
    expect(create).toHaveBeenCalledWith({ id: first.job.id, params: { jobId: first.job.id } });

    const feed = await worker.fetch(request(installed.cookie, "/api/jobs"), env, createExecutionContext());
    expect(feed.status).toBe(200);
    expect((await feed.json<{ jobs: Job[] }>()).jobs.map((job) => job.id)).toContain(first.job.id);
  });

  it("runs the owner-initiated legacy comment workspace scan", async () => {
    const installed = await bootstrap();
    const create = vi.fn(async ({ id }: { id?: string }) => ({ id: id ?? "created" }));
    const bindings = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "NOTES_WORKFLOW") return { create };
        return Reflect.get(target, property, receiver);
      },
    });
    const context = createExecutionContext();
    const response = await worker.fetch(
      request(installed.cookie, "/api/jobs/comment-migration", { method: "POST" }),
      bindings,
      context,
    );
    expect(response.status).toBe(202);
    const job = (await response.json<{ job: Job }>()).job;
    await waitOnExecutionContext(context);
    expect(create).toHaveBeenCalledWith({ id: job.id, params: { jobId: job.id } });

    await env.DB.prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).bind(job.id).run();
    const row = (await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(job.id).first<JobRow>())!;
    const step = {
      async do<T>(_name: string, callback: () => Promise<T>) {
        return callback();
      },
    };
    await runCommentMigration(env, row, step as Parameters<typeof runCommentMigration>[2]);
    expect(
      await env.DB.prepare(`SELECT page_id FROM comment_migrations WHERE page_id = ?`).bind(installed.pageId).first(),
    ).toEqual({ page_id: installed.pageId });
    expect((await env.DB.prepare(`SELECT status FROM jobs WHERE id = ?`).bind(job.id).first())?.status).toBe(
      "succeeded",
    );
  });

  it("cancels a pending job and rejects retrying a successful one", async () => {
    const installed = await bootstrap();
    const timestamp = Date.now();
    const canceledId = crypto.randomUUID();
    const succeededId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO jobs (id, workspace_id, type, status, requested_by, created_at, updated_at)
         VALUES (?, ?, 'import', 'awaiting_confirmation', ?, ?, ?)`,
      ).bind(canceledId, installed.workspaceId, installed.userId, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO jobs (id, workspace_id, type, status, requested_by, created_at, updated_at)
         VALUES (?, ?, 'export', 'succeeded', ?, ?, ?)`,
      ).bind(succeededId, installed.workspaceId, installed.userId, timestamp, timestamp),
    ]);

    const canceled = await worker.fetch(
      request(installed.cookie, `/api/jobs/${canceledId}/cancel`, { method: "POST" }),
      env,
      createExecutionContext(),
    );
    expect(canceled.status).toBe(200);
    expect((await canceled.json<{ job: Job }>()).job.status).toBe("canceled");

    const retry = await worker.fetch(
      request(installed.cookie, `/api/jobs/${succeededId}/retry`, { method: "POST" }),
      env,
      createExecutionContext(),
    );
    expect(retry.status).toBe(409);
  });

  it("authorizes job artifacts and expires their exact R2 keys", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const key = `jobs/${jobId}/result.md`;
    const timestamp = Date.now();
    await env.BUCKET.put(key, "# Export", {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      customMetadata: { filename: "Export.md" },
    });
    await env.DB.prepare(
      `INSERT INTO jobs
        (id, workspace_id, space_id, type, status, requested_by, output_key, expires_at, created_at, updated_at)
       SELECT ?, workspace_id, space_id, 'export', 'succeeded', ?, ?, ?, ?, ? FROM pages WHERE id = ?`,
    )
      .bind(jobId, installed.userId, key, timestamp + 10_000, timestamp, timestamp, installed.pageId)
      .run();

    const download = await worker.fetch(
      request(installed.cookie, `/api/jobs/${jobId}/download`),
      env,
      createExecutionContext(),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("Export.md");
    expect(await download.text()).toBe("# Export");

    await env.DB.prepare(`UPDATE jobs SET expires_at = ? WHERE id = ?`)
      .bind(timestamp - 1, jobId)
      .run();
    await expireJobArtifacts(env);
    expect(await env.BUCKET.get(key)).toBeNull();
    expect(
      (await env.DB.prepare(`SELECT output_key FROM jobs WHERE id = ?`).bind(jobId).first())?.output_key,
    ).toBeNull();
  });

  it("exports a freshly flushed document with portable attachments", async () => {
    const installed = await bootstrap();
    const attachmentId = crypto.randomUUID();
    const attachmentKey = `assets/${installed.workspaceId}/${attachmentId}/brief`;
    await env.BUCKET.put(attachmentKey, "portable bytes", { httpMetadata: { contentType: "text/plain" } });
    await env.DB.prepare(
      `INSERT INTO attachments
        (id, workspace_id, page_id, r2_key, name, mime, size, created_by, created_at)
       VALUES (?, ?, ?, ?, 'brief.txt', 'text/plain', 14, ?, ?)`,
    )
      .bind(attachmentId, installed.workspaceId, installed.pageId, attachmentKey, installed.userId, Date.now())
      .run();
    const bindings = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "WORKFLOW_INLINE") return "true";
        return Reflect.get(target, property, receiver);
      },
    });
    const context = createExecutionContext();
    const response = await worker.fetch(
      request(installed.cookie, `/api/pages/${installed.pageId}/exports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format: "markdown", portable: true }),
      }),
      bindings,
      context,
    );
    expect(response.status).toBe(202);
    const job = (await response.json<{ job: Job }>()).job;
    await waitOnExecutionContext(context);

    const completed = await worker.fetch(request(installed.cookie, `/api/jobs/${job.id}`), env, createExecutionContext());
    expect((await completed.json<{ job: Job }>()).job).toMatchObject({ status: "succeeded", hasDownload: true });
    const download = await worker.fetch(
      request(installed.cookie, `/api/jobs/${job.id}/download`),
      env,
      createExecutionContext(),
    );
    expect(download.headers.get("content-type")).toContain("application/zip");
    const entries = await readZip(new Uint8Array(await download.arrayBuffer()));
    expect(entries.map((entry) => entry.path)).toEqual(["Welcome.md", "assets/brief.txt"]);
    expect(new TextDecoder().decode(entries[0]!.bytes)).toContain("# Welcome");
    expect(new TextDecoder().decode(entries[1]!.bytes)).toBe("portable bytes");
  });

  it("reports PDF configuration and renders through the Browser Run binding", async () => {
    const installed = await bootstrap();
    const unavailableBindings = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "BROWSER") return undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(
      (
        await worker.fetch(
          request(installed.cookie, `/api/pages/${installed.pageId}/exports`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ format: "pdf" }),
          }),
          unavailableBindings,
          createExecutionContext(),
        )
      ).status,
    ).toBe(503);

    const quickAction = vi.fn(async (_action: string, options: { html?: string }) => {
      expect(options.html).toContain("<h1>Welcome</h1>");
      return new Response("%PDF-test", { headers: { "content-type": "application/pdf" } });
    });
    const bindings = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "WORKFLOW_INLINE") return "true";
        if (property === "BROWSER") return { quickAction } as unknown as BrowserRun;
        return Reflect.get(target, property, receiver);
      },
    });
    const context = createExecutionContext();
    const queued = await worker.fetch(
      request(installed.cookie, `/api/pages/${installed.pageId}/exports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format: "pdf" }),
      }),
      bindings,
      context,
    );
    const job = (await queued.json<{ job: Job }>()).job;
    await waitOnExecutionContext(context);
    expect(quickAction).toHaveBeenCalledWith("pdf", expect.objectContaining({ html: expect.any(String) }));
    const download = await worker.fetch(
      request(installed.cookie, `/api/jobs/${job.id}/download`),
      env,
      createExecutionContext(),
    );
    expect(download.headers.get("content-type")).toContain("application/pdf");
    expect(new TextDecoder().decode(await download.arrayBuffer())).toBe("%PDF-test");
  });

  it("publishes a document template atomically and rewrites cloned attachment references", async () => {
    const installed = await bootstrap();
    const sourceAttachmentId = crypto.randomUUID();
    const sourceKey = `assets/${installed.workspaceId}/${sourceAttachmentId}/source`;
    await env.BUCKET.put(sourceKey, "attachment bytes", { httpMetadata: { contentType: "text/plain" } });
    await env.DB.prepare(
      `INSERT INTO attachments
        (id, workspace_id, page_id, r2_key, name, mime, size, content_sha256, created_by, created_at)
       VALUES (?, ?, ?, ?, 'brief.txt', 'text/plain', 16, ?, ?, ?)`,
    )
      .bind(
        sourceAttachmentId,
        installed.workspaceId,
        installed.pageId,
        sourceKey,
        "a".repeat(64),
        installed.userId,
        Date.now(),
      )
      .run();
    const source = new Y.Doc();
    const image = new Y.XmlElement("image");
    image.setAttribute("url", `/api/attachments/${sourceAttachmentId}`);
    source.getXmlFragment("document-store").insert(0, [image]);
    await env.BUCKET.put(`documents/${installed.pageId}/epochs/1/current.bin`, Y.encodeStateAsUpdate(source));

    const create = vi.fn(async ({ id }: { id?: string }) => ({ id: id ?? "created" }));
    const bindings = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "NOTES_WORKFLOW") return { create };
        return Reflect.get(target, property, receiver);
      },
    });
    const context = createExecutionContext();
    const queued = await worker.fetch(
      request(installed.cookie, "/api/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageId: installed.pageId, title: "Project brief" }),
      }),
      bindings,
      context,
    );
    expect(queued.status).toBe(202);
    const queuedJob = (await queued.json<{ job: Job }>()).job;
    expect(queuedJob).toMatchObject({ type: "template_clone", status: "queued", result: null });
    await waitOnExecutionContext(context);

    await env.DB.prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).bind(queuedJob.id).run();
    const row = (await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(queuedJob.id).first<JobRow>())!;
    const step = {
      async do<T>(_name: string, callback: () => Promise<T>) {
        return callback();
      },
    };
    await runTemplateClone(env, row, step as Parameters<typeof runTemplateClone>[2]);

    const completed = await worker.fetch(
      request(installed.cookie, `/api/jobs/${queuedJob.id}`),
      env,
      createExecutionContext(),
    );
    const completedJob = (await completed.json<{ job: Job }>()).job;
    expect(completedJob).toMatchObject({ status: "succeeded", result: { pageId: expect.any(String) } });
    const templateId = completedJob.result!.pageId!;
    const templates = await worker.fetch(request(installed.cookie, "/api/templates"), env, createExecutionContext());
    expect((await templates.json<{ templates: Array<{ id: string; title: string }> }>()).templates).toContainEqual(
      expect.objectContaining({ id: templateId, title: "Project brief" }),
    );
    const clonedAttachment = await env.DB.prepare(`SELECT id, r2_key FROM attachments WHERE page_id = ?`)
      .bind(templateId)
      .first<{ id: string; r2_key: string }>();
    expect(clonedAttachment?.id).not.toBe(sourceAttachmentId);
    expect(await env.BUCKET.get(clonedAttachment!.r2_key)).toBeTruthy();
    const content = await worker.fetch(
      request(installed.cookie, `/api/pages/${templateId}/content`),
      env,
      createExecutionContext(),
    );
    expect(content.status).toBe(200);
    const envelope = await content.json<{ document: unknown }>();
    expect(JSON.stringify(envelope.document)).toContain(`/api/attachments/${clonedAttachment!.id}`);
    expect(JSON.stringify(envelope.document)).not.toContain(`/api/attachments/${sourceAttachmentId}`);
  });

  it("clones typed table state into a staged template", async () => {
    const installed = await bootstrap();
    const created = await worker.fetch(
      request(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "table", parentId: null }),
      }),
      env,
      createExecutionContext(),
    );
    const sourcePageId = (await created.json<{ page: { id: string } }>()).page.id;
    const columnId = crypto.randomUUID();
    const optionId = crypto.randomUUID();
    const rowId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO table_columns (id, page_id, name, type, position) VALUES (?, ?, 'Status', 'select', 0)`,
      ).bind(columnId, sourcePageId),
      env.DB.prepare(
        `INSERT INTO table_select_options (id, column_id, label, position) VALUES (?, ?, 'Ready', 0)`,
      ).bind(optionId, columnId),
      env.DB.prepare(
        `INSERT INTO table_rows (id, page_id, position, created_by, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)`,
      ).bind(rowId, sourcePageId, installed.userId, Date.now(), Date.now()),
      env.DB.prepare(`INSERT INTO table_cells (row_id, column_id, select_value, updated_at) VALUES (?, ?, ?, ?)`).bind(
        rowId,
        columnId,
        optionId,
        Date.now(),
      ),
    ]);

    const create = vi.fn(async ({ id }: { id?: string }) => ({ id: id ?? "created" }));
    const bindings = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "NOTES_WORKFLOW") return { create };
        return Reflect.get(target, property, receiver);
      },
    });
    const context = createExecutionContext();
    const response = await worker.fetch(
      request(installed.cookie, "/api/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageId: sourcePageId, title: "Status tracker" }),
      }),
      bindings,
      context,
    );
    const jobId = (await response.json<{ job: Job }>()).job.id;
    await waitOnExecutionContext(context);
    await env.DB.prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).bind(jobId).run();
    const job = (await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<JobRow>())!;
    await runTemplateClone(env, job, {
      async do<T>(_name: string, callback: () => Promise<T>) {
        return callback();
      },
    } as Parameters<typeof runTemplateClone>[2]);

    const result = JSON.parse(
      (await env.DB.prepare(`SELECT result_json FROM jobs WHERE id = ?`).bind(jobId).first<{ result_json: string }>())!
        .result_json,
    ) as { pageId: string };
    const cloned = await env.DB.prepare(
      `SELECT p.is_template, column.name, option.label, cell.select_value
         FROM pages p JOIN table_columns column ON column.page_id = p.id
         JOIN table_select_options option ON option.column_id = column.id
         JOIN table_rows row ON row.page_id = p.id
         JOIN table_cells cell ON cell.row_id = row.id AND cell.column_id = column.id
        WHERE p.id = ?`,
    )
      .bind(result.pageId)
      .first<{ is_template: number; name: string; label: string; select_value: string }>();
    expect(cloned).toMatchObject({ is_template: 1, name: "Status", label: "Ready" });
    expect(cloned?.select_value).toContain(":option:");
  });
});

describe("delivery outbox", () => {
  it("recovers a committed record and records duplicate delivery idempotently", async () => {
    const installed = await bootstrap();
    const outboxId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.prepare(
      `INSERT INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
       VALUES (?, ?, 'notification', ?, ?, ?)`,
    )
      .bind(
        outboxId,
        installed.workspaceId,
        JSON.stringify({ notificationId: crypto.randomUUID() }),
        timestamp,
        timestamp,
      )
      .run();

    const sent: unknown[] = [];
    const bindings = new Proxy(env as Env, {
      get(target, property, receiver) {
        if (property === "DELIVERY_QUEUE") {
          return { send: vi.fn(async (body: unknown) => void sent.push(body)) };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    await sweepOutbox(bindings);
    expect(sent).toEqual([{ outboxId }]);
    expect(
      (await env.DB.prepare(`SELECT enqueued_at FROM outbox WHERE id = ?`).bind(outboxId).first())?.enqueued_at,
    ).toBeTypeOf("number");

    const ack = vi.fn();
    const queueMessage = {
      id: "message-1",
      timestamp: new Date(),
      body: { outboxId },
      attempts: 1,
      ack,
      retry: vi.fn(),
    } satisfies Message<{ outboxId: string }>;
    await consumeDeliveryMessage(env, queueMessage);
    await consumeDeliveryMessage(env, queueMessage);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(
      (
        await env.DB.prepare(`SELECT COUNT(*) count FROM deliveries WHERE outbox_id = ?`)
          .bind(outboxId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });
});
