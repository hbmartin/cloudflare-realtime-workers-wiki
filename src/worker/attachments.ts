import type { Env } from "./env";
import { safeErrorMessage } from "../shared/error-log.ts";

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

interface DueUploadRow {
  id: string;
  state: "active" | "completing" | "r2_complete" | "reaping" | "aborting";
}

function uploadRetryDelay(attempts: number) {
  return Math.min(60 * 60_000, 10_000 * 2 ** Math.min(Math.max(1, attempts) - 1, 8));
}

function uploadErrorMessage(error: unknown, fallback: string) {
  return safeErrorMessage(error, fallback);
}

async function rescheduleUpload(
  env: Env,
  row: Pick<UploadReapRow, "id" | "attempts">,
  leaseUntil: number,
  state: "active" | "completing" | "r2_complete" | "reaping" | "aborting",
  error: unknown,
) {
  const timestamp = Date.now();
  await env.DB.prepare(
    `UPDATE attachment_uploads
        SET state = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ? AND next_attempt_at = ?`,
  )
    .bind(
      state,
      Math.max(1, row.attempts),
      timestamp + uploadRetryDelay(row.attempts),
      uploadErrorMessage(error, "Unknown upload cleanup failure"),
      timestamp,
      row.id,
      leaseUntil,
    )
    .run();
}

async function reapUpload(env: Env, id: string) {
  const claimedAt = Date.now();
  const leaseUntil = claimedAt + UPLOAD_REAP_LEASE_MS;
  const claimed = await env.DB.prepare(
    `UPDATE attachment_uploads
          SET state = 'reaping', attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND state = 'active' AND next_attempt_at <= ?
        RETURNING id, r2_key, r2_upload_id, attempts`,
  )
    .bind(leaseUntil, claimedAt, id, claimedAt)
    .first<UploadReapRow>();
  if (!claimed) return false;

  try {
    await env.BUCKET.resumeMultipartUpload(claimed.r2_key, claimed.r2_upload_id).abort();
  } catch (error) {
    try {
      // An abort failure is ambiguous: R2 may have applied it before the response was
      // lost. Keep the session fenced as reaping so a client never resumes an upload
      // whose multipart state may already be gone; the terminal retry path reconciles it.
      await rescheduleUpload(env, claimed, leaseUntil, "reaping", error);
    } catch (retryError) {
      console.error("Failed to reschedule abandoned upload", retryError);
    }
    return false;
  }

  try {
    await env.DB.prepare(`DELETE FROM attachment_uploads WHERE id = ? AND state = 'reaping' AND next_attempt_at = ?`)
      .bind(id, leaseUntil)
      .run();
    return true;
  } catch (error) {
    // R2 is already clean. Do not make the row active again: it would advertise a
    // resumable multipart upload that no longer exists. The fenced reaping row is safe
    // for an operator to discard after D1 recovers.
    console.error("Failed to delete reaped upload row", error);
    return false;
  }
}

async function retryTerminalAbort(env: Env, id: string, state: "reaping" | "aborting") {
  const claimedAt = Date.now();
  const leaseUntil = claimedAt + UPLOAD_REAP_LEASE_MS;
  const claimed = await env.DB.prepare(
    `UPDATE attachment_uploads
        SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND state = ? AND next_attempt_at <= ?
      RETURNING id, r2_key, r2_upload_id, attempts`,
  )
    .bind(leaseUntil, claimedAt, id, state, claimedAt)
    .first<UploadReapRow>();
  if (!claimed) return false;
  try {
    // R2 abort is repeatable. This covers a Worker disappearing before abort and the
    // equally important split where abort succeeded but deleting the D1 row did not.
    await env.BUCKET.resumeMultipartUpload(claimed.r2_key, claimed.r2_upload_id).abort();
    await env.DB.prepare(`DELETE FROM attachment_uploads WHERE id = ? AND state = ? AND next_attempt_at = ?`)
      .bind(id, state, leaseUntil)
      .run();
    return true;
  } catch (error) {
    await rescheduleUpload(env, claimed, leaseUntil, state, error).catch((retryError) => {
      console.error("Failed to reschedule terminal upload abort", retryError);
    });
    return false;
  }
}

/**
 * Resolves a completion request whose Worker disappeared after changing state.
 *
 * R2 is strongly consistent once complete: an object at the private random key proves
 * the multipart upload crossed the irreversible boundary, so the request route can
 * safely finish the D1 commit. No object means the parts may still be resumable; return
 * the row to a due active state so the next cron aborts it unless a client refreshes its
 * deadline first.
 */
