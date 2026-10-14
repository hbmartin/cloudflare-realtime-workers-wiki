import type { Env } from "./env";
import { locationHint } from "./http";
import { correlationHeaders, logger, safeTelemetryErrorMessage } from "./observability";
import { HttpError, safeHttpError } from "./http";
import type { PageRow } from "./page-access";
import { acceptedPageDeletionSql } from "./deletion-policy";
import { decodeTableResponse, tableReadPages } from "./table-transport";

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

type TableDeletionTarget = {
  version: 1 | 2;
  mode?: "d1";
  pageId: string;
  workspaceId: string;
  generation: number | null;
  stage: "stop" | "purge";
};

function tableDeletionTarget(target: string): TableDeletionTarget | null {
  if (!target.startsWith("{")) return null;
  const value = JSON.parse(target) as TableDeletionTarget;
  if (
    ![1, 2].includes(value.version) ||
    (value.version === 2 && (value.mode !== "d1" || value.generation !== null)) ||
    typeof value.pageId !== "string" ||
    typeof value.workspaceId !== "string" ||
    (value.generation !== null && (!Number.isSafeInteger(value.generation) || value.generation < 1)) ||
    !["stop", "purge"].includes(value.stage)
  )
    throw new Error("Invalid table deletion target");
  return value;
}

type RowDeletionTarget = {
  detailPageId: string;
  rowId: string;
  tableId: string;
  generation: number;
  handoff?: {
    version: 1;
    jobId: string;
    pageId: string;
    workspaceId: string;
    generation: number;
    archivedAt: number;
    archiveOperationId: string | null;
    status: "pending" | "purged";
  };
};

type ExternalRowEvidence = { detailPageId: string; rowId?: string; kind: "row" | "provenance" };
const EVIDENCE_MAX_BYTES = 1_000_000;
const EVIDENCE_MAX_RECORDS = 1_000;
const EVIDENCE_FAILURE = {
  code: "deletion_evidence_unavailable",
  message: "Table deletion evidence is temporarily unavailable. Please retry shortly.",
};

async function captureExternalRowEvidence(env: Env, job: DeletionJobRow, leaseUntil: number) {
  const locked = await env.DB.prepare("SELECT page_id FROM deletion_job_pages WHERE job_id=?")
    .bind(job.id)
    .all<{ page_id: string }>();
  const ownedPages = new Set(locked.results.map((page) => page.page_id));
  const stops =
    await env.DB.prepare(`SELECT target,completed_at FROM deletion_targets WHERE job_id=? AND kind='table_do'
    AND json_valid(target) AND json_extract(target,'$.version')=1 AND json_extract(target,'$.stage')='stop'`)
      .bind(job.id)
      .all<{ target: string; completed_at: number | null }>();
  for (const stop of stops.results) {
    const table = tableDeletionTarget(stop.target)!;
    const sealed =
      await env.DB.prepare(`SELECT 1 FROM deletion_targets WHERE job_id=? AND kind='table_do' AND completed_at IS NOT NULL
      AND json_valid(target) AND json_extract(target,'$.stage')='evidence' AND json_extract(target,'$.pageId')=?
      AND json_extract(target,'$.generation') IS ? AND json_extract(target,'$.sealed')=1`)
        .bind(job.id, table.pageId, table.generation)
        .first();
    if (sealed) continue;
    const evidence = new Map<string, ExternalRowEvidence>();
    const linked = await env.DB.prepare(`SELECT link.page_id detailPageId,row.id rowId FROM table_rows row
      JOIN table_row_pages link ON link.row_id=row.id JOIN pages detail ON detail.id=link.page_id
      WHERE row.page_id=? AND detail.workspace_id=? AND detail.id NOT IN(SELECT page_id FROM deletion_job_pages WHERE job_id=?)`)
      .bind(table.pageId, table.workspaceId, job.id)
      .all<ExternalRowEvidence>();
    for (const row of linked.results) evidence.set(row.detailPageId, { ...row, kind: "row" });
    const provenance = await env.DB.prepare(`SELECT child.page_id detailPageId FROM page_import_sources child
      JOIN page_import_sources parent ON child.job_id IS NOT NULL AND parent.job_id=child.job_id
        AND child.parent_source_path IS NOT NULL AND parent.source_path=child.parent_source_path
      JOIN pages detail ON detail.id=child.page_id AND detail.workspace_id=?
      WHERE parent.page_id=? AND child.source_role='table_row_detail'
        AND detail.id NOT IN(SELECT page_id FROM deletion_job_pages WHERE job_id=?)`)
      .bind(table.workspaceId, table.pageId, job.id)
      .all<{ detailPageId: string }>();
    for (const row of provenance.results)
      if (!evidence.has(row.detailPageId)) evidence.set(row.detailPageId, { ...row, kind: "provenance" });
    if (table.generation !== null) {
      const canonicalLinks = new Map<string, string>();
      try {
        for await (const snapshot of tableReadPages(async (params) => {
          params.set("deletionJob", job.id);
          params.set("generation", String(table.generation));
          params.set("stopTarget", stop.target);
          const response = await env.TABLE.getByName(table.pageId).fetch(
            new Request(`https://table.internal/deletion-evidence?${params}`, {
              headers: { "x-table-internal": env.BETTER_AUTH_SECRET },
              signal: AbortSignal.timeout(DOCUMENT_PURGE_TIMEOUT_MS),
            }),
          );
          const manifest = await decodeTableResponse<{
            pageId: string;
            workspaceId: string;
            generation: number;
            revision: number;
            rows: Array<{ id: string; detailPageId: string }>;
            nextCursor: string | null;
          }>(response, EVIDENCE_FAILURE);
          if (
            manifest.pageId !== table.pageId ||
            manifest.workspaceId !== table.workspaceId ||
            manifest.generation !== table.generation ||
            !Array.isArray(manifest.rows) ||
            manifest.rows.length > EVIDENCE_MAX_RECORDS ||
            manifest.rows.some((row) => typeof row.id !== "string" || typeof row.detailPageId !== "string")
          )
            throw new HttpError(409, "deletion_pending", "The page subtree changed. Reload before retrying.");
          return manifest;
        })) {
          for (const row of snapshot.rows) {
            if (ownedPages.has(row.detailPageId)) continue;
            const priorRow = canonicalLinks.get(row.detailPageId);
            if (priorRow !== undefined && priorRow !== row.id)
              throw new HttpError(503, EVIDENCE_FAILURE.code, EVIDENCE_FAILURE.message);
            canonicalLinks.set(row.detailPageId, row.id);
            evidence.set(row.detailPageId, { kind: "row", rowId: row.id, detailPageId: row.detailPageId });
          }
        }
      } catch (error) {
        const failure = safeHttpError(error);
        if (
          failure?.code === "table_response_unavailable" ||
          (failure?.code === "table_not_seeded" && failure.status !== 503)
        )
          throw new HttpError(503, EVIDENCE_FAILURE.code, EVIDENCE_FAILURE.message);
        if (!(failure?.status === 503 && failure.code === "table_not_seeded")) throw error;
      }
    }
    // Interrupted accepted capture keeps its exact historical protection.
    const prior = await env.DB.prepare(`SELECT detail_page_id,row_id,source_kind,workspace_id,generation
      FROM deletion_evidence_lookup WHERE job_id=? AND table_id=?`)
      .bind(job.id, table.pageId)
      .all<{
        detail_page_id: string;
        row_id: string | null;
        source_kind: "row" | "provenance";
        workspace_id: string;
        generation: number | null;
      }>();
    for (const record of prior.results) {
      const current = evidence.get(record.detail_page_id);
      if (
        record.workspace_id !== table.workspaceId ||
        record.generation !== table.generation ||
        (current && (current.kind !== record.source_kind || (current.rowId ?? null) !== record.row_id))
      )
        throw new HttpError(503, EVIDENCE_FAILURE.code, EVIDENCE_FAILURE.message);
      if (current) evidence.delete(record.detail_page_id);
    }
    const stored = await env.DB.prepare(`SELECT count(*) count FROM deletion_targets WHERE job_id=? AND kind='table_do'
      AND json_valid(target) AND json_extract(target,'$.stage')='evidence' AND json_extract(target,'$.pageId')=?`)
      .bind(job.id, table.pageId)
      .first<{ count: number }>();
    const firstIndex = stored!.count;
    // Keep all chunks bounded, including the final empty snapshot checkpoint.
    const chunks: ExternalRowEvidence[][] = [[]];
    let chunkBytes = 2;
    const encoder = new TextEncoder();
    for (const row of evidence.values()) {
      const bytes = encoder.encode(JSON.stringify(row)).byteLength + 1;
      if (bytes > EVIDENCE_MAX_BYTES - 1_000) throw new HttpError(503, EVIDENCE_FAILURE.code, EVIDENCE_FAILURE.message);
      let chunk = chunks.at(-1)!;
      if (chunk.length === EVIDENCE_MAX_RECORDS || chunkBytes + bytes > EVIDENCE_MAX_BYTES - 1_000) {
        chunks.push([]);
        chunk = chunks.at(-1)!;
        chunkBytes = 2;
      }
      chunk.push(row);
      chunkBytes += bytes;
    }
    const statements: D1PreparedStatement[] = [];
    for (const [offset, records] of chunks.entries()) {
      const index = firstIndex + offset;
      const value = JSON.stringify({
        version: 1,
        stage: "evidence",
        pageId: table.pageId,
        workspaceId: table.workspaceId,
        generation: table.generation,
        index,
        records,
        sealed: offset === chunks.length - 1,
      });
      if (new TextEncoder().encode(value).byteLength > EVIDENCE_MAX_BYTES)
        throw new Error("Deletion evidence exceeds its checkpoint limit");
      statements.push(
        env.DB.prepare(`INSERT INTO deletion_targets(job_id,kind,target,completed_at)
        SELECT ?, 'table_do', ?, ? WHERE EXISTS(SELECT 1 FROM deletion_jobs whole JOIN deletion_job_pages locked ON locked.job_id=whole.id
          JOIN pages page ON page.id=locked.page_id AND page.workspace_id=whole.workspace_id AND page.kind='table'
          LEFT JOIN table_authority authority ON authority.page_id=page.id
          WHERE whole.id=? AND whole.phase=? AND whole.next_attempt_at=? AND page.id=? AND authority.generation IS ?
            AND page.archived_at IS locked.archived_at AND page.archive_operation_id IS locked.archive_operation_id
            AND EXISTS(SELECT 1 FROM deletion_targets WHERE job_id=whole.id AND kind='table_do' AND target=?))
          AND (SELECT count(*) FROM deletion_targets WHERE job_id=? AND kind='table_do' AND json_valid(target)
            AND json_extract(target,'$.stage')='evidence' AND json_extract(target,'$.pageId')=?)=?`).bind(
          job.id,
          value,
          Date.now(),
          job.id,
          job.phase,
          leaseUntil,
          table.pageId,
          table.generation,
          stop.target,
          job.id,
          table.pageId,
          index,
        ),
      );
    }
    for (let offset = 0; offset < statements.length; offset += 50) {
      const inserted = await env.DB.batch(statements.slice(offset, offset + 50));
      if (inserted.some((result) => !result.meta.changes))
        throw new HttpError(409, "deletion_pending", "The page subtree changed. Reload before retrying.");
    }
  }
}

