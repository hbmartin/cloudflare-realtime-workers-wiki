import type { Env } from "./env";
import { locationHint } from "./http";
import { correlationHeaders, safeTelemetryErrorMessage } from "./observability";
import { HttpError } from "./http";
import type { PageRow } from "./page-access";

type DeletionTargetKind = "document_do" | "table_do" | "table_row" | "r2_object" | "r2_prefix";

interface DeletionJobRow {
  id: string;
  attempts: number;
  workspace_id: string;
  phase: "staging" | "rows" | "cleanup";
  root_page_id: string;
}

interface DeletionTargetRow {
  kind: DeletionTargetKind;
  target: string;
}

const CLEANUP_LEASE_MS = 15 * 60_000;
const DOCUMENT_PURGE_TIMEOUT_MS = 30_000;

const REPAIRING_DELETION_ANCESTRY_SQL = `EXISTS(WITH RECURSIVE ancestors(id,workspace_id) AS (
  SELECT page.id,page.workspace_id FROM deletion_job_pages locked JOIN deletion_jobs job ON job.id=locked.job_id
    JOIN pages page ON page.id=locked.page_id AND page.workspace_id=job.workspace_id WHERE job.id=?
  UNION
  SELECT parent.id,parent.workspace_id FROM ancestors child JOIN pages page ON page.id=child.id
    JOIN pages parent ON parent.id=page.parent_id AND parent.workspace_id=child.workspace_id
  UNION
  SELECT parent.id,parent.workspace_id FROM ancestors child JOIN page_import_sources source
    ON source.page_id=child.id AND source.source_role='table_row_detail'
    JOIN page_import_sources provenance ON source.job_id IS NOT NULL AND provenance.job_id=source.job_id
      AND source.parent_source_path IS NOT NULL AND provenance.source_path=source.parent_source_path
    JOIN pages parent ON parent.id=provenance.page_id AND parent.workspace_id=child.workspace_id
) SELECT 1 FROM ancestors JOIN table_authority authority ON authority.page_id=ancestors.id WHERE authority.state='repairing')`;

export const ACCEPTED_PAGE_DELETION_SQL = `EXISTS(SELECT 1 FROM deletion_job_pages lock
 JOIN deletion_jobs job ON job.id=lock.job_id WHERE lock.page_id=p.id
 AND job.workspace_id=p.workspace_id AND job.phase IN ('rows','cleanup'))`;

export const TASK_DELETION_PENDING_SQL = `EXISTS(SELECT 1 FROM deletion_job_pages lock
 JOIN deletion_jobs job ON job.id=lock.job_id JOIN table_row_pages link ON link.page_id=lock.page_id
 WHERE job.phase='rows' AND link.row_id=?) OR EXISTS(SELECT 1 FROM deletion_targets target
 JOIN deletion_jobs job ON job.id=target.job_id WHERE job.phase='rows' AND target.kind='table_row'
 AND json_extract(target.target,'$.rowId')=?)`;

export async function requireTaskRestorable(env: Env, rowId: string) {
  const pending = await env.DB.prepare(`SELECT 1 pending WHERE ${TASK_DELETION_PENDING_SQL}`)
    .bind(rowId, rowId)
    .first();
  if (pending)
    throw new HttpError(409, "deletion_pending", "Permanent deletion has already been accepted for this task.");
}

export async function pendingPageDeletion(env: Env, pageId: string) {
  return env.DB.prepare(`WITH RECURSIVE subtree(id) AS (
    SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id=s.id
  ) SELECT job.id FROM deletion_job_pages lock JOIN deletion_jobs job ON job.id=lock.job_id
    WHERE lock.page_id IN subtree AND job.phase='rows' LIMIT 1`)
    .bind(pageId)
    .first<{ id: string }>();
}

export async function acceptedDeletionJob(env: Env, workspaceId: string, rootId: string) {
  const job = await env.DB.prepare(`SELECT id FROM deletion_jobs
    WHERE workspace_id=? AND root_page_id=? AND phase IN ('rows','cleanup') ORDER BY created_at LIMIT 1`)
    .bind(workspaceId, rootId)
    .first<{ id: string }>();
  if (!job) return null;
  const pages = await env.DB.prepare("SELECT page_id FROM deletion_job_pages WHERE job_id=? ORDER BY page_id")
    .bind(job.id)
    .all<{ page_id: string }>();
  return { jobId: job.id, pageIds: pages.results.map((page) => page.page_id) };
}

