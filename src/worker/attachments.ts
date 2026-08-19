import type { Env } from "./env";

/**
 * Attachment upload policy, shared by both upload paths, plus the reaper that
 * collects multipart sessions nobody finished.
 *
 * There are two ways bytes reach R2: the original single-shot `multipart/form-data`
 * route, still the browser's path for small files, and the chunked direct-to-R2 route
 * that lifts the practical size cap. They share one MIME policy deliberately — the
 * declared name and content type are equally caller-supplied on both, so forking the
 * rules would add a second thing to keep correct without adding any safety.
 */

/** Ceiling for one single-shot form upload; the Workers request body bounds this. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Sanity ceiling for a multipart upload. "No practical cap" should still be a number
 * an operator can reason about when forecasting R2 spend.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * R2 requires every part except the last to be exactly the same size, so the server
 * dictates it rather than trusting whatever the client chunked to. The floor is R2's
 * own 5 MiB minimum for a non-final part; the ceiling stays under the 100 MB Workers
 * request body limit on the Free and Pro plans.
 */
const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;
const MULTIPART_MAX_PART_BYTES = 64 * 1024 * 1024;

/** How long an untouched upload session survives before the reaper aborts it. */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60_000;

const UPLOAD_REAP_LEASE_MS = 15 * 60_000;
const UPLOAD_REAP_BATCH_SIZE = 50;

const UNSAFE_MIME_TYPES = new Set([
  "text/html",
  "image/svg+xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/x-javascript",
  "text/javascript",
]);

const UNSAFE_FILE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".htx",
  ".xhtml",
  ".xht",
  ".svg",
  ".svgz",
  ".xml",
  ".js",
  ".jse",
  ".mjs",
  ".cjs",
]);

export function isUnsafeMime(mime: string, name: string) {
  const normalizedMime = mime.toLowerCase().split(";", 1)[0]!.trim();
  const extension = name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  return UNSAFE_MIME_TYPES.has(normalizedMime) || UNSAFE_FILE_EXTENSIONS.has(extension);
}

/**
 * Whether a download may render in place rather than being forced to disk.
 *
 * Video and audio belong here because the editor's media blocks play from this route;
 * without them a video block offers a download instead of a player. Range requests,
 * which seeking depends on, are already handled by the download route.
 */
export function isInlineMime(mime: string) {
  return (
    /^image\/(png|jpeg|gif|webp|avif)$/.test(mime) ||
    /^video\/(mp4|webm|ogg)$/.test(mime) ||
    /^audio\/(mpeg|ogg|wav|webm|mp4)$/.test(mime) ||
    mime === "application/pdf" ||
    mime === "text/plain" ||
    mime === "text/markdown"
  );
}

/** Clamps a client's part-size hint into the range R2 and Workers both accept. */
export function resolvePartSize(requested: unknown) {
  const hint = Number(requested);
  if (!Number.isInteger(hint) || hint <= 0) return MULTIPART_PART_BYTES;
  return Math.min(MULTIPART_MAX_PART_BYTES, Math.max(MULTIPART_MIN_PART_BYTES, hint));
}

interface UploadReapRow {
  id: string;
  r2_key: string;
  r2_upload_id: string;
  attempts: number;
}

async function reapUpload(env: Env, id: string) {
  const claimedAt = Date.now();
  const leaseUntil = claimedAt + UPLOAD_REAP_LEASE_MS;
  let attempts = 0;
  try {
    const claimed = await env.DB.prepare(
      `UPDATE attachment_uploads
          SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND next_attempt_at <= ?
        RETURNING id, r2_key, r2_upload_id, attempts`,
    )
      .bind(leaseUntil, claimedAt, id, claimedAt)
      .first<UploadReapRow>();
    if (!claimed) return false;
    attempts = claimed.attempts;
    await env.BUCKET.resumeMultipartUpload(claimed.r2_key, claimed.r2_upload_id).abort();
    await env.DB.prepare(`DELETE FROM attachment_uploads WHERE id = ? AND next_attempt_at = ?`)
      .bind(id, leaseUntil)
      .run();
    return true;
  } catch (error) {
    const recordedAttempts = Math.max(1, attempts);
    const delay = Math.min(60 * 60_000, 10_000 * 2 ** Math.min(recordedAttempts - 1, 8));
    const message = error instanceof Error ? error.message : "Unknown upload abort failure";
    try {
      await env.DB.prepare(
        `UPDATE attachment_uploads
            SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
          WHERE id = ? AND next_attempt_at = ?`,
      )
        .bind(recordedAttempts, Date.now() + delay, message.slice(0, 1_000), Date.now(), id, leaseUntil)
        .run();
    } catch (retryError) {
      // The row stays due, so the next cron picks it up again.
      console.error("Failed to reschedule abandoned upload", retryError);
    }
    return false;
  }
}

/**
 * Aborts upload sessions whose deadline has passed, freeing the parts R2 is holding.
 *
 * Every accepted part pushes the deadline forward, so an upload that is merely slow is
 * never collected; only one nobody is still feeding. An R2 lifecycle rule aborting
 * incomplete multipart uploads is the backstop for sessions whose D1 row was lost.
 */
export async function processDueUploadReaps(env: Env, limit = UPLOAD_REAP_BATCH_SIZE) {
  const due = await env.DB.prepare(
    `SELECT id FROM attachment_uploads WHERE next_attempt_at <= ? ORDER BY created_at LIMIT ?`,
  )
    .bind(Date.now(), limit)
    .all<{ id: string }>();
  for (const row of due.results) await reapUpload(env, row.id);
}