function authorityHistorySql(pageId: string, ownJob: string) {
  return `(EXISTS(SELECT 1 FROM deletion_targets history WHERE history.kind='table_do' AND substr(history.target,1,1)<>'{'
    AND history.target=${pageId} AND history.job_id<>${ownJob})
    OR EXISTS(SELECT 1 FROM deletion_targets history WHERE history.kind='table_do' AND json_valid(history.target)
      AND json_extract(history.target,'$.pageId')=${pageId} AND history.job_id<>${ownJob}
      AND NOT COALESCE((json_extract(history.target,'$.version')=2 AND json_extract(history.target,'$.mode')='d1'
        AND json_type(history.target,'$.generation')='null' AND json_type(history.target,'$.pageId')='text'
        AND json_type(history.target,'$.workspaceId')='text' AND json_extract(history.target,'$.stage') IN('stop','purge')),0))
    OR EXISTS(SELECT 1 FROM deletion_targets history WHERE history.kind='table_row' AND json_valid(history.target)
      AND json_extract(history.target,'$.tableId')=${pageId} AND json_type(history.target,'$.generation')='integer'
      AND history.job_id<>${ownJob}))`;
}

function d1CheckpointSql() {
  const pageId = "json_extract(deletion_targets.target,'$.pageId')";
  return `EXISTS(SELECT 1 FROM deletion_jobs checkpoint JOIN deletion_job_pages locked
      ON locked.job_id=checkpoint.id AND locked.page_id=${pageId}
    LEFT JOIN pages page ON page.id=locked.page_id
    WHERE checkpoint.id=deletion_targets.job_id AND checkpoint.workspace_id=json_extract(deletion_targets.target,'$.workspaceId')
      AND NOT EXISTS(SELECT 1 FROM table_authority WHERE page_id=${pageId})
      AND NOT ${authorityHistorySql(pageId, "checkpoint.id")}
      AND ((checkpoint.phase='rows' AND json_extract(deletion_targets.target,'$.stage')='stop'
        AND page.kind='table' AND page.workspace_id=checkpoint.workspace_id
        AND page.archived_at IS locked.archived_at AND page.archive_operation_id IS locked.archive_operation_id)
        OR (checkpoint.phase='cleanup' AND json_extract(deletion_targets.target,'$.stage')='purge' AND page.id IS NULL)))`;
}

