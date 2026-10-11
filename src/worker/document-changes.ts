import { diffDocuments, digestExcerpts, type DigestComparison, type DocumentDiff } from "../shared/block-diff";
import type { DocumentContentEnvelope } from "../shared/types";
import type { Env } from "./env";
import { HttpError } from "./http";
import { logger } from "./observability";

export const CHANGE_RETENTION_MS = 30 * 86400_000;
const MAX_COMPARISON_BYTES = 2 * 1024 * 1024;
export type ChangeCheckpoint = {
  id: string;
  page_id: string;
  content_epoch: number;
  sequence: number;
  before_key: string | null;
  before_epoch: number | null;
  before_sequence: number | null;
  after_key: string;
  created_at: number;
};
export function checkpointStatements(
  env: Env,
  input: {
    pageId: string;
    epoch: number;
    sequence: number;
    afterKey: string;
    before: { r2_key: string; content_epoch: number; sequence: number } | null;
    actorId: string | null;
    recipients: string[];
    timestamp: number;
  },
) {
  if (env.DIFF_DIGESTS_ENABLED !== "true") return [];
  const id = `${input.pageId}:${input.epoch}:${input.sequence}`;
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO page_change_checkpoints
      (id,page_id,workspace_id,content_epoch,sequence,before_key,before_epoch,before_sequence,after_key,actor_id,created_at)
      SELECT ?,p.id,p.workspace_id,?,?,?,?,?,?,nullif(?,''),? FROM pages p
      JOIN document_projections projection ON projection.page_id=p.id
      WHERE p.id=? AND p.content_epoch=? AND p.kind='document' AND p.archived_at IS NULL
        AND p.import_job_id IS NULL AND p.is_template=0 AND projection.r2_key=? AND projection.sequence=?`).bind(
      id,
      input.epoch,
      input.sequence,
      input.before?.r2_key ?? null,
      input.before?.content_epoch ?? null,
      input.before?.sequence ?? null,
      input.afterKey,
      input.actorId,
      input.timestamp,
      input.pageId,
      input.epoch,
      input.afterKey,
      input.sequence,
    ),
    env.DB.prepare(`INSERT OR IGNORE INTO page_change_recipients(id,checkpoint_id,user_id)
      SELECT 'change:'||c.id||':'||recipient.value,c.id,recipient.value
      FROM page_change_checkpoints c JOIN pages p ON p.id=c.page_id
      JOIN spaces s ON s.id=p.space_id JOIN json_each(?) recipient
      JOIN workspace_members member ON member.workspace_id=c.workspace_id AND member.user_id=recipient.value
      LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=recipient.value
      WHERE c.id=? AND p.archived_at IS NULL AND (c.actor_id IS NULL OR c.actor_id<>recipient.value)
        AND (member.role='owner' OR s.visibility='workspace' OR sm.user_id IS NOT NULL)`).bind(
      JSON.stringify(input.recipients),
      id,
    ),
    // Existing delivery claims reference outbox rows. These digest-only anchors are never queued.
    env.DB.prepare(`INSERT OR IGNORE INTO outbox(id,workspace_id,topic,payload_json,available_at,enqueued_at,created_at)
      SELECT 'outbox:'||r.id,c.workspace_id,'notification_digest_change','{}',9007199254740991,c.created_at,c.created_at
      FROM page_change_recipients r JOIN page_change_checkpoints c ON c.id=r.checkpoint_id WHERE c.id=?`).bind(id),
  ];
}
async function projection(env: Env, key: string | null, pageId: string, epoch: number | null, sequence: number | null) {
  if (!key) return null;
  const object = await env.BUCKET.get(key);
  if (!object || object.size > MAX_COMPARISON_BYTES) return null;
  let envelope: DocumentContentEnvelope;
  try {
    envelope = await object.json<DocumentContentEnvelope>();
  } catch {
    return null;
  }
  if (
    !envelope ||
    envelope.schemaVersion !== 1 ||
    envelope.pageId !== pageId ||
    envelope.contentEpoch !== epoch ||
    envelope.sequence !== sequence ||
    !envelope.document ||
    envelope.document.type !== "doc"
  )
    return null;
  return envelope.document;
}
export async function readComparison(
  env: Env,
  pageId: string,
  firstId: string,
  lastId: string,
): Promise<DocumentDiff | null> {
  const rows = await env.DB.prepare(`SELECT * FROM page_change_checkpoints WHERE page_id=? AND id IN (?,?)`)
    .bind(pageId, firstId, lastId)
    .all<ChangeCheckpoint>();
  const first = rows.results.find((row) => row.id === firstId),
    last = rows.results.find((row) => row.id === lastId);
  if (!first || !last) throw new HttpError(410, "comparison_unavailable", "This comparison is no longer available.");
  if (
    first.created_at > last.created_at ||
    first.content_epoch > last.content_epoch ||
    (first.content_epoch === last.content_epoch && first.sequence > last.sequence)
  )
    throw new HttpError(422, "invalid_comparison", "Choose checkpoints in chronological order.");
  if (first.created_at < Date.now() - CHANGE_RETENTION_MS || last.created_at < Date.now() - CHANGE_RETENTION_MS)
    throw new HttpError(410, "comparison_expired", "This comparison has expired.");
  const [before, after] = await Promise.all([
    projection(env, first.before_key, pageId, first.before_epoch, first.before_sequence),
    projection(env, last.after_key, pageId, last.content_epoch, last.sequence),
  ]);
  if (!before || !after) return null;
  try {
    return diffDocuments(before, after);
  } catch {
    return null;
  }
}
export async function digestComparison(
  env: Env,
  pageId: string,
  first: string,
  last: string,
): Promise<DigestComparison> {
  try {
    const diff = await readComparison(env, pageId, first, last);
    if (!diff)
      logger.warn("document.comparison.fallback", "document", "Comparison snapshots unavailable or oversized.", {
        pageId,
      });
    return { first, last, diff };
  } catch (error) {
    logger.warn(
      "document.comparison.unavailable",
      "document",
      "A digest comparison is unavailable.",
      { pageId },
      error,
    );
    return { first, last, diff: null };
  }
}
export function comparisonUrl(origin: string, pageId: string, comparison: Pick<DigestComparison, "first" | "last">) {
  const url = new URL(origin);
  url.pathname = "/";
  url.search = new URLSearchParams({
    page: pageId,
    compareFrom: comparison.first,
    compareTo: comparison.last,
  }).toString();
  url.hash = "";
  return url.href;
}
export function comparisonLines(comparison: DigestComparison) {
  if (!comparison.diff) return ["Comparison unavailable; showing the activity summary."];
  const { counts } = comparison.diff;
  const lines = [
    `${counts.added} added · ${counts.removed} removed · ${counts.modified} changed · ${counts.moved} moved`,
  ];
  for (const change of digestExcerpts(comparison.diff)) {
    if (change.kind === "added") lines.push(`Added: ${change.after}`);
    else if (change.kind === "removed") lines.push(`Removed: ${change.before}`);
    else lines.push(`Before: ${change.before}`, `After: ${change.after}`);
  }
  return lines;
}
export async function pruneDocumentChanges(env: Env, timestamp = Date.now()) {
  const expired = await env.DB.prepare(
    `SELECT * FROM page_change_checkpoints WHERE created_at<? ORDER BY created_at,id LIMIT 100`,
  )
    .bind(timestamp - CHANGE_RETENTION_MS)
    .all<ChangeCheckpoint>();
  await env.DB.prepare(`DELETE FROM page_change_checkpoints WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(expired.results.map((row) => row.id)))
    .run();
  const queued = await env.DB.prepare("SELECT r2_key FROM page_change_projection_gc LIMIT 200").all<{
    r2_key: string;
  }>();
  for (const { r2_key: key } of queued.results) {
    const used = await env.DB.prepare(`SELECT 1 FROM document_projections WHERE r2_key=? UNION ALL
      SELECT 1 FROM page_change_checkpoints WHERE before_key=? OR after_key=? LIMIT 1`)
      .bind(key, key, key)
      .first();
    if (!used) await env.BUCKET.delete(key);
    await env.DB.prepare("DELETE FROM page_change_projection_gc WHERE r2_key=?").bind(key).run();
  }
  const retained = await env.DB.prepare("SELECT count(*) count FROM page_change_checkpoints").first<{
    count: number;
  }>();
  logger.info("document.comparison.pruned", "document", "Expired comparison history pruned.", {
    count: expired.results.length,
    retainedCheckpoints: retained?.count ?? 0,
    examinedProjections: queued.results.length,
  });
}
