import { canonicalJson, sha256Hex } from "../shared/import-integrity";
import { effectiveSpaceRole, pageForMember } from "./page-access";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import type { JobRow } from "./jobs";
import { captureMarkdown, MAX_CAPTURE_MARKDOWN_BYTES, MAX_CAPTURE_MESSAGES } from "./slack-capture-content";
import { slackApi, SlackApiError, type SlackHistoryMessage, type SlackInstallation } from "./slack";
import { requireChannelMember, validateChannel, verifiedMember } from "./slack-threads";
import { taskAssignees } from "./tasks";
import type { TaskStatus } from "../shared/tasks";

export type SlackCaptureSource = {
  channelId: string;
  ts: string;
  thread: boolean;
  threadTs?: string;
  text: string;
  author: string;
};

const PERMANENT_SOURCE_ERRORS = new Set([
  "message_not_found",
  "thread_not_found",
  "channel_not_found",
  "not_in_channel",
  "no_permission",
  "is_archived",
  "restricted_action",
]);

async function sourceCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SlackApiError && PERMANENT_SOURCE_ERRORS.has(error.code))
      throw new HttpError(404, "slack_source", "The Slack source is no longer available.");
    throw error;
  }
}

type CaptureRow = {
  id: string;
  installation_id: string;
  installation_generation: number;
  workspace_id: string;
  channel_id: string;
  source_ts: string;
  source_kind: "message" | "thread";
  requested_by: string;
  destination_space_id: string;
  destination_parent_id: string | null;
  target_kind: "document" | "task";
  title: string;
  body: string | null;
  task_fields_json: string | null;
  request_hash: string;
  job_id: string | null;
  page_id: string | null;
  state: "pending" | "running" | "succeeded" | "failed";
};

export function captureFeedbackStatement(
  db: Env["DB"],
  captureId: string,
  state: "queued" | "succeeded" | "failed",
  timestamp: number,
) {
  return db
    .prepare(
      `INSERT OR IGNORE INTO outbox (id,workspace_id,topic,payload_json,available_at,created_at)
     SELECT 'slack-capture-feedback:'||id||':'||?||':'||attempt,
       workspace_id,'slack_capture_feedback',?,?,? FROM slack_captures
      WHERE id=? AND (?='queued' OR state=?) AND EXISTS (
        SELECT 1 FROM slack_product_sessions WHERE capture_id=slack_captures.id
      )`,
    )
    .bind(state, JSON.stringify({ captureId, state }), timestamp, timestamp, captureId, state, state);
}