const ROW_HANDOFF_BASE_SQL = `FROM deletion_targets target JOIN deletion_jobs dependent ON dependent.id=target.job_id
  JOIN deletion_job_pages detailLock ON detailLock.job_id=dependent.id AND detailLock.page_id=json_extract(target.target,'$.detailPageId')
  JOIN pages detail ON detail.id=detailLock.page_id AND detail.workspace_id=dependent.workspace_id
  JOIN pages source ON source.id=json_extract(target.target,'$.tableId') AND source.workspace_id=dependent.workspace_id AND source.kind='table'
  JOIN table_authority authority ON authority.page_id=source.id AND authority.generation=json_extract(target.target,'$.generation')
  JOIN deletion_job_pages tableLock ON tableLock.page_id=source.id
  JOIN deletion_jobs whole ON whole.id=tableLock.job_id AND whole.workspace_id=dependent.workspace_id AND whole.phase='rows'
  JOIN deletion_targets stop ON stop.job_id=whole.id AND stop.kind='table_do' AND json_valid(stop.target)
    AND json_extract(stop.target,'$.version')=1 AND json_extract(stop.target,'$.stage')='stop'
    AND json_extract(stop.target,'$.pageId')=source.id AND json_extract(stop.target,'$.workspaceId')=whole.workspace_id
    AND json_extract(stop.target,'$.generation')=authority.generation AND (dependent.phase='rows' OR stop.completed_at IS NULL)
  WHERE target.kind='table_row' AND target.completed_at IS NULL AND json_valid(target.target)
    AND json_type(target.target,'$.generation')='integer'
    AND detail.archived_at IS detailLock.archived_at AND detail.archive_operation_id IS detailLock.archive_operation_id
    AND source.archived_at IS tableLock.archived_at AND source.archive_operation_id IS tableLock.archive_operation_id
    AND dependent.id<>whole.id
    AND NOT EXISTS(SELECT 1 FROM table_rows row WHERE row.id=json_extract(target.target,'$.rowId') AND row.page_id<>source.id)
    AND NOT EXISTS(SELECT 1 FROM table_row_pages link WHERE (link.row_id=json_extract(target.target,'$.rowId') AND link.page_id<>detail.id)
      OR (link.page_id=detail.id AND link.row_id<>json_extract(target.target,'$.rowId')))
    AND (dependent.phase='rows' OR (dependent.phase='staging' AND EXISTS(SELECT 1 FROM table_rows row
      JOIN table_row_pages link ON link.row_id=row.id WHERE row.id=json_extract(target.target,'$.rowId') AND row.page_id=source.id AND link.page_id=detail.id)))`;

const ROW_HANDOFF_FROM_SQL = `${ROW_HANDOFF_BASE_SQL} AND json_type(target.target,'$.handoff') IS NULL`;

function encodedRowHandoff(target: string, handoff: RowDeletionTarget["handoff"]) {
  return JSON.stringify({ ...JSON.parse(target), handoff });
}

async function compareAndSwapRowTarget(
  env: Env,
  jobId: string,
  previous: string,
  next: string,
  guard: string,
  bindings: Array<string | number | null>,
) {
  return env.DB.prepare(`UPDATE deletion_targets SET target=?
    WHERE job_id=? AND kind='table_row' AND target=? AND completed_at IS NULL AND ${guard}`)
    .bind(next, jobId, previous, ...bindings)
    .run();
}

async function captureRowHandoffs(
  env: Env,
  { wholeJobId, dependentJobId, leaseUntil }: { wholeJobId?: string; dependentJobId?: string; leaseUntil?: number },
) {
  const filter = `AND (? IS NULL OR whole.id=?) AND (? IS NULL OR dependent.id=?)
    AND (? IS NULL OR whole.next_attempt_at=?) AND dependent.phase=?`;
  const bindings = [
    wholeJobId ?? null,
    wholeJobId ?? null,
    dependentJobId ?? null,
    dependentJobId ?? null,
    leaseUntil ?? null,
    leaseUntil ?? null,
    dependentJobId ? "staging" : "rows",
  ];
  const candidates =
    await env.DB.prepare(`SELECT dependent.id jobId,target.target,whole.id wholeJobId,whole.workspace_id workspaceId,
    detailLock.archived_at archivedAt,detailLock.archive_operation_id archiveOperationId ${ROW_HANDOFF_FROM_SQL} ${filter}`)
      .bind(...bindings)
      .all<{
        jobId: string;
        target: string;
        wholeJobId: string;
        workspaceId: string;
        archivedAt: number;
        archiveOperationId: string | null;
      }>();
  for (const candidate of candidates.results) {
    const row = JSON.parse(candidate.target) as RowDeletionTarget;
    const next = encodedRowHandoff(candidate.target, {
      version: 1,
      jobId: candidate.wholeJobId,
      pageId: row.tableId,
      workspaceId: candidate.workspaceId,
      generation: row.generation,
      archivedAt: candidate.archivedAt,
      archiveOperationId: candidate.archiveOperationId,
      status: "pending",
    });
    const captured = await compareAndSwapRowTarget(
      env,
      candidate.jobId,
      candidate.target,
      next,
      `EXISTS(SELECT 1 ${ROW_HANDOFF_FROM_SQL} ${filter} AND dependent.id=? AND whole.id=? AND target.target=?)`,
      [...bindings, candidate.jobId, candidate.wholeJobId, candidate.target],
    );
    if (!captured.meta.changes) return "Deletion row handoff ownership changed";
  }
  return undefined;
}

const LEGACY_CLEANUP_HANDOFF_SQL = `FROM deletion_targets target JOIN deletion_jobs dependent ON dependent.id=target.job_id AND dependent.phase='rows'
  JOIN deletion_job_pages detailLock ON detailLock.job_id=dependent.id AND detailLock.page_id=json_extract(target.target,'$.detailPageId')
  JOIN pages detail ON detail.id=detailLock.page_id AND detail.workspace_id=dependent.workspace_id
  JOIN deletion_jobs whole ON whole.workspace_id=dependent.workspace_id AND whole.phase='cleanup'
  JOIN deletion_targets purge ON purge.job_id=whole.id AND purge.kind='table_do' AND purge.completed_at IS NULL AND json_valid(purge.target)
    AND json_extract(purge.target,'$.version')=1 AND json_extract(purge.target,'$.stage')='purge'
    AND json_extract(purge.target,'$.pageId')=json_extract(target.target,'$.tableId') AND json_extract(purge.target,'$.workspaceId')=whole.workspace_id
    AND json_type(purge.target,'$.generation')='integer' AND json_extract(purge.target,'$.generation')>0
    AND json_extract(purge.target,'$.generation')=json_extract(target.target,'$.generation')
  JOIN deletion_job_pages tableLock ON tableLock.job_id=whole.id AND tableLock.page_id=json_extract(purge.target,'$.pageId')
  WHERE target.kind='table_row' AND target.completed_at IS NULL AND json_valid(target.target) AND json_type(target.target,'$.handoff') IS NULL
    AND dependent.id<>whole.id AND detail.archived_at IS detailLock.archived_at AND detail.archive_operation_id IS detailLock.archive_operation_id
    AND NOT EXISTS(SELECT 1 FROM pages WHERE id=json_extract(purge.target,'$.pageId'))
    AND NOT EXISTS(SELECT 1 FROM table_authority WHERE page_id=json_extract(purge.target,'$.pageId'))
    AND EXISTS(SELECT 1 FROM deletion_targets stop WHERE stop.job_id=whole.id AND stop.kind='table_do' AND stop.completed_at IS NOT NULL
      AND json_valid(stop.target) AND json_extract(stop.target,'$.version')=1 AND json_extract(stop.target,'$.stage')='stop'
      AND json_extract(stop.target,'$.pageId')=json_extract(purge.target,'$.pageId') AND json_extract(stop.target,'$.workspaceId')=whole.workspace_id
      AND json_extract(stop.target,'$.generation')=json_extract(purge.target,'$.generation'))
    AND NOT EXISTS(SELECT 1 FROM table_rows row WHERE row.id=json_extract(target.target,'$.rowId') AND row.page_id<>json_extract(target.target,'$.tableId'))
    AND NOT EXISTS(SELECT 1 FROM table_row_pages link WHERE (link.row_id=json_extract(target.target,'$.rowId') AND link.page_id<>detail.id)
      OR (link.page_id=detail.id AND link.row_id<>json_extract(target.target,'$.rowId')))`;