/** Staging is disposable. Once activated, this intent survives every cleanup failure. */
export async function acceptPageDeletion(env: Env, workspaceId: string, actorId: string, rootId: string) {
  const previous = await acceptedDeletionJob(env, workspaceId, rootId);
  if (previous) return previous;
  const pages = await env.DB.prepare(`WITH RECURSIVE subtree(id) AS (
    SELECT id FROM pages WHERE id=? AND workspace_id=?
    UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id=s.id
  ) SELECT * FROM pages WHERE id IN subtree`)
    .bind(rootId, workspaceId)
    .all<PageRow>();
  if (!pages.results.length || pages.results.some((page) => page.archived_at === null))
    throw new HttpError(409, "archive_first", "Archive the whole page subtree before permanently deleting it.");
  const pageIds = pages.results.map((page) => page.id);
  const serializedIds = JSON.stringify(pageIds);
  const attachments =
    await env.DB.prepare(`SELECT r2_key FROM attachments WHERE page_id IN (SELECT value FROM json_each(?))
    UNION ALL SELECT r2_key FROM attachment_uploads WHERE page_id IN (SELECT value FROM json_each(?)) AND state IN ('r2_complete','committed')`)
      .bind(serializedIds, serializedIds)
      .all<{ r2_key: string }>();
  const targets = new Map<string, DeletionTargetRow>();
  for (const page of pages.results) {
    if (page.kind === "table") targets.set(`table:${page.id}`, { kind: "table_do", target: page.id });
    else if (page.kind === "document" || page.kind === "diagram") {
      targets.set(`prefix:${page.id}`, {
        kind: "r2_prefix",
        target: `${page.kind === "diagram" ? "diagrams" : "documents"}/${page.id}/`,
      });
      for (let epoch = 1; epoch <= page.content_epoch; epoch++)
        targets.set(`document:${page.id}:${epoch}`, { kind: "document_do", target: `${page.id}~${epoch}` });
    }
  }
  for (const attachment of attachments.results)
    targets.set(`object:${attachment.r2_key}`, { kind: "r2_object", target: attachment.r2_key });
  const details = await env.DB.prepare(`SELECT link.page_id detailPageId,row.id rowId,row.page_id tableId,a.generation
    FROM table_row_pages link JOIN table_rows row ON row.id=link.row_id
    JOIN table_authority a ON a.page_id=row.page_id AND a.state IN ('seeding','do','repairing')
    WHERE link.page_id IN (SELECT value FROM json_each(?)) AND row.page_id NOT IN (SELECT value FROM json_each(?))`)
    .bind(serializedIds, serializedIds)
    .all<{ detailPageId: string; rowId: string; tableId: string; generation: number }>();
  for (const detail of details.results)
    targets.set(`row:${detail.rowId}`, { kind: "table_row", target: JSON.stringify(detail) });
  const jobId = crypto.randomUUID();
  const timestamp = Date.now();
  try {
    await env.DB.prepare(`INSERT INTO deletion_jobs(id,workspace_id,root_page_id,next_attempt_at,created_at,updated_at,phase,actor_id)
      VALUES(?,?,?,?,?,?,'staging',?)`)
      .bind(jobId, workspaceId, rootId, Number.MAX_SAFE_INTEGER, timestamp, timestamp, actorId)
      .run();
    const statements = [
      ...pages.results.map((page) =>
        env.DB.prepare(
          `INSERT INTO deletion_job_pages(job_id,page_id,archive_operation_id,archived_at) VALUES(?,?,?,?)`,
        ).bind(jobId, page.id, page.archive_operation_id ?? null, page.archived_at),
      ),
      ...[...targets.values()].map((target) =>
        env.DB.prepare("INSERT INTO deletion_targets(job_id,kind,target) VALUES(?,?,?)").bind(
          jobId,
          target.kind,
          target.target,
        ),
      ),
    ];
    for (let i = 0; i < statements.length; i += 80) await env.DB.batch(statements.slice(i, i + 80));
    const accepted = await env.DB.prepare(`UPDATE deletion_jobs SET phase='rows',next_attempt_at=?,updated_at=?
      WHERE id=? AND phase='staging'
      AND NOT EXISTS (SELECT 1 FROM deletion_job_pages lock LEFT JOIN pages p ON p.id=lock.page_id
        WHERE lock.job_id=? AND (p.id IS NULL OR p.workspace_id<>? OR p.archived_at IS NOT lock.archived_at OR p.archive_operation_id IS NOT lock.archive_operation_id))
      AND NOT EXISTS (SELECT 1 FROM deletion_job_pages own JOIN deletion_job_pages other ON other.page_id=own.page_id
        JOIN deletion_jobs job ON job.id=other.job_id WHERE own.job_id=? AND job.id<>? AND job.phase IN ('rows','cleanup'))
      AND (WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id=s.id)
        SELECT count(*) FROM subtree) = (SELECT count(*) FROM deletion_job_pages WHERE job_id=?)
      AND NOT EXISTS(SELECT 1 FROM deletion_job_pages lock WHERE lock.job_id=? AND lock.page_id NOT IN (
        WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id=s.id)
        SELECT id FROM subtree))
      AND NOT EXISTS(SELECT 1 FROM table_row_pages link JOIN table_rows row ON row.id=link.row_id
        JOIN table_authority authority ON authority.page_id=row.page_id AND authority.state<>'d1'
        WHERE link.page_id IN(SELECT page_id FROM deletion_job_pages WHERE job_id=?)
        AND row.page_id NOT IN(SELECT page_id FROM deletion_job_pages WHERE job_id=?)
        AND NOT EXISTS(SELECT 1 FROM deletion_targets target WHERE target.job_id=? AND target.kind='table_row'
          AND json_extract(target.target,'$.rowId')=row.id AND json_extract(target.target,'$.detailPageId')=link.page_id
          AND json_extract(target.target,'$.tableId')=row.page_id AND json_extract(target.target,'$.generation')=authority.generation))
      AND NOT ${REPAIRING_DELETION_ANCESTRY_SQL}
      RETURNING id`)
      .bind(
        timestamp,
        timestamp,
        jobId,
        jobId,
        workspaceId,
        jobId,
        jobId,
        rootId,
        jobId,
        jobId,
        rootId,
        jobId,
        jobId,
        jobId,
        jobId,
      )
      .first<{ id: string }>();
    if (!accepted) {
      const raced = await acceptedDeletionJob(env, workspaceId, rootId);
      await env.DB.prepare("DELETE FROM deletion_jobs WHERE id=? AND phase='staging'").bind(jobId).run();
      if (raced) return raced;
      throw new HttpError(
        409,
        "deletion_pending",
        "The page subtree changed or overlaps an accepted deletion. Reload before retrying.",
      );
    }
    return { jobId, pageIds };
  } catch (error) {
    await env.DB.prepare("DELETE FROM deletion_jobs WHERE id=? AND phase='staging'").bind(jobId).run();
    throw error;
  }
}

