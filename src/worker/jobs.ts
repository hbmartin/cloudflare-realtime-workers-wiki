import { outboxEnqueueRetryAt, reportPersistentEnqueueFailure } from "./outbox-retry";
import { deliverBulkSummary } from "./slack-bulk";
import { deliverRound2ChannelEvent } from "./slack-channel-events";
import { enqueueRound2Outbox, redriveRound2Outbox, round2DeliveryStatus, round2Receipts } from "./slack-recovery";
import { deliverDigest } from "./slack-digests";
import { deliverShareRefresh } from "./slack-shares";
import { deliverThumbnail } from "./slack-files";
import { StaleSlackValidationError } from "./slack-channels";
import { thumbnailDeliveryEnabled } from "./slack-delivery";
import { ROUND2_OUTBOX_SQL, slackScopeRequirements, SLACK_OUTBOX_CHANNEL_TYPE_SQL } from "./slack-delivery-contracts";
import { deliverSlackProductCopy } from "./slack-product";
import {
  captureFeedbackStatement,
  deliverSlackCaptureFeedback,
  failCaptureForJobStatement,
  isSlackCaptureId,
  prepareSlackCapture,
} from "./slack-capture";
import {
  retireUncertainSlackDelivery,
  deliverSlackThread,
  deliverSlackMutation,
  deliverSlackDenial,
  wakeNextSlackDelivery,
} from "./slack-threads";
import { deliverSlackWorkspaceAction, deliverSlackSearchUpdate, deliverSlackShareResponse } from "./slack-workspace";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import * as Y from "yjs";
import { DIAGRAM_EDGES_ROOT, DIAGRAM_META_ROOT, DIAGRAM_NODES_ROOT } from "../shared/diagram";
import { boundedLogString, prefixedErrorLogFields, PERSISTED_ERROR_MESSAGE_LIMIT } from "../shared/error-log";
import { sha256Hex } from "../shared/import-integrity";
import { CLEANUP_JOB_STATUS_SQL } from "../shared/job-state";
import type { ImportPreview, Job, JobStatus, JobType } from "../shared/types";
import type { Env, MemberContext } from "./env";
import { migrateLegacyComments, type CommentPage } from "./comments";
import { HttpError, safeHttpError } from "./http";
import { DeliveryInProgressError, deliverNotification } from "./notifications";
import { pageJson, type PageJsonRow } from "./page-row";
import { deleteR2AttemptArtifactKeys, deleteR2AttemptArtifacts, deleteR2Keys, deleteR2Prefix } from "./r2";
import { refreshPageSearchV2Statements } from "./search-index";
import { broadcastWorkspaceEvent } from "./workspace-events";
import { cleanupExport, runExport } from "./exporter";
import { cleanupImport, runImport } from "./importer";
import {
  deliverSlackChannelEvent,
  deliverSlackControlsExpiry,
  deliverSlackUnfurl,
  SlackApiError,
  slackMissingScope,
  slackInstallationError,
  SLACK_REDRIVE_STALE_MS,
} from "./slack";
import { deliverSlackHome } from "./slack-workspace";
import { deliverWebhook, fanoutWebhookEvent } from "./webhooks";
import {
  correlationHeaders,
  currentObservabilityContext,
  logger,
  safeTelemetryErrorMessage,
  traced,
  withObservabilityContext,
} from "./observability";

const REINDEX_BATCH_SIZE = 100;
const OUTBOX_SWEEP_BATCH_SIZE = 50;
const OUTBOX_SWEEP_MAX_BATCHES = 5;
const OUTBOX_SWEEP_LEASE_MS = 5 * 60_000;
const OUTBOX_SWEEP_CLAIM_ATTEMPTS = 2;
const SLACK_REDRIVE_BASE_MS = 15 * 60_000;
const SLACK_REDRIVE_MAX_MS = 6 * 60 * 60_000;
const SLACK_BLOCKED_RECHECK_MS = 5 * 60_000;
const JOB_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60_000;
const JOB_CLEANUP_LEASE_MS = 15 * 60_000;
const JOB_CLEANUP_LEASE_RENEW_MS = 60_000;
const QUEUED_JOB_RECOVERY_DELAY_MS = 30_000;
const ACTIVE_WORKFLOW_STATUSES = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);
const UNDETERMINED_WORKFLOW_STATUS = "unknown";

export type JobWorkflowParams = { jobId: string; attempt?: number; correlationId?: string };
export type DeliveryQueueMessage =
  | { outboxId: string; correlationId?: string }
  | { sweep: true; correlationId?: string };
export type DeliveryMessageOutcome = "acknowledged" | "retried" | "discarded";
export type OutboxSweepResult = "completed" | "contended" | "lease-lost";

function deliveryQueueIdentifier(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : undefined;
}

export function deliveryQueueMessageBody(value: unknown): DeliveryQueueMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const body = value as Record<string, unknown>;
    const correlationId = deliveryQueueIdentifier(body.correlationId);
    if (body.sweep === true) return { sweep: true, ...(correlationId ? { correlationId } : {}) };
    const outboxId = deliveryQueueIdentifier(body.outboxId);
    if (outboxId) {
      return { outboxId, ...(correlationId ? { correlationId } : {}) };
    }
  } catch {
    return null;
  }
  return null;
}

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
  correlation_id: string | null;
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
  const options = row.type === "import" ? jsonRecord(row.options_json) : {};
  const warnings = Array.isArray(result.warnings)
    ? result.warnings.filter((warning): warning is string => typeof warning === "string").slice(0, 50)
    : [];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    spaceId: row.space_id,
    ...(typeof options.parentId === "string" && typeof options.captureId !== "string"
      ? { importParentId: options.parentId }
      : {}),
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
    if (existing.import_job_id !== job.id)
      throw new HttpError(409, "job_failed", "The template target id is already in use.");
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
  if (!source) throw new HttpError(409, "job_failed", "The template source is no longer available.");
  if (source.kind === "document" || source.kind === "diagram") {
    const response = await env.DOCUMENT.getByName(`${source.id}~${source.content_epoch}`).fetch(
      new Request("https://document.internal/content", {
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, ...correlationHeaders() },
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
  if (options.parentId && !parent)
    throw new HttpError(409, "job_failed", "The template destination is no longer available.");
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
        `INSERT INTO table_select_options (id, column_id, label, label_search_value, position)
         SELECT ? || ':option:' || option.id, ? || ':column:' || option.column_id,
                option.label, option.label_search_value, option.position
           FROM table_select_options option JOIN table_columns column ON column.id = option.column_id
          WHERE column.page_id = ?`,
      ).bind(target, target, source.id),
      env.DB.prepare(
        `INSERT INTO table_rows (id, page_id, position, created_by, created_at, updated_at)
         SELECT ? || ':row:' || id, ?, position, ?, ?, ? FROM table_rows WHERE page_id = ?`,
      ).bind(target, target, job.requested_by, timestamp, timestamp, source.id),
      env.DB.prepare(
        `INSERT INTO table_cells
          (row_id, column_id, text_value, text_search_value, number_value, boolean_value, date_value, select_value, updated_at)
         SELECT ? || ':row:' || cell.row_id, ? || ':column:' || cell.column_id,
                cell.text_value, cell.text_search_value, cell.number_value, cell.boolean_value, cell.date_value,
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
      if (!object) throw new HttpError(409, "job_failed", `Template attachment ${attachment.id} is missing.`);
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
      if (!object) throw new HttpError(409, "job_failed", `Template attachment ${attachment.id} is missing.`);
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
  if (!source) throw new HttpError(409, "job_failed", "The template source is no longer available.");
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
      headers: {
        "content-type": "application/json",
        "x-notes-internal": env.BETTER_AUTH_SECRET,
        ...correlationHeaders(),
      },
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
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, ...correlationHeaders() },
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
  const correlationId =
    currentObservabilityContext()?.correlationId ?? currentObservabilityContext()?.requestId ?? null;
  await env.DB.prepare(
    `INSERT INTO jobs
      (id, workspace_id, space_id, type, status, requested_by, workflow_instance_id, input_key,
       options_json, created_at, updated_at, correlation_id)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
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
      correlationId,
    )
    .run();
  return (await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(id).first<JobRow>())!;
}

async function startJobWorkflow(
  env: Env,
  job: Pick<JobRow, "id" | "workflow_instance_id" | "attempt"> & Partial<Pick<JobRow, "correlation_id">>,
  allowRotation = true,
) {
  const instanceId = job.workflow_instance_id ?? job.id;
  try {
    await env.NOTES_WORKFLOW.create({
      id: instanceId,
      params: {
        jobId: job.id,
        attempt: job.attempt,
        ...(job.correlation_id ? { correlationId: job.correlation_id } : {}),
      },
    });
  } catch (error) {
    // A successful create followed by a lost response is indistinguishable from
    // an existing instance. Its status is authoritative and makes retries safe.
    const status = await env.NOTES_WORKFLOW.get(instanceId)
      .then((instance) => instance.status())
      .catch(() => null);
    if (!status || status.status === "unknown") throw error;
    if (["complete", "errored", "terminated"].includes(status.status)) {
      if (!allowRotation) throw error;
      const replacement = crypto.randomUUID();
      const changed = await env.DB.prepare(
        `UPDATE jobs SET workflow_instance_id=?,updated_at=?
         WHERE id=? AND attempt=? AND status='queued' AND COALESCE(workflow_instance_id,id)=?
         RETURNING id, workspace_id, workflow_instance_id, attempt, correlation_id`,
      )
        .bind(replacement, Date.now(), job.id, job.attempt, instanceId)
        .first<JobRow>();
      if (changed) {
        await notifyJobs(env, changed.workspace_id);
        await startJobWorkflow(env, changed, false);
      }
    }
  }
}

export async function startJobExecution(
  env: Env,
  job: Pick<JobRow, "id" | "workflow_instance_id" | "attempt"> & Partial<Pick<JobRow, "correlation_id">>,
) {
  // An unlinked receipt must be re-staged before creating a Workflow instance.
  if (isSlackCaptureId(job.id) && (await hasUnlinkedCapture(env, job.id))) return;
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
    const current = await env.DB.prepare(
      `SELECT * FROM jobs WHERE id=? AND attempt>=? AND COALESCE(workflow_instance_id,id)=?`,
    )
      .bind(row.id, row.attempt, row.workflow_instance_id ?? row.id)
      .first<JobRow>();
    if (current?.status === "running") {
      const recovery = await shouldRequeueCapture(env, current, error);
      if (recovery) {
        await replaceCaptureWorkflow(env, current, "running", recovery === "lookup_failed");
        return;
      }
      await failJobWithCleanup(env, current, error);
    }
    throw error;
  }
}