async function captureLegacyCleanupHandoffs(env: Env, job: DeletionJobRow, leaseUntil: number) {
  const filter = "AND whole.id=? AND whole.next_attempt_at=?";
  const candidates = await env.DB.prepare(`SELECT dependent.id jobId,target.target,purge.target purgeTarget,
    detailLock.archived_at archivedAt,detailLock.archive_operation_id archiveOperationId ${LEGACY_CLEANUP_HANDOFF_SQL} ${filter}`)
    .bind(job.id, leaseUntil)
    .all<{
      jobId: string;
      target: string;
      purgeTarget: string;
      archivedAt: number;
      archiveOperationId: string | null;
    }>();
  for (const candidate of candidates.results) {
    const row = JSON.parse(candidate.target) as RowDeletionTarget;
    const next = encodedRowHandoff(candidate.target, {
      version: 1,
      jobId: job.id,
      pageId: row.tableId,
      workspaceId: job.workspace_id,
      generation: row.generation,
      archivedAt: candidate.archivedAt,
      archiveOperationId: candidate.archiveOperationId,
      status: "pending",
    });
    const captured = await compareAndSwapRowTarget(
      env,
      candidate.jobId,
      candidate.target,
      next,
      `EXISTS(SELECT 1 ${LEGACY_CLEANUP_HANDOFF_SQL} ${filter} AND dependent.id=? AND target.target=? AND purge.target=?)`,
      [job.id, leaseUntil, candidate.jobId, candidate.target, candidate.purgeTarget],
    );
    if (!captured.meta.changes) return "Deletion row handoff ownership changed";
  }
  return undefined;
}

async function publishRowHandoffProofs(
  env: Env,
  jobId: string,
  table: TableDeletionTarget,
  targetText: string,
  leaseUntil: number,
) {
  const candidates = await env.DB.prepare(`SELECT target.job_id,target.target FROM deletion_targets target
    JOIN deletion_jobs dependent ON dependent.id=target.job_id
    WHERE target.kind='table_row' AND target.completed_at IS NULL AND dependent.phase='rows' AND dependent.workspace_id=?
      AND json_extract(target.target,'$.handoff.version')=1 AND json_extract(target.target,'$.handoff.jobId')=?
      AND json_extract(target.target,'$.handoff.status')='pending' AND json_extract(target.target,'$.tableId')=?
      AND json_extract(target.target,'$.generation')=? AND json_extract(target.target,'$.handoff.pageId')=?
      AND json_extract(target.target,'$.handoff.workspaceId')=? AND json_extract(target.target,'$.handoff.generation')=?`)
    .bind(table.workspaceId, jobId, table.pageId, table.generation, table.pageId, table.workspaceId, table.generation)
    .all<{ job_id: string; target: string }>();
  for (const candidate of candidates.results) {
    const row = JSON.parse(candidate.target) as RowDeletionTarget;
    const next = encodedRowHandoff(candidate.target, { ...row.handoff!, status: "purged" });
    const persisted = await compareAndSwapRowTarget(
      env,
      candidate.job_id,
      candidate.target,
      next,
      `EXISTS(SELECT 1 FROM deletion_jobs whole WHERE whole.id=? AND whole.phase='cleanup' AND whole.next_attempt_at=?
        AND whole.workspace_id=? AND EXISTS(SELECT 1 FROM deletion_targets purge WHERE purge.job_id=whole.id AND purge.kind='table_do' AND purge.target=?))
      AND EXISTS(SELECT 1 FROM deletion_jobs dependent JOIN deletion_job_pages locked ON locked.job_id=dependent.id
        JOIN pages detail ON detail.id=locked.page_id AND detail.workspace_id=dependent.workspace_id
        WHERE dependent.id=? AND dependent.phase='rows' AND dependent.workspace_id=? AND locked.page_id=?
          AND locked.archived_at=? AND locked.archive_operation_id IS ?
          AND detail.archived_at IS locked.archived_at AND detail.archive_operation_id IS locked.archive_operation_id)
      AND NOT EXISTS(SELECT 1 FROM table_rows row WHERE row.id=json_extract(deletion_targets.target,'$.rowId') AND row.page_id<>json_extract(deletion_targets.target,'$.tableId'))
      AND NOT EXISTS(SELECT 1 FROM table_row_pages link WHERE (link.row_id=json_extract(deletion_targets.target,'$.rowId') AND link.page_id<>json_extract(deletion_targets.target,'$.detailPageId'))
        OR (link.page_id=json_extract(deletion_targets.target,'$.detailPageId') AND link.row_id<>json_extract(deletion_targets.target,'$.rowId')))`,
      [
        jobId,
        leaseUntil,
        table.workspaceId,
        targetText,
        candidate.job_id,
        table.workspaceId,
        row.detailPageId,
        row.handoff!.archivedAt,
        row.handoff!.archiveOperationId,
      ],
    );
    if (!persisted.meta.changes) {
      const remaining =
        await env.DB.prepare(`SELECT 1 FROM deletion_targets WHERE job_id=? AND kind='table_row' AND completed_at IS NULL
        AND json_extract(target,'$.tableId')=? AND json_extract(target,'$.generation')=? AND json_extract(target,'$.rowId')=?
        AND json_extract(target,'$.detailPageId')=? AND json_extract(target,'$.handoff.jobId')=? AND json_extract(target,'$.handoff.status')='pending'`)
          .bind(candidate.job_id, row.tableId, row.generation, row.rowId, row.detailPageId, jobId)
          .first();
      if (remaining) throw new Error("Deletion row handoff proof ownership changed");
    }
  }
}

// Every owned table keeps distinct stop and purge checkpoints in the existing target table.
function missingTableStopsSql(completed: boolean) {
  return `EXISTS(SELECT 1 FROM deletion_job_pages locked JOIN deletion_jobs job ON job.id=locked.job_id
    JOIN pages page ON page.id=locked.page_id AND page.kind='table'
    LEFT JOIN table_authority authority ON authority.page_id=page.id
    WHERE job.id=? AND NOT EXISTS(SELECT 1 FROM deletion_targets target WHERE target.job_id=job.id
      AND target.kind='table_do' AND json_valid(target.target)
      AND json_extract(target.target,'$.version') IN (1,2) AND json_extract(target.target,'$.stage')='stop'
      AND json_extract(target.target,'$.pageId')=page.id AND json_extract(target.target,'$.workspaceId')=job.workspace_id
      AND json_extract(target.target,'$.generation') IS authority.generation
      AND (json_extract(target.target,'$.version')=1 OR (json_extract(target.target,'$.mode')='d1'
        AND authority.page_id IS NULL AND NOT ${authorityHistorySql("page.id", "job.id")}))
      ${completed ? "AND target.completed_at IS NOT NULL" : ""}
      AND EXISTS(SELECT 1 FROM deletion_targets purge WHERE purge.job_id=job.id AND purge.kind='table_do'
        AND json_valid(purge.target) AND json_extract(purge.target,'$.version')=json_extract(target.target,'$.version')
        AND json_extract(purge.target,'$.stage')='purge' AND json_extract(purge.target,'$.pageId')=page.id
        AND json_extract(purge.target,'$.workspaceId')=job.workspace_id
        AND json_extract(purge.target,'$.generation') IS authority.generation)))`;
}

