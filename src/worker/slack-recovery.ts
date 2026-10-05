import { deliverBulkSummary } from "./slack-bulk";
import { deliverDigest } from "./slack-digests";
import { deliverShareRefresh } from "./slack-shares";
import { deliverRound2ChannelEvent } from "./slack-channel-events";
import { thumbnailDeliveryEnabled, wakeRound2Mapping, type DeliveryOutcome } from "./slack-delivery";
import type { Env } from "./env";

import { ROUND2_TOPICS_SQL, round2Receipts } from "./slack-delivery-contracts";
export { round2Receipts } from "./slack-delivery-contracts";

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
export async function round2DeliveryStatus(env: Env, topic: keyof typeof round2Receipts, id: string) {
  return (
    (await env.DB.prepare(
      `SELECT ${outcomeSql()} outcome,state,claimed_at,attempted_at,paused,blocked_child FROM (${receiptStatusSql(topic, "?")})`,
    )
      .bind(id)
      .first<{
        outcome: DeliveryOutcome;
        state: string;
        claimed_at: number | null;
        attempted_at: number | null;
        paused: number;
        blocked_child: number;
      }>()) ?? {
      outcome: "completed" as const,
      state: "retired",
      claimed_at: null,
      attempted_at: null,
      paused: 0,
      blocked_child: 0,
    }
  );
}
export async function round2DeliveryOutcome(
  env: Env,
  topic: keyof typeof round2Receipts,
  id: string,
): Promise<DeliveryOutcome> {
  return (await round2DeliveryStatus(env, topic, id)).outcome;
}

type Round2OutboxSnapshot = {
  id: string;
  enqueued_at: number | null;
  available_at: number;
  last_error: string | null;
  slack_redrive_due_at: number | null;
  slack_claim_recheck_at: number | null;
  slack_redrive_count: number;
  slack_scope_paused_at: number | null;
};
const recoverySnapshotFields = [
  "id",
  "enqueued_at",
  "available_at",
  "last_error",
  "slack_redrive_due_at",
  "slack_claim_recheck_at",
  "slack_redrive_count",
  "slack_scope_paused_at",
] as const satisfies readonly (keyof Round2OutboxSnapshot)[];
const recoverySnapshotSql = `${recoverySnapshotFields.map((field) => `${field} IS ?`).join(" AND ")} AND slack_scope_paused_at IS NULL`;
function recoverySnapshotBinds(sibling: Round2OutboxSnapshot) {
  return recoverySnapshotFields.map((field) => sibling[field]);
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
  const now = Date.now();
  // Bound each enabled topic before merging. Disabled-feature backlogs cannot
  // force a scan, and the final merge classifies at most 200 outbox candidates.
  const deadlineStream = (column: "slack_redrive_due_at" | "slack_claim_recheck_at", parameter: number) =>
    topics
      .map(
        (topic) => `SELECT * FROM (
    SELECT id,${column} due_at FROM outbox WHERE topic IN (${ROUND2_TOPICS_SQL}) AND topic='${topic}'
      AND slack_scope_paused_at IS NULL AND ${column}<=?${parameter} ORDER BY ${column},id LIMIT 200)`,
      )
      .join(" UNION ALL ");
  const rows = await env.DB.prepare(`WITH regular AS (
      SELECT * FROM (${deadlineStream("slack_redrive_due_at", 1)}) ORDER BY due_at,id LIMIT 200), claims AS (
      SELECT * FROM (${deadlineStream("slack_claim_recheck_at", 2)}) ORDER BY due_at,id LIMIT 200), candidates AS (
      SELECT id,min(due_at) due_at FROM (SELECT * FROM regular UNION ALL SELECT * FROM claims)
      GROUP BY id ORDER BY due_at,id LIMIT 200)
    SELECT o.id,o.topic,o.slack_round2_receipt_id receipt_id
      FROM candidates c JOIN outbox o ON o.id=c.id ORDER BY c.due_at,c.id`)
    .bind(now, now)
    .all<{ id: string; topic: keyof typeof round2Receipts; receipt_id: string | null }>();
  const seen = new Set<string>();
  let recoveries = 0;
  for (const row of rows.results) {
    const id = row.receipt_id;
    if (!id) {
      await env.DB.prepare(
        `UPDATE outbox SET slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL,last_error='invalid_round2_payload' WHERE id=?`,
      )
        .bind(row.id)
        .run();
      continue;
    }
    const key = `${row.topic}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const siblings = await env.DB.prepare(
      `SELECT ${recoverySnapshotFields.join(",")} FROM outbox WHERE topic=? AND slack_round2_receipt_id=?`,
    )
      .bind(row.topic, id)
      .all<Round2OutboxSnapshot>();
    const current = siblings.results.find((sibling) => sibling.id === row.id);
    if (
      !current ||
      current.slack_scope_paused_at !== null ||
      ![current.slack_redrive_due_at, current.slack_claim_recheck_at].some((due) => due !== null && due <= now)
    )
      continue;
    const coordinationRecheck =
      current.last_error === "slack_validation_stale" &&
      current.slack_claim_recheck_at !== null &&
      current.slack_claim_recheck_at <= now;
    const budget = Math.max(0, ...siblings.results.map((sibling) => sibling.slack_redrive_count));
    // A queue consumer can create a newer validation retry during status reads or send().
    const fence = recoverySnapshotSql;
    const status = await round2DeliveryStatus(env, row.topic, id);
    if (status.outcome === "completed") {
      await env.DB.batch(
        siblings.results.map((sibling) =>
          env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL WHERE ${fence}`).bind(
            ...recoverySnapshotBinds(sibling),
          ),
        ),
      );
      continue;
    }
    if (status.outcome === "competing") {
      const due = Math.max(now + 1_000, (status.claimed_at ?? now) + 60_000);
      await env.DB.batch(
        siblings.results.map((sibling) =>
          env.DB.prepare(`UPDATE outbox SET slack_claim_recheck_at=?,
        slack_redrive_due_at=CASE WHEN slack_redrive_due_at<=? THEN ? ELSE slack_redrive_due_at END WHERE ${fence}`).bind(
            due,
            now,
            due,
            ...recoverySnapshotBinds(sibling),
          ),
        ),
      );
      continue;
    }
    if (
      status.outcome === "paused" ||
      (status.outcome === "uncertain" &&
        (status.state !== "sending" || status.attempted_at === null || status.paused || status.blocked_child))
    ) {
      const due = now + 30 * 60_000;
      await env.DB.batch(
        siblings.results.map((sibling) =>
          env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=max(coalesce(slack_redrive_due_at,0),?),
        slack_claim_recheck_at=CASE WHEN last_error='slack_validation_stale' AND slack_claim_recheck_at IS NOT NULL
          THEN max(slack_claim_recheck_at,?) ELSE NULL END WHERE ${fence}`).bind(
            due,
            due,
            ...recoverySnapshotBinds(sibling),
          ),
        ),
      );
      continue;
    }
    // Exhaustion also writes receipt, failure and sibling records. Bound that
    // work with enqueue attempts so a spent backlog cannot monopolize a pass.
    if (recoveries >= 50) continue;
    recoveries++;
    if (status.outcome === "retryable" && !coordinationRecheck && budget >= 8) {
      await exhaustRound2Receipt(env, row.topic, id, siblings.results);
      continue;
    }
    try {
      await env.DELIVERY_QUEUE.send({ outboxId: row.id });
    } catch {
      await env.DB.batch(
        siblings.results.map((sibling) =>
          env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=max(coalesce(slack_redrive_due_at,0),?),slack_claim_recheck_at=?,
          last_error=CASE WHEN last_error='slack_validation_stale' THEN last_error ELSE 'round2_enqueue_failed' END WHERE ${fence}`).bind(
            now + 60_000,
            now + 60_000,
            ...recoverySnapshotBinds(sibling),
          ),
        ),
      );
      continue;
    }
    const due = now + Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** Math.min(budget, 5));
    await env.DB.batch(
      siblings.results.map((sibling) =>
        env.DB.prepare(`UPDATE outbox SET enqueued_at=?,slack_redrive_due_at=?,slack_claim_recheck_at=NULL,
        last_error=CASE WHEN last_error='slack_validation_stale' THEN NULL ELSE last_error END,
        slack_redrive_count=? WHERE ${fence}`).bind(
          now,
          due,
          budget + (status.outcome === "retryable" && !coordinationRecheck ? 1 : 0),
          ...recoverySnapshotBinds(sibling),
        ),
      ),
    );
  }
}