const UNLINKED_CAPTURE_SQL = `EXISTS (SELECT 1 FROM slack_captures capture
  WHERE capture.id=jobs.id AND capture.workspace_id=jobs.workspace_id
    AND capture.requested_by=jobs.requested_by
    AND capture.state='pending' AND capture.job_id IS NULL)`;

async function hasUnlinkedCapture(env: Env, jobId: string) {
  return Boolean(await env.DB.prepare(`SELECT 1 FROM jobs WHERE id=? AND ${UNLINKED_CAPTURE_SQL}`).bind(jobId).first());
}

function isCaptureImportJob(job: JobRow) {
  return job.type === "import" && jsonRecord(job.options_json).captureId === job.id;
}

async function shouldRequeueCapture(env: Env, job: JobRow, error: unknown) {
  if (safeHttpError(error)?.code === "slack_capture_link_pending") return true;
  if (!isCaptureImportJob(job)) return false;
  // Older Workflow step results can surface a wrapped error without the
  // original HttpError code. The receipt state is authoritative in that case.
  try {
    return await hasUnlinkedCapture(env, job.id);
  } catch (lookupError) {
    try {
      const unlinked = await hasUnlinkedCapture(env, job.id);
      logger.warn(
        "workflow.capture_lookup.retried",
        "workflow",
        "Capture receipt lookup recovered on retry.",
        { jobId: job.id, attempt: job.attempt },
        lookupError,
      );
      return unlinked;
    } catch (retryError) {
      logger.error(
        "workflow.capture_import.unresolved",
        "workflow",
        "Capture import failed while receipt lookup was unavailable.",
        {
          jobId: job.id,
          attempt: job.attempt,
          ...prefixedErrorLogFields("firstLookup", lookupError),
          ...prefixedErrorLogFields("retryLookup", retryError),
        },
        error,
      );
      // The scheduled pass will retry when D1 can answer authoritatively.
    }
    // Defer recovery until D1 can distinguish an unlinked receipt from a real
    // import failure. Neither outcome is safe to assume during an outage.
    return "lookup_failed" as const;
  }
}

async function replaceCaptureWorkflow(
  env: Env,
  job: JobRow,
  expectedStatus: "running" | "queued",
  deferForLookup = false,
) {
  const instanceId = crypto.randomUUID();
  const returned = await env.DB.prepare(
    `UPDATE jobs SET status='queued',workflow_instance_id=?,progress_label=?,
       error_code=?,error_message=NULL,updated_at=?
     WHERE id=? AND attempt=? AND status=?
       AND COALESCE(workflow_instance_id,id)=?`,
  )
    .bind(
      instanceId,
      deferForLookup ? "Waiting to check Slack receipt" : "Queued",
      deferForLookup ? "capture_lookup_unavailable" : null,
      deferForLookup ? Date.now() : Date.now() - QUEUED_JOB_RECOVERY_DELAY_MS,
      job.id,
      job.attempt,
      expectedStatus,
      job.workflow_instance_id ?? job.id,
    )
    .run();
  if (!returned.meta.changes) return false;
  await notifyJobs(env, job.workspace_id);
  if (deferForLookup) return true;
  // prepareSlackCapture may have linked the receipt using the old workflow id
  // while this catch was running. Start the replacement immediately in that case.
  const linked = await env.DB.prepare(
    `SELECT jobs.id,jobs.workflow_instance_id,jobs.attempt,jobs.correlation_id
       FROM jobs JOIN slack_captures ON slack_captures.id=jobs.id
      WHERE jobs.id=? AND jobs.workflow_instance_id=? AND jobs.status='queued'
        AND slack_captures.job_id=jobs.id AND slack_captures.state='running'`,
  )
    .bind(job.id, instanceId)
    .first<Pick<JobRow, "id" | "workflow_instance_id" | "attempt" | "correlation_id">>();
  if (linked) await startJobExecution(env, linked);
  return true;
}