export async function claimSlackCapture(
  env: Env,
  input: {
    installation: SlackInstallation;
    member: MemberContext;
    sessionId: string;
    source: SlackCaptureSource;
    spaceId: string;
    parentId: string | null;
    title: string;
    body: string;
    kind: "document" | "task";
    taskFields?: { status: TaskStatus; assigneeId: string | null; dueDate: string | null };
  },
) {
  const sourceKind = input.source.thread ? "thread" : "message";
  const id = (
    await sha256Hex(`${input.installation.id}:${input.source.channelId}:${input.source.ts}:${sourceKind}`)
  ).slice(0, 32);
  const requestHash = await sha256Hex(
    canonicalJson({
      sourceKind,
      spaceId: input.spaceId,
      parentId: input.parentId,
      title: input.title,
      body: input.body,
      kind: input.kind,
      taskFields: input.taskFields ?? null,
      requestedBy: input.member.user.id,
    }),
  );
  const timestamp = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO slack_captures
      (id, installation_id, installation_generation, workspace_id, channel_id, source_ts, source_kind,
       requested_by, destination_space_id, destination_parent_id, target_kind, title, body, task_fields_json, request_hash,
       state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      id,
      input.installation.id,
      input.installation.generation,
      input.member.workspace.id,
      input.source.channelId,
      input.source.ts,
      sourceKind,
      input.member.user.id,
      input.spaceId,
      input.parentId,
      input.kind,
      input.title,
      input.body,
      input.taskFields ? JSON.stringify(input.taskFields) : null,
      requestHash,
      timestamp,
      timestamp,
    )
    .run();
  const capture = await env.DB.prepare(
    `SELECT * FROM slack_captures WHERE installation_id = ? AND channel_id = ? AND source_ts = ? AND source_kind = ?`,
  )
    .bind(input.installation.id, input.source.channelId, input.source.ts, sourceKind)
    .first<CaptureRow>();
  if (!capture || capture.request_hash !== requestHash || capture.requested_by !== input.member.user.id)
    throw new HttpError(409, "slack_capture_conflict", "This Slack source is already being saved elsewhere.");
  if (capture.installation_generation !== input.installation.generation && capture.state !== "succeeded") {
    const rebound = await env.DB.prepare(
      `UPDATE slack_captures SET installation_generation=?,updated_at=?
       WHERE id=? AND request_hash=? AND installation_generation=? AND state IN ('pending','failed')`,
    )
      .bind(input.installation.generation, timestamp, capture.id, requestHash, capture.installation_generation)
      .run();
    if (!rebound.meta.changes)
      throw new HttpError(409, "slack_capture_unavailable", "Wait for this capture to finish before retrying.");
    capture.installation_generation = input.installation.generation;
  }
  if (capture.state === "failed" && !capture.job_id) {
    await env.DB.prepare(
      `UPDATE slack_captures SET state='pending',error_category=NULL,attempt=attempt+1,updated_at=?
       WHERE id=? AND request_hash=? AND state='failed' AND job_id IS NULL`,
    )
      .bind(timestamp, capture.id, requestHash)
      .run();
    capture.state = "pending";
  }
  const linked = await env.DB.batch([
    env.DB.prepare(
      `UPDATE slack_product_sessions SET capture_id = ?, request_hash = ?
       WHERE id = ? AND installation_id = ? AND (capture_id IS NULL OR capture_id = ?)`,
    ).bind(capture.id, requestHash, input.sessionId, input.installation.id, capture.id),
    env.DB.prepare(
      `INSERT INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
       SELECT ?, ?, 'slack_capture', ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM slack_product_sessions WHERE id = ? AND capture_id = ?
       )
       ON CONFLICT(id) DO UPDATE SET available_at=excluded.available_at,
         enqueued_at=NULL, last_error=NULL`,
    ).bind(
      `slack-capture:${capture.id}`,
      capture.workspace_id,
      JSON.stringify({ captureId: capture.id }),
      timestamp,
      timestamp,
      input.sessionId,
      capture.id,
    ),
    captureFeedbackStatement(env.DB, capture.id, "queued", timestamp),
  ]);
  if (linked[0]?.meta.changes !== 1)
    throw new HttpError(409, "slack_capture_conflict", "This form is already saving a different capture.");
  return capture;
}

async function exactThreadMessage(
  env: Env,
  installation: SlackInstallation,
  channel: string,
  threadTs: string,
  messageTs: string,
) {
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const result = await sourceCall(() =>
      slackApi(env, installation, "conversations.replies", {
        channel,
        ts: threadTs,
        oldest: messageTs,
        latest: messageTs,
        inclusive: true,
        limit: 2,
        include_all_metadata: false,
        ...(cursor ? { cursor } : {}),
      }),
    );
    const message = result.messages.find((item) => item.ts === messageTs);
    if (message) return message;
    cursor = result.response_metadata?.next_cursor || undefined;
    if (result.has_more && !cursor) throw new Error("Slack did not return the next reply cursor.");
    if (!cursor) throw new HttpError(404, "slack_source", "The Slack source is no longer available.");
  }
  throw new Error("Slack reply pagination exceeded the verification limit.");
}