const CLEANUP_LEASE_MS = 15 * 60_000;
const DOCUMENT_PURGE_TIMEOUT_MS = 30_000;

const DELETION_ANCESTRY_SQL = `WITH RECURSIVE ancestors(id,workspace_id,job_id) AS (
  SELECT page.id,page.workspace_id,job.id FROM deletion_job_pages locked JOIN deletion_jobs job ON job.id=locked.job_id
    JOIN pages page ON page.id=locked.page_id AND page.workspace_id=job.workspace_id WHERE job.id=?
  UNION
  SELECT parent.id,parent.workspace_id,child.job_id FROM ancestors child JOIN pages page ON page.id=child.id
    JOIN pages parent ON parent.id=page.parent_id AND parent.workspace_id=child.workspace_id
  UNION
  SELECT parent.id,parent.workspace_id,child.job_id FROM ancestors child JOIN page_import_sources source
    ON source.page_id=child.id AND source.source_role='table_row_detail'
    JOIN page_import_sources provenance ON source.job_id IS NOT NULL AND provenance.job_id=source.job_id
      AND source.parent_source_path IS NOT NULL AND provenance.source_path=source.parent_source_path
    JOIN pages parent ON parent.id=provenance.page_id AND parent.workspace_id=child.workspace_id
)`;
const REPAIRING_DELETION_ANCESTRY_SQL = `EXISTS(${DELETION_ANCESTRY_SQL} SELECT 1 FROM ancestors
  JOIN table_authority authority ON authority.page_id=ancestors.id WHERE authority.state='repairing'
  AND NOT ${acceptedPageDeletionSql("ancestors.id", "ancestors.workspace_id")}
  AND NOT EXISTS(SELECT 1 FROM deletion_job_pages locked JOIN deletion_targets target ON target.job_id=locked.job_id
    WHERE locked.job_id=ancestors.job_id AND locked.page_id=ancestors.id AND target.kind='table_do'
      AND json_valid(target.target) AND json_extract(target.target,'$.version')=1
      AND json_extract(target.target,'$.stage')='stop' AND json_extract(target.target,'$.pageId')=ancestors.id
      AND json_extract(target.target,'$.workspaceId')=ancestors.workspace_id
      AND json_extract(target.target,'$.generation')=authority.generation))`;

const WHOLE_DELETION_ANCESTRY_SQL = `EXISTS(${DELETION_ANCESTRY_SQL} SELECT 1 FROM ancestors
  JOIN pages source ON source.id=ancestors.id AND source.kind='table'
  JOIN deletion_job_pages tableLock ON tableLock.page_id=source.id
  JOIN deletion_jobs whole ON whole.id=tableLock.job_id AND whole.workspace_id=ancestors.workspace_id AND whole.phase IN ('rows','cleanup')
  WHERE whole.id<>ancestors.job_id AND NOT EXISTS(SELECT 1 FROM deletion_job_pages own WHERE own.job_id=ancestors.job_id AND own.page_id=source.id)
    AND NOT EXISTS(SELECT 1 FROM deletion_targets rowTarget WHERE rowTarget.job_id=ancestors.job_id AND rowTarget.kind='table_row'
      AND json_extract(rowTarget.target,'$.handoff.jobId')=whole.id AND json_extract(rowTarget.target,'$.handoff.status')='pending'
      AND json_extract(rowTarget.target,'$.handoff.pageId')=source.id))`;

const EVIDENCE_DELETION_PENDING_SQL = `EXISTS(${DELETION_ANCESTRY_SQL} SELECT 1 FROM ancestors
  JOIN deletion_evidence_lookup evidence ON evidence.workspace_id=ancestors.workspace_id AND evidence.detail_page_id=ancestors.id
  JOIN deletion_jobs whole ON whole.id=evidence.job_id AND whole.workspace_id=ancestors.workspace_id AND whole.phase IN ('rows','cleanup')
  WHERE whole.id<>ancestors.job_id
    AND NOT EXISTS(SELECT 1 FROM deletion_targets purge WHERE purge.job_id=whole.id AND purge.kind='table_do' AND purge.completed_at IS NOT NULL
      AND json_valid(purge.target) AND json_extract(purge.target,'$.stage')='purge'
      AND json_extract(purge.target,'$.pageId')=evidence.table_id
      AND json_extract(purge.target,'$.generation') IS evidence.generation)
    AND NOT EXISTS(SELECT 1 FROM deletion_targets rowTarget WHERE rowTarget.job_id=ancestors.job_id AND rowTarget.kind='table_row'
      AND json_extract(rowTarget.target,'$.handoff.jobId')=whole.id AND json_extract(rowTarget.target,'$.handoff.pageId')=evidence.table_id
      AND json_extract(rowTarget.target,'$.handoff.generation')=evidence.generation
      AND json_extract(rowTarget.target,'$.handoff.status') IN ('pending','purged'))) `;