async function notifyJobs(env: Env, workspaceId: string) {
  try {
    await broadcastWorkspaceEvent(env, workspaceId, { type: "jobs-invalidated" });
  } catch (error) {
    logger.error(
      "workflow.progress_broadcast.failed",
      "workflow",
      "Job progress broadcast failed.",
      { workspaceId },
      error,
    );
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
    if (options.terminateWorkflow !== false && env.WORKFLOW_INLINE !== "true") {
      let terminating = false;
      try {
        const instance = await env.NOTES_WORKFLOW.get(job.workflow_instance_id ?? job.id);
        const status = await instance.status();
        if (ACTIVE_WORKFLOW_STATUSES.has(status.status)) {
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
    const captureId = job.type === "import" ? jsonRecord(job.options_json).captureId : null;
    const finishedBatch = await env.DB.batch([
      env.DB.prepare(
        `UPDATE jobs SET
         status = cleanup_target,
         progress_label = CASE cleanup_target WHEN 'canceled' THEN 'Canceled' ELSE 'Failed' END,
         error_code = CASE cleanup_target WHEN 'canceled' THEN NULL ELSE error_code END,
         error_message = CASE cleanup_target WHEN 'canceled' THEN NULL ELSE error_message END,
         cleanup_token = NULL, cleanup_started_at = NULL, cleanup_target = NULL, updated_at = ?
       WHERE id = ? AND attempt = ? AND cleanup_token = ? AND cleanup_target IS NOT NULL
         AND status IN (${CLEANUP_JOB_STATUS_SQL})`,
      ).bind(completedAt, job.id, job.attempt, token),
      ...(typeof captureId === "string"
        ? [
            failCaptureForJobStatement(env.DB, captureId, job.id, job.attempt, completedAt, null, "final"),
            captureFeedbackStatement(env.DB, captureId, "failed", completedAt),
          ]
        : []),
    ]);
    const finished = finishedBatch[0]!;
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

async function failJobWithCleanup(env: Env, job: JobRow, error: unknown, deferCleanup = false) {
  const httpError = safeHttpError(error);
  // Typed job failures are user-facing product data, not telemetry. Keep their
  // specific message here; structured logging still sanitizes any later copy.
  const message = httpError ? boundedLogString(httpError.message, PERSISTED_ERROR_MESSAGE_LIMIT) : "The job failed.";
  const errorCode = httpError?.code ?? "job_failed";
  if (!httpError)
    logger.error(
      "workflow.job.failed",
      "workflow",
      "Job execution failed.",
      { jobId: job.id, attempt: job.attempt },
      error,
    );
  if (job.type !== "import" && job.type !== "template_clone" && job.type !== "export") {
    const failed = await env.DB.prepare(
      `UPDATE jobs SET status='failed',progress_label='Failed',error_code=?,error_message=?,updated_at=?
        WHERE id=? AND attempt=? AND status='running' AND COALESCE(workflow_instance_id,id)=?`,
    )
      .bind(errorCode, message, Date.now(), job.id, job.attempt, job.workflow_instance_id ?? job.id)
      .run();
    if (failed.meta.changes) await notifyJobs(env, job.workspace_id);
    return false;
  }
  const captureId = job.type === "import" ? jsonRecord(job.options_json).captureId : null;
  const timestamp = Date.now();
  const [pending] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE jobs SET status = 'failed', cleanup_target = COALESCE(cleanup_target, 'failed'),
         progress_label = 'Failure cleanup pending', error_code = ?, error_message = ?, updated_at = ?
       WHERE id = ? AND attempt = ? AND status = 'running'
         AND COALESCE(workflow_instance_id,id)=?`,
    ).bind(errorCode, message, timestamp, job.id, job.attempt, job.workflow_instance_id ?? job.id),
    ...(typeof captureId === "string"
      ? [
          failCaptureForJobStatement(env.DB, captureId, job.id, job.attempt, timestamp, null, "failed"),
          captureFeedbackStatement(env.DB, captureId, "failed", timestamp),
        ]
      : []),
  ]);
  if (!pending?.meta.changes) return false;
  await notifyJobs(env, job.workspace_id);
  if (deferCleanup) return true;
  await finishPendingJobCleanup(env, job, { terminateWorkflow: false }).catch((cleanupError) => {
    logger.error(
      "workflow.failure_cleanup.failed",
      "workflow",
      "Failed job cleanup failed.",
      { jobId: job.id },
      cleanupError,
    );
  });
  return true;
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
     WHERE id = ? AND attempt = ? AND status = ?
       ${fields.status === "running" ? `AND NOT ${UNLINKED_CAPTURE_SQL}` : ""}`,
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
  const legacy = await env.DB.prepare(`SELECT attempt FROM jobs WHERE id = ? AND COALESCE(workflow_instance_id,id) = ?`)
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
  // The queued claim can be blocked while its Slack receipt is unlinked. This
  // Workflow instance will now finish; give the queued job a fresh instance id.
  if (
    current?.status === "queued" &&
    (current.workflow_instance_id ?? current.id) === event.instanceId &&
    isCaptureImportJob(current)
  ) {
    await replaceCaptureWorkflow(env, current, "queued");
    return null;
  }
  return current &&
    current.status === "running" &&
    !current.cleanup_target &&
    (current.workflow_instance_id ?? current.id) === event.instanceId
    ? current
    : null;
}

export class NotesJobWorkflow extends WorkflowEntrypoint<Env, JobWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<JobWorkflowParams>>, step: WorkflowStep) {
    const correlationId = event.payload.correlationId ?? event.payload.jobId;
    return withObservabilityContext(this.env, { trigger: "workflow", correlationId }, () =>
      traced(
        this.ctx.tracing,
        "notes.workflow.job",
        {
          "notes.job_id": event.payload.jobId,
          "notes.job_attempt": event.payload.attempt,
        },
        () => this.runObserved(event, step),
      ),
    );
  }

  private async runObserved(event: Readonly<WorkflowEvent<JobWorkflowParams>>, step: WorkflowStep) {
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
      const current = await this.env.DB.prepare(
        `SELECT * FROM jobs WHERE id=? AND attempt>=? AND COALESCE(workflow_instance_id,id)=?`,
      )
        .bind(jobId, attempt, event.instanceId)
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
      const recovery = await shouldRequeueCapture(this.env, current, error);
      if (recovery) {
        await replaceCaptureWorkflow(this.env, current, "running", recovery === "lookup_failed");
        return;
      }
      await failJobWithCleanup(this.env, current, error);
      throw error;
    }
  }
}

export async function recoverQueuedJobs(env: Env) {
  const cutoff = Date.now() - QUEUED_JOB_RECOVERY_DELAY_MS;
  const terminalCleanups: Array<Pick<JobRow, "id" | "attempt">> = [];
  if (env.WORKFLOW_INLINE !== "true") {
    const rotateRunningJob = (job: JobRow) =>
      env.DB.prepare(`UPDATE jobs SET updated_at=? WHERE id=? AND attempt=? AND status='running'
        AND COALESCE(workflow_instance_id,id)=?`)
        .bind(Date.now(), job.id, job.attempt, job.workflow_instance_id ?? job.id)
        .run();
    // Move live checks to the back of this bounded scan so they cannot starve
    // terminal jobs while long imports continue to make progress.
    const running = await env.DB.prepare(
      `SELECT * FROM jobs WHERE status='running'
         AND updated_at<=? ORDER BY updated_at LIMIT 25`,
    )
      .bind(cutoff)
      .all<JobRow>();
    for (const job of running.results) {
      try {
        let status: { status: string; error?: unknown } | null = null;
        try {
          status = await (await env.NOTES_WORKFLOW.get(job.workflow_instance_id ?? job.id)).status();
        } catch (error) {
          if (!workflowInstanceMissing(error)) throw error;
        }
        if (status && (ACTIVE_WORKFLOW_STATUSES.has(status.status) || status.status === UNDETERMINED_WORKFLOW_STATUS)) {
          if (status.status === UNDETERMINED_WORKFLOW_STATUS && Date.now() - job.created_at > 2 * 60 * 60_000)
            logger.warn(
              "workflow.running_status.unknown",
              "workflow",
              "Workflow status remains unknown; preserving the running job until its outcome is authoritative.",
              { jobId: job.id, attempt: job.attempt },
            );
          await rotateRunningJob(job);
          continue;
        }
        const failure =
          status && "error" in status && status.error
            ? status.error
            : new Error("Workflow ended before the job reached a terminal state.");
        if (isCaptureImportJob(job)) {
          const recovery = await shouldRequeueCapture(env, job, failure);
          if (recovery) {
            await replaceCaptureWorkflow(env, job, "running", recovery === "lookup_failed");
            continue;
          }
        }
        if (await failJobWithCleanup(env, job, failure, true)) terminalCleanups.push(job);
      } catch (error) {
        logger.error(
          "workflow.running_recovery.failed",
          "workflow",
          "Running job recovery failed.",
          { jobId: job.id, attempt: job.attempt },
          error,
        );
        // A repeatedly failing status RPC must not keep terminal jobs beyond
        // this bounded scan from ever being inspected.
        try {
          await rotateRunningJob(job);
        } catch {
          // The next sweep can retry once D1 recovers.
        }
      }
    }
  }
  const queued = await env.DB.prepare(
    `SELECT id, workflow_instance_id, attempt, correlation_id FROM jobs
      WHERE status = 'queued' AND updated_at <= ?
        AND NOT ${UNLINKED_CAPTURE_SQL}
      ORDER BY updated_at LIMIT 25`,
  )
    .bind(cutoff)
    .all<Pick<JobRow, "id" | "workflow_instance_id" | "attempt" | "correlation_id">>();
  const cleanTerminal = async (job: Pick<JobRow, "id" | "attempt">) => {
    try {
      await finishPendingJobCleanup(env, job, { terminateWorkflow: false });
    } catch (error) {
      logger.error(
        "workflow.pending_cleanup.failed",
        "workflow",
        "Pending job cleanup failed.",
        { jobId: job.id },
        error,
      );
    }
  };
  let cleanedTerminal = 0;
  for (; cleanedTerminal < Math.min(2, terminalCleanups.length); cleanedTerminal += 1)
    await cleanTerminal(terminalCleanups[cleanedTerminal]!);
  for (const [index, job] of queued.results.entries()) {
    try {
      await startJobExecution(env, job);
    } catch (error) {
      const failed = await env.DB.prepare(
        `UPDATE jobs SET error_code = 'workflow_start_failed', error_message = ?, updated_at = ?
          WHERE id = ? AND attempt = ? AND status = 'queued'`,
      )
        .bind("Workflow start failed.", Date.now(), job.id, job.attempt)
        .run();
      if (failed.meta.changes) {
        logger.error(
          "workflow.start_recovery.failed",
          "workflow",
          "Queued job workflow start failed.",
          { jobId: job.id, attempt: job.attempt },
          error,
        );
      }
    }
    if ((index + 1) % 5 === 0 && cleanedTerminal < terminalCleanups.length)
      await cleanTerminal(terminalCleanups[cleanedTerminal++]!);
  }
  for (; cleanedTerminal < terminalCleanups.length; cleanedTerminal += 1)
    await cleanTerminal(terminalCleanups[cleanedTerminal]!);
  const cleanups = await env.DB.prepare(
    `SELECT id, attempt FROM jobs WHERE cleanup_target IS NOT NULL
      AND status IN (${CLEANUP_JOB_STATUS_SQL}) AND updated_at <= ?
      ORDER BY updated_at LIMIT 25`,
  )
    .bind(cutoff)
    .all<Pick<JobRow, "id" | "attempt">>();
  for (const job of cleanups.results) {
    try {
      await finishPendingJobCleanup(env, job);
    } catch (error) {
      logger.error(
        "workflow.pending_cleanup.failed",
        "workflow",
        "Pending job cleanup failed.",
        { jobId: job.id },
        error,
      );
    }
  }
}

type SweepOutboxRow = {
  id: string;
  correlation_id: string | null;
  topic: string;
  receipt_id: string | null;
  attempts: number;
  round2: number;
};
async function enqueueOutbox(env: Env, row: SweepOutboxRow) {
  const outboxId = row.id;
  const correlationId = row.correlation_id ?? currentObservabilityContext()?.correlationId ?? undefined;
  if (row.round2 && row.receipt_id) {
    await enqueueRound2Outbox(env, outboxId, row.topic as keyof typeof round2Receipts, row.receipt_id, {
      dueAt: Date.now() + SLACK_REDRIVE_STALE_MS,
      correlationId,
      expectedVersion: row.attempts,
    });
    return;
  }
  try {
    await env.DELIVERY_QUEUE.send({ outboxId, ...(correlationId ? { correlationId } : {}) });
    const now = Date.now();
    await env.DB.prepare(`UPDATE outbox SET enqueued_at = ?, attempts = attempts + 1,
      last_error = CASE WHEN slack_scope_paused_at IS NULL THEN NULL ELSE last_error END,
      slack_redrive_due_at = CASE WHEN slack_scope_paused_at IS NOT NULL THEN NULL WHEN topic IN
        ('slack_bulk','slack_thread_reply','slack_inbound_reply','slack_thread_action','slack_workspace_action','slack_unfurl','slack_digest','slack_share_refresh','slack_file_upload')
        THEN ? WHEN topic='slack_channel' AND (SELECT validation_enabled FROM round2_runtime WHERE id=1)=1 THEN ? ELSE NULL END WHERE id = ?`)
      .bind(now, now + SLACK_REDRIVE_STALE_MS, now + SLACK_REDRIVE_STALE_MS, outboxId)
      .run();
  } catch (error) {
    const failed = await env.DB.prepare(
      `UPDATE outbox SET attempts = attempts + 1, last_error = ?,
         available_at = ?
        WHERE id = ? RETURNING attempts, last_error`,
    )
      .bind(safeTelemetryErrorMessage(error, "Queue enqueue failed."), outboxEnqueueRetryAt(row.attempts + 1), outboxId)
      .first<{ attempts: number; last_error: string | null }>();
    if (failed) reportPersistentEnqueueFailure(env, outboxId, failed.attempts, failed.last_error);
    throw error;
  }
}

async function pauseSlackScopeOutbox(env: Env, outboxId: string, topic: string, error: unknown) {
  const now = Date.now();
  const destination = await env.DB.prepare(
    `SELECT ${SLACK_OUTBOX_CHANNEL_TYPE_SQL} channel_type FROM outbox WHERE id=?`,
  )
    .bind(outboxId)
    .first<{ channel_type: string | null }>();
  const scopes = slackScopeRequirements(
    topic,
    error instanceof SlackApiError ? error.method : undefined,
    error instanceof SlackApiError ? error.neededScopes : [],
    destination?.channel_type,
  );
  await env.DB.prepare(`UPDATE outbox SET slack_scope_paused_at=COALESCE(slack_scope_paused_at,?),slack_scope_required_json=?,
    enqueued_at=COALESCE(enqueued_at,?),slack_claim_recheck_at=NULL,
    slack_redrive_due_at=CASE WHEN ${ROUND2_OUTBOX_SQL} THEN coalesce(slack_redrive_due_at,?+1800000) ELSE NULL END,last_error=CASE WHEN ${ROUND2_OUTBOX_SQL} AND last_error='slack_validation_stale' THEN last_error ELSE 'slack_scope_missing' END
    WHERE id=?`)
    .bind(now, JSON.stringify(scopes), now, now, outboxId)
    .run();
}

async function enqueueSweepContinuation(env: Env, failureMessage: string) {
  try {
    const correlationId = currentObservabilityContext()?.correlationId;
    await env.DELIVERY_QUEUE.send({ sweep: true, ...(correlationId ? { correlationId } : {}) });
  } catch (error) {
    logger.error("outbox.sweep_continuation.enqueue_failed", "outbox", failureMessage, {}, error);
    throw error;
  }
}

export async function sweepOutbox(env: Env, continuation = false): Promise<OutboxSweepResult> {
  const claimToken = crypto.randomUUID();
  let claimedAt = 0;
  let claimed = false;
  for (let attempt = 0; attempt < OUTBOX_SWEEP_CLAIM_ATTEMPTS; attempt += 1) {
    claimedAt = Date.now();
    claimed = Boolean(
      await env.DB.prepare(
        `UPDATE outbox_sweep_state
            SET lease_token = ?, lease_until = ?,
                rescan_requested = 0, updated_at = ?
          WHERE id = 1 AND lease_until <= ?
          RETURNING id`,
      )
        .bind(claimToken, claimedAt + OUTBOX_SWEEP_LEASE_MS, claimedAt, claimedAt)
        .first<{ id: number }>(),
    );
    if (claimed) break;
    if (continuation) return "contended";
    const requestedAt = Date.now();
    const requested = await env.DB.prepare(
      `UPDATE outbox_sweep_state SET rescan_requested = 1, updated_at = ?
        WHERE id = 1 AND lease_until > ?
        RETURNING id`,
    )
      .bind(requestedAt, requestedAt)
      .first<{ id: number }>();
    if (requested) return "contended";
  }
  if (!claimed) {
    logger.warn("outbox.sweep.claim_exhausted", "outbox", "Outbox sweep claim retries were exhausted.", {
      attempts: OUTBOX_SWEEP_CLAIM_ATTEMPTS,
    });
    await enqueueSweepContinuation(env, "Outbox sweep fallback enqueue failed");
    return "contended";
  }
  const releaseIfIdle = async () =>
    Boolean(
      await env.DB.prepare(
        `UPDATE outbox_sweep_state
            SET lease_token = NULL, lease_until = 0, updated_at = ?
          WHERE id = 1 AND lease_token = ? AND rescan_requested = 0
          RETURNING id`,
      )
        .bind(Date.now(), claimToken)
        .first<{ id: number }>(),
    );
  const renewLease = async (stage: string) => {
    const renewedAt = Date.now();
    const renewed = Boolean(
      await env.DB.prepare(
        `UPDATE outbox_sweep_state SET lease_until = ?, updated_at = ?
          WHERE id = 1 AND lease_token = ? AND lease_until > ?
          RETURNING id`,
      )
        .bind(renewedAt + OUTBOX_SWEEP_LEASE_MS, renewedAt, claimToken, renewedAt)
        .first<{ id: number }>(),
    );
    if (!renewed) {
      logger.error("outbox.sweep.lease_lost", "outbox", "Outbox sweep lease was lost.", { stage });
      if (!continuation) {
        await enqueueSweepContinuation(env, "Outbox sweep lease-loss continuation enqueue failed");
      }
    }
    return renewed;
  };

  try {
    for (let batch = 0; batch < OUTBOX_SWEEP_MAX_BATCHES; batch += 1) {
      if (!(await renewLease("before-batch"))) return "lease-lost";
      const rows = await env.DB.prepare(
        `SELECT id,correlation_id,topic,slack_round2_receipt_id receipt_id,attempts,${ROUND2_OUTBOX_SQL} round2
          FROM outbox WHERE enqueued_at IS NULL AND slack_scope_paused_at IS NULL AND available_at <= ?
          AND (topic<>'slack_file_upload' OR ?=1)
          AND (?=1 OR NOT (topic='slack_channel' AND coalesce(slack_round2_receipt_id LIKE 'activity:%',0)))
          ORDER BY available_at, created_at, id LIMIT ?`,
      )
        .bind(
          Date.now(),
          thumbnailDeliveryEnabled(env) ? 1 : 0,
          env.SLACK_CHANNEL_VALIDATION_ENABLED === "true" ? 1 : 0,
          OUTBOX_SWEEP_BATCH_SIZE,
        )
        .all<SweepOutboxRow>();
      for (const row of rows.results) {
        if (!(await renewLease("before-row"))) return "lease-lost";
        try {
          await enqueueOutbox(env, row);
        } catch (error) {
          logger.error("outbox.enqueue.failed", "outbox", "Outbox enqueue failed.", { outboxId: row.id }, error);
        }
      }
      if (!(await renewLease("after-batch"))) return "lease-lost";
      if (rows.results.length < OUTBOX_SWEEP_BATCH_SIZE) {
        if (await releaseIfIdle()) return "completed";
        await env.DB.prepare(
          `UPDATE outbox_sweep_state SET rescan_requested = 0, updated_at = ?
            WHERE id = 1 AND lease_token = ?`,
        )
          .bind(Date.now(), claimToken)
          .run();
      }
    }
    const remaining = await env.DB.prepare(
      `SELECT 1 pending FROM outbox WHERE enqueued_at IS NULL AND slack_scope_paused_at IS NULL AND available_at <= ? AND (topic<>'slack_file_upload' OR ?=1)
          AND (?=1 OR NOT (topic='slack_channel' AND coalesce(slack_round2_receipt_id LIKE 'activity:%',0))) LIMIT 1`,
    )
      .bind(Date.now(), thumbnailDeliveryEnabled(env) ? 1 : 0, env.SLACK_CHANNEL_VALIDATION_ENABLED === "true" ? 1 : 0)
      .first<{ pending: number }>();
    if (!remaining && (await releaseIfIdle())) return "completed";
    logger.warn("outbox.sweep.capped", "outbox", "Outbox sweep cap reached; scheduling continuation.", {
      maxRows: OUTBOX_SWEEP_BATCH_SIZE * OUTBOX_SWEEP_MAX_BATCHES,
    });
    if (!(await renewLease("before-continuation"))) return "lease-lost";
    await enqueueSweepContinuation(env, "Outbox sweep continuation enqueue failed");
    return "completed";
  } finally {
    await env.DB.prepare(
      `UPDATE outbox_sweep_state SET lease_token = NULL, lease_until = 0, updated_at = ?
        WHERE id = 1 AND lease_token = ?`,
    )
      .bind(Date.now(), claimToken)
      .run();
  }
}

// Queue retries are bounded. Requeue only receipt-backed work that is still
// pending; delivery handlers provide the idempotency and uncertain-send fence.
export async function redriveStaleSlackOutbox(env: Env) {
  try {
    await redriveRound2Outbox(env);
  } catch (error) {
    logger.error(
      "slack.round2.redrive_failed",
      "slack",
      "Round-two recovery failed; continuing legacy recovery.",
      {},
      error,
    );
  }
  const now = Date.now();
  await env.DB.prepare(`UPDATE slack_interaction_receipts
    SET response_delivery_state = 'blocked', response_delivery_error = 'send_unconfirmed'
    WHERE response_delivery_state = 'sending' AND response_delivery_attempted_at <= ?`)
    .bind(now - SLACK_REDRIVE_STALE_MS)
    .run();
  const rows = await env.DB.prepare(`SELECT outbox.id, outbox.workspace_id, outbox.topic, outbox.payload_json,
      outbox.enqueued_at, outbox.created_at, outbox.slack_redrive_due_at, outbox.slack_redrive_count,
      outbox.slack_auth_pause_baseline_ms, outbox.slack_eligible_started_at,
      outbox.slack_scope_paused_ms FROM outbox
    LEFT JOIN slack_thread_deliveries delivery ON outbox.topic='slack_thread_reply'
      AND delivery.id=json_extract(CASE WHEN json_valid(outbox.payload_json) THEN outbox.payload_json ELSE '{}' END,'$.deliveryId')
    WHERE outbox.topic NOT IN ('slack_bulk','slack_digest','slack_share_refresh','slack_file_upload')
      AND NOT (outbox.topic='slack_channel' AND ((SELECT validation_enabled FROM round2_runtime WHERE id=1)=1 OR coalesce(outbox.slack_round2_receipt_id LIKE 'activity:%',0)))
      AND outbox.slack_redrive_due_at IS NOT NULL AND outbox.slack_redrive_due_at <= ?
      AND outbox.slack_scope_paused_at IS NULL
      AND (delivery.id IS NULL OR delivery.state<>'pending' OR EXISTS
        (SELECT 1 FROM slack_thread_delivery_runnable runnable WHERE runnable.id=delivery.id))
    ORDER BY CASE WHEN delivery.state='blocked' THEN 1 ELSE 0 END,
      outbox.slack_redrive_due_at, CASE WHEN delivery.operation='root' THEN 0 ELSE 1 END,
      outbox.id LIMIT 50`)
    .bind(now)
    .all<{
      id: string;
      workspace_id: string;
      topic: string;
      payload_json: string;
      enqueued_at: number | null;
      created_at: number;
      slack_redrive_due_at: number;
      slack_redrive_count: number;
      slack_auth_pause_baseline_ms: number | null;
      slack_eligible_started_at: number | null;
      slack_scope_paused_ms: number;
    }>();
  let redriven = 0;
  for (const row of rows.results) {
    const payload = jsonRecord(row.payload_json);
    const key =
      row.topic === "slack_thread_reply"
        ? payload.deliveryId
        : row.topic === "slack_unfurl"
          ? payload.unfurlId
          : payload.receiptId;
    if (typeof key !== "string") {
      await env.DB.prepare(
        `UPDATE outbox SET slack_redrive_due_at=NULL, last_error='Invalid Slack redrive payload' WHERE id=?`,
      )
        .bind(row.id)
        .run();
      continue;
    }
    const pending =
      row.topic === "slack_thread_reply"
        ? await env.DB.prepare(`SELECT id, link_id, operation, state, created_at,attempted_at,
            auth_pause_baseline_ms,history_paused_at,history_pause_auth_ms,history_pause_total_ms
            FROM slack_thread_deliveries
            WHERE id = ? AND (state IN ('pending','sending') OR
              (state='blocked' AND failure_reason LIKE 'reconciliation_%'))`)
            .bind(key)
            .first<{
              id: string;
              link_id: string;
              operation: "root" | "reply" | "refresh";
              state: string;
              created_at: number;
              attempted_at: number | null;
              auth_pause_baseline_ms: number | null;
              history_paused_at: number | null;
              history_pause_auth_ms: number | null;
              history_pause_total_ms: number;
            }>()
        : await env.DB.prepare(
            row.topic === "slack_unfurl"
              ? `SELECT 1 FROM slack_unfurls WHERE id=? AND delivered_at IS NULL AND retired_at IS NULL`
              : `SELECT 1 FROM ${row.topic === "slack_inbound_reply" ? "slack_inbound_receipts" : "slack_interaction_receipts"}
             WHERE id = ? AND processed_at IS NULL`,
          )
            .bind(key)
            .first();
    if (!pending) {
      await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL WHERE id=?`)
        .bind(row.id)
        .run();
      continue;
    }
    const delivery =
      row.topic === "slack_thread_reply"
        ? (pending as {
            id: string;
            link_id: string;
            operation: "root" | "reply" | "refresh";
            state: string;
            created_at: number;
            attempted_at: number | null;
            auth_pause_baseline_ms: number | null;
            history_paused_at: number | null;
            history_pause_auth_ms: number | null;
            history_pause_total_ms: number;
          })
        : null;
    const installation = await env.DB.prepare(`SELECT auth_error_at,auth_paused_ms FROM slack_installations
      WHERE workspace_id=? AND disconnected_at IS NULL`)
      .bind(row.workspace_id)
      .first<{ auth_error_at: number | null; auth_paused_ms: number }>();
    const authClock =
      (installation?.auth_paused_ms ?? 0) +
      (installation?.auth_error_at === null || installation?.auth_error_at === undefined
        ? 0
        : Math.max(0, now - installation.auth_error_at));
    if (
      installation?.auth_error_at !== null &&
      installation?.auth_error_at !== undefined &&
      row.topic !== "slack_thread_action" &&
      row.topic !== "slack_workspace_action"
    ) {
      await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=? WHERE id=? AND slack_redrive_due_at=?`)
        .bind(now + 60_000, row.id, row.slack_redrive_due_at)
        .run();
      continue;
    }
    if (delivery?.state === "pending") {
      if (row.slack_eligible_started_at === null) {
        await env.DB.prepare(`UPDATE outbox SET slack_eligible_started_at=?,slack_auth_pause_baseline_ms=?
          WHERE id=? AND slack_eligible_started_at IS NULL`)
          .bind(now, authClock, row.id)
          .run();
        row.slack_eligible_started_at = now;
        row.slack_auth_pause_baseline_ms = authClock;
      }
    }
    const expiredAction = row.topic === "slack_thread_action" || row.topic === "slack_workspace_action";
    const eligibleAge = Math.max(
      0,
      now -
        (delivery?.state === "pending" ? (row.slack_eligible_started_at ?? now) : row.created_at) -
        Math.max(0, authClock - (row.slack_auth_pause_baseline_ms ?? 0)) -
        row.slack_scope_paused_ms,
    );
    const historyPause =
      delivery?.history_paused_at === null || delivery?.history_paused_at === undefined
        ? 0
        : Math.max(
            0,
            now - delivery.history_paused_at - Math.max(0, authClock - (delivery.history_pause_auth_ms ?? authClock)),
          );
    const uncertainAge =
      delivery?.attempted_at === null || delivery?.attempted_at === undefined
        ? 0
        : Math.max(
            0,
            now -
              delivery.attempted_at -
              Math.max(0, authClock - (delivery.auth_pause_baseline_ms ?? 0)) -
              (delivery.state === "blocked" ? 0 : delivery.history_pause_total_ms + historyPause),
          );
    const exhausted =
      delivery?.state === "sending" || delivery?.state === "blocked"
        ? uncertainAge >= 24 * 60 * 60_000
        : row.slack_redrive_count >= 8 || eligibleAge >= 24 * 60 * 60_000;
    if (expiredAction || exhausted) {
      if (delivery) {
        if (delivery.state === "sending" || delivery.state === "blocked") {
          if (!(await retireUncertainSlackDelivery(env, delivery))) {
            await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=?
              WHERE id=? AND slack_redrive_due_at=?`)
              .bind(now + 60_000, row.id, row.slack_redrive_due_at)
              .run();
            continue;
          }
        } else {
          if (delivery.operation === "root") {
            await env.DB.batch([
              env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired', failure_reason='redrive_exhausted', updated_at=?
                WHERE id=? AND state='pending'`).bind(now, key),
              env.DB.prepare(`INSERT OR IGNORE INTO slack_delivery_failures
                (delivery_id,workspace_id,subscription_id,channel_name,reason,created_at)
                SELECT delivery.id,link.workspace_id,COALESCE(link.subscription_id,'orphan:' || link.id),
                  COALESCE(NULLIF(mapping.channel_name,''),link.channel_id),'redrive_exhausted',?
                FROM slack_thread_deliveries delivery JOIN slack_thread_links link ON link.id=delivery.link_id
                LEFT JOIN slack_channel_subscriptions mapping ON mapping.id=link.subscription_id
                WHERE delivery.id=? AND delivery.state='retired' AND delivery.failure_reason='redrive_exhausted'`).bind(
                now,
                key,
              ),
              env.DB.prepare(`UPDATE slack_thread_links SET state='retired', updated_at=?
                WHERE id=? AND EXISTS
                  (SELECT 1 FROM slack_thread_deliveries WHERE id=? AND state='retired' AND failure_reason='redrive_exhausted')`).bind(
                now,
                delivery.link_id,
                key,
              ),
              env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired', failure_reason='root_rejected', updated_at=?
                WHERE link_id=? AND (state='pending' OR (state='blocked' AND failure_reason='predecessor_blocked'))
                  AND EXISTS (SELECT 1 FROM slack_thread_links WHERE id=? AND state='retired')
                  AND EXISTS (SELECT 1 FROM slack_thread_deliveries WHERE id=? AND state='retired'
                    AND failure_reason='redrive_exhausted')`).bind(now, delivery.link_id, delivery.link_id, key),
            ]);
          } else {
            await env.DB.batch([
              env.DB.prepare(`UPDATE slack_thread_deliveries SET state='retired',failure_reason='redrive_exhausted',updated_at=?
                WHERE id=? AND state='pending'`).bind(now, key),
              env.DB.prepare(`INSERT OR IGNORE INTO slack_delivery_failures
                (delivery_id,workspace_id,subscription_id,channel_name,reason,created_at)
                SELECT delivery.id,link.workspace_id,COALESCE(link.subscription_id,'orphan:' || link.id),
                  COALESCE(NULLIF(mapping.channel_name,''),link.channel_id),'redrive_exhausted',?
                FROM slack_thread_deliveries delivery JOIN slack_thread_links link ON link.id=delivery.link_id
                LEFT JOIN slack_channel_subscriptions mapping ON mapping.id=link.subscription_id
                WHERE delivery.id=? AND delivery.state='retired' AND delivery.failure_reason='redrive_exhausted'`).bind(
                now,
                key,
              ),
            ]);
            await wakeNextSlackDelivery(env, delivery.link_id);
          }
        }
      } else if (row.topic === "slack_unfurl") {
        await env.DB.prepare(`UPDATE slack_unfurls SET retired_at=?,retirement_reason='redrive_exhausted'
          WHERE id=? AND delivered_at IS NULL AND retired_at IS NULL`)
          .bind(now, key)
          .run();
      } else if (row.topic === "slack_inbound_reply") {
        await env.DB.prepare(`UPDATE slack_inbound_receipts SET processed_at=?,outcome='redrive_exhausted',payload_json=NULL
          WHERE id=? AND processed_at IS NULL`)
          .bind(now, key)
          .run();
      } else {
        const receipt = await env.DB.prepare(`SELECT payload_json FROM slack_interaction_receipts WHERE id=?`)
          .bind(key)
          .first<{ payload_json: string | null }>();
        const input = receipt?.payload_json ? jsonRecord(receipt.payload_json) : {};
        const threadTs = row.topic === "slack_thread_action" ? input.threadTs : input.messageTs;
        await env.DB.batch([
          env.DB.prepare(`UPDATE slack_interaction_receipts SET processed_at=?,outcome='expired',payload_json=NULL
            WHERE id=? AND processed_at IS NULL`).bind(now, key),
          ...(typeof input.installationId === "string" &&
          typeof input.generation === "number" &&
          typeof input.channelId === "string" &&
          typeof input.slackUserId === "string" &&
          typeof threadTs === "string"
            ? [
                env.DB.prepare(`INSERT OR IGNORE INTO outbox
                  (id,workspace_id,topic,payload_json,available_at,created_at)
                  VALUES (?,?,'slack_interaction_response',?,?,?)`).bind(
                  `outbox:slack-denial:${key}`,
                  row.workspace_id,
                  JSON.stringify({
                    receiptId: key,
                    action: true,
                    installationId: input.installationId,
                    generation: input.generation,
                    channelId: input.channelId,
                    slackUserId: input.slackUserId,
                    threadTs,
                    reason: "expired",
                  }),
                  now,
                  now,
                ),
              ]
            : []),
        ]);
      }
      await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=NULL,last_error=? WHERE id=?`)
        .bind(expiredAction ? "Slack action expired" : "Slack redrive limit reached", row.id)
        .run();
      continue;
    }
    if (delivery?.state === "blocked") {
      await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=? WHERE id=? AND slack_redrive_due_at=?`)
        .bind(now + SLACK_BLOCKED_RECHECK_MS, row.id, row.slack_redrive_due_at)
        .run();
      continue;
    }
    const backoff = Math.min(SLACK_REDRIVE_MAX_MS, SLACK_REDRIVE_BASE_MS * 2 ** Math.min(row.slack_redrive_count, 5));
    const reset =
      await env.DB.prepare(`UPDATE outbox SET enqueued_at = NULL, available_at = ?, slack_redrive_due_at=NULL,
        slack_redrive_count=slack_redrive_count+1, last_error = 'Queue acknowledgement missing; scheduled redrive'
      WHERE id = ? AND slack_redrive_due_at = ? AND slack_scope_paused_at IS NULL
        AND (?=0 OR EXISTS (SELECT 1 FROM slack_thread_delivery_runnable WHERE id=?))`)
        .bind(now + backoff, row.id, row.slack_redrive_due_at, delivery?.state === "pending" ? 1 : 0, key)
        .run();
    if (reset.meta.changes) redriven++;
  }
  if (redriven) logger.warn("slack.outbox.redrive", "slack", "Requeued stale Slack work.", { count: redriven });
  return redriven;
}

export async function consumeDeliveryMessage(
  env: Env,
  message: Message<DeliveryQueueMessage>,
  body = deliveryQueueMessageBody(message.body),
): Promise<DeliveryMessageOutcome> {
  if (!body) {
    logger.warn("queue.message.invalid", "delivery-queue", "Delivery queue message body is invalid.", {
      messageId: message.id,
      attempts: message.attempts,
    });
    message.ack();
    return "discarded";
  }
  if ("sweep" in body) {
    if ((await sweepOutbox(env, true)) === "completed") {
      message.ack();
      return "acknowledged";
    }
    message.retry({ delaySeconds: Math.min(60, 2 ** Math.min(message.attempts, 6)) });
    return "retried";
  }
  const outboxId = body.outboxId;
  const row =
    await env.DB.prepare(`SELECT id, topic, payload_json, available_at,last_error,enqueued_at,attempts,correlation_id,
    slack_redrive_due_at,slack_claim_recheck_at FROM outbox WHERE id = ?`)
      .bind(outboxId)
      .first<{
        id: string;
        topic: string;
        payload_json: string;
        available_at: number;
        last_error: string | null;
        enqueued_at: number | null;
        attempts: number;
        correlation_id: string | null;
        slack_redrive_due_at: number | null;
        slack_claim_recheck_at: number | null;
      }>();
  if (!row) {
    message.ack();
    return "acknowledged";
  }
  if (row.available_at > Date.now()) {
    message.retry({
      delaySeconds: Math.min(12 * 60 * 60, Math.max(1, Math.ceil((row.available_at - Date.now()) / 1000))),
    });
    return "retried";
  }
  const payload = jsonRecord(row.payload_json);
  const retryFence = `id=? AND attempts=? AND available_at=? AND enqueued_at IS ? AND slack_redrive_due_at IS ? AND slack_claim_recheck_at IS ?`;
  const retryBinds = [
    outboxId,
    row.attempts,
    row.available_at,
    row.enqueued_at,
    row.slack_redrive_due_at,
    row.slack_claim_recheck_at,
  ];
  let round2Work = false;
  let coordinationSiblings: Array<{ id: string; attempts: number }> = [];
  const clearSiblingCoordination = () =>
    coordinationSiblings
      .filter((sibling) => sibling.id !== outboxId)
      .map((sibling) =>
        env.DB.prepare(`UPDATE outbox SET last_error=NULL WHERE id=? AND attempts=?
      AND last_error='slack_validation_stale' AND slack_scope_paused_at IS NULL`).bind(sibling.id, sibling.attempts),
      );
  const updateRound2Retention = async (statement: D1PreparedStatement, consumeExemption = false) => {
    const siblings = consumeExemption ? clearSiblingCoordination() : [];
    if (siblings.length) await env.DB.batch([statement, ...siblings]);
    else await statement.run();
  };
  const clearValidationStale = async () => {
    const statements = clearSiblingCoordination();
    if (row.last_error === "slack_validation_stale")
      statements.unshift(
        env.DB.prepare(
          `UPDATE outbox SET last_error=NULL WHERE ${retryFence} AND last_error='slack_validation_stale' AND slack_scope_paused_at IS NULL`,
        ).bind(...retryBinds),
      );
    if (statements.length) await env.DB.batch(statements);
  };
  // A payload that fails validation will never become valid, so record it and ack
  // instead of retrying. An unknown topic still throws: a rolling deploy can leave an
  // older consumer reading a topic a newer one writes, and that does resolve on retry.
  const rejectPayload = async (reason: string): Promise<DeliveryMessageOutcome> => {
    await env.DB.prepare(
      `UPDATE outbox SET last_error = ?, slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL WHERE id = ?`,
    )
      .bind(reason, outboxId)
      .run();
    message.ack();
    return "discarded";
  };
  const retainRound2 = async (status: Awaited<ReturnType<typeof round2DeliveryStatus>>, attempted = false) => {
    const now = Date.now();
    if (status.outcome === "competing") {
      await env.DB.prepare(`UPDATE outbox SET slack_claim_recheck_at=? WHERE ${retryFence}`)
        .bind(Math.max(now + 1_000, (status.claimed_at ?? now) + 60_000), ...retryBinds)
        .run();
    } else {
      const consumeExemption = attempted && status.outcome === "retryable";
      const due = now + (status.outcome === "paused" || status.outcome === "uncertain" ? 30 * 60_000 : 60_000);
      await updateRound2Retention(
        env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=max(coalesce(slack_redrive_due_at,0),?),
        slack_claim_recheck_at=CASE WHEN last_error='slack_validation_stale' AND (?=0 OR slack_scope_paused_at IS NOT NULL)
          THEN max(coalesce(slack_claim_recheck_at,0),?) ELSE NULL END,
        last_error=CASE WHEN last_error='slack_validation_stale' AND ?=1 AND slack_scope_paused_at IS NULL THEN NULL ELSE last_error END
        WHERE ${retryFence}`).bind(due, consumeExemption ? 1 : 0, due, consumeExemption ? 1 : 0, ...retryBinds),
        consumeExemption,
      );
    }
    message.ack();
  };
  const keepRound2 = async (topic: keyof typeof round2Receipts, id: string) => {
    const status = await round2DeliveryStatus(env, topic, id);
    if (status.outcome === "completed") return false;
    await retainRound2(status, true);
    return true;
  };
  const deferRound2 = async (topic: keyof typeof round2Receipts, id: string) => {
    round2Work = true;
    coordinationSiblings = (
      await env.DB.prepare(`SELECT id,attempts FROM outbox WHERE topic=? AND slack_round2_receipt_id=?
      AND last_error='slack_validation_stale'`)
        .bind(topic, id)
        .all<{ id: string; attempts: number }>()
    ).results;
    const status = await round2DeliveryStatus(env, topic, id);
    if (status.outcome === "retryable" || status.outcome === "uncertain") return false;
    if (status.outcome === "completed") {
      await updateRound2Retention(
        env.DB.prepare(
          `UPDATE outbox SET slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL,last_error=CASE WHEN last_error='slack_validation_stale' THEN NULL ELSE last_error END WHERE ${retryFence}`,
        ).bind(...retryBinds),
        true,
      );
      message.ack();
    } else await retainRound2(status);
    return true;
  };
  const round2Failure = async (error: unknown) => {
    if (error instanceof StaleSlackValidationError) {
      const now = Date.now();
      const retry =
        await env.DB.prepare(`UPDATE outbox SET attempts=attempts+1,enqueued_at=NULL,available_at=?,slack_claim_recheck_at=?,
        slack_redrive_due_at=NULL,slack_enqueue_redrive_pending=0,last_error='slack_validation_stale' WHERE ${retryFence}`)
          .bind(now + 2000, now + 2000, ...retryBinds)
          .run();
      if (retry.meta.changes) {
        const id = payload[round2Receipts[row.topic as keyof typeof round2Receipts]?.key];
        if (typeof id === "string")
          try {
            await enqueueRound2Outbox(env, outboxId, row.topic as keyof typeof round2Receipts, id, {
              dueAt: now + SLACK_REDRIVE_STALE_MS,
              delaySeconds: 2,
              expectedVersion: row.attempts + 1,
              correlationId: body.correlationId ?? row.correlation_id ?? undefined,
            });
          } catch {
            // Durable scheduling recovers a failed delayed enqueue without queue retries.
          }
      }
      message.ack();
      return "acknowledged" as const;
    }
    if (slackMissingScope(error)) await pauseSlackScopeOutbox(env, outboxId, row.topic, error);
    else if (error instanceof DeliveryInProgressError) {
      await env.DB.prepare(`UPDATE outbox SET slack_claim_recheck_at=? WHERE ${retryFence}`)
        .bind(Date.now() + 60_000, ...retryBinds)
        .run();
    } else if (error instanceof SlackApiError && slackInstallationError(error)) {
      await env.DB.prepare(
        `UPDATE outbox SET slack_redrive_due_at=max(coalesce(slack_redrive_due_at,0),?) WHERE ${retryFence}`,
      )
        .bind(Date.now() + 60_000, ...retryBinds)
        .run();
    } else {
      const contract = round2Receipts[row.topic as keyof typeof round2Receipts];
      const id = contract ? payload[contract.key] : undefined;
      if (typeof id === "string") {
        const status = await round2DeliveryStatus(env, row.topic as keyof typeof round2Receipts, id);
        if (status.outcome === "retryable") await clearValidationStale();
      }
      throw error;
    }
    message.ack();
    return "acknowledged" as const;
  };
  const deferSlackView = async (): Promise<DeliveryMessageOutcome> => {
    const now = Date.now();
    await env.DB.prepare(`UPDATE outbox SET enqueued_at=NULL, available_at=?, slack_redrive_due_at=NULL
      WHERE id=?`)
      .bind(now + 2_000, outboxId)
      .run();
    try {
      await env.DELIVERY_QUEUE.send({ outboxId }, { delaySeconds: 2 });
      await env.DB.prepare(`UPDATE outbox SET enqueued_at=?, slack_redrive_due_at=? WHERE id=?`)
        .bind(now, now + SLACK_REDRIVE_STALE_MS, outboxId)
        .run();
    } catch {
      // The outbox sweep recovers a failed delayed enqueue.
    }
    message.ack();
    return "acknowledged";
  };
  const keepSlackThreadRedrive = async (deliveryId: string) => {
    const delivery = await env.DB.prepare(`SELECT state,failure_reason FROM slack_thread_deliveries WHERE id=?`)
      .bind(deliveryId)
      .first<{ state: string; failure_reason: string | null }>();
    if (!delivery || !["pending", "sending", "blocked"].includes(delivery.state)) return false;
    if (delivery.state === "blocked" && !delivery.failure_reason?.startsWith("reconciliation_")) return false;
    await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=? WHERE id=? AND slack_scope_paused_at IS NULL`)
      .bind(Date.now() + (delivery.state === "blocked" ? SLACK_BLOCKED_RECHECK_MS : 60_000), outboxId)
      .run();
    return true;
  };
  if (row.topic === "notification") {
    const notificationId = payload.notificationId;
    if (typeof notificationId !== "string") return await rejectPayload("Notification outbox payload is invalid.");
    await deliverNotification(env, notificationId, outboxId);
  } else if (row.topic === "slack_thread_reply") {
    if (typeof payload.deliveryId !== "string") return await rejectPayload("Slack thread delivery is invalid.");
    try {
      await deliverSlackThread(env, payload.deliveryId);
    } catch (error) {
      if (error instanceof HttpError && error.code === "slack_mirror_missing_scope") {
        await pauseSlackScopeOutbox(env, outboxId, row.topic, error);
        message.ack();
        return "acknowledged";
      }
      if (
        !(error instanceof DeliveryInProgressError) &&
        !(
          error instanceof SlackApiError &&
          (slackInstallationError(error) ||
            error.status >= 500 ||
            ["internal_error", "service_unavailable", "fatal_error", "invalid_response", "http_error"].includes(
              error.code,
            ))
        )
      )
        throw error;
      // The predecessor or another consumer owns the link. The indexed due marker
      // and predecessor completion will wake this row without spending queue retries.
      await keepSlackThreadRedrive(payload.deliveryId);
      message.ack();
      return "acknowledged";
    }
    await sweepOutbox(env);
    if (await keepSlackThreadRedrive(payload.deliveryId)) {
      message.ack();
      return "acknowledged";
    }
  } else if (row.topic === "slack_inbound_reply" || row.topic === "slack_thread_action") {
    if (typeof payload.receiptId !== "string") return await rejectPayload("Slack receipt is invalid.");
    try {
      await deliverSlackMutation(env, payload.receiptId, row.topic === "slack_thread_action");
    } catch (error) {
      if (error instanceof HttpError && error.code === "slack_mirror_missing_scope") {
        await pauseSlackScopeOutbox(env, outboxId, row.topic, error);
        message.ack();
        return "acknowledged";
      }
      if (!(error instanceof SlackApiError && slackInstallationError(error))) throw error;
      await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=? WHERE id=? AND slack_redrive_due_at IS NOT NULL`)
        .bind(Date.now() + 60_000, outboxId)
        .run();
      message.ack();
      return "acknowledged";
    }
    await sweepOutbox(env);
  } else if (row.topic === "slack_interaction_response") {
    await deliverSlackDenial(env, payload);
  } else if (row.topic === "slack_product_copy") {
    if (typeof payload.sessionId !== "string") return await rejectPayload("Slack capture session is invalid.");
    try {
      await deliverSlackProductCopy(env, payload.sessionId);
    } catch (error) {
      if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        return await rejectPayload(error.code);
      }
      throw error;
    }
  } else if (row.topic === "slack_capture") {
    if (typeof payload.captureId !== "string") return await rejectPayload("Slack capture receipt is invalid.");
    const expected = await env.DB.prepare(`SELECT installation_generation,attempt FROM slack_captures WHERE id=?`)
      .bind(payload.captureId)
      .first<{ installation_generation: number; attempt: number }>();
    try {
      const job = await prepareSlackCapture(env, payload.captureId);
      if (job) await startJobExecution(env, job);
    } catch (error) {
      if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        const timestamp = Date.now();
        const failedBatch = await env.DB.batch([
          env.DB.prepare(
            `UPDATE slack_captures SET state='failed',error_category=?,updated_at=?
             WHERE id=? AND job_id IS NULL AND state IN ('pending','running')
               AND installation_generation=? AND attempt=?`,
          ).bind(
            error.code,
            timestamp,
            payload.captureId,
            expected?.installation_generation ?? -1,
            expected?.attempt ?? -1,
          ),
          captureFeedbackStatement(env.DB, payload.captureId, "failed", timestamp),
        ]);
        const failed = failedBatch[0]!;
        if (!failed.meta.changes) {
          const current = await env.DB.prepare(`SELECT job_id,state FROM slack_captures WHERE id=?`)
            .bind(payload.captureId)
            .first<{ job_id: string | null; state: string }>();
          if (!current || current.job_id || current.state === "failed" || current.state === "succeeded")
            return await rejectPayload(error.code);
          message.retry({ delaySeconds: 2 });
          return "retried";
        }
        return await rejectPayload(error.code);
      }
      throw error;
    }
  } else if (row.topic === "slack_capture_feedback") {
    if (typeof payload.captureId !== "string" || !["queued", "succeeded", "failed"].includes(String(payload.state)))
      return await rejectPayload("Slack capture feedback is invalid.");
    await deliverSlackCaptureFeedback(env, payload.captureId, payload.state as "queued" | "succeeded" | "failed");
  } else if (row.topic === "slack_workspace_action") {
    if (typeof payload.receiptId !== "string") return await rejectPayload("Slack workspace receipt is invalid.");
    if ((await deliverSlackWorkspaceAction(env, payload.receiptId)) === "deferred") return await deferSlackView();
    await sweepOutbox(env);
  } else if (row.topic === "slack_search_update") {
    if (typeof payload.sessionId !== "string" || typeof payload.revision !== "number")
      return await rejectPayload("Slack search update is invalid.");
    if ((await deliverSlackSearchUpdate(env, payload.sessionId, payload.revision)) === "deferred")
      return await deferSlackView();
    await sweepOutbox(env);
  } else if (row.topic === "slack_share_response") {
    await deliverSlackShareResponse(env, payload, outboxId);
  } else if (
    row.topic === "slack_bulk" ||
    row.topic === "slack_digest" ||
    row.topic === "slack_share_refresh" ||
    row.topic === "slack_file_upload"
  ) {
    const id =
      row.topic === "slack_bulk"
        ? payload.summaryId
        : row.topic === "slack_digest"
          ? payload.digestId
          : row.topic === "slack_share_refresh"
            ? payload.refreshId
            : payload.artifactId;
    if (typeof id !== "string") return await rejectPayload("Slack round 2 delivery is invalid.");
    const enabled =
      row.topic === "slack_bulk" || row.topic === "slack_digest"
        ? env.SLACK_CHANNEL_VALIDATION_ENABLED === "true"
        : row.topic === "slack_share_refresh"
          ? env.SLACK_SHARE_REFRESH_ENABLED === "true"
          : thumbnailDeliveryEnabled(env);
    if (!enabled) {
      message.ack();
      return "acknowledged";
    } // Preserve recovery markers during a release pause.
    if (await deferRound2(row.topic, id)) return "acknowledged";
    try {
      if (row.topic === "slack_bulk") await deliverBulkSummary(env, id);
      else if (row.topic === "slack_digest") await deliverDigest(env, id);
      else if (row.topic === "slack_share_refresh") await deliverShareRefresh(env, id);
      else await deliverThumbnail(env, id);
    } catch (error) {
      return await round2Failure(error);
    }
    await sweepOutbox(env);
    if (await keepRound2(row.topic, id)) return "acknowledged";
  } else if (row.topic === "slack_channel") {
    const eventId = payload.eventId;
    if (typeof eventId !== "string") return await rejectPayload("Slack channel outbox payload is invalid.");
    if (env.SLACK_CHANNEL_VALIDATION_ENABLED !== "true" && eventId.startsWith("activity:")) {
      message.ack();
      return "acknowledged";
    }
    if (env.SLACK_CHANNEL_VALIDATION_ENABLED === "true" && (await deferRound2("slack_channel", eventId)))
      return "acknowledged";
    try {
      if (env.SLACK_CHANNEL_VALIDATION_ENABLED === "true") await deliverRound2ChannelEvent(env, eventId);
      else await deliverSlackChannelEvent(env, eventId);
    } catch (error) {
      return await round2Failure(error);
    }
    if (env.SLACK_CHANNEL_VALIDATION_ENABLED === "true" && (await keepRound2("slack_channel", eventId)))
      return "acknowledged";
  } else if (row.topic === "slack_controls_expire") {
    await deliverSlackControlsExpiry(env, payload);
    await sweepOutbox(env);
  } else if (row.topic === "slack_unfurl") {
    const unfurlId = payload.unfurlId;
    if (typeof unfurlId !== "string") return await rejectPayload("Slack unfurl outbox payload is invalid.");
    try {
      await deliverSlackUnfurl(env, unfurlId, outboxId);
    } catch (error) {
      if (slackMissingScope(error)) {
        await pauseSlackScopeOutbox(env, outboxId, row.topic, error);
        message.ack();
        return "acknowledged";
      }
      if (!(error instanceof SlackApiError && slackInstallationError(error))) throw error;
      await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=? WHERE id=? AND slack_redrive_due_at IS NOT NULL`)
        .bind(Date.now() + 60_000, outboxId)
        .run();
      message.ack();
      return "acknowledged";
    }
  } else if (row.topic === "slack_home_publish") {
    const installationId = payload.installationId;
    const userId = payload.userId;
    if (typeof installationId !== "string" || typeof userId !== "string") {
      return await rejectPayload("Slack Home outbox payload is invalid.");
    }
    await deliverSlackHome(
      env,
      installationId,
      userId,
      typeof payload.generation === "number" ? payload.generation : undefined,
      payload.reset === true || payload.reset === 1,
    );
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
  await updateRound2Retention(
    env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL,
    last_error=CASE WHEN last_error='slack_validation_stale' THEN NULL ELSE last_error END WHERE ${round2Work ? retryFence : "id=?"}`).bind(
      ...(round2Work ? retryBinds : [outboxId]),
    ),
    true,
  );
  message.ack();
  return "acknowledged";
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
      await deleteR2Prefix(env.BUCKET, `jobs/${row.id}/input/`);
      await deleteR2AttemptArtifacts(env.BUCKET, `jobs/${row.id}`, row.attempt, "documents/");
      await deleteR2Prefix(env.BUCKET, `jobs/${row.id}/documents/`);
    }
    if (row.type === "export") await deleteR2AttemptArtifacts(env.BUCKET, `jobs/${row.id}`, row.attempt, "output/");
    await env.DB.prepare(`UPDATE jobs SET input_key = NULL, output_key = NULL, updated_at = ? WHERE id = ?`)
      .bind(Date.now(), row.id)
      .run();
  }
}
