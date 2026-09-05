import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import * as Y from "yjs";
import { sha256Hex } from "../shared/import-integrity";
import type { Job, JobStatus, JobType } from "../shared/types";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import { pageJson, type PageJsonRow } from "./page-row";
import { broadcastWorkspaceEvent } from "./workspace-events";

const REINDEX_BATCH_SIZE = 100;
const OUTBOX_SWEEP_BATCH_SIZE = 50;
const JOB_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60_000;

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
    result: typeof result.pageId === "string" ? { pageId: result.pageId } : null,
    error: row.error_code && row.error_message ? { code: row.error_code, message: row.error_message } : null,
    hasDownload: Boolean(row.output_key && (!row.expires_at || row.expires_at > Date.now())),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type TemplateCloneOptions = {
  sourcePageId: string;
  targetPageId: string;
  targetSpaceId: string;
  parentId: string | null;
  title: string;
  isTemplate: boolean;
};

type TemplateSourceRow = PageJsonRow & {
  import_job_id: string | null;
  created_by: string;
};

type TemplateAttachmentRow = {
  id: string;
  workspace_id: string;
  r2_key: string;
  name: string;
  mime: string;
  size: number;
  content_sha256: string | null;
};

function templateCloneOptions(row: JobRow): TemplateCloneOptions {
  const options = jsonRecord(row.options_json);
  const required = ["sourcePageId", "targetPageId", "targetSpaceId", "title"] as const;
  if (required.some((field) => typeof options[field] !== "string" || !options[field])) {
    throw new Error("Template clone options are invalid.");
  }
  if (options.parentId !== null && typeof options.parentId !== "string") {
    throw new Error("Template clone parent is invalid.");
  }
  if (typeof options.isTemplate !== "boolean") throw new Error("Template clone kind is invalid.");
  return options as TemplateCloneOptions;
}

function replaceAttachmentReferences(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    let rewritten = value;
    for (const [sourceId, targetId] of ids) {
      rewritten = rewritten.replaceAll(`/api/attachments/${sourceId}`, `/api/attachments/${targetId}`);
    }
    return rewritten;
  }
  if (Array.isArray(value)) return value.map((item) => replaceAttachmentReferences(item, ids));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceAttachmentReferences(item, ids)]),
    );
  }
  return value;
}

function rewriteSnapshotAttachments(update: Uint8Array, ids: ReadonlyMap<string, string>) {
  const document = new Y.Doc();
  Y.applyUpdate(document, update);
  const visit = (type: Y.XmlFragment | Y.XmlElement | Y.Map<unknown>) => {
    if (type instanceof Y.XmlElement) {
      for (const [name, value] of Object.entries(type.getAttributes())) {
        const rewritten = replaceAttachmentReferences(value, ids);
        if (rewritten !== value) type.setAttribute(name, rewritten as string);
      }
    }
    if (type instanceof Y.Map) {
      for (const [name, value] of type.entries()) {
        if (value instanceof Y.Map || value instanceof Y.XmlFragment || value instanceof Y.XmlElement) visit(value);
        else {
          const rewritten = replaceAttachmentReferences(value, ids);
          if (rewritten !== value) type.set(name, rewritten);
        }
      }
    }
    if (type instanceof Y.XmlFragment || type instanceof Y.XmlElement) {
      for (const child of type.toArray()) {
        if (child instanceof Y.Map || child instanceof Y.XmlFragment || child instanceof Y.XmlElement) visit(child);
      }
    }
  };
  visit(document.getXmlFragment("document-store"));
  return Y.encodeStateAsUpdate(document);
}

async function templateAttachmentId(jobId: string, sourceId: string) {
  return sha256Hex(`${jobId}:${sourceId}`);
}

