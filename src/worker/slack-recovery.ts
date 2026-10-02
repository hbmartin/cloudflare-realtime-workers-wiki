import { deliverBulkSummary } from "./slack-bulk";
import { deliverDigest } from "./slack-digests";
import { deliverShareRefresh } from "./slack-shares";
import { deliverRound2ChannelEvent } from "./slack-channel-events";
import { thumbnailDeliveryEnabled, type DeliveryOutcome } from "./slack-delivery";
import type { Env } from "./env";

export const round2Receipts = {
  slack_bulk: { table: "slack_bulk_receipts", key: "summaryId", state: "state" },
  slack_channel: { table: "slack_channel_events", key: "eventId", state: "round2_state" },
  slack_digest: { table: "slack_digest_receipts", key: "digestId", state: "state" },
  slack_share_refresh: { table: "slack_share_refreshes", key: "refreshId", state: "state" },
  slack_file_upload: { table: "slack_file_artifacts", key: "artifactId", state: "state" },
} as const;
export async function round2DeliveryOutcome(
  env: Env,
  topic: keyof typeof round2Receipts,
  id: string,
): Promise<DeliveryOutcome> {
  const contract = round2Receipts[topic];
  const row = await env.DB.prepare(`SELECT ${contract.state} state,claimed_at FROM ${contract.table} WHERE id=?`)
    .bind(id)
    .first<{ state: string; claimed_at: number | null }>();
  if (!row || ["sent", "skipped", "retired", "uploaded", "failed"].includes(row.state)) return "completed" as const;
  if (row.claimed_at && row.claimed_at > Date.now() - 60_000) return "competing" as const;
  if (["sending", "blocked"].includes(row.state)) return "uncertain" as const;
  const paused = await env.DB.prepare(
    topic === "slack_channel"
      ? `SELECT 1 FROM slack_channel_events e JOIN slack_channel_subscriptions m ON m.id=e.subscription_id JOIN slack_installations i ON i.id=m.installation_id WHERE e.id=? AND (i.auth_error IS NOT NULL OR m.notification_blocked_at IS NOT NULL)`
      : `SELECT 1 FROM ${contract.table} r JOIN slack_installations i ON i.id=r.installation_id WHERE r.id=? AND i.auth_error IS NOT NULL`,
  )
    .bind(id)
    .first();
  if (paused) return "paused";
  return "retryable" as const;
}

