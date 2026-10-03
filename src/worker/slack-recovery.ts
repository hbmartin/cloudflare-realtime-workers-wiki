import { deliverBulkSummary } from "./slack-bulk";
import { deliverDigest } from "./slack-digests";
import { deliverShareRefresh } from "./slack-shares";
import { deliverRound2ChannelEvent } from "./slack-channel-events";
import { thumbnailDeliveryEnabled, wakeRound2Mapping, type DeliveryOutcome } from "./slack-delivery";
import type { Env } from "./env";

export const round2Receipts = {
  slack_bulk: { table: "slack_bulk_receipts", key: "summaryId", state: "state" },
  slack_channel: { table: "slack_channel_events", key: "eventId", state: "round2_state" },
  slack_digest: { table: "slack_digest_receipts", key: "digestId", state: "state" },
  slack_share_refresh: { table: "slack_share_refreshes", key: "refreshId", state: "state" },
  slack_file_upload: { table: "slack_file_artifacts", key: "artifactId", state: "state" },
} as const;

// Both consumers and redrive use the same receipt and destination evidence.
function receiptStatusSql(topic: keyof typeof round2Receipts, idSql: string) {
  const contract = round2Receipts[topic];
  const channel = topic === "slack_channel";
  const mapping = channel || topic === "slack_digest";
  const installation = channel ? "m.installation_id" : "r.installation_id";
  let destinationPause = "0";
  if (mapping)
    destinationPause = `m.notification_blocked_at IS NOT NULL OR m.muted_at IS NOT NULL OR coalesce(m.snoozed_until,0)>${Date.now()}`;
  else if (topic === "slack_bulk")
    destinationPause = `EXISTS(SELECT 1 FROM slack_channel_subscriptions m WHERE m.installation_id=r.installation_id AND m.channel_id=r.channel_id)
    AND NOT EXISTS(SELECT 1 FROM slack_channel_subscriptions m WHERE m.installation_id=r.installation_id AND m.channel_id=r.channel_id AND m.notification_blocked_at IS NULL AND m.muted_at IS NULL AND coalesce(m.snoozed_until,0)<=${Date.now()})`;
  else if (topic === "slack_file_upload")
    destinationPause = `EXISTS(SELECT 1 FROM slack_channel_subscriptions m JOIN pages p ON p.space_id=m.space_id AND (m.page_id IS NULL OR m.page_id=p.id) WHERE p.id=r.page_id AND m.installation_id=r.installation_id)
    AND NOT EXISTS(SELECT 1 FROM slack_channel_subscriptions m JOIN pages p ON p.space_id=m.space_id AND (m.page_id IS NULL OR m.page_id=p.id) WHERE p.id=r.page_id AND m.installation_id=r.installation_id AND m.notification_blocked_at IS NULL)`;
  return `SELECT r.${contract.state} state,r.claimed_at,${topic === "slack_file_upload" ? "NULL" : "r.attempted_at"} attempted_at,
    ${channel ? "r.delivered_at IS NOT NULL OR r.suppressed_at IS NOT NULL" : "0"} completed,
    ${topic === "slack_digest" ? "EXISTS(SELECT 1 FROM slack_digest_messages child WHERE child.receipt_id=r.id AND child.state IN ('sending','blocked'))" : "0"} uncertain_child,
    ${topic === "slack_digest" ? "EXISTS(SELECT 1 FROM slack_digest_messages child WHERE child.receipt_id=r.id AND child.state='blocked')" : "0"} blocked_child,
    i.disconnected_at IS NULL AND i.generation=r.installation_generation AND (i.auth_error IS NOT NULL OR (${destinationPause})) paused
    FROM ${contract.table} r ${mapping ? "JOIN slack_channel_subscriptions m ON m.id=r.subscription_id" : ""}
    JOIN slack_installations i ON i.id=${installation} WHERE r.id=${idSql}`;
}
const outcomeSql = () => `CASE WHEN state IN ('sent','skipped','retired','uploaded','failed') THEN 'completed'
  WHEN claimed_at>${Date.now() - 60_000} THEN 'competing'
  WHEN state IN ('sending','blocked') OR uncertain_child THEN 'uncertain'
  WHEN completed THEN 'completed' WHEN paused THEN 'paused' ELSE 'retryable' END`;
export async function round2DeliveryOutcome(
  env: Env,
  topic: keyof typeof round2Receipts,
  id: string,
): Promise<DeliveryOutcome> {
  const row = await env.DB.prepare(`SELECT ${outcomeSql()} outcome FROM (${receiptStatusSql(topic, "?")})`)
    .bind(id)
    .first<{ outcome: DeliveryOutcome }>();
  return row?.outcome ?? "completed";
}

