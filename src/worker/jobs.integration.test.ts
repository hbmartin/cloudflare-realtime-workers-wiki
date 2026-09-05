import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../shared/types";
import type { Env } from "./env";
import { consumeDeliveryMessage, expireJobArtifacts, sweepOutbox } from "./jobs";
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