const INVALID_ROW_HANDOFF_SQL = `EXISTS(SELECT 1 FROM deletion_targets candidate WHERE candidate.job_id=? AND candidate.kind='table_row'
  AND json_type(candidate.target,'$.handoff') IS NOT NULL AND NOT EXISTS(SELECT 1 ${ROW_HANDOFF_BASE_SQL}
    AND json_extract(target.target,'$.handoff.version')=1 AND json_extract(target.target,'$.handoff.jobId')=whole.id
    AND json_extract(target.target,'$.handoff.pageId')=source.id AND json_extract(target.target,'$.handoff.workspaceId')=dependent.workspace_id
    AND json_extract(target.target,'$.handoff.generation')=authority.generation AND json_extract(target.target,'$.handoff.status')='pending'
    AND json_extract(target.target,'$.handoff.archivedAt')=detailLock.archived_at
    AND json_extract(target.target,'$.handoff.archiveOperationId') IS detailLock.archive_operation_id
    AND target.job_id=candidate.job_id AND target.target=candidate.target))`;

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
  const authorities = await env.DB.prepare(
    "SELECT page_id,generation FROM table_authority WHERE page_id IN(SELECT value FROM json_each(?))",
  )
    .bind(serializedIds)
    .all<{ page_id: string; generation: number }>();
  const generations = new Map(authorities.results.map((authority) => [authority.page_id, authority.generation]));
  const history = await env.DB.prepare(`SELECT id FROM pages page WHERE id IN(SELECT value FROM json_each(?))
    AND ${authorityHistorySql("page.id", "''")}`)
    .bind(serializedIds)
    .all<{ id: string }>();
  const recorded = new Set(history.results.map((page) => page.id));
  for (const page of pages.results) {
    if (page.kind === "table")
      for (const stage of ["stop", "purge"] as const) {
        const target: TableDeletionTarget = {
          version: !generations.has(page.id) && !recorded.has(page.id) ? 2 : 1,
          ...(!generations.has(page.id) && !recorded.has(page.id) ? { mode: "d1" as const } : {}),
          pageId: page.id,
          workspaceId,
          generation: generations.get(page.id) ?? null,
          stage,
        };
        targets.set(`table:${page.id}:${stage}`, { kind: "table_do", target: JSON.stringify(target) });
      }
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
    try {
      await captureExternalRowEvidence(
        env,
        { id: jobId, workspace_id: workspaceId, root_page_id: rootId, attempts: 0, phase: "staging" },
        Number.MAX_SAFE_INTEGER,
      );
    } catch (error) {
      if (safeHttpError(error)) throw error;
      throw new HttpError(
        503,
        "deletion_evidence_unavailable",
        "Table deletion evidence is temporarily unavailable. Please retry shortly.",
      );
    }
    if (await captureRowHandoffs(env, { dependentJobId: jobId }))
      throw new HttpError(409, "deletion_pending", "The containing table deletion changed. Retry after it completes.");
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
      AND NOT ${missingTableStopsSql(false)} AND NOT ${REPAIRING_DELETION_ANCESTRY_SQL}
      AND NOT ${WHOLE_DELETION_ANCESTRY_SQL} AND NOT ${EVIDENCE_DELETION_PENDING_SQL} AND NOT ${INVALID_ROW_HANDOFF_SQL}
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
        jobId,
        jobId,
        jobId,
        jobId,
      )
      .first<{ id: string }>();
    if (!accepted) {
      const raced = await acceptedDeletionJob(env, workspaceId, rootId);
      const repairing = await env.DB.prepare(`SELECT 1 WHERE ${REPAIRING_DELETION_ANCESTRY_SQL}`).bind(jobId).first();
      await env.DB.prepare("DELETE FROM deletion_jobs WHERE id=? AND phase='staging'").bind(jobId).run();
      if (raced) return raced;
      if (repairing)
        throw new HttpError(
          409,
          "table_repairing",
          "A containing table is being repaired. Finish its repair before deleting this page.",
        );
      throw new HttpError(
        409,
        "deletion_pending",
        "The page subtree changed or overlaps an accepted deletion. Reload before retrying.",
      );
    }
    return { jobId, pageIds };
  } catch (error) {
    try {
      await env.DB.prepare("DELETE FROM deletion_jobs WHERE id=? AND phase='staging'").bind(jobId).run();
    } catch (cleanupError) {
      logger.warn(
        "deletion.staging.cleanup_failed",
        "cleanup",
        "Unaccepted deletion staging could not be removed.",
        { jobId },
        cleanupError,
      );
    }
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
      AND NOT ${missingTableStopsSql(true)} AND NOT ${REPAIRING_DELETION_ANCESTRY_SQL} RETURNING id`).bind(
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

async function processTarget(
  env: Env,
  target: DeletionTargetRow,
  hint?: DurableObjectLocationHint,
  jobId?: string,
  leaseUntil?: number,
) {
  if (target.kind === "table_row") {
    const tuple = JSON.parse(target.target) as RowDeletionTarget;
    if (tuple.handoff) {
      const handoff = tuple.handoff;
      if (
        handoff.version !== 1 ||
        handoff.pageId !== tuple.tableId ||
        handoff.generation !== tuple.generation ||
        typeof handoff.jobId !== "string" ||
        typeof handoff.workspaceId !== "string" ||
        !Number.isSafeInteger(handoff.archivedAt) ||
        (handoff.archiveOperationId !== null && typeof handoff.archiveOperationId !== "string") ||
        !["pending", "purged"].includes(handoff.status)
      )
        throw new Error("Invalid deletion row handoff");
      if (handoff.status !== "purged") throw new Error("Whole-table deletion is pending");
      const owned =
        await env.DB.prepare(`SELECT 1 FROM deletion_jobs dependent JOIN deletion_job_pages locked ON locked.job_id=dependent.id
        JOIN pages detail ON detail.id=locked.page_id AND detail.workspace_id=dependent.workspace_id
        WHERE dependent.id=? AND dependent.phase='rows' AND dependent.workspace_id=? AND dependent.next_attempt_at=?
          AND locked.page_id=? AND locked.archived_at=? AND locked.archive_operation_id IS ?
          AND detail.archived_at IS locked.archived_at AND detail.archive_operation_id IS locked.archive_operation_id`)
          .bind(
            jobId,
            handoff.workspaceId,
            leaseUntil,
            tuple.detailPageId,
            handoff.archivedAt,
            handoff.archiveOperationId,
          )
          .first();
      if (!owned) throw new Error("Deletion row handoff ownership changed");
      return;
    }
    const response = await env.TABLE.getByName(tuple.tableId).fetch(
      new Request("https://table.internal/delete-row", {
        method: "POST",
        headers: { "content-type": "application/json", "x-table-internal": env.BETTER_AUTH_SECRET },
        body: JSON.stringify({ ...tuple, jobId }),
        signal: AbortSignal.timeout(DOCUMENT_PURGE_TIMEOUT_MS),
      }),
    );
    let result: { ok?: unknown; projectionPending?: unknown };
    try {
      result = await decodeTableResponse(response);
    } catch (error) {
      const failure = safeHttpError(error);
      if (failure?.status === 503 && failure.code === "table_not_seeded") {
        const absent = await env.DB.prepare(`SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM pages WHERE id=?)
          AND NOT EXISTS(SELECT 1 FROM table_authority WHERE page_id=?)`)
          .bind(tuple.tableId, tuple.tableId)
          .first();
        if (!absent) throw error;
      } else if (failure?.status !== 410 || failure.code !== "table_purged") throw error;
      const dependent = await env.DB.prepare(
        "SELECT workspace_id FROM deletion_jobs WHERE id=? AND phase='rows' AND next_attempt_at=?",
      )
        .bind(jobId, leaseUntil)
        .first<{ workspace_id: string }>();
      if (!dependent) throw new HttpError(409, "deletion_pending", "Deletion ownership changed. Please retry.");
      const proofResponse = await env.TABLE.getByName(tuple.tableId).fetch(
        new Request("https://table.internal/row-deletion-proof", {
          method: "POST",
          headers: { "content-type": "application/json", "x-table-internal": env.BETTER_AUTH_SECRET },
          body: JSON.stringify({
            jobId,
            pageId: tuple.tableId,
            workspaceId: dependent.workspace_id,
            generation: tuple.generation,
            rowId: tuple.rowId,
            detailPageId: tuple.detailPageId,
            target: target.target,
            leaseUntil,
          }),
          signal: AbortSignal.timeout(DOCUMENT_PURGE_TIMEOUT_MS),
        }),
      );
      const proof = await decodeTableResponse<{
        purged: unknown;
        pageId: string;
        workspaceId: string;
        generation: number;
        purgeJobId: string;
        archivedAt: number;
        archiveOperationId: string | null;
      }>(proofResponse);
      if (
        proof.purged !== true ||
        proof.pageId !== tuple.tableId ||
        proof.workspaceId !== dependent.workspace_id ||
        proof.generation !== tuple.generation ||
        typeof proof.purgeJobId !== "string" ||
        !Number.isSafeInteger(proof.archivedAt) ||
        (proof.archiveOperationId !== null && typeof proof.archiveOperationId !== "string")
      )
        throw new HttpError(
          503,
          "table_deletion_proof_unavailable",
          "Deletion proof is unavailable. An owner can retry this deletion.",
        );
      const next = encodedRowHandoff(target.target, {
        version: 1,
        jobId: proof.purgeJobId,
        pageId: tuple.tableId,
        workspaceId: proof.workspaceId,
        generation: proof.generation,
        archivedAt: proof.archivedAt,
        archiveOperationId: proof.archiveOperationId,
        status: "purged",
      });
      const captured = await compareAndSwapRowTarget(
        env,
        jobId!,
        target.target,
        next,
        `EXISTS(SELECT 1 FROM deletion_jobs dependent JOIN deletion_job_pages locked ON locked.job_id=dependent.id
          JOIN pages detail ON detail.id=locked.page_id AND detail.workspace_id=dependent.workspace_id
          WHERE dependent.id=? AND dependent.phase='rows' AND dependent.next_attempt_at=? AND dependent.workspace_id=?
            AND locked.page_id=? AND locked.archived_at=? AND locked.archive_operation_id IS ?
            AND detail.archived_at IS locked.archived_at AND detail.archive_operation_id IS locked.archive_operation_id)
          AND NOT EXISTS(SELECT 1 FROM pages WHERE id=?) AND NOT EXISTS(SELECT 1 FROM table_authority WHERE page_id=?)
          AND NOT EXISTS(SELECT 1 FROM table_rows WHERE id=?) AND NOT EXISTS(SELECT 1 FROM table_row_pages WHERE row_id=? OR page_id=?)
          AND NOT EXISTS(SELECT 1 FROM table_id_claims WHERE kind='row' AND id=? AND page_id<>?)`,
        [
          jobId!,
          leaseUntil!,
          proof.workspaceId,
          tuple.detailPageId,
          proof.archivedAt,
          proof.archiveOperationId,
          tuple.tableId,
          tuple.tableId,
          tuple.rowId,
          tuple.rowId,
          tuple.detailPageId,
          tuple.rowId,
          tuple.tableId,
        ],
      );
      if (!captured.meta.changes)
        throw new HttpError(409, "deletion_pending", "Deletion proof ownership changed. Please retry.");
      target.target = next;
      return;
    }
    if (result.ok !== true || result.projectionPending !== false)
      throw new Error("Canonical row deletion projection is pending");
    return;
  }
  if (target.kind === "table_do") {
    const tuple = tableDeletionTarget(target.target);
    if (tuple?.version === 2) return;
    const pageId = tuple?.pageId ?? target.target;
    if (!tuple) {
      // Older cleanup jobs may have no page lock. Reserve the absent identity
      // in the same D1 statement that proves this job still owns its purge.
      const reserved =
        await env.DB.prepare(`INSERT OR IGNORE INTO deletion_job_pages(job_id,page_id,archive_operation_id,archived_at)
        SELECT job.id,?,NULL,0 FROM deletion_jobs job WHERE job.id=? AND job.phase='cleanup'
        AND EXISTS(SELECT 1 FROM deletion_targets WHERE job_id=job.id AND kind='table_do' AND target=? AND completed_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM pages WHERE id=?) AND NOT EXISTS(SELECT 1 FROM table_authority WHERE page_id=?);
      `)
          .bind(pageId, jobId, target.target, pageId, pageId)
          .run();
      const owned =
        await env.DB.prepare(`SELECT 1 FROM deletion_job_pages locked JOIN deletion_jobs job ON job.id=locked.job_id
        WHERE job.id=? AND job.phase='cleanup' AND locked.page_id=?
        AND NOT EXISTS(SELECT 1 FROM pages WHERE id=?) AND NOT EXISTS(SELECT 1 FROM table_authority WHERE page_id=?)`)
          .bind(jobId, pageId, pageId, pageId)
          .first();
      if (!reserved.meta.changes && !owned) throw new Error("Legacy table purge identity is unavailable");
    }
    const stop = tuple?.stage === "stop";
    const response = await env.TABLE.getByName(pageId).fetch(
      new Request(`https://table.internal/${stop ? "stop-repair-for-deletion" : "purge"}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-table-internal": env.BETTER_AUTH_SECRET },
        body: JSON.stringify(tuple ? { ...tuple, jobId } : { jobId, pageId }),
        signal: AbortSignal.timeout(DOCUMENT_PURGE_TIMEOUT_MS),
      }),
    );
    if (!response.ok) throw new Error(`Table ${stop ? "stop" : "purge"} failed with ${response.status}`);
    const result = await response.json<{
      ok?: unknown;
      stopped?: unknown;
      generation?: unknown;
      purged?: unknown;
      jobId?: unknown;
      pageId?: unknown;
      workspaceId?: unknown;
    }>();
    if (result.ok !== true || (stop && (result.stopped !== true || result.generation !== tuple!.generation)))
      throw new Error("Table deletion acknowledgment is invalid");
    if (tuple && !stop) {
      if (
        result.purged !== true ||
        result.jobId !== jobId ||
        result.pageId !== tuple.pageId ||
        result.workspaceId !== tuple.workspaceId ||
        result.generation !== tuple.generation
      )
        throw new Error("Table purge acknowledgment is invalid");
      await publishRowHandoffProofs(env, jobId!, tuple, target.target, leaseUntil!);
    }
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