async function stageTemplateClone(env: Env, job: JobRow, options: TemplateCloneOptions) {
  await assertJobActive(env, job.id);
  const existing = await env.DB.prepare(`SELECT * FROM pages WHERE id = ? AND workspace_id = ?`)
    .bind(options.targetPageId, job.workspace_id)
    .first<TemplateSourceRow>();
  if (existing) {
    if (existing.import_job_id === null && existing.created_by === job.requested_by)
      return { published: true, page: existing };
    if (existing.import_job_id !== job.id) throw new Error("The template target id is already in use.");
    return { published: false, page: existing };
  }
  const source = await env.DB.prepare(
    `SELECT * FROM pages WHERE id = ? AND workspace_id = ? AND space_id = ?
      AND archived_at IS NULL AND import_job_id IS NULL`,
  )
    .bind(options.sourcePageId, job.workspace_id, options.targetSpaceId)
    .first<TemplateSourceRow>();
  if (!source) throw new Error("The template source is no longer available.");
  if (source.kind === "document") {
    const response = await env.DOCUMENT.getByName(`${source.id}~${source.content_epoch}`).fetch(
      new Request("https://document.internal/content", {
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    );
    if (!response.ok) throw new Error("The template content could not be flushed.");
  }
  const parent = options.parentId
    ? await env.DB.prepare(
        `SELECT id FROM pages WHERE id = ? AND workspace_id = ? AND space_id = ?
          AND archived_at IS NULL AND import_job_id IS NULL AND is_template = 0`,
      )
        .bind(options.parentId, job.workspace_id, options.targetSpaceId)
        .first<{ id: string }>()
    : null;
  if (options.parentId && !parent) throw new Error("The template destination is no longer available.");
  const last = await env.DB.prepare(
    `SELECT position FROM pages WHERE space_id = ? AND parent_id IS ? AND archived_at IS NULL
      AND import_job_id IS NULL AND is_template = ? ORDER BY position DESC, id DESC LIMIT 1`,
  )
    .bind(options.targetSpaceId, options.parentId, options.isTemplate ? 1 : 0)
    .first<{ position: string }>();
  const timestamp = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO pages
        (id, workspace_id, space_id, parent_id, kind, position, title, icon, is_template, import_job_id,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      options.targetPageId,
      job.workspace_id,
      options.targetSpaceId,
      options.parentId,
      source.kind,
      generateJitteredKeyBetween(last?.position ?? null, null),
      options.title,
      source.icon,
      options.isTemplate ? 1 : 0,
      job.id,
      job.requested_by,
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO subscriptions
        (id, workspace_id, user_id, resource_type, resource_id, created_by, created_at)
       VALUES (?, ?, ?, 'page', ?, ?, ?)
       ON CONFLICT(user_id, resource_type, resource_id) DO UPDATE SET muted_at = NULL`,
    ).bind(
      `page:${options.targetPageId}:${job.requested_by}`,
      job.workspace_id,
      job.requested_by,
      options.targetPageId,
      job.requested_by,
      timestamp,
    ),
  ]);
  if (source.kind === "table") {
    const target = options.targetPageId;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO table_state (page_id, revision) SELECT ?, revision FROM table_state WHERE page_id = ?`,
      ).bind(target, source.id),
      env.DB.prepare(
        `INSERT INTO table_columns (id, page_id, name, type, position)
         SELECT ? || ':column:' || id, ?, name, type, position FROM table_columns WHERE page_id = ?`,
      ).bind(target, target, source.id),
      env.DB.prepare(
        `INSERT INTO table_select_options (id, column_id, label, position)
         SELECT ? || ':option:' || option.id, ? || ':column:' || option.column_id, option.label, option.position
           FROM table_select_options option JOIN table_columns column ON column.id = option.column_id
          WHERE column.page_id = ?`,
      ).bind(target, target, source.id),
      env.DB.prepare(
        `INSERT INTO table_rows (id, page_id, position, created_by, created_at, updated_at)
         SELECT ? || ':row:' || id, ?, position, ?, ?, ? FROM table_rows WHERE page_id = ?`,
      ).bind(target, target, job.requested_by, timestamp, timestamp, source.id),
      env.DB.prepare(
        `INSERT INTO table_cells
          (row_id, column_id, text_value, number_value, boolean_value, date_value, select_value, updated_at)
         SELECT ? || ':row:' || cell.row_id, ? || ':column:' || cell.column_id,
                cell.text_value, cell.number_value, cell.boolean_value, cell.date_value,
                CASE WHEN cell.select_value IS NULL THEN NULL ELSE ? || ':option:' || cell.select_value END, ?
           FROM table_cells cell JOIN table_rows row ON row.id = cell.row_id WHERE row.page_id = ?`,
      ).bind(target, target, target, timestamp, source.id),
    ]);
  }
  const page = await env.DB.prepare(`SELECT * FROM pages WHERE id = ?`)
    .bind(options.targetPageId)
    .first<TemplateSourceRow>();
  if (!page) throw new Error("The staged template page was not created.");
  await updateJob(env, job.id, { current: 1, total: 4, label: "Cloning content" });
  await notifyJobs(env, job.workspace_id);
  return { published: false, page };
}