async function sourceMessages(
  env: Env,
  installation: SlackInstallation,
  capture: CaptureRow,
  source: SlackCaptureSource,
) {
  if (capture.source_kind === "message" && (!source.threadTs || source.threadTs === source.ts)) {
    const result = await sourceCall(() =>
      slackApi(env, installation, "conversations.history", {
        channel: capture.channel_id,
        oldest: capture.source_ts,
        latest: capture.source_ts,
        inclusive: true,
        limit: 1,
        include_all_metadata: false,
      }),
    );
    const message = result.messages.find((item) => item.ts === capture.source_ts);
    if (!message) throw new HttpError(404, "slack_source", "The Slack source is no longer available.");
    return [message];
  }
  if (capture.source_kind === "message") {
    return [await exactThreadMessage(env, installation, capture.channel_id, source.threadTs!, capture.source_ts)];
  }
  const messages: SlackHistoryMessage[] = [];
  let textBytes = 0;
  const encoder = new TextEncoder();
  let cursor: string | undefined;
  do {
    const result = await sourceCall(() =>
      slackApi(env, installation, "conversations.replies", {
        channel: capture.channel_id,
        ts: capture.source_ts,
        oldest: "0",
        limit: 100,
        include_all_metadata: false,
        ...(cursor ? { cursor } : {}),
      }),
    );
    for (const message of result.messages) {
      textBytes += encoder.encode(message.text ?? "").length;
      if (textBytes > MAX_CAPTURE_MARKDOWN_BYTES)
        throw new HttpError(413, "thread_too_large", "This capture exceeds the 2 MiB content limit.");
      messages.push(message);
    }
    if (messages.length > MAX_CAPTURE_MESSAGES)
      throw new HttpError(422, "thread_too_large", "This thread exceeds the capture limit of 2,000 messages.");
    cursor = result.response_metadata?.next_cursor || undefined;
    if (result.has_more && !cursor) throw new Error("Slack did not return the next thread cursor.");
  } while (cursor);
  if (!messages.some((message) => message.ts === capture.source_ts))
    throw new HttpError(404, "slack_source", "The Slack source is no longer available.");
  return messages;
}

function captureSource(session: { state_json: string }, capture: CaptureRow) {
  const source = (JSON.parse(session.state_json) as { source?: SlackCaptureSource }).source;
  if (
    !source ||
    source.channelId !== capture.channel_id ||
    source.ts !== capture.source_ts ||
    source.thread !== (capture.source_kind === "thread")
  )
    throw new HttpError(403, "slack_source", "The Slack source is no longer available.");
  return source;
}