export async function redriveRound2Outbox(env: Env) {
  const topics = (Object.keys(round2Receipts) as Array<keyof typeof round2Receipts>).filter((topic) =>
    topic === "slack_file_upload"
      ? thumbnailDeliveryEnabled(env)
      : topic === "slack_share_refresh"
        ? env.SLACK_SHARE_REFRESH_ENABLED === "true"
        : env.SLACK_CHANNEL_VALIDATION_ENABLED === "true",
  );
  if (!topics.length) return;
  const due = topics
    .map((topic) => {
      const key = round2Receipts[topic].key;
      const id = `json_extract(CASE WHEN json_valid(o.payload_json) THEN o.payload_json ELSE '{}' END,'$.${key}')`;
      const status = receiptStatusSql(topic, id);
      return `SELECT o.id,o.topic,o.payload_json,${id} receipt_id,
      coalesce((SELECT max(b.slack_redrive_count) FROM outbox b WHERE b.topic=o.topic
        AND json_extract(CASE WHEN json_valid(b.payload_json) THEN b.payload_json ELSE '{}' END,'$.${key}')=${id}),0) slack_redrive_count,o.slack_redrive_due_at,
      coalesce((SELECT ${outcomeSql()} FROM (${status})),'completed') outcome,
      (SELECT state FROM (${status})) state,(SELECT attempted_at FROM (${status})) attempted_at,
      coalesce((SELECT paused OR blocked_child FROM (${status})),0) paused
      FROM outbox o WHERE o.topic='${topic}' AND o.slack_redrive_due_at<=${Date.now()} AND o.slack_scope_paused_at IS NULL`;
    })
    .join(" UNION ALL ");
  await env.DB.prepare(`WITH due AS (${due}) UPDATE outbox SET slack_redrive_due_at=NULL
    WHERE id IN (SELECT id FROM due WHERE outcome='completed')`).run();
  const rows = await env.DB.prepare(`WITH due AS (${due}),runnable AS (
    SELECT *,row_number() OVER (PARTITION BY topic,receipt_id ORDER BY slack_redrive_due_at,id) position FROM due
    WHERE outcome='retryable' OR (outcome='uncertain' AND state='sending' AND attempted_at IS NOT NULL AND paused=0))
    SELECT * FROM runnable WHERE position=1 ORDER BY slack_redrive_due_at,id LIMIT 50`).all<{
    id: string;
    topic: keyof typeof round2Receipts;
    payload_json: string;
    slack_redrive_count: number;
    outcome: DeliveryOutcome;
  }>();
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
    const outcome = await round2DeliveryOutcome(env, row.topic, id);
    if (outcome !== row.outcome) continue;
    if (outcome === "retryable" && row.slack_redrive_count >= 8) {
      await exhaustRound2Receipt(env, row.topic, id);
      if ((await round2DeliveryOutcome(env, row.topic, id)) === "completed")
        await env.DB.prepare("UPDATE outbox SET slack_redrive_due_at=NULL,last_error='redrive_exhausted' WHERE id=?")
          .bind(row.id)
          .run();
      continue;
    }
    try {
      await env.DELIVERY_QUEUE.send({ outboxId: row.id });
    } catch {
      await env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=?,last_error='round2_enqueue_failed' WHERE id=?`)
        .bind(Date.now() + 60_000, row.id)
        .run();
      continue;
    }
    const dueAt = Date.now() + Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** Math.min(row.slack_redrive_count, 5));
    await env.DB.batch([
      env.DB.prepare(`UPDATE outbox SET enqueued_at=?,slack_redrive_due_at=?,slack_redrive_count=(
        SELECT max(b.slack_redrive_count) FROM outbox b WHERE b.topic=?
          AND json_extract(CASE WHEN json_valid(b.payload_json) THEN b.payload_json ELSE '{}' END,'$.${contract.key}')=?)+? WHERE id=?`).bind(
        Date.now(),
        dueAt,
        row.topic,
        id,
        outcome === "retryable" ? 1 : 0,
        row.id,
      ),
      env.DB.prepare(`UPDATE outbox SET enqueued_at=?,slack_redrive_due_at=?,slack_redrive_count=(SELECT slack_redrive_count FROM outbox WHERE id=?)
        WHERE topic=? AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.${contract.key}')=? AND id<>? AND slack_scope_paused_at IS NULL`).bind(
        Date.now(),
        dueAt,
        row.id,
        row.topic,
        id,
        row.id,
      ),
    ]);
  }
}