async function cloneTemplateAttachments(env: Env, job: JobRow, options: TemplateCloneOptions) {
  await assertJobActive(env, job.id);
  const attachments = await env.DB.prepare(`SELECT * FROM attachments WHERE page_id = ? AND workspace_id = ?`)
    .bind(options.sourcePageId, job.workspace_id)
    .all<TemplateAttachmentRow>();
  const ids = new Map<string, string>();
  for (const attachment of attachments.results) {
    const targetId = await templateAttachmentId(job.id, attachment.id);
    ids.set(attachment.id, targetId);
    const key = `assets/${job.workspace_id}/${targetId}/${attachment.content_sha256 ?? "clone"}`;
    const existing = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE id = ?`)
      .bind(targetId)
      .first<{ r2_key: string }>();
    if (!existing) {
      const object = await env.BUCKET.get(attachment.r2_key);
      if (!object) throw new Error(`Template attachment ${attachment.id} is missing.`);
      await env.BUCKET.put(key, object.body, {
        ...(object.httpMetadata && { httpMetadata: object.httpMetadata }),
        customMetadata: { ...object.customMetadata, attachmentId: targetId },
      });
      await env.DB.prepare(
        `INSERT INTO attachments
          (id, workspace_id, page_id, r2_key, name, mime, size, content_sha256, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          targetId,
          job.workspace_id,
          options.targetPageId,
          key,
          attachment.name,
          attachment.mime,
          attachment.size,
          attachment.content_sha256,
          job.requested_by,
          Date.now(),
        )
        .run();
    } else if (existing.r2_key !== key) {
      throw new Error("A cloned attachment id is already in use.");
    }
  }
  await updateJob(env, job.id, { current: 2, total: 4, label: "Initializing page" });
  await notifyJobs(env, job.workspace_id);
  return ids;
}

async function initializeTemplateDocument(
  env: Env,
  job: JobRow,
  options: TemplateCloneOptions,
  page: TemplateSourceRow,
  ids: ReadonlyMap<string, string>,
) {
  if (page.kind !== "document") return;
  await assertJobActive(env, job.id);
  const source = await env.DB.prepare(`SELECT content_epoch FROM pages WHERE id = ? AND workspace_id = ?`)
    .bind(options.sourcePageId, job.workspace_id)
    .first<{ content_epoch: number }>();
  if (!source) throw new Error("The template source is no longer available.");
  const snapshot = await env.BUCKET.get(`documents/${options.sourcePageId}/epochs/${source.content_epoch}/current.bin`);
  const sourceUpdate = snapshot ? new Uint8Array(await snapshot.arrayBuffer()) : Y.encodeStateAsUpdate(new Y.Doc());
  const update = rewriteSnapshotAttachments(sourceUpdate, ids);
  const inputKey = `jobs/${job.id}/template-content.bin`;
  await env.BUCKET.put(inputKey, update, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { jobId: job.id, pageId: options.targetPageId },
  });
  await env.DB.prepare(`UPDATE jobs SET input_key = ?, updated_at = ? WHERE id = ?`)
    .bind(inputKey, Date.now(), job.id)
    .run();
  const response = await env.DOCUMENT.getByName(`${options.targetPageId}~${page.content_epoch}`).fetch(
    new Request("https://document.internal/initialize", {
      method: "POST",
      headers: { "content-type": "application/json", "x-notes-internal": env.BETTER_AUTH_SECRET },
      body: JSON.stringify({ jobId: job.id, inputKey }),
    }),
  );
  if (!response.ok) throw new Error(`The staged document could not be initialized (${response.status}).`);
}