async function authorizedCaptureContext(env: Env, capture: CaptureRow) {
  const session = await env.DB.prepare(
    `SELECT slack_user_id, identity_json, state_json FROM slack_product_sessions
      WHERE capture_id = ? AND installation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
    .bind(capture.id, capture.installation_id)
    .first<{ slack_user_id: string; identity_json: string; state_json: string }>();
  const installation = await env.DB.prepare(
    `SELECT * FROM slack_installations WHERE id = ? AND generation = ? AND disconnected_at IS NULL`,
  )
    .bind(capture.installation_id, capture.installation_generation)
    .first<SlackInstallation>();
  if (!installation) throw new HttpError(403, "slack_capture_unavailable", "Reconnect Slack and retry this capture.");
  if (!session)
    throw new HttpError(
      403,
      "slack_capture_session_expired",
      "Open the Slack shortcut again and resubmit. If a NoteFlare job already exists, retry it in Activities.",
    );
  const { member } = await verifiedMember(env, installation, session.slack_user_id, JSON.parse(session.identity_json));
  if (member.user.id !== capture.requested_by || member.workspace.id !== capture.workspace_id)
    throw new HttpError(403, "slack_capture_unavailable", "This capture is no longer available.");
  await sourceCall(() => validateChannel(env, installation, capture.channel_id));
  await sourceCall(() => requireChannelMember(env, installation, capture.channel_id, session.slack_user_id));
  const space = await env.DB.prepare(
    `SELECT s.visibility, sm.role space_role FROM spaces s
       LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=?
      WHERE s.id=? AND s.workspace_id=?`,
  )
    .bind(member.user.id, capture.destination_space_id, capture.workspace_id)
    .first<{ visibility: "workspace" | "private"; space_role: "editor" | "viewer" | null }>();
  if (
    !space ||
    !["owner", "editor"].includes(effectiveSpaceRole(member.role, space.visibility, space.space_role) ?? "")
  )
    throw new HttpError(403, "slack_capture_unavailable", "Choose a writable destination and retry.");
  if (capture.destination_parent_id) {
    const parent = await pageForMember(env, member, capture.destination_parent_id);
    if (parent.effective_role === "viewer" || parent.space_id !== capture.destination_space_id || parent.is_template)
      throw new HttpError(403, "slack_capture_unavailable", "Choose a writable parent and retry.");
    if (capture.target_kind === "task" && !parent.is_task_list)
      throw new HttpError(422, "task_list_required", "Choose a task list for a task capture.");
  }
  if (capture.target_kind === "task") {
    if (!capture.destination_parent_id || !capture.task_fields_json)
      throw new HttpError(422, "task_list_required", "Choose a task list for a task capture.");
    const fields = JSON.parse(capture.task_fields_json) as { assigneeId: string | null };
    if (
      fields.assigneeId &&
      !(await taskAssignees(env, member, capture.destination_parent_id)).some((user) => user.id === fields.assigneeId)
    )
      throw new HttpError(403, "invalid_assignee", "The assignee no longer has access to this task list.");
  }
  return { session, installation };
}

export async function recheckSlackCapturePublication(env: Env, captureId: string, jobId: string) {
  const capture = await env.DB.prepare(`SELECT * FROM slack_captures WHERE id = ?`).bind(captureId).first<CaptureRow>();
  if (!capture || capture.job_id !== jobId || capture.state !== "running")
    throw new HttpError(409, "job_failed", "The Slack capture receipt changed. Retry the capture.");
  const { session, installation } = await authorizedCaptureContext(env, capture);
  const source = captureSource(session, capture);
  if (capture.source_kind === "message") {
    await sourceMessages(env, installation, capture, source);
  } else {
    await exactThreadMessage(env, installation, capture.channel_id, capture.source_ts, capture.source_ts);
  }
}

export async function authorizeSlackCaptureJobRetry(env: Env, captureId: string, jobId: string) {
  const capture = await env.DB.prepare(`SELECT * FROM slack_captures WHERE id=?`).bind(captureId).first<CaptureRow>();
  if (!capture || capture.job_id !== jobId || !["failed", "running"].includes(capture.state))
    throw new HttpError(409, "slack_capture_unavailable", "This Slack capture cannot be retried.");
  await authorizedCaptureContext(env, capture);
}

function captureInputKey(capture: CaptureRow) {
  return `jobs/${capture.id}/input/slack-${capture.installation_generation}.md`;
}

async function deleteSupersededCaptureInputs(env: Env, capture: CaptureRow) {
  const prefix = `jobs/${capture.id}/input/`;
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, ...(cursor ? { cursor } : {}) });
    const old = page.objects
      .filter((object) => {
        const name = object.key.slice(prefix.length);
        if (name === "slack.md") return true;
        const generation = /^slack-(\d+)\.md$/.exec(name);
        return generation && Number(generation[1]) < capture.installation_generation;
      })
      .map((object) => object.key);
    if (old.length) await env.BUCKET.delete(old);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function stageCaptureInput(
  env: Env,
  capture: CaptureRow,
  session: { state_json: string },
  installation: SlackInstallation,
) {
  const inputKey = captureInputKey(capture);
  if (await env.BUCKET.head(inputKey)) return inputKey;
  const source = captureSource(session, capture);
  const { permalink } = await sourceCall(() =>
    slackApi(env, installation, "chat.getPermalink", {
      channel: capture.channel_id,
      message_ts: capture.source_ts,
    }),
  );
  const markdown = captureMarkdown({
    title: capture.title,
    ...(capture.body ? { description: capture.body } : {}),
    permalink,
    capturedAt: Date.now(),
    messages: await sourceMessages(env, installation, capture, source),
  });
  // A reconnect can supersede this worker while it fetches Slack. A generation
  // specific key prevents its old transcript from replacing the new input.
  const current = await env.DB.prepare(`SELECT installation_generation FROM slack_captures WHERE id=?`)
    .bind(capture.id)
    .first<{ installation_generation: number }>();
  if (current?.installation_generation !== capture.installation_generation)
    throw new Error("The Slack installation changed during capture staging.");
  await env.BUCKET.put(inputKey, markdown, {
    httpMetadata: { contentType: "text/markdown" },
    customMetadata: { captureId: capture.id, installationGeneration: String(capture.installation_generation) },
  });
  return inputKey;
}

export async function resumeSlackCaptureJob(env: Env, captureId: string, jobId: string, attempt: number) {
  const capture = await env.DB.prepare(`SELECT * FROM slack_captures WHERE id=?`).bind(captureId).first<CaptureRow>();
  if (!capture || capture.job_id !== jobId)
    throw new HttpError(409, "slack_capture_unavailable", "This Slack capture cannot be resumed.");
  if (capture.state !== "running" && (capture.state !== "failed" || attempt < 2))
    throw new HttpError(409, "slack_capture_unavailable", "This Slack capture cannot be resumed.");
  if (capture.state === "running" && attempt === 1) {
    const current = await env.DB.prepare(`SELECT input_key FROM jobs WHERE id=? AND attempt=1 AND status='running'`)
      .bind(jobId)
      .first<{ input_key: string | null }>();
    const inputKey = captureInputKey(capture);
    if (current?.input_key === inputKey && (await env.BUCKET.head(inputKey))) return inputKey;
  }
  const { session, installation } = await authorizedCaptureContext(env, capture);
  const inputKey = await stageCaptureInput(env, capture, session, installation);
  const input = await env.DB.prepare(
    `UPDATE jobs SET input_key=?,updated_at=? WHERE id=? AND attempt=? AND status='running' RETURNING input_key`,
  )
    .bind(inputKey, Date.now(), jobId, attempt)
    .first<{ input_key: string }>();
  if (!input) throw new HttpError(409, "slack_capture_unavailable", "This Slack capture cannot be resumed.");
  await deleteSupersededCaptureInputs(env, capture);
  if (capture.state === "running") return input.input_key;
  const resumed = await env.DB.prepare(
    `UPDATE slack_captures SET state='running',error_category=NULL,attempt=attempt+1,updated_at=?
     WHERE id=? AND job_id=? AND state='failed'
       AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND attempt=? AND status='running')`,
  )
    .bind(Date.now(), captureId, jobId, jobId, attempt)
    .run();
  if (!resumed.meta.changes)
    throw new HttpError(409, "slack_capture_unavailable", "This Slack capture cannot be resumed.");
  return input.input_key;
}

export async function retryFailedSlackCapture(env: Env, captureId: string) {
  const capture = await env.DB.prepare(`SELECT * FROM slack_captures WHERE id=?`).bind(captureId).first<CaptureRow>();
  if (!capture) throw new HttpError(404, "slack_capture_unavailable", "Reopen the capture form.");
  if (capture.state !== "failed" || capture.job_id) return capture;
  await authorizedCaptureContext(env, capture);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE slack_captures SET state='pending',error_category=NULL,attempt=attempt+1,updated_at=?
       WHERE id=? AND state='failed' AND job_id IS NULL`,
    ).bind(now, capture.id),
    env.DB.prepare(
      `INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
       SELECT ?,workspace_id,'slack_capture',?,?,? FROM slack_captures WHERE id=? AND state='pending'
       ON CONFLICT(id) DO UPDATE SET available_at=excluded.available_at,enqueued_at=NULL,last_error=NULL`,
    ).bind(`slack-capture:${capture.id}`, JSON.stringify({ captureId: capture.id }), now, now, capture.id),
  ]);
  return { ...capture, state: "pending" as const };
}