async function exhaustRound2Receipt(env: Env, topic: keyof typeof round2Receipts, id: string) {
  const contract = round2Receipts[topic];
  const token = crypto.randomUUID();
  const claim = await env.DB.prepare(`UPDATE ${contract.table} SET claim_token=?,claimed_at=? WHERE id=?
    AND (SELECT ${outcomeSql()} FROM (${receiptStatusSql(topic, "?")}))='retryable'`)
    .bind(token, Date.now(), id, id)
    .run();
  if (!claim.meta.changes) return;
  const mappingJoin =
    topic === "slack_channel" || topic === "slack_digest"
      ? "m.id=r.subscription_id"
      : topic === "slack_file_upload"
        ? "m.installation_id=r.installation_id AND EXISTS(SELECT 1 FROM pages p WHERE p.id=r.page_id AND p.space_id=m.space_id AND (m.page_id IS NULL OR m.page_id=p.id))"
        : "m.installation_id=r.installation_id AND m.channel_id=r.channel_id";
  const installation = topic === "slack_channel" ? "m.installation_id" : "r.installation_id";
  const channel = topic === "slack_channel" || topic === "slack_file_upload" ? "m.channel_id" : "r.channel_id";
  const statements = [
    env.DB.prepare(`INSERT OR IGNORE INTO slack_delivery_failures
      (delivery_id,workspace_id,subscription_id,channel_name,reason,created_at)
      SELECT r.id||':redrive:'||coalesce(m.id,'orphan'),i.workspace_id,coalesce(m.id,'orphan:'||r.id),
      coalesce(nullif(m.channel_name,''),${channel},'Slack'),'redrive_exhausted',?
      FROM ${contract.table} r LEFT JOIN slack_channel_subscriptions m ON ${mappingJoin}
      JOIN slack_installations i ON i.id=${installation} WHERE r.id=? AND r.claim_token=?`).bind(Date.now(), id, token),
  ];
  if (topic === "slack_digest")
    statements.push(
      env.DB.prepare(`UPDATE slack_digest_messages SET state='retired',last_error='redrive_exhausted'
    WHERE receipt_id=? AND state='pending' AND EXISTS(SELECT 1 FROM slack_digest_receipts WHERE id=? AND claim_token=?)`).bind(
        id,
        id,
        token,
      ),
    );
  if (topic === "slack_bulk")
    statements.push(
      env.DB.prepare(`UPDATE slack_channel_events SET round2_state='retired',suppressed_at=coalesce(suppressed_at,?)
    WHERE summary_id=? AND round2_state='pending' AND EXISTS(SELECT 1 FROM slack_bulk_receipts WHERE id=? AND claim_token=?)`).bind(
        Date.now(),
        id,
        id,
        token,
      ),
    );
  statements.push(
    env.DB.prepare(`UPDATE ${contract.table} SET ${contract.state}=?,claim_token=NULL,claimed_at=NULL
    ${topic === "slack_channel" ? ",suppressed_at=coalesce(suppressed_at,?)" : ",last_error='redrive_exhausted'"}
    WHERE id=? AND claim_token=?`).bind(
      topic === "slack_file_upload" ? "failed" : "retired",
      ...(topic === "slack_channel" ? [Date.now()] : []),
      id,
      token,
    ),
  );
  await env.DB.batch(statements);
}

// Owner recovery reconciles evidence only; it never resets an uncertain post for blind delivery.
export async function reconcileRound2Mapping(env: Env, mappingId: string) {
  const digests = await env.DB.prepare(
    `SELECT id FROM slack_digest_receipts WHERE subscription_id=? AND state IN ('sending','blocked') AND attempted_at IS NOT NULL`,
  )
    .bind(mappingId)
    .all<{ id: string }>();
  for (const row of digests.results)
    if ((await round2DeliveryOutcome(env, "slack_digest", row.id)) === "uncertain")
      await deliverDigest(env, row.id, true);
  const events = await env.DB.prepare(
    `SELECT id FROM slack_channel_events WHERE subscription_id=? AND round2_state IN ('sending','blocked') AND attempted_at IS NOT NULL`,
  )
    .bind(mappingId)
    .all<{ id: string }>();
  for (const row of events.results)
    if ((await round2DeliveryOutcome(env, "slack_channel", row.id)) === "uncertain")
      await deliverRound2ChannelEvent(env, row.id, true);
  const summaries = await env.DB.prepare(
    `SELECT DISTINCT r.id FROM slack_bulk_receipts r JOIN slack_channel_subscriptions m ON m.installation_id=r.installation_id AND m.channel_id=r.channel_id WHERE m.id=? AND r.state IN ('sending','blocked') AND r.attempted_at IS NOT NULL`,
  )
    .bind(mappingId)
    .all<{ id: string }>();
  for (const row of summaries.results)
    if ((await round2DeliveryOutcome(env, "slack_bulk", row.id)) === "uncertain")
      await deliverBulkSummary(env, row.id, true);
  const shares =
    await env.DB.prepare(`SELECT r.id FROM slack_share_refreshes r JOIN slack_channel_subscriptions m ON m.installation_id=r.installation_id AND m.channel_id=r.channel_id
    WHERE m.id=? AND r.state IN ('sending','blocked') AND r.attempted_at IS NOT NULL`)
      .bind(mappingId)
      .all<{ id: string }>();
  for (const row of shares.results)
    if ((await round2DeliveryOutcome(env, "slack_share_refresh", row.id)) === "uncertain")
      await deliverShareRefresh(env, row.id, true);
  await wakeRound2Mapping(env, mappingId);
}