async function publishTemplateClone(env: Env, job: JobRow, options: TemplateCloneOptions) {
  await assertJobActive(env, job.id);
  const timestamp = Date.now();
  const result = JSON.stringify({ warnings: [], pageId: options.targetPageId });
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE pages SET import_job_id = NULL, updated_at = ? WHERE id = ? AND import_job_id = ?
        AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status = 'running')`,
    ).bind(timestamp, options.targetPageId, job.id, job.id),
    env.DB.prepare(`DELETE FROM page_search WHERE page_id = ?`).bind(options.targetPageId),
    env.DB.prepare(
      `INSERT INTO page_search (page_id, workspace_id, title, body)
       SELECT id, workspace_id, title, COALESCE(plain_text, '') FROM pages
        WHERE id = ? AND import_job_id IS NULL AND is_template = 0`,
    ).bind(options.targetPageId),
    env.DB.prepare(`DELETE FROM page_search_v2 WHERE page_id = ?`).bind(options.targetPageId),
    env.DB.prepare(
      `INSERT INTO page_search_v2
        (page_id, workspace_id, space_id, title, tags, body, comments, attachments)
       SELECT p.id, p.workspace_id, p.space_id, p.title, '', COALESCE(p.plain_text, ''), '',
              COALESCE((SELECT group_concat(a.name, ' ') FROM attachments a WHERE a.page_id = p.id), '')
         FROM pages p WHERE p.id = ? AND p.import_job_id IS NULL AND p.is_template = 0`,
    ).bind(options.targetPageId),
    env.DB.prepare(
      `UPDATE jobs SET status = 'succeeded', progress_current = 4, progress_total = 4,
        progress_label = 'Complete', result_json = ?, expires_at = ?, error_code = NULL, error_message = NULL,
        updated_at = ?
       WHERE id = ? AND status = 'running'`,
    ).bind(result, timestamp + JOB_ARTIFACT_TTL_MS, timestamp, job.id),
  ]);
  const page = await env.DB.prepare(`SELECT * FROM pages WHERE id = ? AND import_job_id IS NULL`)
    .bind(options.targetPageId)
    .first<PageJsonRow>();
  if (!page) throw new Error("The cloned page could not be published.");
  await notifyJobs(env, job.workspace_id);
  if (options.isTemplate) {
    await broadcastWorkspaceEvent(env, job.workspace_id, { type: "organization-invalidated" });
  } else {
    await broadcastWorkspaceEvent(env, job.workspace_id, { type: "pages-upserted", pages: [pageJson(page)] });
  }
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function cleanupTemplateClone(env: Env, job: JobRow, options: TemplateCloneOptions) {
  const staged = await env.DB.prepare(`SELECT id, kind, content_epoch FROM pages WHERE id = ? AND import_job_id = ?`)
    .bind(options.targetPageId, job.id)
    .first<{ id: string; kind: "document" | "table"; content_epoch: number }>();
  if (!staged) return;
  const attachments = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE page_id = ?`)
    .bind(options.targetPageId)
    .all<{ r2_key: string }>();
  if (staged.kind === "document") {
    const purged = await env.DOCUMENT.getByName(`${staged.id}~${staged.content_epoch}`).fetch(
      new Request("https://document.internal/purge", {
        method: "POST",
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    );
    if (!purged.ok) throw new Error("The staged document could not be purged.");
  }
  await env.DB.prepare(`DELETE FROM pages WHERE id = ? AND import_job_id = ?`).bind(options.targetPageId, job.id).run();
  const keys = [
    ...new Set(
      [job.input_key, `jobs/${job.id}/template-content.bin`, ...attachments.results.map((row) => row.r2_key)].filter(
        Boolean,
      ),
    ),
  ] as string[];
  if (keys.length) await env.BUCKET.delete(keys);
  await deleteR2Prefix(env.BUCKET, `documents/${options.targetPageId}/`);
  await env.DB.prepare(`UPDATE jobs SET input_key = NULL, updated_at = ? WHERE id = ?`).bind(Date.now(), job.id).run();
}

export async function runTemplateClone(env: Env, job: JobRow, step: Pick<WorkflowStep, "do">) {
  const options = templateCloneOptions(job);
  const staged = await step.do("stage template clone", () => stageTemplateClone(env, job, options));
  if (staged.published) {
    await updateJob(env, job.id, {
      status: "succeeded",
      current: 4,
      total: 4,
      label: "Complete",
      resultJson: JSON.stringify({ warnings: [], pageId: options.targetPageId }),
    });
    await notifyJobs(env, job.workspace_id);
    return;
  }
  const attachmentEntries = await step.do("clone template attachments", async () => [
    ...(await cloneTemplateAttachments(env, job, options)).entries(),
  ]);
  await step.do("initialize template content", async () => {
    await initializeTemplateDocument(env, job, options, staged.page, new Map(attachmentEntries));
    await updateJob(env, job.id, { current: 3, total: 4, label: "Publishing page" });
    await notifyJobs(env, job.workspace_id);
  });
  await step.do("publish template clone", () => publishTemplateClone(env, job, options));
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

async function startJobWorkflow(env: Env, job: Pick<JobRow, "id" | "workflow_instance_id">) {
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

export async function startJobExecution(env: Env, job: Pick<JobRow, "id" | "workflow_instance_id">) {
  if (env.WORKFLOW_INLINE !== "true") return startJobWorkflow(env, job);
  const row = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(job.id).first<JobRow>();
  if (!row || row.type !== "template_clone") return startJobWorkflow(env, job);
  await updateJob(env, row.id, { status: "running", current: 0, label: "Preparing" });
  await notifyJobs(env, row.workspace_id);
  const inlineStep = {
    async do<T>(_name: string, callback: () => Promise<T>) {
      return callback();
    },
  };
  try {
    await runTemplateClone(env, row, inlineStep as Parameters<typeof runTemplateClone>[2]);
  } catch (error) {
    await cleanupTemplateClone(env, row, templateCloneOptions(row)).catch((cleanupError) => {
      console.error("Failed to clean up inline template clone", { jobId: row.id, cleanupError });
    });
    await updateJob(env, row.id, {
      status: "failed",
      label: "Failed",
      errorCode: "job_failed",
      errorMessage: error instanceof Error ? error.message.slice(0, 500) : "The job failed.",
    });
    await notifyJobs(env, row.workspace_id);
    throw error;
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
    `SELECT id FROM pages WHERE workspace_id = ? AND archived_at IS NULL
      AND import_job_id IS NULL AND is_template = 0 AND id > ? ORDER BY id LIMIT ?`,
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
           FROM pages p WHERE p.id = ? AND p.archived_at IS NULL
             AND p.import_job_id IS NULL AND p.is_template = 0`,
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
        return row;
      });
      if (job.type === "template_clone") {
        await runTemplateClone(this.env, job, step);
        return;
      }
      if (job.type !== "search_reindex") {
        throw new Error(`The ${job.type} executor is not registered yet.`);
      }
      const total = await step.do("count pages", async () => {
        await assertJobActive(this.env, jobId);
        const count = await this.env.DB.prepare(
          `SELECT COUNT(*) count FROM pages WHERE workspace_id = ? AND archived_at IS NULL
            AND import_job_id IS NULL AND is_template = 0`,
        )
          .bind(job.workspace_id)
          .first<{ count: number }>();
        await updateJob(this.env, jobId, { total: count?.count ?? 0, label: "Reindexing pages" });
        await notifyJobs(this.env, job.workspace_id);
        return count?.count ?? 0;
      });
      let indexed = 0;
      let afterId = "";
      for (let batchIndex = 0; indexed < total; batchIndex += 1) {
        const result = await step.do(`reindex batch ${batchIndex + 1}`, async () => {
          await assertJobActive(this.env, jobId);
          const batch = await reindexPageBatch(this.env, job.workspace_id, afterId);
          const nextCount = indexed + batch.count;
          await updateJob(this.env, jobId, { current: nextCount, total, label: "Reindexing pages" });
          await notifyJobs(this.env, job.workspace_id);
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
        await notifyJobs(this.env, job.workspace_id);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "The job failed.";
      const current = await this.env.DB.prepare(`SELECT status FROM jobs WHERE id = ?`)
        .bind(jobId)
        .first<{ status: JobStatus }>();
      if (current?.status === "canceling" || current?.status === "canceled") {
        const canceledJob = await this.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<JobRow>();
        if (canceledJob?.type === "template_clone") {
          await cleanupTemplateClone(this.env, canceledJob, templateCloneOptions(canceledJob)).catch((cleanupError) => {
            console.error("Failed to clean up canceled template clone", { jobId, cleanupError });
          });
        }
        await updateJob(this.env, jobId, { status: "canceled", label: "Canceled" });
        return;
      }
      const failedJob = await this.env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<JobRow>();
      if (failedJob?.type === "template_clone") {
        await cleanupTemplateClone(this.env, failedJob, templateCloneOptions(failedJob)).catch((cleanupError) => {
          console.error("Failed to clean up failed template clone", { jobId, cleanupError });
        });
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
      await startJobExecution(env, job);
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
