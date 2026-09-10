import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import * as Y from "yjs";
import { DIAGRAM_EDGES_ROOT, DIAGRAM_META_ROOT, DIAGRAM_NODES_ROOT } from "../shared/diagram";
import { sha256Hex } from "../shared/import-integrity";
import { CLEANUP_JOB_STATUS_SQL } from "../shared/job-state";
import type { ImportPreview, Job, JobStatus, JobType } from "../shared/types";
import type { Env, MemberContext } from "./env";
import { migrateLegacyComments, type CommentPage } from "./comments";
import { HttpError } from "./http";
import { deliverNotification } from "./notifications";
import { pageJson, type PageJsonRow } from "./page-row";
import { deleteR2AttemptArtifactKeys, deleteR2AttemptArtifacts, deleteR2Keys, deleteR2Prefix } from "./r2";
import { refreshPageSearchV2Statements } from "./search-index";
import { broadcastWorkspaceEvent } from "./workspace-events";
import { cleanupExport, runExport } from "./exporter";
import { cleanupImport, runImport } from "./importer";
import { deliverSlackChannelEvent, deliverSlackUnfurl } from "./slack";
import { deliverWebhook, fanoutWebhookEvent } from "./webhooks";

const REINDEX_BATCH_SIZE = 100;
const OUTBOX_SWEEP_BATCH_SIZE = 50;
const OUTBOX_SWEEP_MAX_BATCHES = 5;
const OUTBOX_SWEEP_LEASE_MS = 5 * 60_000;
const OUTBOX_POISON_WARNING_ATTEMPTS = 10;
const OUTBOX_POISON_WARNING_INTERVAL = 24;
const OUTBOX_RETRY_BASE_MS = 10_000;
const OUTBOX_RETRY_MAX_MS = 60 * 60_000;
const JOB_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60_000;
const JOB_CLEANUP_LEASE_MS = 15 * 60_000;
const JOB_CLEANUP_LEASE_RENEW_MS = 60_000;

export type JobWorkflowParams = { jobId: string; attempt?: number };
export type DeliveryQueueMessage = { outboxId: string } | { sweep: true };

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
  cleanup_token: string | null;
  cleanup_started_at: number | null;
  cleanup_target: "failed" | "canceled" | null;
  expires_at: number | null;
  attempt: number;
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
    result:
      typeof result.pageId === "string" || (result.preview && typeof result.preview === "object")
        ? {
            ...(typeof result.pageId === "string" ? { pageId: result.pageId } : {}),
            ...(result.preview && typeof result.preview === "object"
              ? { preview: result.preview as ImportPreview }
              : {}),
          }
        : null,
    error: row.error_code && row.error_message ? { code: row.error_code, message: row.error_message } : null,
    hasDownload: Boolean(row.output_key && (!row.expires_at || row.expires_at > Date.now())),
    cleanupPending: row.cleanup_target !== null,
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
    const direct = ids.get(value);
    if (direct) return direct;
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

function rewriteSnapshotAttachments(
  update: Uint8Array,
  ids: ReadonlyMap<string, string>,
  kind: "document" | "diagram",
) {
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
        else if (value instanceof Y.Text || value instanceof Y.XmlText || value instanceof Y.Array) continue;
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
  if (kind === "document") visit(document.getXmlFragment("document-store"));
  else {
    visit(document.getMap(DIAGRAM_META_ROOT));
    visit(document.getMap(DIAGRAM_NODES_ROOT));
    visit(document.getMap(DIAGRAM_EDGES_ROOT));
  }
  return Y.encodeStateAsUpdate(document);
}

async function templateAttachmentId(jobId: string, sourceId: string) {
  return sha256Hex(`${jobId}:${sourceId}`);
}

