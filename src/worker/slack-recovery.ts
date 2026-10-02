import { deliverDigest } from "./slack-digests";
import { deliverShareRefresh } from "./slack-shares";
import { deliverRound2ChannelEvent } from "./slack-channel-events";
import type { Env } from "./env";

const receipts = {
  slack_channel: { table: "slack_channel_events", key: "eventId", state: "round2_state" },
  slack_digest: { table: "slack_digest_receipts", key: "digestId", state: "state" },
  slack_share_refresh: { table: "slack_share_refreshes", key: "refreshId", state: "state" },
  slack_file_upload: { table: "slack_file_artifacts", key: "artifactId", state: "state" },
} as const;
export async function redriveRound2Outbox(env: Env) {
  const rows = await env.DB.prepare(`SELECT id,topic,payload_json,slack_redrive_count FROM outbox
    WHERE topic IN ('slack_channel','slack_digest','slack_share_refresh','slack_file_upload') AND slack_redrive_due_at<=?
    AND slack_scope_paused_at IS NULL ORDER BY slack_redrive_due_at,id LIMIT 50`)
    .bind(Date.now())
    .all<{ id: string; topic: keyof typeof receipts; payload_json: string; slack_redrive_count: number }>();
  for (const row of rows.results) {
    const contract = receipts[row.topic];
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
    if (!receipt || !["pending", "sending", "uploading"].includes(receipt.state)) {
      await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=NULL WHERE id=?`).bind(row.id).run();
      continue;
    }
    if (row.slack_redrive_count >= 8) {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE ${contract.table} SET ${contract.state}=? ${row.topic === "slack_channel" ? "" : ",last_error='redrive_exhausted'"} WHERE id=?`,
        ).bind(row.topic === "slack_file_upload" ? "failed" : "blocked", id),
        env.DB.prepare(
          `UPDATE outbox SET slack_redrive_due_at=NULL,last_error='round2_redrive_exhausted' WHERE id=?`,
        ).bind(row.id),
      ]);
      continue;
    }
    if (
      (["slack_digest", "slack_channel"].includes(row.topic) && env.SLACK_CHANNEL_VALIDATION_ENABLED !== "true") ||
      (row.topic === "slack_share_refresh" && env.SLACK_SHARE_REFRESH_ENABLED !== "true") ||
      (row.topic === "slack_file_upload" && env.SLACK_RICH_DIGESTS_ENABLED !== "true")
    )
      continue;
    try {
      await env.DELIVERY_QUEUE.send({ outboxId: row.id });
    } catch {
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
  const shares =
    await env.DB.prepare(`SELECT r.id FROM slack_share_refreshes r JOIN slack_channel_subscriptions m ON m.installation_id=r.installation_id AND m.channel_id=r.channel_id
    WHERE m.id=? AND r.state IN ('sending','blocked') AND r.attempted_at IS NOT NULL`)
      .bind(mappingId)
      .all<{ id: string }>();
  for (const row of shares.results) await deliverShareRefresh(env, row.id, true);
}