async function removeDeletionMetadata(env: Env, job: DeletionJobRow, leaseUntil: number) {
  const guard = "EXISTS(SELECT 1 FROM deletion_jobs WHERE id=? AND phase='cleanup' AND next_attempt_at=?)";
  const ids = "SELECT page_id FROM deletion_job_pages WHERE job_id=?";
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE deletion_jobs SET phase='cleanup',updated_at=? WHERE id=? AND phase='rows' AND next_attempt_at=?
      AND NOT EXISTS(SELECT 1 FROM deletion_targets WHERE job_id=? AND kind='table_row' AND completed_at IS NULL)
      AND EXISTS(SELECT 1 FROM deletion_job_pages WHERE job_id=? AND page_id=?)
      AND NOT EXISTS(SELECT 1 FROM deletion_job_pages lock LEFT JOIN pages p ON p.id=lock.page_id WHERE lock.job_id=?
        AND (p.id IS NULL OR p.workspace_id<>? OR p.archived_at IS NOT lock.archived_at OR p.archive_operation_id IS NOT lock.archive_operation_id))
      AND NOT EXISTS(SELECT 1 FROM pages p WHERE p.parent_id IN (${ids}) AND p.id NOT IN (${ids}))
      AND NOT EXISTS(SELECT 1 FROM table_row_pages link JOIN table_rows row ON row.id=link.row_id
        JOIN table_authority a ON a.page_id=row.page_id AND a.state<>'d1'
        WHERE link.page_id IN (${ids}) AND row.page_id NOT IN (${ids}))
      AND NOT ${REPAIRING_DELETION_ANCESTRY_SQL} RETURNING id`).bind(
      Date.now(),
      job.id,
      leaseUntil,
      job.id,
      job.id,
      job.root_page_id,
      job.id,
      job.workspace_id,
      job.id,
      job.id,
      job.id,
      job.id,
      job.id,
    ),
    env.DB.prepare(`DELETE FROM table_rows WHERE id IN(SELECT row_id FROM table_row_pages WHERE page_id IN (${ids}))
      AND page_id NOT IN (${ids}) AND ${guard}`).bind(job.id, job.id, job.id, leaseUntil),
    env.DB.prepare(`INSERT OR REPLACE INTO table_projection_context(page_id,generation)
      SELECT page_id,generation FROM table_authority WHERE page_id IN (${ids}) AND ${guard}`).bind(
      job.id,
      job.id,
      leaseUntil,
    ),
    env.DB.prepare(`DELETE FROM page_search WHERE page_id IN (${ids}) AND ${guard}`).bind(job.id, job.id, leaseUntil),
    env.DB.prepare(
      `DELETE FROM attachment_uploads WHERE state IN ('r2_complete','committed') AND page_id IN (${ids}) AND ${guard}`,
    ).bind(job.id, job.id, leaseUntil),
    env.DB.prepare(`DELETE FROM pages WHERE id=? AND workspace_id=? AND ${guard} RETURNING id`).bind(
      job.root_page_id,
      job.workspace_id,
      job.id,
      leaseUntil,
    ),
    env.DB.prepare(`DELETE FROM table_projection_context WHERE page_id IN (${ids}) AND ${guard}`).bind(
      job.id,
      job.id,
      leaseUntil,
    ),
  ]);
  return result[0]?.results.length === 1 && result[5]?.results.length === 1;
}

async function deletePrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, limit: 1_000, ...(cursor ? { cursor } : {}) });
    if (listed.objects.length) await bucket.delete(listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function processTarget(env: Env, target: DeletionTargetRow, hint?: DurableObjectLocationHint, jobId?: string) {
  if (target.kind === "table_row") {
    const tuple = JSON.parse(target.target) as { tableId: string };
    const response = await env.TABLE.getByName(tuple.tableId).fetch(
      new Request("https://table.internal/delete-row", {
        method: "POST",
        headers: { "content-type": "application/json", "x-table-internal": env.BETTER_AUTH_SECRET },
        body: JSON.stringify({ ...tuple, jobId }),
        signal: AbortSignal.timeout(DOCUMENT_PURGE_TIMEOUT_MS),
      }),
    );
    if (!response.ok) throw new Error(`Canonical row deletion failed with ${response.status}`);
    const result = await response.json<{ ok?: unknown; projectionPending?: unknown }>();
    if (result.ok !== true || result.projectionPending !== false)
      throw new Error("Canonical row deletion projection is pending");
    return;
  }
  if (target.kind === "table_do") {
    const response = await env.TABLE.getByName(target.target).fetch(
      new Request("https://table.internal/purge", {
        method: "POST",
        headers: { "x-table-internal": env.BETTER_AUTH_SECRET },
        signal: AbortSignal.timeout(DOCUMENT_PURGE_TIMEOUT_MS),
      }),
    );
    if (!response.ok) throw new Error(`Table purge failed with ${response.status}`);
    return;
  }
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
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, ...correlationHeaders() },
      signal: AbortSignal.timeout(DOCUMENT_PURGE_TIMEOUT_MS),
    }),
  );
  if (!response.ok) throw new Error(`Document purge failed with ${response.status}`);
}

async function reconcileDeletionRowTargets(env: Env, job: DeletionJobRow, leaseUntil: number) {
  const rows =
    await env.DB.prepare(`SELECT link.page_id detailPageId,row.id rowId,row.page_id tableId,authority.generation
    FROM deletion_job_pages locked JOIN deletion_jobs job ON job.id=locked.job_id
    JOIN pages detail ON detail.id=locked.page_id AND detail.workspace_id=job.workspace_id
    JOIN table_row_pages link ON link.page_id=detail.id JOIN table_rows row ON row.id=link.row_id
    JOIN pages source ON source.id=row.page_id AND source.workspace_id=job.workspace_id AND source.kind='table'
    JOIN table_authority authority ON authority.page_id=source.id AND authority.state<>'d1'
    WHERE job.id=? AND job.phase='rows' AND job.next_attempt_at=?
      AND detail.archived_at IS locked.archived_at AND detail.archive_operation_id IS locked.archive_operation_id
      AND row.page_id NOT IN(SELECT page_id FROM deletion_job_pages WHERE job_id=job.id)
      AND NOT EXISTS(SELECT 1 FROM deletion_targets target WHERE target.job_id=job.id AND target.kind='table_row'
        AND json_extract(target.target,'$.rowId')=row.id AND json_extract(target.target,'$.detailPageId')=detail.id
        AND json_extract(target.target,'$.tableId')=source.id)`)
      .bind(job.id, leaseUntil)
      .all<{ detailPageId: string; rowId: string; tableId: string; generation: number }>();
  let incomplete: string | undefined;
  for (const row of rows.results) {
    // Only this job's original target can establish the accepted generation.
    const evidence =
      await env.DB.prepare(`SELECT DISTINCT json_extract(target,'$.generation') generation FROM deletion_targets
      WHERE job_id=? AND kind='table_row' AND json_extract(target,'$.tableId')=?`)
        .bind(job.id, row.tableId)
        .all<{ generation: number }>();
    if (evidence.results.length !== 1 || evidence.results[0]?.generation !== row.generation) {
      incomplete = "Deletion row target generation is unavailable";
      continue;
    }
    const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO deletion_targets(job_id,kind,target)
      SELECT ?,'table_row',? WHERE EXISTS(SELECT 1 FROM deletion_jobs WHERE id=? AND phase='rows' AND next_attempt_at=?)
      AND EXISTS(SELECT 1 FROM deletion_job_pages locked JOIN deletion_jobs job ON job.id=locked.job_id
        JOIN pages detail ON detail.id=locked.page_id AND detail.workspace_id=job.workspace_id
        JOIN table_row_pages link ON link.page_id=detail.id JOIN table_rows row ON row.id=link.row_id
        JOIN pages source ON source.id=row.page_id AND source.workspace_id=job.workspace_id AND source.kind='table'
        JOIN table_authority authority ON authority.page_id=source.id
        WHERE job.id=? AND detail.id=? AND row.id=? AND source.id=? AND authority.generation=? AND authority.state<>'d1'
          AND detail.archived_at IS locked.archived_at AND detail.archive_operation_id IS locked.archive_operation_id)
      AND EXISTS(SELECT 1 FROM deletion_targets WHERE job_id=? AND kind='table_row'
        AND json_extract(target,'$.tableId')=? AND json_extract(target,'$.generation')=?)
      AND NOT EXISTS(SELECT 1 FROM deletion_targets WHERE job_id=? AND kind='table_row'
        AND json_extract(target,'$.tableId')=? AND json_extract(target,'$.generation') IS NOT ?)`)
      .bind(
        job.id,
        JSON.stringify(row),
        job.id,
        leaseUntil,
        job.id,
        row.detailPageId,
        row.rowId,
        row.tableId,
        row.generation,
        job.id,
        row.tableId,
        row.generation,
        job.id,
        row.tableId,
        row.generation,
      )
      .run();
    if (!inserted.meta.changes) incomplete = "Deletion row target ownership changed";
  }
  return incomplete;
}

