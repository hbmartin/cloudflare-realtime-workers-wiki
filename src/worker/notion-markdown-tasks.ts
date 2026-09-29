import type { Env } from "./env";

const RESULT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const LEASE_MS = 60_000;

export type MarkdownTaskRow = {
  id: string;
  workspace_id: string;
  integration_id: string;
  page_id: string;
  page_epoch: number;
  request_json: string;
  request_key_hash: string | null;
  target_signature: string;
  operation_id: string;
  status: "queued" | "running" | "retrying" | "succeeded" | "failed";
  attempts: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  next_attempt_at: number;
  result_json: string | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

export async function createMarkdownTask(
  env: Env,
  input: Pick<
    MarkdownTaskRow,
    | "id"
    | "workspace_id"
    | "integration_id"
    | "page_id"
    | "page_epoch"
    | "request_json"
    | "request_key_hash"
    | "target_signature"
    | "operation_id"
  >,
) {
  const now = Date.now();
  const inserted = await env.DB.prepare(
    `INSERT INTO notion_markdown_tasks
      (id,workspace_id,integration_id,page_id,page_epoch,request_json,request_key_hash,target_signature,operation_id,
       status,next_attempt_at,created_at,updated_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?,?,?)
     ON CONFLICT(integration_id,request_key_hash) DO NOTHING RETURNING *`,
  )
    .bind(
      input.id,
      input.workspace_id,
      input.integration_id,
      input.page_id,
      input.page_epoch,
      input.request_json,
      input.request_key_hash,
      input.target_signature,
      input.operation_id,
      now,
      now,
      now,
      now + RESULT_RETENTION_MS,
    )
    .first<MarkdownTaskRow>();
  if (inserted) return { row: inserted, created: true };
  const existing = await env.DB.prepare(
    `SELECT * FROM notion_markdown_tasks WHERE integration_id=? AND request_key_hash=?`,
  )
    .bind(input.integration_id, input.request_key_hash)
    .first<MarkdownTaskRow>();
  if (!existing) throw new Error("The Markdown task could not be created.");
  return { row: existing, created: false };
}

export async function markdownTaskForIntegration(env: Env, id: string, workspaceId: string, integrationId: string) {
  return env.DB.prepare(
    `SELECT * FROM notion_markdown_tasks
      WHERE id=? AND workspace_id=? AND integration_id=? AND expires_at>?`,
  )
    .bind(id, workspaceId, integrationId, Date.now())
    .first<MarkdownTaskRow>();
}

export async function markdownTaskForRequestKey(env: Env, integrationId: string, requestKeyHash: string) {
  return env.DB.prepare(`SELECT * FROM notion_markdown_tasks WHERE integration_id=? AND request_key_hash=?`)
    .bind(integrationId, requestKeyHash)
    .first<MarkdownTaskRow>();
}

export async function claimMarkdownTask(env: Env, id: string) {
  const now = Date.now();
  const leaseToken = crypto.randomUUID();
  const row = await env.DB.prepare(
    `UPDATE notion_markdown_tasks SET status='running',attempts=attempts+1,
       lease_token=?,lease_expires_at=?,updated_at=?
     WHERE id=? AND status IN ('queued','running','retrying') AND next_attempt_at<=?
       AND (lease_expires_at IS NULL OR lease_expires_at<=?) AND expires_at>?
     RETURNING *`,
  )
    .bind(leaseToken, now + LEASE_MS, now, id, now, now, now)
    .first<MarkdownTaskRow>();
  return row;
}

export async function completeMarkdownTask(env: Env, row: MarkdownTaskRow, result: unknown) {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE notion_markdown_tasks SET status='succeeded',result_json=?,error_json=NULL,
       lease_token=NULL,lease_expires_at=NULL,updated_at=?,expires_at=?
     WHERE id=? AND status='running' AND lease_token=?`,
  )
    .bind(JSON.stringify(result), now, now + RESULT_RETENTION_MS, row.id, row.lease_token)
    .run();
}

export async function failMarkdownTask(env: Env, row: MarkdownTaskRow, error: unknown, retry: boolean) {
  const now = Date.now();
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(row.attempts, 6));
  await env.DB.prepare(
    `UPDATE notion_markdown_tasks SET status=?,error_json=?,lease_token=NULL,lease_expires_at=NULL,
       next_attempt_at=?,updated_at=?,expires_at=?
     WHERE id=? AND status='running' AND lease_token=?`,
  )
    .bind(
      retry ? "retrying" : "failed",
      retry ? null : JSON.stringify(error),
      retry ? now + delay : now,
      now,
      retry ? row.expires_at : now + RESULT_RETENTION_MS,
      row.id,
      row.lease_token,
    )
    .run();
}

export async function dueMarkdownTasks(env: Env) {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT id FROM notion_markdown_tasks
      WHERE status IN ('queued','running','retrying') AND next_attempt_at<=?
        AND (lease_expires_at IS NULL OR lease_expires_at<=?) AND expires_at>?
      ORDER BY next_attempt_at,id LIMIT 5`,
  )
    .bind(now, now, now)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

export async function pruneMarkdownTasks(env: Env) {
  const now = Date.now();
  await env.DB.prepare(
    `DELETE FROM notion_markdown_tasks WHERE id IN
      (SELECT id FROM notion_markdown_tasks WHERE expires_at<=? ORDER BY expires_at LIMIT 100)`,
  )
    .bind(now)
    .run();
}

export function markdownTaskJson(row: MarkdownTaskRow, requestUrl: string) {
  const statusUrl = new URL(`/v1/async_tasks/${encodeURIComponent(row.id)}`, requestUrl).toString();
  return {
    object: "async_task" as const,
    id: row.id,
    status: row.status,
    status_url: statusUrl,
    created_time: new Date(row.created_at).toISOString(),
    ...(["queued", "running", "retrying"].includes(row.status) ? { poll_after_seconds: 2 } : {}),
    operation: { surface: "rest" as const, name: "PATCH /v1/pages/:page_id/markdown" },
    ...(row.status === "succeeded" && row.result_json ? { result: JSON.parse(row.result_json) as unknown } : {}),
    ...(row.status === "failed" && row.error_json ? { error: JSON.parse(row.error_json) as unknown } : {}),
  };
}