async function upgradeDeletionTableTargets(env: Env, job: DeletionJobRow, leaseUntil: number) {
  const legacy = await env.DB.prepare(`SELECT target.target,page.workspace_id,authority.generation
    FROM deletion_targets target JOIN deletion_jobs job ON job.id=target.job_id
    JOIN deletion_job_pages locked ON locked.job_id=job.id AND locked.page_id=target.target
    JOIN pages page ON page.id=locked.page_id AND page.workspace_id=job.workspace_id AND page.kind='table'
    LEFT JOIN table_authority authority ON authority.page_id=page.id
    WHERE job.id=? AND job.phase='rows' AND job.next_attempt_at=? AND target.kind='table_do'
      AND substr(target.target,1,1)<>'{' AND target.completed_at IS NULL
      AND page.archived_at IS locked.archived_at AND page.archive_operation_id IS locked.archive_operation_id`)
    .bind(job.id, leaseUntil)
    .all<{ target: string; workspace_id: string; generation: number | null }>();
  for (const old of legacy.results) {
    const tuple = { version: 1, pageId: old.target, workspaceId: old.workspace_id, generation: old.generation };
    const guard = `EXISTS(SELECT 1 FROM deletion_jobs job JOIN deletion_job_pages locked ON locked.job_id=job.id
      JOIN pages page ON page.id=locked.page_id AND page.workspace_id=job.workspace_id AND page.kind='table'
      LEFT JOIN table_authority authority ON authority.page_id=page.id
      WHERE job.id=? AND job.phase='rows' AND job.next_attempt_at=? AND page.id=?
        AND page.archived_at IS locked.archived_at AND page.archive_operation_id IS locked.archive_operation_id
        AND authority.generation IS ? AND EXISTS(SELECT 1 FROM deletion_targets WHERE job_id=job.id AND kind='table_do' AND target=?))`;
    const result = await env.DB.batch([
      ...(["stop", "purge"] as const).map((stage) =>
        env.DB.prepare(`INSERT OR IGNORE INTO deletion_targets(job_id,kind,target)
        SELECT ?,'table_do',? WHERE ${guard}`).bind(
          job.id,
          JSON.stringify({ ...tuple, stage }),
          job.id,
          leaseUntil,
          old.target,
          old.generation,
          old.target,
        ),
      ),
      env.DB.prepare(`DELETE FROM deletion_targets WHERE job_id=? AND kind='table_do' AND target=? AND ${guard}`).bind(
        job.id,
        old.target,
        job.id,
        leaseUntil,
        old.target,
        old.generation,
        old.target,
      ),
    ]);
    if (!result[2]?.meta.changes) return "Deletion table target ownership changed";
  }
  return undefined;
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

  let phaseFailure: string | undefined;
  let parked = false;
  try {
    phaseFailure = job.phase === "rows" ? await upgradeDeletionTableTargets(env, job, leaseUntil) : undefined;
    if (job.phase === "cleanup") phaseFailure = await captureLegacyCleanupHandoffs(env, job, leaseUntil);
    if (job.phase === "rows" && !phaseFailure) {
      try {
        await captureExternalRowEvidence(env, job, leaseUntil);
        phaseFailure = await captureRowHandoffs(env, { wholeJobId: job.id, leaseUntil });
      } catch (error) {
        phaseFailure = safeTelemetryErrorMessage(error, "Deletion handoff capture failed");
      }
    }

    let targets = await env.DB.prepare(
      `SELECT kind, target FROM deletion_targets
      WHERE job_id = ? AND completed_at IS NULL
        AND (kind<>'table_do' OR NOT json_valid(target) OR json_extract(target,'$.stage') IN ('stop','purge'))
        AND (?<>'rows' OR (kind='table_do' AND json_valid(target) AND json_extract(target,'$.stage')='stop'))
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
      if (phaseFailure) break;
      for (const target of targets.results) {
        try {
          await processTarget(env, target, hint, job.id, leaseUntil);
          const d1 = target.kind === "table_do" && tableDeletionTarget(target.target)?.version === 2;
          const completed = await env.DB.prepare(
            `UPDATE deletion_targets
            SET completed_at = ?, attempts = attempts + 1, last_error = NULL
          WHERE job_id = ? AND kind = ? AND target = ?
            AND EXISTS (
              SELECT 1 FROM deletion_jobs WHERE id = ? AND next_attempt_at = ?
            ) ${d1 ? `AND ${d1CheckpointSql()}` : ""}`,
          )
            .bind(Date.now(), job.id, target.kind, target.target, job.id, leaseUntil)
            .run();
          if (d1 && !completed.meta.changes) throw new Error("D1 table deletion ownership changed");
        } catch (error) {
          const message = safeTelemetryErrorMessage(error, "Unknown cleanup failure");
          parked ||= safeHttpError(error)?.code === "table_deletion_proof_unavailable";
          phaseFailure ??= message;
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
      if (targets.results.some((target) => target.kind === "table_do")) {
        const unstopped = await env.DB.prepare(`SELECT 1 FROM deletion_targets WHERE job_id=? AND kind='table_do'
        AND json_valid(target) AND json_extract(target,'$.stage')='stop' AND completed_at IS NULL LIMIT 1`)
          .bind(job.id)
          .first();
        if (unstopped) break;
      }
      // Owned tables cannot restore links while external row targets are reconciled.
      if (targets.results.every((target) => target.kind !== "table_row")) {
        phaseFailure = await reconcileDeletionRowTargets(env, job, leaseUntil);
        if (phaseFailure) break;
        targets = await env.DB.prepare(
          "SELECT kind,target FROM deletion_targets WHERE job_id=? AND kind='table_row' AND completed_at IS NULL ORDER BY target",
        )
          .bind(job.id)
          .all<DeletionTargetRow>();
        if (targets.results.length) continue;
      }
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
          "SELECT kind,target FROM deletion_targets WHERE job_id=? AND completed_at IS NULL AND (kind<>'table_do' OR NOT json_valid(target) OR json_extract(target,'$.stage') IN ('stop','purge')) ORDER BY kind,target",
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
  } catch (error) {
    phaseFailure = safeTelemetryErrorMessage(error, "Deletion processing failed");
    parked ||= safeHttpError(error)?.code === "table_deletion_proof_unavailable";
  }

  await recordDeletionFailure(env, job.id, leaseUntil, phaseFailure, parked);
}

async function recordDeletionFailure(
  env: Env,
  jobId: string,
  leaseUntil: number,
  phaseFailure?: string,
  parked = false,
) {
  try {
    // Metadata finalization can commit even when its response is lost.
    const job = await env.DB.prepare("SELECT phase,attempts FROM deletion_jobs WHERE id=? AND next_attempt_at=?")
      .bind(jobId, leaseUntil)
      .first<{ phase: DeletionJobRow["phase"]; attempts: number }>();
    if (!job) return;
    const attempts = job.attempts + 1;
    const delay =
      job.phase === "rows" ? 60_000 : Math.min(24 * 60 * 60_000, 60 * 60_000 * 2 ** Math.min(attempts - 1, 4));
    const failed = await env.DB.prepare(
      `SELECT last_error FROM deletion_targets
      WHERE job_id = ? AND completed_at IS NULL AND last_error IS NOT NULL LIMIT 1`,
    )
      .bind(jobId)
      .first<{ last_error: string }>();
    await env.DB.prepare(
      `UPDATE deletion_jobs
        SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND next_attempt_at = ?`,
    )
      .bind(
        attempts,
        parked ? Number.MAX_SAFE_INTEGER : Date.now() + delay,
        phaseFailure ?? failed?.last_error ?? "Cleanup incomplete",
        Date.now(),
        jobId,
        leaseUntil,
      )
      .run();
  } catch (error) {
    logger.warn("cleanup.failure_checkpoint", "cleanup", "Deletion failure checkpoint unavailable", {
      error: safeTelemetryErrorMessage(error, "Cleanup retry checkpoint failed"),
    });
  }
}

export async function processDueDeletionJobs(env: Env, limit = 10) {
  await env.DB.prepare("DELETE FROM deletion_jobs WHERE phase='staging' AND created_at<?")
    .bind(Date.now() - 24 * 60 * 60_000)
    .run();
  const jobs = await env.DB.prepare(
    `SELECT id FROM deletion_jobs WHERE next_attempt_at <= ? AND phase<>'staging' ORDER BY next_attempt_at,created_at,id LIMIT ?`,
  )
    .bind(Date.now(), limit)
    .all<{ id: string }>();
  for (const job of jobs.results) {
    try {
      await processDeletionJob(env, job.id);
    } catch (error) {
      logger.warn("cleanup.job_unavailable", "cleanup", "Deletion job processing unavailable", {
        error: safeTelemetryErrorMessage(error, "Cleanup processing failed"),
      });
    }
  }
}
