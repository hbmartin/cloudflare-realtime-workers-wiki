import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Job, JobStatus, JobType } from "../shared/types";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import { broadcastWorkspaceEvent } from "./workspace-events";

const REINDEX_BATCH_SIZE = 100;
const OUTBOX_SWEEP_BATCH_SIZE = 50;

export type JobWorkflowParams = { jobId: string };
export type DeliveryQueueMessage = { outboxId: string };

export type JobRow = {
  id: string;
  workspace_id: string;
  space_id: string | null;
  type: JobType;
  status: JobStatus;
  requested_by: string;
  workflow_instance_id: string | null;
  input_key: string | null;
  output_key: string | null;
  progress_current: number;
  progress_total: number;
  progress_label: string;
  options_json: string;
  result_json: string;
  error_code: string | null;
  error_message: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

function jsonRecord(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function jobJson(row: JobRow): Job {
  const result = jsonRecord(row.result_json);
  const warnings = Array.isArray(result.warnings)
    ? result.warnings.filter((warning): warning is string => typeof warning === "string").slice(0, 50)
    : [];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    spaceId: row.space_id,
    type: row.type,
    status: row.status,
    progress: {
      current: row.progress_current,
      total: row.progress_total,
      label: row.progress_label,
    },
    warnings,
    error: row.error_code && row.error_message ? { code: row.error_code, message: row.error_message } : null,
    hasDownload: Boolean(row.output_key && (!row.expires_at || row.expires_at > Date.now())),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function jobForMember(env: Env, member: MemberContext, jobId: string) {
  const row = await env.DB.prepare(
    `SELECT j.* FROM jobs j
      LEFT JOIN spaces s ON s.id = j.space_id
      LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
     WHERE j.id = ? AND j.workspace_id = ? AND j.requested_by = ?
       AND (j.space_id IS NULL OR ? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)`,
  )
    .bind(member.user.id, jobId, member.workspace.id, member.user.id, member.role)
    .first<JobRow>();
  if (!row) throw new HttpError(404, "job_not_found", "Job not found.");
  return row;
}

export async function createJob(
  env: Env,
  input: {
    member: MemberContext;
    type: JobType;
    spaceId?: string | null;
    inputKey?: string | null;
    options?: Record<string, unknown>;
  },
) {
  const id = crypto.randomUUID();
  const timestamp = Date.now();
  await env.DB.prepare(
    `INSERT INTO jobs
      (id, workspace_id, space_id, type, status, requested_by, workflow_instance_id, input_key,
       options_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.member.workspace.id,
      input.spaceId ?? null,
      input.type,
      input.member.user.id,
      id,
      input.inputKey ?? null,
      JSON.stringify(input.options ?? {}),
      timestamp,
      timestamp,
    )
    .run();
  return (await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(id).first<JobRow>())!;
}

export async function startJobWorkflow(env: Env, job: Pick<JobRow, "id" | "workflow_instance_id">) {
  const instanceId = job.workflow_instance_id ?? job.id;
  try {
    await env.NOTES_WORKFLOW.create({ id: instanceId, params: { jobId: job.id } });
  } catch (error) {
    // A successful create followed by a lost response is indistinguishable from
    // an existing instance. Its status is authoritative and makes retries safe.
    const status = await env.NOTES_WORKFLOW.get(instanceId)
      .then((instance) => instance.status())
      .catch(() => null);
    if (!status || status.status === "unknown") throw error;
  }
}

async function notifyJobs(env: Env, workspaceId: string) {
  try {
    await broadcastWorkspaceEvent(env, workspaceId, { type: "jobs-invalidated" });
  } catch (error) {
    console.error("Failed to broadcast job progress", { workspaceId, error });
  }
}

async function updateJob(
  env: Env,
  jobId: string,
  fields: {
    status?: JobStatus;
    current?: number;
    total?: number;
    label?: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    resultJson?: string;
  },
) {
  await env.DB.prepare(
    `UPDATE jobs SET
       status = COALESCE(?, status),
       progress_current = COALESCE(?, progress_current),
       progress_total = COALESCE(?, progress_total),
       progress_label = COALESCE(?, progress_label),
       error_code = ?, error_message = ?,
       result_json = COALESCE(?, result_json), updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      fields.status ?? null,
      fields.current ?? null,
      fields.total ?? null,
      fields.label ?? null,
      fields.errorCode ?? null,
      fields.errorMessage ?? null,
      fields.resultJson ?? null,
      Date.now(),
      jobId,
    )
    .run();
}

async function assertJobActive(env: Env, jobId: string) {
  const row = await env.DB.prepare(`SELECT status FROM jobs WHERE id = ?`).bind(jobId).first<{ status: JobStatus }>();
  if (!row || row.status === "canceling" || row.status === "canceled") {
    throw new Error("Job canceled.");
  }
}

async function reindexPageBatch(env: Env, workspaceId: string, afterId: string) {
  const pages = await env.DB.prepare(
    `SELECT id FROM pages WHERE workspace_id = ? AND archived_at IS NULL AND id > ? ORDER BY id LIMIT ?`,
  )
    .bind(workspaceId, afterId, REINDEX_BATCH_SIZE)
    .all<{ id: string }>();
  if (!pages.results.length) return { lastId: afterId, count: 0 };
  const statements: D1PreparedStatement[] = [];
  for (const page of pages.results) {
    statements.push(
      env.DB.prepare(`DELETE FROM page_search_v2 WHERE page_id = ?`).bind(page.id),
      env.DB.prepare(
        `INSERT INTO page_search_v2
          (page_id, workspace_id, space_id, title, tags, body, comments, attachments)
         SELECT p.id, p.workspace_id, p.space_id, p.title,
                COALESCE((SELECT group_concat(t.name, ' ') FROM page_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.page_id = p.id), ''),
                COALESCE(p.plain_text, ''),
                COALESCE((SELECT group_concat(c.plain_text, ' ') FROM comment_threads ct JOIN comments c ON c.thread_id = ct.id WHERE ct.page_id = p.id AND c.deleted_at IS NULL), ''),
                COALESCE((SELECT group_concat(a.name, ' ') FROM attachments a WHERE a.page_id = p.id), '')
           FROM pages p WHERE p.id = ? AND p.archived_at IS NULL`,
      ).bind(page.id),
    );
  }
  await env.DB.batch(statements);
  return { lastId: pages.results.at(-1)!.id, count: pages.results.length };
}

export class NotesJobWorkflow extends WorkflowEntrypoint<Env, JobWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<JobWorkflowParams>>, step: WorkflowStep) {
    const { jobId } = event.payload;
    try {
      const job = await step.do("load job", async () => {
        const row = await this.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<JobRow>();
        if (!row) throw new Error("Job not found.");
        await updateJob(this.env, jobId, { status: "running", current: 0, label: "Preparing" });
        await notifyJobs(this.env, row.workspace_id);
        return { type: row.type, workspaceId: row.workspace_id };
      });
      if (job.type !== "search_reindex") {
        throw new Error(`The ${job.type} executor is not registered yet.`);
      }
      const total = await step.do("count pages", async () => {
        await assertJobActive(this.env, jobId);
        const count = await this.env.DB.prepare(
          `SELECT COUNT(*) count FROM pages WHERE workspace_id = ? AND archived_at IS NULL`,
        )
          .bind(job.workspaceId)
          .first<{ count: number }>();
        await updateJob(this.env, jobId, { total: count?.count ?? 0, label: "Reindexing pages" });
        await notifyJobs(this.env, job.workspaceId);
        return count?.count ?? 0;
      });
      let indexed = 0;
      let afterId = "";
      for (let batchIndex = 0; indexed < total; batchIndex += 1) {
        const result = await step.do(`reindex batch ${batchIndex + 1}`, async () => {
          await assertJobActive(this.env, jobId);
          const batch = await reindexPageBatch(this.env, job.workspaceId, afterId);
          const nextCount = indexed + batch.count;
          await updateJob(this.env, jobId, { current: nextCount, total, label: "Reindexing pages" });
          await notifyJobs(this.env, job.workspaceId);
          return batch;
        });
        if (!result.count) break;
        indexed += result.count;
        afterId = result.lastId;
      }
      await step.do("complete job", async () => {
        await assertJobActive(this.env, jobId);
        await updateJob(this.env, jobId, {
          status: "succeeded",
          current: indexed,
          total,
          label: "Complete",
          resultJson: JSON.stringify({ warnings: [] }),
        });
        await notifyJobs(this.env, job.workspaceId);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "The job failed.";
      const current = await this.env.DB.prepare(`SELECT status FROM jobs WHERE id = ?`)
        .bind(jobId)
        .first<{ status: JobStatus }>();
      if (current?.status === "canceling" || current?.status === "canceled") {
        await updateJob(this.env, jobId, { status: "canceled", label: "Canceled" });
        return;
      }
      await updateJob(this.env, jobId, {
        status: "failed",
        label: "Failed",
        errorCode: "job_failed",
        errorMessage: message,
      });
      const failed = await this.env.DB.prepare(`SELECT workspace_id FROM jobs WHERE id = ?`)
        .bind(jobId)
        .first<{ workspace_id: string }>();
      if (failed) await notifyJobs(this.env, failed.workspace_id);
      throw error;
    }
  }
}

export async function recoverQueuedJobs(env: Env) {
  const queued = await env.DB.prepare(
    `SELECT id, workflow_instance_id FROM jobs
      WHERE status = 'queued' AND updated_at <= ? ORDER BY updated_at LIMIT 25`,
  )
    .bind(Date.now() - 30_000)
    .all<Pick<JobRow, "id" | "workflow_instance_id">>();
  for (const job of queued.results) {
    try {
      await startJobWorkflow(env, job);
    } catch (error) {
      await env.DB.prepare(
        `UPDATE jobs SET error_code = 'workflow_start_failed', error_message = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(error instanceof Error ? error.message.slice(0, 500) : "Workflow start failed.", Date.now(), job.id)
        .run();
    }
  }
}

async function enqueueOutbox(env: Env, outboxId: string) {
  try {
    await env.DELIVERY_QUEUE.send({ outboxId });
    await env.DB.prepare(`UPDATE outbox SET enqueued_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?`)
      .bind(Date.now(), outboxId)
      .run();
  } catch (error) {
    await env.DB.prepare(`UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?`)
      .bind(error instanceof Error ? error.message.slice(0, 500) : "Queue enqueue failed.", outboxId)
      .run();
    throw error;
  }
}

export async function sweepOutbox(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT id FROM outbox WHERE enqueued_at IS NULL AND available_at <= ? ORDER BY created_at LIMIT ?`,
  )
    .bind(Date.now(), OUTBOX_SWEEP_BATCH_SIZE)
    .all<{ id: string }>();
  for (const row of rows.results) {
    try {
      await enqueueOutbox(env, row.id);
    } catch (error) {
      console.error("Outbox enqueue failed", { outboxId: row.id, error });
    }
  }
}

export async function consumeDeliveryMessage(env: Env, message: Message<DeliveryQueueMessage>) {
  const outboxId = message.body?.outboxId;
  if (typeof outboxId !== "string") {
    message.ack();
    return;
  }
  const row = await env.DB.prepare(`SELECT id, topic, payload_json FROM outbox WHERE id = ?`)
    .bind(outboxId)
    .first<{ id: string; topic: string; payload_json: string }>();
  if (!row) {
    message.ack();
    return;
  }
  if (row.topic !== "notification") {
    throw new Error(`Unsupported outbox topic: ${row.topic}`);
  }
  const payload = jsonRecord(row.payload_json);
  const notificationId = payload.notificationId;
  if (typeof notificationId !== "string") throw new Error("Notification outbox payload is invalid.");
  const ledgerKey = `${outboxId}:in_app`;
  const timestamp = Date.now();
  await env.DB.prepare(
    `INSERT INTO deliveries (idempotency_key, outbox_id, channel, status, delivered_at, updated_at)
     VALUES (?, ?, 'in_app', 'sent', ?, ?)
     ON CONFLICT(idempotency_key) DO UPDATE SET status = 'sent', delivered_at = COALESCE(deliveries.delivered_at, excluded.updated_at), updated_at = excluded.updated_at`,
  )
    .bind(ledgerKey, outboxId, timestamp, timestamp)
    .run();
  message.ack();
}

export async function expireJobArtifacts(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT id, input_key, output_key FROM jobs WHERE expires_at IS NOT NULL AND expires_at <= ?
      AND (input_key IS NOT NULL OR output_key IS NOT NULL) LIMIT 50`,
  )
    .bind(Date.now())
    .all<Pick<JobRow, "id" | "input_key" | "output_key">>();
  for (const row of rows.results) {
    const keys = [...new Set([row.input_key, row.output_key].filter((key): key is string => Boolean(key)))];
    if (keys.length) await env.BUCKET.delete(keys);
    await env.DB.prepare(`UPDATE jobs SET input_key = NULL, output_key = NULL, updated_at = ? WHERE id = ?`)
      .bind(Date.now(), row.id)
      .run();
  }
}
