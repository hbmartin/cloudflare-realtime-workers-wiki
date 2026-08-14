import type { Env } from "./env";

type DeletionTargetKind = "document_do" | "r2_object" | "r2_prefix";

interface DeletionJobRow {
  id: string;
  attempts: number;
}

interface DeletionTargetRow {
  kind: DeletionTargetKind;
  target: string;
}

async function deletePrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1_000 });
    if (listed.objects.length) await bucket.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function processTarget(env: Env, target: DeletionTargetRow) {
  if (target.kind === "r2_object") {
    await env.BUCKET.delete(target.target);
    return;
  }
  if (target.kind === "r2_prefix") {
    await deletePrefix(env.BUCKET, target.target);
    return;
  }
  const stub = env.DOCUMENT.getByName(target.target);
  const response = await stub.fetch(new Request("https://document.internal/purge", {
    method: "POST",
    headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
  }));
  if (!response.ok) throw new Error(`Document purge failed with ${response.status}`);
}

export async function processDeletionJob(env: Env, jobId: string) {
  const job = await env.DB.prepare(
    `SELECT id, attempts FROM deletion_jobs WHERE id = ?`,
  ).bind(jobId).first<DeletionJobRow>();
  if (!job) return;

  const targets = await env.DB.prepare(
    `SELECT kind, target FROM deletion_targets
      WHERE job_id = ? AND completed_at IS NULL
      ORDER BY CASE kind WHEN 'document_do' THEN 0 WHEN 'r2_object' THEN 1 ELSE 2 END, target`,
  ).bind(job.id).all<DeletionTargetRow>();

  for (const target of targets.results) {
    try {
      await processTarget(env, target);
      await env.DB.prepare(
        `UPDATE deletion_targets
            SET completed_at = ?, attempts = attempts + 1, last_error = NULL
          WHERE job_id = ? AND kind = ? AND target = ?`,
      ).bind(Date.now(), job.id, target.kind, target.target).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown cleanup failure";
      await env.DB.prepare(
        `UPDATE deletion_targets
            SET attempts = attempts + 1, last_error = ?
          WHERE job_id = ? AND kind = ? AND target = ?`,
      ).bind(message.slice(0, 1_000), job.id, target.kind, target.target).run();
    }
  }

  const pending = await env.DB.prepare(
    `SELECT COUNT(*) count FROM deletion_targets WHERE job_id = ? AND completed_at IS NULL`,
  ).bind(job.id).first<{ count: number }>();
  if (!pending?.count) {
    await env.DB.prepare(`DELETE FROM deletion_jobs WHERE id = ?`).bind(job.id).run();
    return;
  }

  const attempts = job.attempts + 1;
  const delay = Math.min(24 * 60 * 60_000, 60 * 60_000 * 2 ** Math.min(attempts - 1, 4));
  const failed = await env.DB.prepare(
    `SELECT last_error FROM deletion_targets
      WHERE job_id = ? AND completed_at IS NULL AND last_error IS NOT NULL LIMIT 1`,
  ).bind(job.id).first<{ last_error: string }>();
  await env.DB.prepare(
    `UPDATE deletion_jobs
        SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(attempts, Date.now() + delay, failed?.last_error ?? "Cleanup incomplete", Date.now(), job.id).run();
}

export async function processDueDeletionJobs(env: Env, limit = 10) {
  const jobs = await env.DB.prepare(
    `SELECT id FROM deletion_jobs WHERE next_attempt_at <= ? ORDER BY created_at LIMIT ?`,
  ).bind(Date.now(), limit).all<{ id: string }>();
  for (const job of jobs.results) await processDeletionJob(env, job.id);
}