export async function deliverSlackCaptureFeedback(
  env: Env,
  captureId: string,
  state: "queued" | "succeeded" | "failed",
) {
  const capture = await env.DB.prepare(`SELECT * FROM slack_captures WHERE id=?`).bind(captureId).first<CaptureRow>();
  if (
    !capture ||
    (state === "queued" && capture.state !== "pending" && capture.state !== "running") ||
    (state !== "queued" && capture.state !== state)
  )
    return;
  const session = await env.DB.prepare(
    `SELECT slack_user_id,identity_json FROM slack_product_sessions
      WHERE capture_id=? AND installation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`,
  )
    .bind(capture.id, capture.installation_id)
    .first<{ slack_user_id: string; identity_json: string }>();
  const installation = await env.DB.prepare(
    `SELECT * FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL`,
  )
    .bind(capture.installation_id, capture.installation_generation)
    .first<SlackInstallation>();
  if (!session || !installation) return;
  try {
    await verifiedMember(env, installation, session.slack_user_id, JSON.parse(session.identity_json));
    await validateChannel(env, installation, capture.channel_id);
    await requireChannelMember(env, installation, capture.channel_id, session.slack_user_id);
  } catch (error) {
    if (error instanceof HttpError && error.status >= 400 && error.status < 500) return;
    throw error;
  }
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  const message =
    state === "queued"
      ? "Your Slack capture is queued. The page will appear after verification."
      : state === "succeeded" && capture.page_id
        ? `Saved to NoteFlare: ${origin}/?page=${encodeURIComponent(capture.page_id)}`
        : capture.job_id
          ? `Your Slack capture could not be saved. Open ${origin}/?activity=1 to review and retry it.`
          : "Your Slack capture could not be saved. Use Retry capture in the Slack form.";
  await slackApi(env, installation, "chat.postEphemeral", {
    channel: capture.channel_id,
    user: session.slack_user_id,
    text: message,
  });
}