async function stageTemplateClone(env: Env, job: JobRow, options: TemplateCloneOptions) {
  await assertJobActive(env, job);
  const existing = await env.DB.prepare(`SELECT * FROM pages WHERE id = ? AND workspace_id = ?`)
    .bind(options.targetPageId, job.workspace_id)
    .first<TemplateSourceRow>();
  if (existing) {
    if (existing.import_job_id === null && existing.created_by === job.requested_by)
      return { published: true, page: existing };
    if (existing.import_job_id !== job.id) throw new Error("The template target id is already in use.");
    if (existing.content_epoch !== job.attempt) {
      // A retry must not reuse the purged document room of the previous attempt.
      const updated = await env.DB.prepare(
        `UPDATE pages SET content_epoch = ? WHERE id = ? AND import_job_id = ?
          AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND attempt = ? AND status = 'running')`,
      )
        .bind(job.attempt, existing.id, job.id, job.id, job.attempt)
        .run();
      if (!updated.meta.changes) {
        await assertJobActive(env, job);
        const current = await env.DB.prepare(`SELECT import_job_id, content_epoch FROM pages WHERE id = ?`)
          .bind(existing.id)
          .first<{ import_job_id: string | null; content_epoch: number }>();
        if (current?.import_job_id !== job.id || current.content_epoch !== job.attempt) {
          throw new Error("The staged template page could not be fenced to this attempt.");
        }
      }
      existing.content_epoch = job.attempt;
    }
    return { published: false, page: existing };
  }
  const source = await env.DB.prepare(
    `SELECT * FROM pages WHERE id = ? AND workspace_id = ? AND space_id = ?
      AND archived_at IS NULL AND import_job_id IS NULL`,
  )
    .bind(options.sourcePageId, job.workspace_id, options.targetSpaceId)
    .first<TemplateSourceRow>();
  if (!source) throw new Error("The template source is no longer available.");
  if (source.kind === "document" || source.kind === "diagram") {
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
         content_epoch, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      job.attempt,
      job.requested_by,
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
  await updateJob(env, job, { current: 1, total: 4, label: "Cloning content" });
  await notifyJobs(env, job.workspace_id);
  return { published: false, page };
}

async function cloneTemplateAttachments(env: Env, job: JobRow, options: TemplateCloneOptions) {
  await assertJobActive(env, job);
  const attachments = await env.DB.prepare(`SELECT * FROM attachments WHERE page_id = ? AND workspace_id = ?`)
    .bind(options.sourcePageId, job.workspace_id)
    .all<TemplateAttachmentRow>();
  const ids = new Map<string, string>();
  for (const attachment of attachments.results) {
    const targetId = await templateAttachmentId(job.id, attachment.id);
    ids.set(attachment.id, targetId);
    const key = `assets/${job.workspace_id}/${targetId}/attempts/${job.attempt}/${attachment.content_sha256 ?? "clone"}`;
    const existing = await env.DB.prepare(`SELECT page_id, r2_key FROM attachments WHERE id = ?`)
      .bind(targetId)
      .first<{ page_id: string; r2_key: string }>();
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
    } else if (existing.page_id !== options.targetPageId) {
      throw new Error("A cloned attachment id is already in use.");
    } else if (existing.r2_key !== key) {
      const object = await env.BUCKET.get(attachment.r2_key);
      if (!object) throw new Error(`Template attachment ${attachment.id} is missing.`);
      await env.BUCKET.put(key, object.body, {
        ...(object.httpMetadata && { httpMetadata: object.httpMetadata }),
        customMetadata: { ...object.customMetadata, attachmentId: targetId },
      });
      const moved = await env.DB.prepare(
        `UPDATE attachments SET r2_key = ? WHERE id = ? AND page_id = ? AND r2_key = ?
          AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND attempt = ? AND status = 'running')`,
      )
        .bind(key, targetId, options.targetPageId, existing.r2_key, job.id, job.attempt)
        .run();
      if (!moved.meta.changes) {
        const replay = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE id = ?`)
          .bind(targetId)
          .first<{ r2_key: string }>();
        if (replay?.r2_key !== key) {
          await env.BUCKET.delete(key);
          throw new Error("The cloned attachment could not be fenced to this attempt.");
        }
      } else {
        await env.BUCKET.delete(existing.r2_key);
      }
    }
  }
  await updateJob(env, job, { current: 2, total: 4, label: "Initializing page" });
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
  if (page.kind === "table") return;
  await assertJobActive(env, job);
  const source = await env.DB.prepare(`SELECT content_epoch FROM pages WHERE id = ? AND workspace_id = ?`)
    .bind(options.sourcePageId, job.workspace_id)
    .first<{ content_epoch: number }>();
  if (!source) throw new Error("The template source is no longer available.");
  const prefix = page.kind === "diagram" ? "diagrams" : "documents";
  const snapshot = await env.BUCKET.get(`${prefix}/${options.sourcePageId}/epochs/${source.content_epoch}/current.bin`);
  const sourceUpdate = snapshot ? new Uint8Array(await snapshot.arrayBuffer()) : Y.encodeStateAsUpdate(new Y.Doc());
  const update = rewriteSnapshotAttachments(sourceUpdate, ids, page.kind);
  const inputKey = `jobs/${job.id}/attempts/${job.attempt}/template-content.bin`;
  await env.BUCKET.put(inputKey, update, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { jobId: job.id, pageId: options.targetPageId },
  });
  await env.DB.prepare(`UPDATE jobs SET input_key = ?, updated_at = ? WHERE id = ? AND attempt = ?`)
    .bind(inputKey, Date.now(), job.id, job.attempt)
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
  await assertJobActive(env, job);
  const timestamp = Date.now();
  const result = JSON.stringify({ warnings: [], pageId: options.targetPageId });
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE pages SET import_job_id = NULL, updated_at = ? WHERE id = ? AND import_job_id = ?
        AND content_epoch = ?
        AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND attempt = ? AND status = 'running')`,
    ).bind(timestamp, options.targetPageId, job.id, job.attempt, job.id, job.attempt),
    env.DB.prepare(`DELETE FROM page_search WHERE page_id = ?`).bind(options.targetPageId),
    env.DB.prepare(
      `INSERT INTO page_search (page_id, workspace_id, title, body)
       SELECT id, workspace_id, title, COALESCE(plain_text, '') FROM pages
        WHERE id = ? AND import_job_id IS NULL AND is_template = 0`,
    ).bind(options.targetPageId),
    ...refreshPageSearchV2Statements(env.DB, options.targetPageId),
    env.DB.prepare(
      `UPDATE jobs SET status = 'succeeded', progress_current = 4, progress_total = 4,
        progress_label = 'Complete', result_json = ?, expires_at = ?, error_code = NULL, error_message = NULL,
        updated_at = ?
       WHERE id = ? AND attempt = ? AND status = 'running'`,
    ).bind(result, timestamp + JOB_ARTIFACT_TTL_MS, timestamp, job.id, job.attempt),
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

export async function cleanupTemplateClone(env: Env, job: JobRow, stillOwned: () => Promise<boolean>) {
  const current = await env.DB.prepare(
    `SELECT 1 active FROM jobs WHERE id = ? AND attempt = ? AND status IN (${CLEANUP_JOB_STATUS_SQL})`,
  )
    .bind(job.id, job.attempt)
    .first();
  if (!current || !(await stillOwned())) return;
  const options = templateCloneOptions(job);
  const staged = await env.DB.prepare(
    `SELECT id, kind, content_epoch FROM pages
      WHERE id = ? AND import_job_id = ? AND content_epoch <= ?`,
  )
    .bind(options.targetPageId, job.id, job.attempt)
    .first<{ id: string; kind: "document" | "table" | "diagram"; content_epoch: number }>();
  const attachments = staged
    ? (
        await env.DB.prepare(`SELECT id, r2_key, content_sha256 FROM attachments WHERE page_id = ?`)
          .bind(options.targetPageId)
          .all<{ id: string; r2_key: string; content_sha256: string | null }>()
      ).results
    : [];
  if (staged?.kind === "document" || staged?.kind === "diagram") {
    if (!(await stillOwned())) return;
    const purged = await env.DOCUMENT.getByName(`${staged.id}~${staged.content_epoch}`).fetch(
      new Request("https://document.internal/purge", {
        method: "POST",
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    );
    if (!(await stillOwned())) return;
    if (!purged.ok) throw new Error("The staged document could not be purged.");
  }
  const keys = [
    ...new Set(
      [job.input_key, `jobs/${job.id}/template-content.bin`, ...attachments.map((row) => row.r2_key)].filter(Boolean),
    ),
  ] as string[];
  if (keys.length) await deleteR2Keys(env.BUCKET, keys, stillOwned);
  if (!(await stillOwned())) return;
  await deleteR2AttemptArtifacts(env.BUCKET, `jobs/${job.id}`, job.attempt, "template-content.bin");
  if (!(await stillOwned())) return;
  await deleteR2AttemptArtifactKeys(
    env.BUCKET,
    attachments.map((attachment) => ({
      rootPrefix: `assets/${job.workspace_id}/${attachment.id}`,
      artifactPath: attachment.content_sha256 ?? "clone",
    })),
    job.attempt,
    stillOwned,
  );
  if (staged && (await stillOwned())) {
    await deleteR2Prefix(env.BUCKET, `documents/${options.targetPageId}/epochs/${staged.content_epoch}/`);
    if (staged.kind === "diagram" && (await stillOwned())) {
      await deleteR2Prefix(env.BUCKET, `diagrams/${options.targetPageId}/epochs/${staged.content_epoch}/`);
    }
  }
  if (staged) {
    if (!(await stillOwned())) return;
    await env.DB.prepare(`DELETE FROM pages WHERE id = ? AND import_job_id = ? AND content_epoch = ?`)
      .bind(options.targetPageId, job.id, staged.content_epoch)
      .run();
  }
  if (!(await stillOwned())) return;
  await env.DB.prepare(`UPDATE jobs SET input_key = NULL, updated_at = ? WHERE id = ? AND attempt = ?`)
    .bind(Date.now(), job.id, job.attempt)
    .run();
}

export async function runTemplateClone(env: Env, job: JobRow, step: Pick<WorkflowStep, "do">) {
  const options = templateCloneOptions(job);
  const staged = await step.do("stage template clone", () => stageTemplateClone(env, job, options));
  if (staged.published) {
    await updateJob(env, job, {
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
    await updateJob(env, job, { current: 3, total: 4, label: "Publishing page" });
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

async function startJobWorkflow(env: Env, job: Pick<JobRow, "id" | "workflow_instance_id" | "attempt">) {
  const instanceId = job.workflow_instance_id ?? job.id;
  try {
    await env.NOTES_WORKFLOW.create({ id: instanceId, params: { jobId: job.id, attempt: job.attempt } });
  } catch (error) {
    // A successful create followed by a lost response is indistinguishable from
    // an existing instance. Its status is authoritative and makes retries safe.
    const status = await env.NOTES_WORKFLOW.get(instanceId)
      .then((instance) => instance.status())
      .catch(() => null);
    if (!status || status.status === "unknown") throw error;
  }
}

export async function startJobExecution(env: Env, job: Pick<JobRow, "id" | "workflow_instance_id" | "attempt">) {
  if (env.WORKFLOW_INLINE !== "true") return startJobWorkflow(env, job);
  const row = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ? AND attempt = ?`)
    .bind(job.id, job.attempt)
    .first<JobRow>();
  if (!row || (row.type !== "template_clone" && row.type !== "export" && row.type !== "import"))
    return startJobWorkflow(env, job);
  const started = await updateJob(env, row, { status: "running", current: 0, label: "Preparing" });
  if (!started.meta.changes) return;
  await notifyJobs(env, row.workspace_id);
  const inlineStep = {
    async do<T>(_name: string, callback: () => Promise<T>) {
      return callback();
    },
  };
  try {
    if (row.type === "template_clone")
      await runTemplateClone(env, row, inlineStep as Parameters<typeof runTemplateClone>[2]);
    else if (row.type === "export") await runExport(env, row, inlineStep as Parameters<typeof runExport>[2]);
    else await runImport(env, row, inlineStep as Parameters<typeof runImport>[2]);
  } catch (error) {
    await failJobWithCleanup(env, row, error instanceof Error ? error.message.slice(0, 500) : "The job failed.");
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

export async function beginJobCancellation(env: Env, job: Pick<JobRow, "id" | "attempt">) {
  return env.DB.prepare(
    `UPDATE jobs SET status = 'canceling', progress_label = 'Canceling', cleanup_target = 'canceled',
       error_code = NULL, error_message = NULL, updated_at = ?
     WHERE id = ? AND attempt = ?
       AND status IN ('queued', 'running', 'awaiting_confirmation', 'canceling')
     RETURNING *`,
  )
    .bind(Date.now(), job.id, job.attempt)
    .first<JobRow>();
}

function cleanupLeaseGuard(env: Env, job: Pick<JobRow, "id" | "attempt">, token: string, claimedAt: number) {
  let refreshAfter = claimedAt + JOB_CLEANUP_LEASE_RENEW_MS;
  return async () => {
    const timestamp = Date.now();
    if (timestamp < refreshAfter) return true;
    const renewed = await env.DB.prepare(
      `UPDATE jobs SET cleanup_started_at = ?, updated_at = ?
        WHERE id = ? AND attempt = ? AND cleanup_token = ?
          AND cleanup_target IS NOT NULL AND status IN (${CLEANUP_JOB_STATUS_SQL})`,
    )
      .bind(timestamp, timestamp, job.id, job.attempt, token)
      .run();
    if (renewed.meta.changes) refreshAfter = timestamp + JOB_CLEANUP_LEASE_RENEW_MS;
    return Boolean(renewed.meta.changes);
  };
}

function workflowErrorHasCode(error: unknown, code: string) {
  const messageHasCode = (message: string) => {
    let normalized = message.trim();
    // RPC boundaries can prepend Error class names. Strip only those wrappers;
    // the workflow code must still begin the remaining message.
    for (let depth = 0; depth < 4; depth += 1) {
      const wrapper = normalized.match(/^(?:[A-Za-z_$][\w.$]*Error|Error):\s*/)?.[0];
      if (!wrapper) break;
      normalized = normalized.slice(wrapper.length).trimStart();
    }
    const prefix = `(${code})`;
    return normalized === code || normalized === prefix || normalized.startsWith(`${prefix} `);
  };
  if (typeof error === "string") return messageHasCode(error);
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === code || (typeof value.message === "string" && messageHasCode(value.message));
}

function workflowInstanceMissing(error: unknown) {
  if (workflowErrorHasCode(error, "instance.not_found")) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; status?: unknown };
  return value.code === 404 || value.status === 404;
}

/**
 * Finishes staged-resource cleanup under an attempt-scoped lease. The terminal
 * state remains unavailable to retry until cleanup succeeds.
 */
export async function finishPendingJobCleanup(
  env: Env,
  identity: Pick<JobRow, "id" | "attempt">,
  options: { terminateWorkflow?: boolean } = {},
) {
  const token = crypto.randomUUID();
  const timestamp = Date.now();
  const job = await env.DB.prepare(
    `UPDATE jobs SET cleanup_token = ?, cleanup_started_at = ?, updated_at = ?
      WHERE id = ? AND attempt = ? AND cleanup_target IS NOT NULL
        AND status IN (${CLEANUP_JOB_STATUS_SQL})
        AND (cleanup_token IS NULL OR cleanup_started_at IS NULL OR cleanup_started_at <= ?)
      RETURNING *`,
  )
    .bind(token, timestamp, timestamp, identity.id, identity.attempt, timestamp - JOB_CLEANUP_LEASE_MS)
    .first<JobRow>();
  if (!job) return false;

  const stillOwned = cleanupLeaseGuard(env, identity, token, timestamp);
  try {
    if (options.terminateWorkflow !== false && job.workflow_instance_id && env.WORKFLOW_INLINE !== "true") {
      let terminating = false;
      try {
        const instance = await env.NOTES_WORKFLOW.get(job.workflow_instance_id);
        const status = await instance.status();
        if (["queued", "running", "paused", "waiting", "waitingForPause"].includes(status.status)) {
          terminating = true;
          await instance.terminate();
        }
      } catch (error) {
        if (
          !workflowInstanceMissing(error) &&
          !(terminating && workflowErrorHasCode(error, "instance.cannot_terminate"))
        )
          throw error;
      }
    }
    if (!(await stillOwned())) return false;
    if (job.type === "import") await cleanupImport(env, job, stillOwned);
    if (job.type === "template_clone") await cleanupTemplateClone(env, job, stillOwned);
    if (job.type === "export") await cleanupExport(env, job, stillOwned);
    if (!(await stillOwned())) return false;
    const completedAt = Date.now();
    const finished = await env.DB.prepare(
      `UPDATE jobs SET
         status = cleanup_target,
         progress_label = CASE cleanup_target WHEN 'canceled' THEN 'Canceled' ELSE 'Failed' END,
         error_code = CASE cleanup_target WHEN 'canceled' THEN NULL ELSE error_code END,
         error_message = CASE cleanup_target WHEN 'canceled' THEN NULL ELSE error_message END,
         cleanup_token = NULL, cleanup_started_at = NULL, cleanup_target = NULL, updated_at = ?
       WHERE id = ? AND attempt = ? AND cleanup_token = ? AND cleanup_target IS NOT NULL
         AND status IN (${CLEANUP_JOB_STATUS_SQL})`,
    )
      .bind(completedAt, job.id, job.attempt, token)
      .run();
    if (finished.meta.changes) await notifyJobs(env, job.workspace_id);
    return Boolean(finished.meta.changes);
  } catch (error) {
    // Keep the job non-retryable while cleanup is incomplete. The scheduled
    // recovery pass can claim it again.
    await env.DB.prepare(
      `UPDATE jobs SET
         status = CASE cleanup_target WHEN 'canceled' THEN 'canceling' ELSE 'failed' END,
         progress_label = CASE cleanup_target WHEN 'canceled' THEN 'Cleanup pending' ELSE 'Failure cleanup pending' END,
         cleanup_token = NULL, cleanup_started_at = NULL, updated_at = ?
       WHERE id = ? AND attempt = ? AND cleanup_token = ?`,
    )
      .bind(Date.now(), job.id, job.attempt, token)
      .run();
    await notifyJobs(env, job.workspace_id);
    throw error;
  }
}

async function failJobWithCleanup(env: Env, job: JobRow, message: string) {
  if (job.type !== "import" && job.type !== "template_clone" && job.type !== "export") {
    await updateJob(env, job, {
      status: "failed",
      label: "Failed",
      errorCode: "job_failed",
      errorMessage: message,
    });
    await notifyJobs(env, job.workspace_id);
    return;
  }
  const pending = await env.DB.prepare(
    `UPDATE jobs SET status = 'failed', cleanup_target = COALESCE(cleanup_target, 'failed'),
       progress_label = 'Failure cleanup pending', error_code = 'job_failed', error_message = ?, updated_at = ?
     WHERE id = ? AND attempt = ? AND status = 'running'`,
  )
    .bind(message, Date.now(), job.id, job.attempt)
    .run();
  if (!pending.meta.changes) return;
  await notifyJobs(env, job.workspace_id);
  await finishPendingJobCleanup(env, job, { terminateWorkflow: false }).catch((cleanupError) => {
    console.error("Failed to clean up failed job", { jobId: job.id, cleanupError });
  });
}

async function updateJob(
  env: Env,
  job: Pick<JobRow, "id" | "attempt">,
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
  const expectedStatus =
    fields.status === "running" ? "queued" : fields.status === "canceled" ? "canceling" : "running";
  return env.DB.prepare(
    `UPDATE jobs SET
       status = COALESCE(?, status),
       progress_current = COALESCE(?, progress_current),
       progress_total = COALESCE(?, progress_total),
       progress_label = COALESCE(?, progress_label),
       error_code = ?, error_message = ?,
       result_json = COALESCE(?, result_json), updated_at = ?
     WHERE id = ? AND attempt = ? AND status = ?`,
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
      job.id,
      job.attempt,
      expectedStatus,
    )
    .run();
}

async function assertJobActive(env: Env, job: Pick<JobRow, "id" | "attempt">) {
  const row = await env.DB.prepare(`SELECT status FROM jobs WHERE id = ? AND attempt = ?`)
    .bind(job.id, job.attempt)
    .first<{ status: JobStatus }>();
  if (!row || row.status !== "running")
    throw new Error(row?.status === "canceling" || row?.status === "canceled" ? "Job canceled." : "Job is not active.");
}

async function reindexPageBatch(env: Env, workspaceId: string, afterId: string) {
  const pages = await env.DB.prepare(
    `SELECT id FROM pages WHERE workspace_id = ?
      AND import_job_id IS NULL AND is_template = 0 AND id > ? ORDER BY id LIMIT ?`,
  )
    .bind(workspaceId, afterId, REINDEX_BATCH_SIZE)
    .all<{ id: string }>();
  if (!pages.results.length) return { lastId: afterId, count: 0 };
  const statements: D1PreparedStatement[] = [];
  for (const page of pages.results) {
    statements.push(...refreshPageSearchV2Statements(env.DB, page.id));
  }
  await env.DB.batch(statements);
  return { lastId: pages.results.at(-1)!.id, count: pages.results.length };
}

async function migrateCommentPageBatch(env: Env, workspaceId: string, afterId: string) {
  const pages = await env.DB.prepare(
    `SELECT p.id, p.workspace_id, p.space_id, p.content_epoch, p.created_by
       FROM pages p LEFT JOIN comment_migrations migration ON migration.page_id = p.id
      WHERE p.workspace_id = ? AND p.kind = 'document' AND p.import_job_id IS NULL
        AND migration.page_id IS NULL AND p.id > ? ORDER BY p.id LIMIT ?`,
  )
    .bind(workspaceId, afterId, REINDEX_BATCH_SIZE)
    .all<Omit<CommentPage, "effective_role">>();
  for (const page of pages.results) {
    await migrateLegacyComments(env, { ...page, effective_role: "owner" });
  }
  return { lastId: pages.results.at(-1)?.id ?? afterId, count: pages.results.length };
}

export async function runCommentMigration(env: Env, job: JobRow, step: Pick<WorkflowStep, "do">) {
  const total = await step.do("count legacy comment pages", async () => {
    await assertJobActive(env, job);
    const count = await env.DB.prepare(
      `SELECT COUNT(*) count FROM pages p
        LEFT JOIN comment_migrations migration ON migration.page_id = p.id
       WHERE p.workspace_id = ? AND p.kind = 'document' AND p.import_job_id IS NULL
         AND migration.page_id IS NULL`,
    )
      .bind(job.workspace_id)
      .first<{ count: number }>();
    await updateJob(env, job, { total: count?.count ?? 0, label: "Migrating comments" });
    await notifyJobs(env, job.workspace_id);
    return count?.count ?? 0;
  });
  let migrated = 0;
  let afterId = "";
  for (let batchIndex = 0; migrated < total; batchIndex += 1) {
    const result = await step.do(`migrate comment batch ${batchIndex + 1}`, async () => {
      await assertJobActive(env, job);
      const batch = await migrateCommentPageBatch(env, job.workspace_id, afterId);
      const nextCount = migrated + batch.count;
      await updateJob(env, job, { current: nextCount, total, label: "Migrating comments" });
      await notifyJobs(env, job.workspace_id);
      return batch;
    });
    if (!result.count) break;
    migrated += result.count;
    afterId = result.lastId;
  }
  await step.do("complete comment migration", async () => {
    await assertJobActive(env, job);
    await updateJob(env, job, {
      status: "succeeded",
      current: migrated,
      total,
      label: "Complete",
      resultJson: JSON.stringify({ warnings: [] }),
    });
    await notifyJobs(env, job.workspace_id);
  });
}

export async function resolveJobWorkflowAttempt(
  env: Env,
  event: Pick<WorkflowEvent<JobWorkflowParams>, "payload" | "instanceId">,
) {
  if (Number.isInteger(event.payload.attempt) && event.payload.attempt! > 0) return event.payload.attempt!;
  const legacy = await env.DB.prepare(`SELECT attempt FROM jobs WHERE id = ? AND workflow_instance_id = ?`)
    .bind(event.payload.jobId, event.instanceId)
    .first<{ attempt: number }>();
  return legacy?.attempt ?? null;
}

export async function claimJobWorkflowRun(
  env: Env,
  event: Pick<WorkflowEvent<JobWorkflowParams>, "payload" | "instanceId">,
  attempt: number,
) {
  const row = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ? AND attempt = ?`)
    .bind(event.payload.jobId, attempt)
    .first<JobRow>();
  if (!row || row.cleanup_target || (row.workflow_instance_id ?? row.id) !== event.instanceId) return null;
  if (row.status === "running") return row;
  if (row.status !== "queued") return null;
  const started = await updateJob(env, row, { status: "running", current: 0, label: "Preparing" });
  if (started.meta.changes) {
    await notifyJobs(env, row.workspace_id);
    return { ...row, status: "running" as const, progress_current: 0, progress_label: "Preparing" };
  }
  const current = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ? AND attempt = ?`)
    .bind(event.payload.jobId, attempt)
    .first<JobRow>();
  return current &&
    current.status === "running" &&
    !current.cleanup_target &&
    (current.workflow_instance_id ?? current.id) === event.instanceId
    ? current
    : null;
}

export class NotesJobWorkflow extends WorkflowEntrypoint<Env, JobWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<JobWorkflowParams>>, step: WorkflowStep) {
    const { jobId } = event.payload;
    const attempt =
      event.payload.attempt ??
      (await step.do("resolve legacy job attempt", async () => {
        return resolveJobWorkflowAttempt(this.env, event);
      }));
    // A missing row means this is an obsolete legacy workflow instance. It must
    // not attach itself to whichever attempt happens to be current now.
    if (attempt === null) return;
    const identity = { id: jobId, attempt };
    try {
      const job = await step.do("load job", async () => claimJobWorkflowRun(this.env, event, attempt));
      if (!job) return;
      if (job.type === "template_clone") {
        await runTemplateClone(this.env, job, step);
        return;
      }
      if (job.type === "comment_migration") {
        await runCommentMigration(this.env, job, step);
        return;
      }
      if (job.type === "export") {
        await runExport(this.env, job, step);
        return;
      }
      if (job.type === "import") {
        await runImport(this.env, job, step);
        return;
      }
      const total = await step.do("count pages", async () => {
        await assertJobActive(this.env, identity);
        const count = await this.env.DB.prepare(
          `SELECT COUNT(*) count FROM pages WHERE workspace_id = ?
            AND import_job_id IS NULL AND is_template = 0`,
        )
          .bind(job.workspace_id)
          .first<{ count: number }>();
        await updateJob(this.env, identity, { total: count?.count ?? 0, label: "Reindexing pages" });
        await notifyJobs(this.env, job.workspace_id);
        return count?.count ?? 0;
      });
      let indexed = 0;
      let afterId = "";
      for (let batchIndex = 0; indexed < total; batchIndex += 1) {
        const result = await step.do(`reindex batch ${batchIndex + 1}`, async () => {
          await assertJobActive(this.env, identity);
          const batch = await reindexPageBatch(this.env, job.workspace_id, afterId);
          const nextCount = indexed + batch.count;
          await updateJob(this.env, identity, { current: nextCount, total, label: "Reindexing pages" });
          await notifyJobs(this.env, job.workspace_id);
          return batch;
        });
        if (!result.count) break;
        indexed += result.count;
        afterId = result.lastId;
      }
      await step.do("complete job", async () => {
        await assertJobActive(this.env, identity);
        await updateJob(this.env, identity, {
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
      const current = await this.env.DB.prepare(`SELECT * FROM jobs WHERE id = ? AND attempt = ?`)
        .bind(jobId, attempt)
        .first<JobRow>();
      // A superseded workflow belongs to an older attempt and must not clean up or
      // report failure against the replacement attempt.
      if (!current) return;
      if (current?.status === "canceling" || current?.status === "canceled") {
        if (current.status === "canceling")
          await finishPendingJobCleanup(this.env, current, { terminateWorkflow: false });
        return;
      }
      if (current.status !== "running") return;
      await failJobWithCleanup(this.env, current, message);
      throw error;
    }
  }
}

export async function recoverQueuedJobs(env: Env) {
  const cutoff = Date.now() - 30_000;
  const queued = await env.DB.prepare(
    `SELECT id, workflow_instance_id, attempt FROM jobs
      WHERE status = 'queued' AND updated_at <= ? ORDER BY updated_at LIMIT 25`,
  )
    .bind(cutoff)
    .all<Pick<JobRow, "id" | "workflow_instance_id" | "attempt">>();
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
  const cleanups = await env.DB.prepare(
    `SELECT id, attempt FROM jobs WHERE cleanup_target IS NOT NULL
      AND status IN (${CLEANUP_JOB_STATUS_SQL}) AND updated_at <= ? ORDER BY updated_at LIMIT 25`,
  )
    .bind(cutoff)
    .all<Pick<JobRow, "id" | "attempt">>();
  for (const job of cleanups.results) {
    try {
      await finishPendingJobCleanup(env, job);
    } catch (error) {
      console.error("Pending job cleanup failed", { jobId: job.id, error });
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
    const failed = await env.DB.prepare(
      `UPDATE outbox SET attempts = attempts + 1, last_error = ?,
         available_at = ? + MIN(?, ? * (1 << MIN(attempts, 8)))
        WHERE id = ? RETURNING attempts, last_error`,
    )
      .bind(
        error instanceof Error ? error.message.slice(0, 500) : "Queue enqueue failed.",
        Date.now(),
        OUTBOX_RETRY_MAX_MS,
        OUTBOX_RETRY_BASE_MS,
        outboxId,
      )
      .first<{ attempts: number; last_error: string | null }>();
    if (
      failed &&
      (failed.attempts === OUTBOX_POISON_WARNING_ATTEMPTS || failed.attempts % OUTBOX_POISON_WARNING_INTERVAL === 0)
    ) {
      console.error("Outbox row has persistent enqueue failures", {
        outboxId,
        attempts: failed.attempts,
        error: failed.last_error,
      });
    }
    throw error;
  }
}

export async function sweepOutbox(env: Env, continuation = false) {
  const claimedAt = Date.now();
  const claimToken = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE outbox_sweep_state
        SET lease_token = ?, lease_until = ?,
            continuation_pending = CASE WHEN ? = 1 THEN 0 ELSE continuation_pending END,
            updated_at = ?
      WHERE id = 1 AND lease_until <= ?
      RETURNING continuation_pending`,
  )
    .bind(claimToken, claimedAt + OUTBOX_SWEEP_LEASE_MS, continuation ? 1 : 0, claimedAt, claimedAt)
    .first<{ continuation_pending: number }>();
  if (!claimed) return false;

  try {
    for (let batch = 0; batch < OUTBOX_SWEEP_MAX_BATCHES; batch += 1) {
      const rows = await env.DB.prepare(
        `SELECT id FROM outbox WHERE enqueued_at IS NULL AND available_at <= ?
          ORDER BY available_at, created_at, id LIMIT ?`,
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
      if (rows.results.length < OUTBOX_SWEEP_BATCH_SIZE) return true;
    }
    const remaining = await env.DB.prepare(
      `SELECT 1 pending FROM outbox WHERE enqueued_at IS NULL AND available_at <= ? LIMIT 1`,
    )
      .bind(Date.now())
      .first<{ pending: number }>();
    if (!remaining) return true;
    console.warn("Outbox sweep cap reached; scheduling continuation", {
      maxRows: OUTBOX_SWEEP_BATCH_SIZE * OUTBOX_SWEEP_MAX_BATCHES,
    });
    if (!claimed.continuation_pending) {
      try {
        await env.DELIVERY_QUEUE.send({ sweep: true });
        await env.DB.prepare(
          `UPDATE outbox_sweep_state SET continuation_pending = 1, updated_at = ?
            WHERE id = 1 AND lease_token = ?`,
        )
          .bind(Date.now(), claimToken)
          .run();
      } catch (error) {
        console.error("Outbox sweep continuation enqueue failed", { error });
      }
    }
    return true;
  } finally {
    await env.DB.prepare(
      `UPDATE outbox_sweep_state SET lease_token = NULL, lease_until = 0, updated_at = ?
        WHERE id = 1 AND lease_token = ?`,
    )
      .bind(Date.now(), claimToken)
      .run();
  }
}

export async function consumeDeliveryMessage(env: Env, message: Message<DeliveryQueueMessage>) {
  if (message.body && "sweep" in message.body && message.body.sweep) {
    if (await sweepOutbox(env, true)) message.ack();
    else message.retry({ delaySeconds: 1 });
    return;
  }
  const outboxId = message.body && "outboxId" in message.body ? message.body.outboxId : undefined;
  if (typeof outboxId !== "string") {
    message.ack();
    return;
  }
  const row = await env.DB.prepare(`SELECT id, topic, payload_json, available_at FROM outbox WHERE id = ?`)
    .bind(outboxId)
    .first<{ id: string; topic: string; payload_json: string; available_at: number }>();
  if (!row) {
    message.ack();
    return;
  }
  if (row.available_at > Date.now()) {
    message.retry({
      delaySeconds: Math.min(12 * 60 * 60, Math.max(1, Math.ceil((row.available_at - Date.now()) / 1000))),
    });
    return;
  }
  const payload = jsonRecord(row.payload_json);
  // A payload that fails validation will never become valid, so record it and ack
  // instead of retrying. An unknown topic still throws: a rolling deploy can leave an
  // older consumer reading a topic a newer one writes, and that does resolve on retry.
  const rejectPayload = async (reason: string) => {
    await env.DB.prepare(`UPDATE outbox SET last_error = ? WHERE id = ?`).bind(reason, outboxId).run();
    message.ack();
  };
  if (row.topic === "notification") {
    const notificationId = payload.notificationId;
    if (typeof notificationId !== "string") return await rejectPayload("Notification outbox payload is invalid.");
    await deliverNotification(env, notificationId, outboxId);
  } else if (row.topic === "slack_channel") {
    const eventId = payload.eventId;
    if (typeof eventId !== "string") return await rejectPayload("Slack channel outbox payload is invalid.");
    await deliverSlackChannelEvent(env, eventId);
  } else if (row.topic === "slack_unfurl") {
    const unfurlId = payload.unfurlId;
    if (typeof unfurlId !== "string") return await rejectPayload("Slack unfurl outbox payload is invalid.");
    await deliverSlackUnfurl(env, unfurlId, outboxId);
  } else if (row.topic === "webhook_event") {
    const eventId = payload.eventId;
    if (typeof eventId !== "string") return await rejectPayload("Webhook event outbox payload is invalid.");
    await fanoutWebhookEvent(env, eventId);
    await sweepOutbox(env);
  } else if (row.topic === "webhook_delivery") {
    const deliveryId = payload.deliveryId;
    if (typeof deliveryId !== "string") return await rejectPayload("Webhook delivery outbox payload is invalid.");
    await deliverWebhook(env, deliveryId);
  } else throw new Error(`Unsupported outbox topic: ${row.topic}`);
  message.ack();
}

export async function expireJobArtifacts(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT id, type, input_key, output_key, attempt FROM jobs WHERE expires_at IS NOT NULL AND expires_at <= ?
      AND (input_key IS NOT NULL OR output_key IS NOT NULL) LIMIT 50`,
  )
    .bind(Date.now())
    .all<Pick<JobRow, "id" | "type" | "input_key" | "output_key" | "attempt">>();
  for (const row of rows.results) {
    const keys = [...new Set([row.input_key, row.output_key].filter((key): key is string => Boolean(key)))];
    if (keys.length) await env.BUCKET.delete(keys);
    if (row.type === "import") {
      await deleteR2AttemptArtifacts(env.BUCKET, `jobs/${row.id}`, row.attempt, "documents/");
      await deleteR2Prefix(env.BUCKET, `jobs/${row.id}/documents/`);
    }
    if (row.type === "export") await deleteR2AttemptArtifacts(env.BUCKET, `jobs/${row.id}`, row.attempt, "output/");
    await env.DB.prepare(`UPDATE jobs SET input_key = NULL, output_key = NULL, updated_at = ? WHERE id = ?`)
      .bind(Date.now(), row.id)
      .run();
  }
}
