import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { diagramNodeMap, diagramRoots } from "../shared/diagram";
import type { DiagramContentEnvelope, Job, Page } from "../shared/types";
import { createZip, readZip } from "../shared/zip";
import type { Env } from "./env";
import { runImport } from "./importer";
import {
  claimJobWorkflowRun,
  cleanupTemplateClone,
  consumeDeliveryMessage,
  expireJobArtifacts,
  finishPendingJobCleanup,
  recoverQueuedJobs,
  resolveJobWorkflowAttempt,
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

// `in` rather than a nullish fallback: some tests override a binding to undefined.
function bindingsWith(overrides: Record<string, unknown>) {
  return new Proxy(env as Env, {
    get(target, property, receiver) {
      if (typeof property === "string" && property in overrides) return overrides[property];
      return Reflect.get(target, property, receiver);
    },
  });
}

function inlineBindings() {
  return bindingsWith({ WORKFLOW_INLINE: "true" });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
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
    const bindings = bindingsWith({ NOTES_WORKFLOW: { create } });
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
    expect(create).toHaveBeenCalledWith({ id: first.job.id, params: { jobId: first.job.id, attempt: 1 } });

    const feed = await worker.fetch(request(installed.cookie, "/api/jobs"), env, createExecutionContext());
    expect(feed.status).toBe(200);
    expect((await feed.json<{ jobs: Job[] }>()).jobs.map((job) => job.id)).toContain(first.job.id);
  });

  it("runs the owner-initiated legacy comment workspace scan", async () => {
    const installed = await bootstrap();
    const create = vi.fn(async ({ id }: { id?: string }) => ({ id: id ?? "created" }));
    const bindings = bindingsWith({ NOTES_WORKFLOW: { create } });
    const context = createExecutionContext();
    const response = await worker.fetch(
      request(installed.cookie, "/api/jobs/comment-migration", { method: "POST" }),
      bindings,
      context,
    );
    expect(response.status).toBe(202);
    const job = (await response.json<{ job: Job }>()).job;
    await waitOnExecutionContext(context);
    expect(create).toHaveBeenCalledWith({ id: job.id, params: { jobId: job.id, attempt: 1 } });

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

    const cancelContext = createExecutionContext();
    const canceled = await worker.fetch(
      request(installed.cookie, `/api/jobs/${canceledId}/cancel`, { method: "POST" }),
      env,
      cancelContext,
    );
    expect(canceled.status).toBe(200);
    expect((await canceled.json<{ job: Job }>()).job.status).toBe("canceling");
    await waitOnExecutionContext(cancelContext);
    expect(
      (
        await (
          await worker.fetch(request(installed.cookie, `/api/jobs/${canceledId}`), env, createExecutionContext())
        ).json<{ job: Job }>()
      ).job.status,
    ).toBe("canceled");

    const retry = await worker.fetch(
      request(installed.cookie, `/api/jobs/${succeededId}/retry`, { method: "POST" }),
      env,
      createExecutionContext(),
    );
    expect(retry.status).toBe(409);
  });

  it("recovers an interrupted cancellation before making the job retryable", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const timestamp = Date.now() - 60_000;
    await env.DB.prepare(
      `INSERT INTO jobs
        (id, workspace_id, type, status, requested_by, cleanup_target, progress_label, created_at, updated_at)
       VALUES (?, ?, 'import', 'canceling', ?, 'canceled', 'Cleanup pending', ?, ?)`,
    )
      .bind(jobId, installed.workspaceId, installed.userId, timestamp, timestamp)
      .run();

    await recoverQueuedJobs(env);

    expect(
      await env.DB.prepare(`SELECT status, cleanup_target, cleanup_token FROM jobs WHERE id = ?`).bind(jobId).first(),
    ).toEqual({ status: "canceled", cleanup_target: null, cleanup_token: null });
  });

  it("rejects a retry while cancellation cleanup is still running", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const stagedPageId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO jobs (id, workspace_id, space_id, type, status, requested_by, created_at, updated_at)
         VALUES (?, ?, ?, 'import', 'running', ?, ?, ?)`,
      ).bind(jobId, installed.workspaceId, `${installed.workspaceId}-general`, installed.userId, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO pages
          (id, workspace_id, space_id, kind, position, title, import_job_id, content_epoch,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'document', 'z-pending-cleanup', 'Pending cleanup', ?, 1, ?, ?, ?)`,
      ).bind(
        stagedPageId,
        installed.workspaceId,
        `${installed.workspaceId}-general`,
        jobId,
        installed.userId,
        timestamp,
        timestamp,
      ),
    ]);
    const purgeStarted = deferred<void>();
    const releasePurge = deferred<void>();
    const bindings = bindingsWith({
      DOCUMENT: {
        getByName: () => ({
          fetch: async () => {
            purgeStarted.resolve();
            await releasePurge.promise;
            return new Response(null, { status: 204 });
          },
        }),
      },
    });
    const cancelContext = createExecutionContext();
    const canceled = await worker.fetch(
      request(installed.cookie, `/api/jobs/${jobId}/cancel`, { method: "POST" }),
      bindings,
      cancelContext,
    );
    expect(canceled.status).toBe(200);
    await purgeStarted.promise;

    const earlyRetry = await worker.fetch(
      request(installed.cookie, `/api/jobs/${jobId}/retry`, { method: "POST" }),
      bindings,
      createExecutionContext(),
    );
    expect(earlyRetry.status).toBe(409);

    releasePurge.resolve();
    await waitOnExecutionContext(cancelContext);
    expect((await env.DB.prepare(`SELECT status FROM jobs WHERE id = ?`).bind(jobId).first())?.status).toBe("canceled");
  });

  it("resolves legacy workflow payloads only through their stored instance identity", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.prepare(
      `INSERT INTO jobs
        (id, workspace_id, type, status, requested_by, workflow_instance_id, attempt, created_at, updated_at)
       VALUES (?, ?, 'export', 'queued', ?, 'legacy-instance', 3, ?, ?)`,
    )
      .bind(jobId, installed.workspaceId, installed.userId, timestamp, timestamp)
      .run();

    expect(await resolveJobWorkflowAttempt(env, { payload: { jobId }, instanceId: "legacy-instance" })).toBe(3);
    expect(await resolveJobWorkflowAttempt(env, { payload: { jobId }, instanceId: "stale-instance" })).toBeNull();
    expect(await resolveJobWorkflowAttempt(env, { payload: { jobId, attempt: 4 }, instanceId: "stale-instance" })).toBe(
      4,
    );
  });

  it("loads the same running workflow attempt idempotently", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.prepare(
      `INSERT INTO jobs
        (id, workspace_id, type, status, requested_by, workflow_instance_id, attempt, created_at, updated_at)
       VALUES (?, ?, 'search_reindex', 'queued', ?, 'workflow-retry', 2, ?, ?)`,
    )
      .bind(jobId, installed.workspaceId, installed.userId, timestamp, timestamp)
      .run();
    const event = { payload: { jobId, attempt: 2 }, instanceId: "workflow-retry" };

    expect(await claimJobWorkflowRun(env, event, 2)).toMatchObject({ id: jobId, status: "running", attempt: 2 });
    expect(await claimJobWorkflowRun(env, event, 2)).toMatchObject({ id: jobId, status: "running", attempt: 2 });
    expect(await claimJobWorkflowRun(env, { ...event, instanceId: "stale-workflow" }, 2)).toBeNull();
  });

  it("does not reclaim a running workflow attempt that is parked for cleanup", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.prepare(
      `INSERT INTO jobs
        (id, workspace_id, type, status, requested_by, workflow_instance_id, attempt,
         cleanup_target, progress_label, created_at, updated_at)
       VALUES (?, ?, 'import', 'running', ?, 'cleanup-workflow', 2,
               'failed', 'Failure cleanup pending', ?, ?)`,
    )
      .bind(jobId, installed.workspaceId, installed.userId, timestamp, timestamp)
      .run();

    expect(
      await claimJobWorkflowRun(env, { payload: { jobId, attempt: 2 }, instanceId: "cleanup-workflow" }, 2),
    ).toBeNull();
  });

  it.each(["code", "status"] as const)(
    "finishes cancellation cleanup when its missing workflow exposes a %s 404",
    async (field) => {
      const installed = await bootstrap();
      const jobId = crypto.randomUUID();
      const timestamp = Date.now();
      await env.DB.prepare(
        `INSERT INTO jobs
          (id, workspace_id, type, status, requested_by, workflow_instance_id, cleanup_target,
           progress_label, created_at, updated_at)
         VALUES (?, ?, 'import', 'canceling', ?, 'expired-workflow', 'canceled', 'Canceling', ?, ?)`,
      )
        .bind(jobId, installed.workspaceId, installed.userId, timestamp, timestamp)
        .run();
      const get = vi.fn(async () => {
        throw Object.assign(new Error("Workflow instance expired"), { [field]: 404 });
      });

      await finishPendingJobCleanup(bindingsWith({ NOTES_WORKFLOW: { get } }), { id: jobId, attempt: 1 });

      expect(get).toHaveBeenCalledWith("expired-workflow");
      expect(
        await env.DB.prepare(`SELECT status, cleanup_target, progress_label FROM jobs WHERE id = ?`)
          .bind(jobId)
          .first(),
      ).toEqual({ status: "canceled", cleanup_target: null, progress_label: "Canceled" });
    },
  );

  it.each([
    "instance.not_found",
    "(instance.not_found) Instance does not exist",
    "WorkflowError: (instance.not_found) Instance does not exist",
    "Error: WorkflowError: (instance.not_found) Instance does not exist",
  ])("finishes cancellation cleanup for the Workflows binding error %s", async (message) => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.prepare(
      `INSERT INTO jobs
          (id, workspace_id, type, status, requested_by, workflow_instance_id, cleanup_target,
           progress_label, created_at, updated_at)
         VALUES (?, ?, 'import', 'canceling', ?, 'expired-workflow', 'canceled', 'Canceling', ?, ?)`,
    )
      .bind(jobId, installed.workspaceId, installed.userId, timestamp, timestamp)
      .run();
    const get = vi.fn(async () => Promise.reject(new Error(message)));

    await finishPendingJobCleanup(bindingsWith({ NOTES_WORKFLOW: { get } }), { id: jobId, attempt: 1 });

    expect(await env.DB.prepare(`SELECT status, cleanup_target FROM jobs WHERE id = ?`).bind(jobId).first()).toEqual({
      status: "canceled",
      cleanup_target: null,
    });
  });

  it.each(["error", "string"] as const)(
    "does not treat an unrelated %s containing a workflow code as an instance result",
    async (kind) => {
      const installed = await bootstrap();
      const jobId = crypto.randomUUID();
      const timestamp = Date.now();
      await env.DB.prepare(
        `INSERT INTO jobs
          (id, workspace_id, type, status, requested_by, workflow_instance_id, cleanup_target,
           progress_label, created_at, updated_at)
         VALUES (?, ?, 'import', 'canceling', ?, 'active-workflow', 'canceled', 'Canceling', ?, ?)`,
      )
        .bind(jobId, installed.workspaceId, installed.userId, timestamp, timestamp)
        .run();
      const message = "Proxy failed while decoding an instance.not_found response";
      const failure: unknown = kind === "error" ? new Error(message) : message;
      const get = vi.fn(async () => Promise.reject(failure));

      await expect(
        finishPendingJobCleanup(bindingsWith({ NOTES_WORKFLOW: { get } }), { id: jobId, attempt: 1 }),
      ).rejects.toBe(failure);

      expect(await env.DB.prepare(`SELECT status, cleanup_target FROM jobs WHERE id = ?`).bind(jobId).first()).toEqual({
        status: "canceling",
        cleanup_target: "canceled",
      });
    },
  );

  it("finishes cancellation cleanup when the workflow completes before termination", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.prepare(
      `INSERT INTO jobs
        (id, workspace_id, type, status, requested_by, workflow_instance_id, cleanup_target,
         progress_label, created_at, updated_at)
       VALUES (?, ?, 'import', 'canceling', ?, 'finishing-workflow', 'canceled', 'Canceling', ?, ?)`,
    )
      .bind(jobId, installed.workspaceId, installed.userId, timestamp, timestamp)
      .run();
    const terminate = vi.fn(async () => {
      throw new Error("(instance.cannot_terminate) Cannot terminate an instance in a finite state");
    });
    const get = vi.fn(async () => ({
      status: async () => ({ status: "running" }),
      terminate,
    }));

    await finishPendingJobCleanup(bindingsWith({ NOTES_WORKFLOW: { get } }), { id: jobId, attempt: 1 });

    expect(terminate).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(`SELECT status, cleanup_target FROM jobs WHERE id = ?`).bind(jobId).first()).toEqual({
      status: "canceled",
      cleanup_target: null,
    });
  });

  it.each(["get", "status", "terminate"] as const)(
    "keeps cancellation cleanup pending when workflow %s fails without a structured 404",
    async (operation) => {
      const installed = await bootstrap();
      const jobId = crypto.randomUUID();
      const timestamp = Date.now();
      await env.DB.prepare(
        `INSERT INTO jobs
          (id, workspace_id, type, status, requested_by, workflow_instance_id, cleanup_target,
           progress_label, created_at, updated_at)
         VALUES (?, ?, 'import', 'canceling', ?, 'active-workflow', 'canceled', 'Canceling', ?, ?)`,
      )
        .bind(jobId, installed.workspaceId, installed.userId, timestamp, timestamp)
        .run();
      const failure = new Error("Workflow control-plane endpoint not found");
      const instance = {
        async status() {
          if (operation === "status") throw failure;
          return { status: "running" };
        },
        async terminate() {
          if (operation === "terminate") throw failure;
        },
      };
      const get = vi.fn(async () => {
        if (operation === "get") throw failure;
        return instance;
      });

      await expect(
        finishPendingJobCleanup(bindingsWith({ NOTES_WORKFLOW: { get } }), { id: jobId, attempt: 1 }),
      ).rejects.toBe(failure);

      expect(
        await env.DB.prepare(`SELECT status, cleanup_target, progress_label FROM jobs WHERE id = ?`)
          .bind(jobId)
          .first(),
      ).toEqual({ status: "canceling", cleanup_target: "canceled", progress_label: "Cleanup pending" });
    },
  );

  it("reports an inline job failure as failed while its cleanup remains pending", async () => {
    const installed = await bootstrap();
    const unavailable = new Error("R2 unavailable");
    const bucket = { list: vi.fn(async () => Promise.reject(unavailable)) };
    const bindings = bindingsWith({ WORKFLOW_INLINE: "true", BUCKET: bucket });
    const context = createExecutionContext();

    const response = await worker.fetch(
      request(installed.cookie, `/api/pages/${installed.pageId}/exports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format: "markdown", portable: false }),
      }),
      bindings,
      context,
    );
    expect(response.status).toBe(202);
    const queued = (await response.json<{ job: Job }>()).job;
    await waitOnExecutionContext(context);

    const failed = await worker.fetch(
      request(installed.cookie, `/api/jobs/${queued.id}`),
      env,
      createExecutionContext(),
    );
    expect((await failed.json<{ job: Job }>()).job).toMatchObject({
      status: "failed",
      cleanupPending: true,
      error: { code: "job_failed", message: "R2 unavailable" },
    });
  });

  it("keeps failed export cleanup recoverable, non-retryable, and scoped through its attempt", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const oldOutputKey = `jobs/${jobId}/attempts/1/output/old.md`;
    const outputKey = `jobs/${jobId}/attempts/2/output/export.md`;
    const futureOutputKey = `jobs/${jobId}/attempts/3/output/future.md`;
    const timestamp = Date.now();
    await Promise.all([
      env.BUCKET.put(oldOutputKey, "old export"),
      env.BUCKET.put(outputKey, "orphaned export"),
      env.BUCKET.put(futureOutputKey, "future export"),
    ]);
    await env.DB.prepare(
      `INSERT INTO jobs
        (id, workspace_id, type, status, requested_by, attempt, cleanup_target, progress_label,
         error_code, error_message, created_at, updated_at)
       VALUES (?, ?, 'export', 'failed', ?, 2, 'failed', 'Failure cleanup pending',
               'job_failed', 'render failed', ?, ?)`,
    )
      .bind(jobId, installed.workspaceId, installed.userId, timestamp, timestamp)
      .run();
    const failingBucket = { list: vi.fn(async () => Promise.reject(new Error("R2 unavailable"))) };

    await expect(
      finishPendingJobCleanup(bindingsWith({ WORKFLOW_INLINE: "true", BUCKET: failingBucket }), {
        id: jobId,
        attempt: 2,
      }),
    ).rejects.toThrow("R2 unavailable");
    expect(
      await env.DB.prepare(`SELECT status, cleanup_target, progress_label FROM jobs WHERE id = ?`).bind(jobId).first(),
    ).toEqual({ status: "failed", cleanup_target: "failed", progress_label: "Failure cleanup pending" });

    const read = await worker.fetch(request(installed.cookie, `/api/jobs/${jobId}`), env, createExecutionContext());
    expect(read.status).toBe(200);
    expect((await read.json<{ job: Job }>()).job).toMatchObject({
      status: "failed",
      cleanupPending: true,
      error: { code: "job_failed", message: "render failed" },
    });
    expect(
      (
        await worker.fetch(
          request(installed.cookie, `/api/jobs/${jobId}/retry`, { method: "POST" }),
          env,
          createExecutionContext(),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await worker.fetch(
          request(installed.cookie, `/api/jobs/${jobId}/cancel`, { method: "POST" }),
          env,
          createExecutionContext(),
        )
      ).status,
    ).toBe(409);

    const cleanupContext = createExecutionContext();
    const cleanupResponse = await worker.fetch(
      request(installed.cookie, `/api/jobs/${jobId}/cleanup`, { method: "POST" }),
      inlineBindings(),
      cleanupContext,
    );
    expect(cleanupResponse.status).toBe(202);
    await waitOnExecutionContext(cleanupContext);

    expect(await env.BUCKET.get(oldOutputKey)).toBeNull();
    expect(await env.BUCKET.get(outputKey)).toBeNull();
    expect(await env.BUCKET.get(futureOutputKey)).toBeTruthy();
    expect(
      await env.DB.prepare(`SELECT status, cleanup_target, progress_label FROM jobs WHERE id = ?`).bind(jobId).first(),
    ).toEqual({ status: "failed", cleanup_target: null, progress_label: "Failed" });
  });

  it("cleans document staging from every completed import attempt", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const timestamp = Date.now();
    const oldKey = `jobs/${jobId}/attempts/1/documents/old.bin`;
    const currentKey = `jobs/${jobId}/attempts/2/documents/current.bin`;
    const futureKey = `jobs/${jobId}/attempts/3/documents/future.bin`;
    const legacyKey = `jobs/${jobId}/documents/legacy.bin`;
    await Promise.all(
      [oldKey, currentKey, futureKey, legacyKey].map((key) => env.BUCKET.put(key, new Uint8Array([1]))),
    );
    await env.DB.prepare(
      `INSERT INTO jobs
        (id, workspace_id, type, status, requested_by, attempt, cleanup_target,
         progress_label, error_code, error_message, created_at, updated_at)
       VALUES (?, ?, 'import', 'canceling', ?, 2, 'failed',
               'Failure cleanup pending', 'job_failed', 'import failed', ?, ?)`,
    )
      .bind(jobId, installed.workspaceId, installed.userId, timestamp, timestamp)
      .run();

    await finishPendingJobCleanup(inlineBindings(), { id: jobId, attempt: 2 });

    expect(await env.BUCKET.get(oldKey)).toBeNull();
    expect(await env.BUCKET.get(currentKey)).toBeNull();
    expect(await env.BUCKET.get(legacyKey)).toBeNull();
    expect(await env.BUCKET.get(futureKey)).toBeTruthy();
    expect(await env.DB.prepare(`SELECT status, cleanup_target FROM jobs WHERE id = ?`).bind(jobId).first()).toEqual({
      status: "failed",
      cleanup_target: null,
    });
  });

  it("cleans attachment objects from every completed import attempt", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const pageId = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const timestamp = Date.now();
    const oldKey = `assets/${installed.workspaceId}/${attachmentId}/attempts/1/import-hash`;
    const currentKey = `assets/${installed.workspaceId}/${attachmentId}/attempts/2/import-hash`;
    const futureKey = `assets/${installed.workspaceId}/${attachmentId}/attempts/3/import-hash`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO jobs
          (id, workspace_id, space_id, type, status, requested_by, attempt, cleanup_target,
           progress_label, error_code, error_message, created_at, updated_at)
         VALUES (?, ?, ?, 'import', 'failed', ?, 2, 'failed', 'Failure cleanup pending',
                 'job_failed', 'import failed', ?, ?)`,
      ).bind(jobId, installed.workspaceId, `${installed.workspaceId}-general`, installed.userId, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO pages
          (id, workspace_id, space_id, kind, position, title, import_job_id, content_epoch,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'table', 'z-import-cleanup', 'Staged import', ?, 2, ?, ?, ?)`,
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
        `INSERT INTO attachments
          (id, workspace_id, page_id, r2_key, name, mime, size, content_sha256, created_by, created_at)
         VALUES (?, ?, ?, ?, 'import.txt', 'text/plain', 1, 'import-hash', ?, ?)`,
      ).bind(attachmentId, installed.workspaceId, pageId, currentKey, installed.userId, timestamp),
    ]);
    await Promise.all([
      env.BUCKET.put(oldKey, "old attachment"),
      env.BUCKET.put(currentKey, "current attachment"),
      env.BUCKET.put(futureKey, "future attachment"),
    ]);

    await finishPendingJobCleanup(inlineBindings(), { id: jobId, attempt: 2 });

    expect(await Promise.all([oldKey, currentKey].map((key) => env.BUCKET.get(key)))).toEqual([null, null]);
    expect(await env.BUCKET.get(futureKey)).toBeTruthy();
    expect(await env.DB.prepare(`SELECT id FROM pages WHERE id = ?`).bind(pageId).first()).toBeNull();
  });

  it("cleans staged template clone resources after cancellation", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const targetPageId = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const oldAttachmentKey = `assets/${installed.workspaceId}/${attachmentId}/attempts/1/clone`;
    const attachmentKey = `assets/${installed.workspaceId}/${attachmentId}/attempts/2/clone`;
    const futureAttachmentKey = `assets/${installed.workspaceId}/${attachmentId}/attempts/3/clone`;
    const oldInputKey = `jobs/${jobId}/attempts/1/template-content.bin`;
    const inputKey = `jobs/${jobId}/attempts/2/template-content.bin`;
    const futureInputKey = `jobs/${jobId}/attempts/3/template-content.bin`;
    const legacyInputKey = `jobs/${jobId}/template-content.bin`;
    const documentKey = `documents/${targetPageId}/epochs/2/current.bin`;
    const timestamp = Date.now();
    const options = JSON.stringify({
      sourcePageId: installed.pageId,
      targetPageId,
      targetSpaceId: `${installed.workspaceId}-general`,
      parentId: null,
      title: "Canceled clone",
      isTemplate: false,
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO jobs
          (id, workspace_id, space_id, type, status, requested_by, input_key, options_json, attempt, created_at,
           updated_at)
         VALUES (?, ?, ?, 'template_clone', 'running', ?, ?, ?, 2, ?, ?)`,
      ).bind(
        jobId,
        installed.workspaceId,
        `${installed.workspaceId}-general`,
        installed.userId,
        inputKey,
        options,
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO pages
          (id, workspace_id, space_id, kind, position, title, import_job_id, content_epoch, created_by, created_at,
           updated_at)
         VALUES (?, ?, ?, 'table', 'z-canceled', 'Canceled clone', ?, 2, ?, ?, ?)`,
      ).bind(
        targetPageId,
        installed.workspaceId,
        `${installed.workspaceId}-general`,
        jobId,
        installed.userId,
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO attachments
          (id, workspace_id, page_id, r2_key, name, mime, size, created_by, created_at)
         VALUES (?, ?, ?, ?, 'clone.txt', 'text/plain', 1, ?, ?)`,
      ).bind(attachmentId, installed.workspaceId, targetPageId, attachmentKey, installed.userId, timestamp),
    ]);
    await Promise.all([
      env.BUCKET.put(oldAttachmentKey, "old attachment"),
      env.BUCKET.put(attachmentKey, "a"),
      env.BUCKET.put(futureAttachmentKey, "future attachment"),
      env.BUCKET.put(oldInputKey, "old input"),
      env.BUCKET.put(inputKey, "input"),
      env.BUCKET.put(futureInputKey, "future input"),
      env.BUCKET.put(legacyInputKey, "legacy input"),
      env.BUCKET.put(documentKey, "document"),
    ]);
    const context = createExecutionContext();

    const response = await worker.fetch(
      request(installed.cookie, `/api/jobs/${jobId}/cancel`, { method: "POST" }),
      env,
      context,
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(200);
    expect(await env.DB.prepare(`SELECT id FROM pages WHERE id = ?`).bind(targetPageId).first()).toBeNull();
    expect(await env.DB.prepare(`SELECT id FROM attachments WHERE id = ?`).bind(attachmentId).first()).toBeNull();
    expect(
      await Promise.all(
        [oldAttachmentKey, attachmentKey, oldInputKey, inputKey, legacyInputKey, documentKey].map((key) =>
          env.BUCKET.get(key),
        ),
      ),
    ).toEqual([null, null, null, null, null, null]);
    expect(await Promise.all([futureAttachmentKey, futureInputKey].map((key) => env.BUCKET.get(key)))).toEqual([
      expect.anything(),
      expect.anything(),
    ]);
  });

  it("does not let stale attempt cleanup delete a retried template clone", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const targetPageId = crypto.randomUUID();
    const timestamp = Date.now();
    const options = JSON.stringify({
      sourcePageId: installed.pageId,
      targetPageId,
      targetSpaceId: `${installed.workspaceId}-general`,
      parentId: null,
      title: "Retried clone",
      isTemplate: false,
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO jobs
          (id, workspace_id, space_id, type, status, requested_by, options_json, attempt, created_at, updated_at)
         VALUES (?, ?, ?, 'template_clone', 'running', ?, ?, 2, ?, ?)`,
      ).bind(
        jobId,
        installed.workspaceId,
        `${installed.workspaceId}-general`,
        installed.userId,
        options,
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO pages
          (id, workspace_id, space_id, kind, position, title, import_job_id, content_epoch,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'document', 'z-retry', 'Retried clone', ?, 2, ?, ?, ?)`,
      ).bind(
        targetPageId,
        installed.workspaceId,
        `${installed.workspaceId}-general`,
        jobId,
        installed.userId,
        timestamp,
        timestamp,
      ),
    ]);
    const current = (await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<JobRow>())!;

    await cleanupTemplateClone(env, { ...current, attempt: 1 }, async () => true);

    expect(
      await env.DB.prepare(`SELECT import_job_id, content_epoch FROM pages WHERE id = ?`).bind(targetPageId).first(),
    ).toEqual({ import_job_id: jobId, content_epoch: 2 });
  });

  it("does not let current cleanup delete a template page fenced to a newer epoch", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const targetPageId = crypto.randomUUID();
    const timestamp = Date.now();
    const options = JSON.stringify({
      sourcePageId: installed.pageId,
      targetPageId,
      targetSpaceId: `${installed.workspaceId}-general`,
      parentId: null,
      title: "Newer clone",
      isTemplate: false,
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO jobs
          (id, workspace_id, space_id, type, status, requested_by, options_json, attempt, created_at, updated_at)
         VALUES (?, ?, ?, 'template_clone', 'running', ?, ?, 1, ?, ?)`,
      ).bind(
        jobId,
        installed.workspaceId,
        `${installed.workspaceId}-general`,
        installed.userId,
        options,
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO pages
          (id, workspace_id, space_id, kind, position, title, import_job_id, content_epoch,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'document', 'z-newer', 'Newer clone', ?, 2, ?, ?, ?)`,
      ).bind(
        targetPageId,
        installed.workspaceId,
        `${installed.workspaceId}-general`,
        jobId,
        installed.userId,
        timestamp,
        timestamp,
      ),
    ]);
    const current = (await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<JobRow>())!;

    await cleanupTemplateClone(env, current, async () => true);

    expect(
      await env.DB.prepare(`SELECT import_job_id, content_epoch FROM pages WHERE id = ?`).bind(targetPageId).first(),
    ).toEqual({ import_job_id: jobId, content_epoch: 2 });
  });

  it("cleans a staged template page left at an older epoch by the current attempt", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const targetPageId = crypto.randomUUID();
    const timestamp = Date.now();
    const options = JSON.stringify({
      sourcePageId: installed.pageId,
      targetPageId,
      targetSpaceId: `${installed.workspaceId}-general`,
      parentId: null,
      title: "Unfenced clone",
      isTemplate: false,
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO jobs
          (id, workspace_id, space_id, type, status, requested_by, options_json, attempt, created_at, updated_at)
         VALUES (?, ?, ?, 'template_clone', 'running', ?, ?, 2, ?, ?)`,
      ).bind(
        jobId,
        installed.workspaceId,
        `${installed.workspaceId}-general`,
        installed.userId,
        options,
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO pages
          (id, workspace_id, space_id, kind, position, title, import_job_id, content_epoch,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'table', 'z-unfenced', 'Unfenced clone', ?, 1, ?, ?, ?)`,
      ).bind(
        targetPageId,
        installed.workspaceId,
        `${installed.workspaceId}-general`,
        jobId,
        installed.userId,
        timestamp,
        timestamp,
      ),
    ]);
    const current = (await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<JobRow>())!;

    await cleanupTemplateClone(env, current, async () => true);

    expect(await env.DB.prepare(`SELECT id FROM pages WHERE id = ?`).bind(targetPageId).first()).toBeNull();
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

  it("expires import staging from every completed attempt without touching a future retry", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const timestamp = Date.now();
    const oldKey = `jobs/${jobId}/attempts/1/documents/old.bin`;
    const currentKey = `jobs/${jobId}/attempts/2/documents/current.bin`;
    const futureKey = `jobs/${jobId}/attempts/3/documents/future.bin`;
    const legacyKey = `jobs/${jobId}/documents/legacy.bin`;
    await Promise.all(
      [oldKey, currentKey, futureKey, legacyKey].map((key) => env.BUCKET.put(key, new Uint8Array([1]))),
    );
    await env.DB.prepare(
      `INSERT INTO jobs
        (id, workspace_id, type, status, requested_by, input_key, expires_at, attempt, created_at, updated_at)
       VALUES (?, ?, 'import', 'succeeded', ?, ?, ?, 2, ?, ?)`,
    )
      .bind(jobId, installed.workspaceId, installed.userId, currentKey, timestamp - 1, timestamp, timestamp)
      .run();

    await expireJobArtifacts(env);

    expect(await Promise.all([oldKey, currentKey, legacyKey].map((key) => env.BUCKET.get(key)))).toEqual([
      null,
      null,
      null,
    ]);
    expect(await env.BUCKET.get(futureKey)).toBeTruthy();
    expect((await env.DB.prepare(`SELECT input_key FROM jobs WHERE id = ?`).bind(jobId).first())?.input_key).toBeNull();
  });

  it("exports a freshly flushed document with portable attachments", async () => {
    const installed = await bootstrap();
    const attachmentId = "brief[1";
    const attachmentKey = `assets/${installed.workspaceId}/${attachmentId}/brief`;
    await env.BUCKET.put(attachmentKey, "portable bytes", { httpMetadata: { contentType: "text/plain" } });
    await env.DB.prepare(
      `INSERT INTO attachments
        (id, workspace_id, page_id, r2_key, name, mime, size, created_by, created_at)
       VALUES (?, ?, ?, ?, 'brief.txt', 'text/plain', 14, ?, ?)`,
    )
      .bind(attachmentId, installed.workspaceId, installed.pageId, attachmentKey, installed.userId, Date.now())
      .run();
    const bindings = bindingsWith({ WORKFLOW_INLINE: "true" });
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

    const completed = await worker.fetch(
      request(installed.cookie, `/api/jobs/${job.id}`),
      env,
      createExecutionContext(),
    );
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

  it("exports a diagram as structured JSON", async () => {
    const installed = await bootstrap();
    const created = await worker.fetch(
      request(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "diagram", title: "Service map" }),
      }),
      env,
      createExecutionContext(),
    );
    const page = (await created.json<{ page: Page }>()).page;
    const diagram = new Y.Doc();
    diagramRoots(diagram).nodes.set(
      "service-node",
      diagramNodeMap({
        id: "service-node",
        type: "service",
        x: 10,
        y: 20,
        width: 160,
        height: 80,
        zIndex: 1,
        parentId: null,
        label: "API",
        notes: "",
        color: "blue",
        assetId: null,
        references: [],
        mentions: [],
      }),
    );
    await env.BUCKET.put(`diagrams/${page.id}/epochs/1/current.bin`, Y.encodeStateAsUpdate(diagram));

    const context = createExecutionContext();
    const queued = await worker.fetch(
      request(installed.cookie, `/api/pages/${page.id}/exports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ format: "json", portable: false }),
      }),
      inlineBindings(),
      context,
    );
    expect(queued.status).toBe(202);
    const job = (await queued.json<{ job: Job }>()).job;
    await waitOnExecutionContext(context);

    const download = await worker.fetch(
      request(installed.cookie, `/api/jobs/${job.id}/download`),
      env,
      createExecutionContext(),
    );
    expect(download.headers.get("content-type")).toContain("application/json");
    const exported = await download.json<DiagramContentEnvelope>();
    expect(exported).toMatchObject({ pageId: page.id, nodes: [{ id: "service-node", label: "API" }] });
  });

  it("reports PDF configuration and renders through the Browser Run binding", async () => {
    const installed = await bootstrap();
    const unavailableBindings = bindingsWith({ BROWSER: undefined });
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

    const prefixKey = `assets/${installed.workspaceId}/a/prefix`;
    const exactKey = `assets/${installed.workspaceId}/ab/exact`;
    const hostileKey = `assets/${installed.workspaceId}/evil/hostile`;
    const hostileMime = `image/png" onerror="fetch('https://attacker.invalid')//`;
    await Promise.all([
      env.BUCKET.put(prefixKey, "wrong"),
      env.BUCKET.put(exactKey, "right"),
      env.BUCKET.put(hostileKey, "invalid"),
    ]);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO attachments
          (id, workspace_id, page_id, r2_key, name, mime, size, created_by, created_at)
         VALUES ('a', ?, ?, ?, 'prefix.png', 'image/png', 5, ?, ?)`,
      ).bind(installed.workspaceId, installed.pageId, prefixKey, installed.userId, Date.now()),
      env.DB.prepare(
        `INSERT INTO attachments
          (id, workspace_id, page_id, r2_key, name, mime, size, created_by, created_at)
         VALUES ('ab', ?, ?, ?, 'exact.png', 'image/png', 5, ?, ?)`,
      ).bind(installed.workspaceId, installed.pageId, exactKey, installed.userId, Date.now()),
      env.DB.prepare(
        `INSERT INTO attachments
          (id, workspace_id, page_id, r2_key, name, mime, size, created_by, created_at)
         VALUES ('evil', ?, ?, ?, 'evil.png', ?, 7, ?, ?)`,
      ).bind(installed.workspaceId, installed.pageId, hostileKey, hostileMime, installed.userId, Date.now()),
    ]);
    const source = new Y.Doc();
    for (const id of ["ab", "evil"]) {
      const image = new Y.XmlElement("image");
      image.setAttribute("url", `/api/attachments/${id}`);
      source.getXmlFragment("document-store").push([image]);
    }
    await env.BUCKET.put(`documents/${installed.pageId}/epochs/1/current.bin`, Y.encodeStateAsUpdate(source));

    const quickAction = vi.fn(async (_action: string, options: { html?: string }) => {
      expect(options.html).toContain("<h1>Welcome</h1>");
      expect(options.html).toContain("data:image/png;base64,cmlnaHQ=");
      expect(options.html).not.toContain("d3Jvbmc=");
      expect(options.html).not.toContain(" onerror=");
      expect(options.html).not.toContain("attacker.invalid");
      return new Response("%PDF-test", { headers: { "content-type": "application/pdf" } });
    });
    const bindings = bindingsWith({ WORKFLOW_INLINE: "true", BROWSER: { quickAction } as unknown as BrowserRun });
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
    const bindings = bindingsWith({ NOTES_WORKFLOW: { create } });
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

  it("publishes a diagram template and rewrites image node attachments", async () => {
    const installed = await bootstrap();
    const created = await worker.fetch(
      request(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "diagram", title: "Architecture template source" }),
      }),
      env,
      createExecutionContext(),
    );
    const sourcePage = (await created.json<{ page: Page }>()).page;
    const sourceAttachmentId = crypto.randomUUID();
    const sourceKey = `assets/${installed.workspaceId}/${sourceAttachmentId}/source`;
    await env.BUCKET.put(sourceKey, "image bytes", { httpMetadata: { contentType: "image/png" } });
    await env.DB.prepare(
      `INSERT INTO attachments
        (id, workspace_id, page_id, r2_key, name, mime, size, content_sha256, created_by, created_at)
       VALUES (?, ?, ?, ?, 'architecture.png', 'image/png', 11, ?, ?, ?)`,
    )
      .bind(
        sourceAttachmentId,
        installed.workspaceId,
        sourcePage.id,
        sourceKey,
        "b".repeat(64),
        installed.userId,
        Date.now(),
      )
      .run();
    const source = new Y.Doc();
    diagramRoots(source).nodes.set(
      "image-node",
      diagramNodeMap({
        id: "image-node",
        type: "image",
        x: 20,
        y: 30,
        width: 240,
        height: 160,
        zIndex: 1,
        parentId: null,
        label: "Architecture",
        notes: "",
        color: "slate",
        assetId: sourceAttachmentId,
        references: [],
        mentions: [],
      }),
    );
    await env.BUCKET.put(`diagrams/${sourcePage.id}/epochs/1/current.bin`, Y.encodeStateAsUpdate(source));

    const create = vi.fn(async ({ id }: { id?: string }) => ({ id: id ?? "created" }));
    const bindings = bindingsWith({ NOTES_WORKFLOW: { create } });
    const context = createExecutionContext();
    const queued = await worker.fetch(
      request(installed.cookie, "/api/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageId: sourcePage.id, title: "Architecture starter" }),
      }),
      bindings,
      context,
    );
    expect(queued.status).toBe(202);
    const queuedJob = (await queued.json<{ job: Job }>()).job;
    await waitOnExecutionContext(context);
    await env.DB.prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).bind(queuedJob.id).run();
    const row = (await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(queuedJob.id).first<JobRow>())!;
    await runTemplateClone(env, row, {
      async do<T>(_name: string, callback: () => Promise<T>) {
        return callback();
      },
    } as Parameters<typeof runTemplateClone>[2]);

    const completed = await worker.fetch(
      request(installed.cookie, `/api/jobs/${queuedJob.id}`),
      env,
      createExecutionContext(),
    );
    const completedJob = (await completed.json<{ job: Job }>()).job;
    const templateId = completedJob.result!.pageId!;
    expect(completedJob).toMatchObject({ status: "succeeded", result: { pageId: templateId } });
    const template = await env.DB.prepare(`SELECT kind, is_template FROM pages WHERE id = ?`)
      .bind(templateId)
      .first<{ kind: string; is_template: number }>();
    expect(template).toEqual({ kind: "diagram", is_template: 1 });
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
    expect((await content.json<DiagramContentEnvelope>()).nodes).toContainEqual(
      expect.objectContaining({ id: "image-node", assetId: clonedAttachment!.id }),
    );
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
    const bindings = bindingsWith({ NOTES_WORKFLOW: { create } });
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

  it("previews and confirms a Markdown import without exposing staged pages", async () => {
    const installed = await bootstrap();
    const upload = new FormData();
    upload.set("spaceId", `${installed.workspaceId}-general`);
    upload.set(
      "file",
      new File(["# Imported heading\n\nHello **team**.\n\n- [x] Verified\n"], "brief.md", {
        type: "text/markdown",
      }),
    );
    const uploadContext = createExecutionContext();
    const response = await worker.fetch(
      request(installed.cookie, "/api/import-uploads", { method: "POST", body: upload }),
      inlineBindings(),
      uploadContext,
    );
    expect(response.status).toBe(202);
    const queued = (await response.json<{ job: Job }>()).job;
    await waitOnExecutionContext(uploadContext);

    const preview = (
      await (
        await worker.fetch(request(installed.cookie, `/api/jobs/${queued.id}`), env, createExecutionContext())
      ).json<{ job: Job }>()
    ).job;
    expect(preview).toMatchObject({
      status: "awaiting_confirmation",
      result: { preview: { format: "markdown", filename: "brief.md", pages: 1, tables: 0, assets: 0 } },
    });
    const hiddenTree = await worker.fetch(request(installed.cookie, "/api/pages/tree"), env, createExecutionContext());
    expect(
      (await hiddenTree.json<{ pages: Array<{ title: string }> }>()).pages.map((page) => page.title),
    ).not.toContain("brief");

    const confirmContext = createExecutionContext();
    const confirmed = await worker.fetch(
      request(installed.cookie, `/api/imports/${queued.id}/confirm`, { method: "POST" }),
      inlineBindings(),
      confirmContext,
    );
    expect(confirmed.status).toBe(202);
    await waitOnExecutionContext(confirmContext);

    const completed = (
      await (
        await worker.fetch(request(installed.cookie, `/api/jobs/${queued.id}`), env, createExecutionContext())
      ).json<{ job: Job }>()
    ).job;
    expect(completed).toMatchObject({ status: "succeeded", result: { pageId: expect.any(String) } });
    const content = await worker.fetch(
      request(installed.cookie, `/api/pages/${completed.result!.pageId}/content`),
      env,
      createExecutionContext(),
    );
    expect(content.status).toBe(200);
    expect(JSON.stringify((await content.json<{ document: unknown }>()).document)).toContain("Imported heading");
  });

  it("imports a Notion ZIP hierarchy, database CSV, and bundled image", async () => {
    const installed = await bootstrap();
    const encoder = new TextEncoder();
    const zip = createZip([
      {
        path: "Project 0123456789abcdef0123456789abcdef.html",
        bytes: encoder.encode(
          '<article><div class="page-body"><p>Overview</p><img src="Project 0123456789abcdef0123456789abcdef/photo.png"></div></article>',
        ),
      },
      {
        path: "Project 0123456789abcdef0123456789abcdef/Tasks aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.html",
        bytes: encoder.encode('<article><div class="page-body"><p>Database</p></div></article>'),
      },
      {
        path: "Project 0123456789abcdef0123456789abcdef/Tasks aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.csv",
        bytes: encoder.encode("Task,Done,Estimate\nShip,yes,2\n"),
      },
      {
        // Notion ships a view-filtered CSV next to the unfiltered `_all` CSV; only the latter is imported.
        path: "Project 0123456789abcdef0123456789abcdef/Tasks aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_all.csv",
        bytes: encoder.encode("Task,Done,Estimate\nShip,yes,2\nTest,no,3\n"),
      },
      {
        path: "Project 0123456789abcdef0123456789abcdef/photo.png",
        bytes: new Uint8Array([137, 80, 78, 71]),
      },
    ]);
    const upload = new FormData();
    upload.set("spaceId", `${installed.workspaceId}-general`);
    upload.set("file", new File([zip], "notion.zip", { type: "application/zip" }));
    const uploadContext = createExecutionContext();
    const uploaded = await worker.fetch(
      request(installed.cookie, "/api/import-uploads", { method: "POST", body: upload }),
      inlineBindings(),
      uploadContext,
    );
    const jobId = (await uploaded.json<{ job: Job }>()).job.id;
    await waitOnExecutionContext(uploadContext);
    const preview = (
      await (
        await worker.fetch(request(installed.cookie, `/api/jobs/${jobId}`), env, createExecutionContext())
      ).json<{ job: Job }>()
    ).job;
    expect(preview.result?.preview).toMatchObject({ format: "notion_zip", pages: 2, tables: 1, assets: 1 });

    const confirmContext = createExecutionContext();
    await worker.fetch(
      request(installed.cookie, "/api/imports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId }),
      }),
      inlineBindings(),
      confirmContext,
    );
    await waitOnExecutionContext(confirmContext);
    const tree = await worker.fetch(request(installed.cookie, "/api/pages/tree"), env, createExecutionContext());
    const imported = (
      await tree.json<{ pages: Array<{ id: string; parentId: string | null; kind: string; title: string }> }>()
    ).pages;
    const project = imported.find((page) => page.title === "Project")!;
    expect(imported.filter((page) => page.title === "Tasks")).toHaveLength(1);
    const tasks = imported.find((page) => page.title === "Tasks")!;
    expect(tasks).toMatchObject({ parentId: project.id, kind: "table" });
    expect(
      await env.DB.prepare(`SELECT COUNT(*) count FROM table_rows WHERE page_id = ?`).bind(tasks.id).first(),
    ).toMatchObject({ count: 2 });
    expect(
      await env.DB.prepare(`SELECT name FROM attachments WHERE page_id = ?`).bind(project.id).first(),
    ).toMatchObject({ name: "photo.png" });
  });

  it("re-fences staged pages and attachments that survive into an import retry", async () => {
    const installed = await bootstrap();
    const sourcePath = "Project 0123456789abcdef0123456789abcdef";
    const zip = createZip([
      {
        path: `${sourcePath}.html`,
        bytes: new TextEncoder().encode(
          `<article><div class="page-body"><p>Overview</p><img src="${sourcePath}/photo.png"></div></article>`,
        ),
      },
      { path: `${sourcePath}/photo.png`, bytes: new Uint8Array([137, 80, 78, 71]) },
    ]);
    const upload = new FormData();
    upload.set("spaceId", `${installed.workspaceId}-general`);
    upload.set("file", new File([zip], "retry.zip", { type: "application/zip" }));
    const uploadContext = createExecutionContext();
    const response = await worker.fetch(
      request(installed.cookie, "/api/import-uploads", { method: "POST", body: upload }),
      inlineBindings(),
      uploadContext,
    );
    const jobId = (await response.json<{ job: Job }>()).job.id;
    await waitOnExecutionContext(uploadContext);
    const awaiting = (await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<JobRow>())!;
    await env.DB.prepare(`UPDATE jobs SET status = 'running', options_json = ? WHERE id = ?`)
      .bind(JSON.stringify({ ...JSON.parse(awaiting.options_json), confirmed: true }), jobId)
      .run();
    const firstAttempt = (await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<JobRow>())!;

    await expect(
      runImport(env, firstAttempt, {
        async do<T>(name: string, callback: () => Promise<T>) {
          if (name === "write imported content") throw new Error("interrupted after asset upload");
          return callback();
        },
      } as Parameters<typeof runImport>[2]),
    ).rejects.toThrow("interrupted after asset upload");
    const surviving = (await env.DB.prepare(
      `SELECT attachment.r2_key, page.content_epoch
         FROM attachments attachment JOIN pages page ON page.id = attachment.page_id
        WHERE page.import_job_id = ?`,
    )
      .bind(jobId)
      .first<{ r2_key: string; content_epoch: number }>())!;
    expect(surviving).toMatchObject({ content_epoch: 1 });
    expect(surviving.r2_key).toContain("/attempts/1/");

    await env.DB.prepare(`UPDATE jobs SET attempt = 2, progress_current = 0 WHERE id = ?`).bind(jobId).run();
    const retry = (await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<JobRow>())!;
    await runImport(env, retry, {
      async do<T>(_name: string, callback: () => Promise<T>) {
        return callback();
      },
    } as Parameters<typeof runImport>[2]);

    const published = await env.DB.prepare(
      `SELECT attachment.r2_key, page.content_epoch, page.import_job_id
         FROM attachments attachment JOIN pages page ON page.id = attachment.page_id
        WHERE page.workspace_id = ? AND page.title = 'Project'`,
    )
      .bind(installed.workspaceId)
      .first<{ r2_key: string; content_epoch: number; import_job_id: string | null }>();
    expect(published).toMatchObject({ content_epoch: 2, import_job_id: null });
    expect(published?.r2_key).toContain("/attempts/2/");
    expect(await env.BUCKET.get(surviving.r2_key)).toBeNull();
    expect(await env.BUCKET.get(published!.r2_key)).toBeTruthy();
  });
});

describe("delivery outbox", () => {
  it("logs a diagnostic when an outbox row becomes persistently poisoned", async () => {
    const installed = await bootstrap();
    const outboxId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.prepare(
      `INSERT INTO outbox
        (id, workspace_id, topic, payload_json, available_at, attempts, created_at)
       VALUES (?, ?, 'notification', '{}', ?, 9, ?)`,
    )
      .bind(outboxId, installed.workspaceId, timestamp - 1, timestamp - 10_000)
      .run();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await sweepOutbox(
      bindingsWith({ DELIVERY_QUEUE: { send: vi.fn(async () => Promise.reject(new Error("poison"))) } }),
    );

    expect(log).toHaveBeenCalledWith("Outbox row has persistent enqueue failures", {
      outboxId,
      attempts: 10,
      error: "poison",
    });
    expect(await env.DB.prepare(`SELECT attempts, last_error FROM outbox WHERE id = ?`).bind(outboxId).first()).toEqual(
      {
        attempts: 10,
        last_error: "poison",
      },
    );
    log.mockRestore();
  });

  it("keeps retrying an outbox row after ten transient enqueue failures", async () => {
    const installed = await bootstrap();
    const outboxId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.prepare(
      `INSERT INTO outbox
        (id, workspace_id, topic, payload_json, available_at, attempts, last_error, created_at)
       VALUES (?, ?, 'notification', '{}', ?, 10, 'temporary outage', ?)`,
    )
      .bind(outboxId, installed.workspaceId, timestamp - 1, timestamp - 10_000)
      .run();
    const send = vi.fn(async () => undefined);

    await sweepOutbox(bindingsWith({ DELIVERY_QUEUE: { send } }));

    expect(send).toHaveBeenCalledWith({ outboxId });
    expect(
      await env.DB.prepare(`SELECT attempts, enqueued_at, last_error FROM outbox WHERE id = ?`).bind(outboxId).first(),
    ).toMatchObject({ attempts: 11, enqueued_at: expect.any(Number), last_error: null });
  });

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
    const bindings = bindingsWith({ DELIVERY_QUEUE: { send: vi.fn(async (body: unknown) => void sent.push(body)) } });
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