async function inspectStaleCompletion(env: Env, id: string) {
  const inspectedAt = Date.now();
  const leaseUntil = inspectedAt + UPLOAD_REAP_LEASE_MS;
  const claimed = await env.DB.prepare(
    `UPDATE attachment_uploads
        SET next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND state = 'completing' AND next_attempt_at <= ?
      RETURNING id, r2_key, r2_upload_id, attempts`,
  )
    .bind(leaseUntil, inspectedAt, id, inspectedAt)
    .first<UploadReapRow>();
  if (!claimed) return false;

  try {
    const object = await env.BUCKET.head(claimed.r2_key);
    if (object) {
      // Give the client one more session lifetime to commit the metadata; after that
      // the reaper resolves the row terminally rather than leaving it parked forever.
      await env.DB.prepare(
        `UPDATE attachment_uploads
            SET state = 'r2_complete', next_attempt_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ? AND state = 'completing' AND next_attempt_at = ?`,
      )
        .bind(Date.now() + UPLOAD_SESSION_TTL_MS, Date.now(), id, leaseUntil)
        .run();
      return true;
    }

    await env.DB.prepare(
      `UPDATE attachment_uploads
          SET state = 'active', next_attempt_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND state = 'completing' AND next_attempt_at = ?`,
    )
      .bind(inspectedAt, Date.now(), id, leaseUntil)
      .run();
    return true;
  } catch (error) {
    try {
      await rescheduleUpload(env, claimed, leaseUntil, "completing", error);
    } catch (retryError) {
      console.error("Failed to reschedule completion inspection", retryError);
    }
    return false;
  }
}

/**
 * Resolves an 'r2_complete' session whose client never returned for the metadata
 * commit.
 *
 * The upload crossed R2's irreversible completion boundary, so the bytes are whole and
 * every column the attachments row needs is already on the session. When the page still
 * exists the reaper finishes the commit the client abandoned - the same idempotent
 * batch the complete route runs, so a late client retry replays it as committed. When
 * the page is gone the metadata can never commit, and the object and row are deleted.
 */
async function resolveCompletedUpload(env: Env, id: string) {
  const claimedAt = Date.now();
  const leaseUntil = claimedAt + UPLOAD_REAP_LEASE_MS;
  const claimed = await env.DB.prepare(
    `UPDATE attachment_uploads
        SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND state = 'r2_complete' AND next_attempt_at <= ?
      RETURNING id, r2_key, r2_upload_id, attempts, page_id`,
  )
    .bind(leaseUntil, claimedAt, id, claimedAt)
    .first<UploadReapRow & { page_id: string }>();
  if (!claimed) return false;

  try {
    const page = await env.DB.prepare(`SELECT 1 found FROM pages WHERE id = ?`).bind(claimed.page_id).first();
    if (page) {
      const timestamp = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO attachments
               (id, workspace_id, page_id, r2_key, name, mime, size, content_sha256, created_by, created_at)
             SELECT id, workspace_id, page_id, r2_key, name, mime, size, content_sha256, created_by, ?
               FROM attachment_uploads WHERE id = ? AND state = 'r2_complete'`,
        ).bind(timestamp, id),
        env.DB.prepare(
          `UPDATE attachment_uploads SET state = 'committed', updated_at = ? WHERE id = ? AND state = 'r2_complete'`,
        ).bind(timestamp, id),
        env.DB.prepare(`DELETE FROM attachment_uploads WHERE id = ? AND state = 'committed'`).bind(id),
      ]);
      return true;
    }
    await env.BUCKET.delete(claimed.r2_key);
    await env.DB.prepare(
      `DELETE FROM attachment_uploads WHERE id = ? AND state = 'r2_complete' AND next_attempt_at = ?`,
    )
      .bind(id, leaseUntil)
      .run();
    return true;
  } catch (error) {
    await rescheduleUpload(env, claimed, leaseUntil, "r2_complete", error).catch((retryError) => {
      console.error("Failed to reschedule completed upload resolution", retryError);
    });
    return false;
  }
}

/**
 * Aborts upload sessions whose deadline has passed, freeing the parts R2 is holding.
 *
 * Every accepted part pushes the deadline forward, so an upload that is merely slow is
 * never collected; only one nobody is still feeding. A completed-but-uncommitted
 * session ('r2_complete') is resolved terminally after one further session lifetime
 * instead of leaking its object. An R2 lifecycle rule aborting incomplete multipart
 * uploads is the backstop for sessions whose D1 row was lost.
 */
export async function processDueUploadReaps(env: Env, limit = UPLOAD_REAP_BATCH_SIZE) {
  const due = await env.DB.prepare(
    `SELECT id, state FROM attachment_uploads
      WHERE state IN ('active', 'completing', 'r2_complete', 'reaping', 'aborting') AND next_attempt_at <= ?
      ORDER BY created_at LIMIT ?`,
  )
    .bind(Date.now(), limit)
    .all<DueUploadRow>();
  for (const row of due.results) {
    if (row.state === "completing") await inspectStaleCompletion(env, row.id);
    else if (row.state === "r2_complete") await resolveCompletedUpload(env, row.id);
    else if (row.state === "active") await reapUpload(env, row.id);
    else await retryTerminalAbort(env, row.id, row.state);
  }
}