export async function processDeletionJob(env: Env, jobId: string, { retryFailedRows = false } = {}) {
  const claimedAt = Date.now();
  const leaseUntil = claimedAt + CLEANUP_LEASE_MS;
  // Older claims retained last_error; their exact lease timestamps still cannot
  // be mistaken for failure backoff. New claims clear the failure marker atomically.
  const job = await env.DB.prepare(
    `UPDATE deletion_jobs
        SET next_attempt_at = ?, updated_at = ?, last_error = NULL
      WHERE id = ? AND phase<>'staging' AND (next_attempt_at <= ? OR
        (?=1 AND phase='rows' AND last_error IS NOT NULL AND next_attempt_at<>updated_at+?))
      RETURNING id, attempts, workspace_id, phase, root_page_id`,
  )
    .bind(leaseUntil, claimedAt, jobId, claimedAt, retryFailedRows ? 1 : 0, CLEANUP_LEASE_MS)
    .first<DeletionJobRow>();
  if (!job) return;

  let phaseFailure = job.phase === "rows" ? await reconcileDeletionRowTargets(env, job, leaseUntil) : undefined;

  let targets = await env.DB.prepare(
    `SELECT kind, target FROM deletion_targets
      WHERE job_id = ? AND completed_at IS NULL
        AND (?<>'rows' OR kind='table_row')
      ORDER BY CASE kind WHEN 'document_do' THEN 0 WHEN 'r2_object' THEN 1 ELSE 2 END, target`,
  )
    .bind(job.id, job.phase ?? "cleanup")
    .all<DeletionTargetRow>();

  let hint: DurableObjectLocationHint | undefined;
  if (targets.results.some((target) => target.kind === "document_do")) {
    const workspace = await env.DB.prepare(`SELECT location_hint FROM workspaces WHERE id = ?`)
      .bind(job.workspace_id)
      .first<{ location_hint: string | null }>();
    hint = locationHint(workspace?.location_hint ?? undefined);
  }

  for (;;) {
    for (const target of targets.results) {
      try {
        await processTarget(env, target, hint, job.id);
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
        const message = safeTelemetryErrorMessage(error, "Unknown cleanup failure");
        await env.DB.prepare(
          `UPDATE deletion_targets
            SET attempts = attempts + 1, last_error = ?
          WHERE job_id = ? AND kind = ? AND target = ?
            AND EXISTS (
              SELECT 1 FROM deletion_jobs WHERE id = ? AND next_attempt_at = ?
            )`,
        )
          .bind(message, job.id, target.kind, target.target, job.id, leaseUntil)
          .run();
      }
    }
    if (job.phase !== "rows" || phaseFailure) break;
    const remainingRows = await env.DB.prepare(
      "SELECT count(*) count FROM deletion_targets WHERE job_id=? AND kind='table_row' AND completed_at IS NULL",
    )
      .bind(job.id)
      .first<{ count: number }>();
    if (remainingRows?.count) break;
    try {
      if (!(await removeDeletionMetadata(env, job, leaseUntil)))
        throw new Error("Deletion metadata ownership changed or cleanup lease expired");
      job.phase = "cleanup";
      targets = await env.DB.prepare(
        "SELECT kind,target FROM deletion_targets WHERE job_id=? AND completed_at IS NULL ORDER BY kind,target",
      )
        .bind(job.id)
        .all<DeletionTargetRow>();
      if (targets.results.some((target) => target.kind === "document_do")) {
        const workspace = await env.DB.prepare("SELECT location_hint FROM workspaces WHERE id=?")
          .bind(job.workspace_id)
          .first<{ location_hint: string | null }>();
        hint = locationHint(workspace?.location_hint ?? undefined);
      }
    } catch (error) {
      phaseFailure = safeTelemetryErrorMessage(error, "Deletion metadata cleanup failed");
      break;
    }
  }

  const pending = await env.DB.prepare(
    `SELECT COUNT(*) count FROM deletion_targets WHERE job_id = ? AND completed_at IS NULL`,
  )
    .bind(job.id)
    .first<{ count: number }>();
  if (!pending?.count && job.phase !== "rows") {
    await env.DB.prepare(`DELETE FROM deletion_jobs WHERE id = ? AND next_attempt_at = ?`)
      .bind(job.id, leaseUntil)
      .run();
    return;
  }

  const attempts = job.attempts + 1;
  const delay =
    job.phase === "rows" ? 60_000 : Math.min(24 * 60 * 60_000, 60 * 60_000 * 2 ** Math.min(attempts - 1, 4));
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
    .bind(
      attempts,
      Date.now() + delay,
      phaseFailure ?? failed?.last_error ?? "Cleanup incomplete",
      Date.now(),
      job.id,
      leaseUntil,
    )
    .run();
}

export async function processDueDeletionJobs(env: Env, limit = 10) {
  await env.DB.prepare("DELETE FROM deletion_jobs WHERE phase='staging' AND created_at<?")
    .bind(Date.now() - 24 * 60 * 60_000)
    .run();
  const jobs = await env.DB.prepare(
    `SELECT id FROM deletion_jobs WHERE next_attempt_at <= ? AND phase<>'staging' ORDER BY created_at LIMIT ?`,
  )
    .bind(Date.now(), limit)
    .all<{ id: string }>();
  for (const job of jobs.results) await processDeletionJob(env, job.id);
}
