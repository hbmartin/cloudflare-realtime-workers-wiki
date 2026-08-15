import type { Env } from "./env";

interface ArchiveDisconnectTarget {
  page_id: string;
  workspace_id: string;
  content_epoch: number;
  room: string;
  attempts: number;
}

const ARCHIVE_DISCONNECT_BATCH_SIZE = 25;

async function processArchiveDisconnectTarget(env: Env, target: ArchiveDisconnectTarget) {
  try {
    const page = await env.DB.prepare(
      `SELECT content_epoch, archived_at FROM pages WHERE id = ? AND workspace_id = ?`,
    ).bind(target.page_id, target.workspace_id).first<{
      content_epoch: number;
      archived_at: number | null;
    }>();
    if (!page || page.archived_at === null || page.content_epoch !== target.content_epoch) {
      await env.DB.prepare(
        `DELETE FROM archive_disconnect_targets WHERE page_id = ? AND content_epoch = ?`,
      ).bind(target.page_id, target.content_epoch).run();
      return true;
    }

    const stub = env.DOCUMENT.getByName(target.room);
    const response = await stub.fetch(new Request("https://document.internal/archive", {
      method: "POST",
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
    }));
    if (!response.ok) throw new Error(`Document archive failed with ${response.status}`);
    await env.DB.prepare(
      `DELETE FROM archive_disconnect_targets WHERE page_id = ? AND content_epoch = ?`,
    ).bind(target.page_id, target.content_epoch).run();
    return true;
  } catch (error) {
    const attempts = target.attempts + 1;
    const delay = Math.min(60 * 60_000, 10_000 * 2 ** Math.min(attempts - 1, 8));
    const message = error instanceof Error ? error.message : "Unknown document archive failure";
    try {
      await env.DB.prepare(
        `UPDATE archive_disconnect_targets
            SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
          WHERE page_id = ? AND content_epoch = ?`,
      ).bind(
        attempts,
        Date.now() + delay,
        message.slice(0, 1_000),
        Date.now(),
        target.page_id,
        target.content_epoch,
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
    `SELECT page_id, workspace_id, content_epoch, room, attempts
       FROM archive_disconnect_targets
      WHERE next_attempt_at <= ?
      ORDER BY created_at LIMIT ?`,
  ).bind(Date.now(), limit).all<ArchiveDisconnectTarget>();
  await processArchiveDisconnectTargets(env, targets.results);
}
