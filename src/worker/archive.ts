import type { Env } from "./env";
import { locationHint } from "./http";

interface ArchiveDisconnectTarget {
  page_id: string;
  content_epoch: number;
}

const ARCHIVE_DISCONNECT_BATCH_SIZE = 25;
const ARCHIVE_DISCONNECT_TIMEOUT_MS = 30_000;
const ARCHIVE_DISCONNECT_LEASE_MS = 60_000;

async function processArchiveDisconnectTarget(env: Env, target: ArchiveDisconnectTarget) {
  const claimedAt = Date.now();
  const leaseUntil = claimedAt + ARCHIVE_DISCONNECT_LEASE_MS;
  let attempts = 0;
  try {
    const claimed = await env.DB.prepare(
      `UPDATE archive_disconnect_targets
          SET next_attempt_at = ?, updated_at = ?
        WHERE page_id = ? AND content_epoch = ? AND next_attempt_at <= ?
        RETURNING workspace_id, room, attempts`,
    ).bind(leaseUntil, claimedAt, target.page_id, target.content_epoch, claimedAt).first<{
      workspace_id: string;
      room: string;
      attempts: number;
    }>();
    if (!claimed) return false;
    attempts = claimed.attempts;

    const page = await env.DB.prepare(
      `SELECT p.content_epoch, p.archived_at, w.location_hint
         FROM pages p JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.id = ? AND p.workspace_id = ?`,
    ).bind(target.page_id, claimed.workspace_id).first<{
      content_epoch: number;
      archived_at: number | null;
      location_hint: string | null;
    }>();
    if (!page || page.archived_at === null || page.content_epoch !== target.content_epoch) {
      await env.DB.prepare(
        `DELETE FROM archive_disconnect_targets
          WHERE page_id = ? AND content_epoch = ? AND next_attempt_at = ?`,
      ).bind(target.page_id, target.content_epoch, leaseUntil).run();
      return true;
    }

    const hint = locationHint(page.location_hint ?? undefined);
    const stub = env.DOCUMENT.getByName(
      claimed.room,
      hint ? { locationHint: hint } : undefined,
    );
    const response = await stub.fetch(new Request("https://document.internal/archive", {
      method: "POST",
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      signal: AbortSignal.timeout(ARCHIVE_DISCONNECT_TIMEOUT_MS),
    }));
    if (!response.ok) throw new Error(`Document archive failed with ${response.status}`);
    await env.DB.prepare(
      `DELETE FROM archive_disconnect_targets
        WHERE page_id = ? AND content_epoch = ? AND next_attempt_at = ?`,
    ).bind(target.page_id, target.content_epoch, leaseUntil).run();
    return true;
  } catch (error) {
    const nextAttempts = attempts + 1;
    const delay = Math.min(60 * 60_000, 10_000 * 2 ** Math.min(nextAttempts - 1, 8));
    const message = error instanceof Error ? error.message : "Unknown document archive failure";
    try {
      await env.DB.prepare(
        `UPDATE archive_disconnect_targets
            SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
          WHERE page_id = ? AND content_epoch = ? AND next_attempt_at = ?`,
      ).bind(
        nextAttempts,
        Date.now() + delay,
        message.slice(0, 1_000),
        Date.now(),
        target.page_id,
        target.content_epoch,
        leaseUntil,
      ).run();
    } catch (retryError) {
      // The original target row remains due and can be retried by the next cron.
      console.error("Failed to reschedule archive disconnect", retryError);
    }
    return false;
  }
}

export async function processArchiveDisconnectTargets(
  env: Env,
  targets: ArchiveDisconnectTarget[],
) {
  const pendingPageIds: string[] = [];
  for (let offset = 0; offset < targets.length; offset += ARCHIVE_DISCONNECT_BATCH_SIZE) {
    const batch = targets.slice(offset, offset + ARCHIVE_DISCONNECT_BATCH_SIZE);
    const results = await Promise.all(batch.map((target) => processArchiveDisconnectTarget(env, target)));
    for (const [index, complete] of results.entries()) {
      if (!complete) pendingPageIds.push(batch[index].page_id);
    }
  }
  return pendingPageIds;
}

export async function processDueArchiveDisconnects(env: Env, limit = 50) {
  const targets = await env.DB.prepare(
    `SELECT page_id, content_epoch
       FROM archive_disconnect_targets
      WHERE next_attempt_at <= ?
      ORDER BY created_at LIMIT ?`,
  ).bind(Date.now(), limit).all<ArchiveDisconnectTarget>();
  await processArchiveDisconnectTargets(env, targets.results);
}