export async function redriveRound2Outbox(env: Env) {
  const rows = await env.DB.prepare(`SELECT id,topic,payload_json,slack_redrive_count FROM outbox
    WHERE topic IN ('slack_bulk','slack_channel','slack_digest','slack_share_refresh','slack_file_upload') AND slack_redrive_due_at<=?
    AND slack_scope_paused_at IS NULL AND ((topic IN ('slack_bulk','slack_channel','slack_digest') AND ?=1) OR (topic='slack_share_refresh' AND ?=1) OR (topic='slack_file_upload' AND ?=1)) ORDER BY slack_redrive_due_at,id LIMIT 50`)
    .bind(
      Date.now(),
      env.SLACK_CHANNEL_VALIDATION_ENABLED === "true" ? 1 : 0,
      env.SLACK_SHARE_REFRESH_ENABLED === "true" ? 1 : 0,
      thumbnailDeliveryEnabled(env) ? 1 : 0,
    )
    .all<{ id: string; topic: keyof typeof round2Receipts; payload_json: string; slack_redrive_count: number }>();
  for (const row of rows.results) {
    const contract = round2Receipts[row.topic];
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const id = payload?.[contract.key];
    if (typeof id !== "string") {
      await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=NULL,last_error='invalid_round2_payload' WHERE id=?`)
        .bind(row.id)
        .run();
      continue;
    }
    const receipt = await env.DB.prepare(`SELECT ${contract.state} state FROM ${contract.table} WHERE id=?`)
      .bind(id)
      .first<{ state: string }>();
    if (receipt?.state === "blocked") {
      await env.DB.prepare("UPDATE outbox SET slack_redrive_due_at=? WHERE id=?")
        .bind(Date.now() + 30 * 60_000, row.id)
        .run();
      continue;
    }
    if (!receipt || !["pending", "sending", "uploading"].includes(receipt.state)) {
      await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=NULL WHERE id=?`).bind(row.id).run();
      continue;
    }
    const installationPaused = await env.DB.prepare(
      row.topic === "slack_channel"
        ? `SELECT 1 FROM slack_channel_events e JOIN slack_channel_subscriptions m ON m.id=e.subscription_id JOIN slack_installations i ON i.id=m.installation_id WHERE e.id=? AND (i.auth_error IS NOT NULL OR m.notification_blocked_at IS NOT NULL)`
        : `SELECT 1 FROM ${contract.table} r JOIN slack_installations i ON i.id=r.installation_id WHERE r.id=? AND i.auth_error IS NOT NULL`,
    )
      .bind(id)
      .first();
    if (installationPaused) {
      await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=? WHERE id=?`)
        .bind(Date.now() + 30 * 60_000, row.id)
        .run();
      continue;
    }
    if (
      (["slack_bulk", "slack_digest", "slack_channel"].includes(row.topic) &&
        env.SLACK_CHANNEL_VALIDATION_ENABLED !== "true") ||
      (row.topic === "slack_share_refresh" && env.SLACK_SHARE_REFRESH_ENABLED !== "true") ||
      (row.topic === "slack_file_upload" && !thumbnailDeliveryEnabled(env))
    )
      continue;
    try {
      await env.DELIVERY_QUEUE.send({ outboxId: row.id });
    } catch {
      await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=?,last_error='round2_enqueue_failed' WHERE id=?`)
        .bind(Date.now() + 60_000, row.id)
        .run();
      continue;
    }
    await env.DB.prepare(
      `UPDATE outbox SET enqueued_at=?,slack_redrive_due_at=?,slack_redrive_count=slack_redrive_count+1 WHERE id=?`,
    )
      .bind(Date.now(), Date.now() + 30 * 60_000, row.id)
      .run();
  }
}

// Owner recovery reconciles evidence only; it never resets an uncertain post for blind delivery.
export async function reconcileRound2Mapping(env: Env, mappingId: string) {
  const digests = await env.DB.prepare(
    `SELECT id FROM slack_digest_receipts WHERE subscription_id=? AND state IN ('sending','blocked') AND attempted_at IS NOT NULL`,
  )
    .bind(mappingId)
    .all<{ id: string }>();
  for (const row of digests.results) await deliverDigest(env, row.id, true);
  const events = await env.DB.prepare(
    `SELECT id FROM slack_channel_events WHERE subscription_id=? AND round2_state IN ('sending','blocked') AND attempted_at IS NOT NULL`,
  )
    .bind(mappingId)
    .all<{ id: string }>();
  for (const row of events.results) await deliverRound2ChannelEvent(env, row.id, true);
  const summaries = await env.DB.prepare(
    `SELECT DISTINCT r.id FROM slack_bulk_receipts r JOIN slack_channel_subscriptions m ON m.installation_id=r.installation_id AND m.channel_id=r.channel_id WHERE m.id=? AND r.state IN ('sending','blocked') AND r.attempted_at IS NOT NULL`,
  )
    .bind(mappingId)
    .all<{ id: string }>();
  for (const row of summaries.results) await deliverBulkSummary(env, row.id, true);
  const shares =
    await env.DB.prepare(`SELECT r.id FROM slack_share_refreshes r JOIN slack_channel_subscriptions m ON m.installation_id=r.installation_id AND m.channel_id=r.channel_id
    WHERE m.id=? AND r.state IN ('sending','blocked') AND r.attempted_at IS NOT NULL`)
      .bind(mappingId)
      .all<{ id: string }>();
  for (const row of shares.results) await deliverShareRefresh(env, row.id, true);
}