async function exhaustRound2Receipt(
  env: Env,
  topic: keyof typeof round2Receipts,
  id: string,
  snapshots: Round2OutboxSnapshot[],
) {
  const contract = round2Receipts[topic];
  if (snapshots.some((snapshot) => snapshot.slack_scope_paused_at !== null)) return;
  const token = crypto.randomUUID();
  const claim = env.DB.prepare(`UPDATE ${contract.table} SET claim_token=?,claimed_at=? WHERE id=?
    AND (SELECT ${outcomeSql()} FROM (${receiptStatusSql(topic, "?")}))='retryable'
    AND (SELECT count(*) FROM outbox WHERE topic=? AND slack_round2_receipt_id=?)=?
    AND NOT EXISTS(SELECT 1 FROM outbox WHERE topic=? AND slack_round2_receipt_id=? AND slack_scope_paused_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN outbox actual
      ON actual.id=json_extract(expected.value,'$.id')
      WHERE actual.id IS NULL OR actual.topic IS NOT ? OR actual.slack_round2_receipt_id IS NOT ?
        OR ${recoverySnapshotFields.map((field) => `actual.${field} IS NOT json_extract(expected.value,'$.${field}')`).join(" OR ")})`).bind(
    token,
    Date.now(),
    id,
    id,
    topic,
    id,
    snapshots.length,
    topic,
    id,
    JSON.stringify(snapshots),
    topic,
    id,
  );
  const mappingJoin =
    topic === "slack_channel" || topic === "slack_digest"
      ? "m.id=r.subscription_id"
      : topic === "slack_file_upload"
        ? "m.installation_id=r.installation_id AND EXISTS(SELECT 1 FROM pages p WHERE p.id=r.page_id AND p.space_id=m.space_id AND (m.page_id IS NULL OR m.page_id=p.id))"
        : "m.installation_id=r.installation_id AND m.channel_id=r.channel_id";
  const installation = topic === "slack_channel" ? "m.installation_id" : "r.installation_id";
  const channel = topic === "slack_channel" || topic === "slack_file_upload" ? "m.channel_id" : "r.channel_id";
  // Keep the sibling fence and retirement in one transaction: no retry can
  // change a sibling between claiming and retiring its shared receipt.
  const statements = [
    claim,
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
    env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL,last_error='redrive_exhausted'
      WHERE topic=? AND slack_round2_receipt_id=? AND slack_scope_paused_at IS NULL
        AND EXISTS(SELECT 1 FROM ${contract.table} WHERE id=? AND claim_token=?)`).bind(topic, id, id, token),
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