export async function prepareSlackCapture(env: Env, captureId: string): Promise<JobRow | null> {
  const capture = await env.DB.prepare(`SELECT * FROM slack_captures WHERE id = ?`).bind(captureId).first<CaptureRow>();
  if (!capture || capture.state === "succeeded" || capture.state === "failed") return null;
  const { session, installation } = await authorizedCaptureContext(env, capture);
  const existingJob = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(capture.id).first<JobRow>();
  if (existingJob) {
    if (existingJob.workspace_id !== capture.workspace_id || existingJob.requested_by !== capture.requested_by)
      throw new Error("The Slack capture job receipt could not be verified.");
    if (existingJob.status !== "queued" && existingJob.status !== "running") {
      const failed = await env.DB.prepare(
        `UPDATE slack_captures SET job_id=?,state='failed',error_category='job_failed',updated_at=?
         WHERE id=? AND installation_generation=?
           AND ((state='pending' AND job_id IS NULL) OR (state='running' AND job_id=?))`,
      )
        .bind(existingJob.id, Date.now(), capture.id, capture.installation_generation, existingJob.id)
        .run();
      if (failed.meta.changes) await captureFeedbackStatement(env.DB, capture.id, "failed", Date.now()).run();
      return null;
    }
    if (capture.state === "running" && capture.job_id === existingJob.id) {
      await deleteSupersededCaptureInputs(env, capture);
      return existingJob;
    }
    if (capture.state !== "pending" || capture.job_id) throw new Error("The Slack capture receipt changed.");
    const inputKey = captureInputKey(capture);
    if (existingJob.status === "running" && existingJob.input_key !== inputKey) {
      const failed = await env.DB.prepare(
        `UPDATE slack_captures SET job_id=?,state='failed',error_category='job_failed',updated_at=?
         WHERE id=? AND installation_generation=? AND state='pending' AND job_id IS NULL`,
      )
        .bind(existingJob.id, Date.now(), capture.id, capture.installation_generation)
        .run();
      if (failed.meta.changes) await captureFeedbackStatement(env.DB, capture.id, "failed", Date.now()).run();
      return null;
    }
    if (existingJob.status === "queued") await stageCaptureInput(env, capture, session, installation);
    const timestamp = Date.now();
    const linked = await env.DB.batch([
      env.DB.prepare(
        `UPDATE jobs SET input_key=?,updated_at=? WHERE id=? AND input_key IS ? AND status='queued'
         AND EXISTS (SELECT 1 FROM slack_captures WHERE id=? AND installation_generation=? AND state='pending')`,
      ).bind(inputKey, timestamp, existingJob.id, existingJob.input_key, capture.id, capture.installation_generation),
      env.DB.prepare(
        `UPDATE slack_captures SET job_id=?,state='running',attempt=attempt+1,updated_at=?
         WHERE id=? AND installation_generation=? AND state='pending' AND job_id IS NULL
           AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND input_key=? AND status IN ('queued','running'))`,
      ).bind(existingJob.id, timestamp, capture.id, capture.installation_generation, existingJob.id, inputKey),
    ]);
    if (!linked[1]?.meta.changes) throw new Error("The Slack capture changed during job staging.");
    await deleteSupersededCaptureInputs(env, capture);
    return (await env.DB.prepare(`SELECT * FROM jobs WHERE id=?`).bind(existingJob.id).first<JobRow>())!;
  }
  const inputKey = await stageCaptureInput(env, capture, session, installation);
  const timestamp = Date.now();
  const options = {
    filename: "slack.md",
    format: "markdown",
    confirmed: true,
    previewId: "slack-capture",
    captureId: capture.id,
    title: capture.title,
    groupSpaceIds: { Imported: capture.destination_space_id },
    previewGroupKeys: ["Imported"],
    ...(capture.destination_parent_id ? { parentId: capture.destination_parent_id } : {}),
    ...(capture.target_kind === "task" && capture.task_fields_json
      ? { task: { listId: capture.destination_parent_id, ...JSON.parse(capture.task_fields_json) } }
      : {}),
  };
  const linked = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO jobs
      (id, workspace_id, space_id, type, status, requested_by, workflow_instance_id, input_key,
       options_json, created_at, updated_at)
     SELECT id,workspace_id,destination_space_id,'import','queued',requested_by,id,?,?,?,?
       FROM slack_captures
      WHERE id=? AND installation_generation=? AND state='pending' AND job_id IS NULL`).bind(
      inputKey,
      JSON.stringify(options),
      timestamp,
      timestamp,
      capture.id,
      capture.installation_generation,
    ),
    env.DB.prepare(
      `UPDATE slack_captures SET job_id=?,state='running',attempt=attempt+1,updated_at=?
       WHERE id=? AND installation_generation=? AND state='pending' AND job_id IS NULL
         AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND input_key=? AND status='queued')`,
    ).bind(capture.id, timestamp, capture.id, capture.installation_generation, capture.id, inputKey),
  ]);
  const job = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(capture.id).first<JobRow>();
  if (!linked[1]?.meta.changes) {
    const current = await env.DB.prepare(`SELECT installation_generation,job_id,state FROM slack_captures WHERE id=?`)
      .bind(capture.id)
      .first<Pick<CaptureRow, "installation_generation" | "job_id" | "state">>();
    if (current?.installation_generation !== capture.installation_generation) await env.BUCKET.delete(inputKey);
    if (current?.job_id !== job?.id || current?.state !== "running")
      throw new Error("The Slack capture changed during job staging.");
  }
  if (
    !job ||
    job.workspace_id !== capture.workspace_id ||
    job.requested_by !== capture.requested_by ||
    job.input_key !== inputKey
  )
    throw new Error("The Slack capture job receipt could not be verified.");
  await deleteSupersededCaptureInputs(env, capture);
  return job;
}
