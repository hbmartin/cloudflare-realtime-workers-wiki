import type { Env } from "./env";
import { locationHint } from "./http";
import { TABLE_BULK_RECEIPT_TTL_MS } from "../shared/table-limits";

type DeletionTargetKind = "document_do" | "r2_object" | "r2_prefix";

interface DeletionJobRow {
  id: string;
  attempts: number;
  workspace_id: string;
}

interface DeletionTargetRow {
  kind: DeletionTargetKind;
  target: string;
}

const CLEANUP_LEASE_MS = 15 * 60_000;
const DOCUMENT_PURGE_TIMEOUT_MS = 30_000;

async function deletePrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, limit: 1_000, ...(cursor ? { cursor } : {}) });
    if (listed.objects.length) await bucket.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function processTarget(env: Env, target: DeletionTargetRow, hint?: DurableObjectLocationHint) {
  if (target.kind === "r2_object") {
    await env.BUCKET.delete(target.target);
    return;
  }
  if (target.kind === "r2_prefix") {
    await deletePrefix(env.BUCKET, target.target);
    return;
  }
  const stub = env.DOCUMENT.getByName(target.target, hint ? { locationHint: hint } : undefined);
  const response = await stub.fetch(
    new Request("https://document.internal/purge", {
      method: "POST",
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      signal: AbortSignal.timeout(DOCUMENT_PURGE_TIMEOUT_MS),
    }),
  );
  if (!response.ok) throw new Error(`Document purge failed with ${response.status}`);
}

export async function processDeletionJob(env: Env, jobId: string) {
  const claimedAt = Date.now();
  const leaseUntil = claimedAt + CLEANUP_LEASE_MS;
  const job = await env.DB.prepare(
    `UPDATE deletion_jobs
        SET next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND next_attempt_at <= ?
      RETURNING id, attempts, workspace_id`,
  )
    .bind(leaseUntil, claimedAt, jobId, claimedAt)
    .first<DeletionJobRow>();
  if (!job) return;

  const targets = await env.DB.prepare(
    `SELECT kind, target FROM deletion_targets
      WHERE job_id = ? AND completed_at IS NULL
      ORDER BY CASE kind WHEN 'document_do' THEN 0 WHEN 'r2_object' THEN 1 ELSE 2 END, target`,
  )
    .bind(job.id)
    .all<DeletionTargetRow>();

  let hint: DurableObjectLocationHint | undefined;
  if (targets.results.some((target) => target.kind === "document_do")) {
    const workspace = await env.DB.prepare(`SELECT location_hint FROM workspaces WHERE id = ?`)
      .bind(job.workspace_id)
      .first<{ location_hint: string | null }>();
    hint = locationHint(workspace?.location_hint ?? undefined);
  }

  for (const target of targets.results) {
    try {
      await processTarget(env, target, hint);
      await env.DB.prepare(
        `UPDATE deletion_targets
            SET completed_at = ?, attempts = attempts + 1, last_error = NULL
          WHERE job_id = ? AND kind = ? AND target = ?
            AND EXISTS (
              SELECT 1 FROM deletion_jobs WHERE id = ? AND next_attempt_at = ?
            )`,
      )
        .bind(Date.now(), job.id, target.kind, target.target, job.id, leaseUntil)
        .run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown cleanup failure";
      await env.DB.prepare(
        `UPDATE deletion_targets
            SET attempts = attempts + 1, last_error = ?
          WHERE job_id = ? AND kind = ? AND target = ?
            AND EXISTS (
              SELECT 1 FROM deletion_jobs WHERE id = ? AND next_attempt_at = ?
            )`,
      )
        .bind(message.slice(0, 1_000), job.id, target.kind, target.target, job.id, leaseUntil)
        .run();
    }
  }

  const pending = await env.DB.prepare(
    `SELECT COUNT(*) count FROM deletion_targets WHERE job_id = ? AND completed_at IS NULL`,
  )
    .bind(job.id)
    .first<{ count: number }>();
  if (!pending?.count) {
    await env.DB.prepare(`DELETE FROM deletion_jobs WHERE id = ? AND next_attempt_at = ?`)
      .bind(job.id, leaseUntil)
      .run();
    return;
  }

  const attempts = job.attempts + 1;
  const delay = Math.min(24 * 60 * 60_000, 60 * 60_000 * 2 ** Math.min(attempts - 1, 4));
  const failed = await env.DB.prepare(
    `SELECT last_error FROM deletion_targets
      WHERE job_id = ? AND completed_at IS NULL AND last_error IS NOT NULL LIMIT 1`,
  )
    .bind(job.id)
    .first<{ last_error: string }>();
  await env.DB.prepare(
    `UPDATE deletion_jobs
        SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND next_attempt_at = ?`,
  )
    .bind(attempts, Date.now() + delay, failed?.last_error ?? "Cleanup incomplete", Date.now(), job.id, leaseUntil)
    .run();
}

export async function processDueDeletionJobs(env: Env, limit = 10) {
  const jobs = await env.DB.prepare(
    `SELECT id FROM deletion_jobs WHERE next_attempt_at <= ? ORDER BY created_at LIMIT ?`,
  )
    .bind(Date.now(), limit)
    .all<{ id: string }>();
  for (const job of jobs.results) await processDeletionJob(env, job.id);
}

// Bulk-write receipts exist only so a request whose response was lost can be replayed
// instead of appending its rows a second time. Past the TTL the caller has long since
// stopped waiting, so the receipt is dead weight on a table's cascade.
export async function pruneBulkWriteReceipts(env: Env, before = Date.now() - TABLE_BULK_RECEIPT_TTL_MS) {
  await env.DB.prepare(`DELETE FROM table_bulk_writes WHERE created_at < ?`).bind(before).run();
}
