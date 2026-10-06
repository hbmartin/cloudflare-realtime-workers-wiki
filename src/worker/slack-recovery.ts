import { DeliveryInProgressError } from "./notifications";
import { slackBulkCandidateSql } from "./slack";
import { deliverBulkSummary } from "./slack-bulk";
import { deliverDigest } from "./slack-digests";
import { deliverShareRefresh } from "./slack-shares";
import { deliverRound2ChannelEvent } from "./slack-channel-events";
import {
  thumbnailDeliveryEnabled,
  wakeRound2Mapping,
  retireDigestReceiptStatements,
  type DeliveryOutcome,
} from "./slack-delivery";
import type { Env } from "./env";
import { outboxEnqueueRetryAt, reportPersistentEnqueueFailure } from "./outbox-retry";
import { safeTelemetryErrorMessage } from "./observability";

import { ROUND2_TOPICS_SQL, round2Receipts, mappingDeliveryPauseSql } from "./slack-delivery-contracts";
export { round2Receipts } from "./slack-delivery-contracts";

// Both consumers and redrive use the same receipt and destination evidence.
function receiptStatusSql(topic: keyof typeof round2Receipts, idSql: string) {
  const contract = round2Receipts[topic];
  const channel = topic === "slack_channel";
  const mapping = channel || topic === "slack_digest";
  const installation = channel ? "m.installation_id" : "r.installation_id";
  let destinationPause = "0";
  if (mapping) destinationPause = mappingDeliveryPauseSql("m", Date.now());
  else if (topic === "slack_bulk")
    destinationPause = `EXISTS(SELECT 1 FROM slack_channel_events e JOIN slack_channel_subscriptions m ON m.id=e.subscription_id
      JOIN pages page ON page.id=e.page_id JOIN slack_installations installation ON installation.id=m.installation_id
      WHERE e.summary_id=r.id AND ${slackBulkCandidateSql})
    AND NOT EXISTS(SELECT 1 FROM slack_channel_events e JOIN slack_channel_subscriptions m ON m.id=e.subscription_id
      JOIN pages page ON page.id=e.page_id JOIN slack_installations installation ON installation.id=m.installation_id
      WHERE e.summary_id=r.id AND ${slackBulkCandidateSql} AND NOT ${mappingDeliveryPauseSql("m", Date.now())})`;
  else if (topic === "slack_file_upload")
    destinationPause = `EXISTS(SELECT 1 FROM slack_channel_subscriptions m JOIN pages p ON p.space_id=m.space_id AND (m.page_id IS NULL OR m.page_id=p.id) WHERE p.id=r.page_id AND m.installation_id=r.installation_id)
    AND NOT EXISTS(SELECT 1 FROM slack_channel_subscriptions m JOIN pages p ON p.space_id=m.space_id AND (m.page_id IS NULL OR m.page_id=p.id) WHERE p.id=r.page_id AND m.installation_id=r.installation_id AND m.notification_blocked_at IS NULL)`;
  const childClaim = `(SELECT max(child.claimed_at) FROM slack_digest_messages child WHERE child.receipt_id=r.id AND child.state='pending')`;
  const claimed =
    topic === "slack_digest"
      ? `CASE WHEN ${childClaim}>coalesce(r.claimed_at,0) THEN ${childClaim} ELSE r.claimed_at END`
      : "r.claimed_at";
  return `SELECT r.${contract.state} state,${claimed} claimed_at,${topic === "slack_file_upload" ? "NULL" : "r.attempted_at"} attempted_at,
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
  if (topic === "slack_bulk") {
    const pending = await env.DB.prepare(`SELECT 1 FROM slack_bulk_receipts WHERE id=? AND state='pending'
      AND (claimed_at IS NULL OR claimed_at<=?)`)
      .bind(id, Date.now() - 60_000)
      .first();
    if (pending) {
      try {
        await deliverBulkSummary(env, id, false, true);
      } catch (error) {
        if (!(error instanceof DeliveryInProgressError)) throw error;
      }
    }
  }
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

export type Round2OutboxSnapshot = {
  id: string;
  attempts: number;
  enqueued_at: number | null;
  available_at: number;
  last_error: string | null;
  slack_redrive_due_at: number | null;
  slack_claim_recheck_at: number | null;
  slack_redrive_count: number;
  slack_scope_paused_at: number | null;
  slack_enqueue_redrive_pending: number;
  slack_enqueue_failure_count: number;
};
const recoverySnapshotFields = [
  "id",
  "attempts",
  "enqueued_at",
  "available_at",
  "last_error",
  "slack_redrive_due_at",
  "slack_claim_recheck_at",
  "slack_redrive_count",
  "slack_scope_paused_at",
  "slack_enqueue_redrive_pending",
  "slack_enqueue_failure_count",
] as const satisfies readonly (keyof Round2OutboxSnapshot)[];
const recoverySnapshotSql = `${recoverySnapshotFields.map((field) => `${field} IS ?`).join(" AND ")} AND slack_scope_paused_at IS NULL`;
function recoverySnapshotBinds(sibling: Round2OutboxSnapshot) {
  return recoverySnapshotFields.map((field) => sibling[field]);
}

// Materialize the complete sibling set before changing any row in it. A producer
// that read an older scheduling version cannot checkpoint or send that version.
function recoverySetGuard(topic: keyof typeof round2Receipts, id: string, snapshots: Round2OutboxSnapshot[]) {
  return {
    sql: `(SELECT count(*) FROM outbox WHERE topic=? AND slack_round2_receipt_id=?)=?
      AND NOT EXISTS(SELECT 1 FROM outbox WHERE topic=? AND slack_round2_receipt_id=? AND slack_scope_paused_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM json_each(?) expected LEFT JOIN outbox actual
        ON actual.id=json_extract(expected.value,'$.id')
        WHERE actual.id IS NULL OR actual.topic IS NOT ? OR actual.slack_round2_receipt_id IS NOT ?
          OR ${recoverySnapshotFields.map((field) => `actual.${field} IS NOT json_extract(expected.value,'$.${field}')`).join(" OR ")})`,
    binds: [topic, id, snapshots.length, topic, id, JSON.stringify(snapshots), topic, id],
  };
}

async function deferRecoverySnapshots(env: Env, snapshots: Round2OutboxSnapshot[], due: number, scopePaused = false) {
  const unpaused = snapshots.filter((snapshot) => snapshot.slack_scope_paused_at === null);
  if (!unpaused.length) return;
  await env.DB.batch(
    unpaused.map((snapshot) =>
      env.DB.prepare(`UPDATE outbox SET available_at=max(available_at,?),
      slack_redrive_due_at=max(coalesce(slack_redrive_due_at,0),?),
      slack_claim_recheck_at=CASE WHEN ? THEN NULL ELSE max(coalesce(slack_claim_recheck_at,0),?) END
      WHERE ${recoverySnapshotSql}`).bind(due, due, scopePaused ? 1 : 0, due, ...recoverySnapshotBinds(snapshot)),
    ),
  );
}

export async function enqueueRound2Outbox(
  env: Env,
  outboxId: string,
  topic: keyof typeof round2Receipts,
  receiptId: string,
  options: {
    dueAt: number;
    correlationId?: string | undefined;
    delaySeconds?: number;
    expectedVersion?: number;
    snapshots?: Round2OutboxSnapshot[];
    ordinaryRedrive?: boolean;
  },
): Promise<"enqueued" | "scope_paused" | "stale"> {
  const snapshots =
    options.snapshots ??
    (
      await env.DB.prepare(
        `SELECT ${recoverySnapshotFields.join(",")} FROM outbox WHERE topic=? AND slack_round2_receipt_id=?`,
      )
        .bind(topic, receiptId)
        .all<Round2OutboxSnapshot>()
    ).results;
  const current = snapshots.find((snapshot) => snapshot.id === outboxId);
  if (!current || (options.expectedVersion !== undefined && current.attempts !== options.expectedVersion))
    return "stale";
  const now = Date.now();
  if (snapshots.some((snapshot) => snapshot.slack_scope_paused_at !== null)) {
    await deferRecoverySnapshots(env, snapshots, now + 30 * 60_000, true);
    return "scope_paused";
  }
  const existingIntent = snapshots.some((snapshot) => snapshot.slack_enqueue_redrive_pending);
  const newIntent =
    !existingIntent &&
    Boolean(options.ordinaryRedrive && !snapshots.some((snapshot) => snapshot.last_error === "slack_validation_stale"));
  const redrivePending = existingIntent || newIntent;
  const guard = recoverySetGuard(topic, receiptId, snapshots);
  const checkpoint = await env.DB.prepare(`UPDATE outbox SET attempts=attempts+1,enqueued_at=?,
    slack_redrive_due_at=max(coalesce(slack_redrive_due_at,0),?),slack_claim_recheck_at=NULL,slack_enqueue_redrive_pending=?
    WHERE id IN (SELECT id FROM outbox WHERE topic=? AND slack_round2_receipt_id=? AND ${guard.sql})`)
    .bind(now, options.dueAt, redrivePending ? 1 : 0, topic, receiptId, ...guard.binds)
    .run();
  if (checkpoint.meta.changes !== snapshots.length) {
    const paused = await env.DB.prepare(
      "SELECT 1 FROM outbox WHERE topic=? AND slack_round2_receipt_id=? AND slack_scope_paused_at IS NOT NULL LIMIT 1",
    )
      .bind(topic, receiptId)
      .first();
    await deferRecoverySnapshots(env, snapshots, now + (paused ? 30 * 60_000 : 2_000), Boolean(paused));
    return paused ? "scope_paused" : "stale";
  }
  const staged = snapshots.map((snapshot) => ({
    ...snapshot,
    attempts: snapshot.attempts + 1,
    enqueued_at: now,
    slack_redrive_due_at: Math.max(snapshot.slack_redrive_due_at ?? 0, options.dueAt),
    slack_claim_recheck_at: null,
    slack_enqueue_redrive_pending: redrivePending ? 1 : 0,
  }));
  try {
    await env.DELIVERY_QUEUE.send(
      { outboxId, ...(options.correlationId ? { correlationId: options.correlationId } : {}) },
      ...(options.delaySeconds === undefined ? [] : [{ delaySeconds: options.delaySeconds }]),
    );
  } catch (error) {
    // Only our untouched checkpoint can be rescheduled. A consumer, scope pause,
    // or newer retry owns its own scheduling and must survive enqueue failure.
    const message = safeTelemetryErrorMessage(error, "Queue enqueue failed.");
    const failed = await env.DB.batch(
      staged.map((snapshot) => {
        const failures = snapshot.slack_enqueue_failure_count + 1;
        const retryAt = outboxEnqueueRetryAt(failures);
        return env.DB.prepare(`UPDATE outbox SET enqueued_at=NULL,slack_enqueue_failure_count=slack_enqueue_failure_count+1,
          available_at=max(available_at,?),slack_redrive_due_at=max(coalesce(slack_redrive_due_at,0),?),slack_claim_recheck_at=?,
          last_error=CASE WHEN last_error='slack_validation_stale' THEN last_error ELSE ? END
          WHERE ${recoverySnapshotSql}`).bind(retryAt, retryAt, retryAt, message, ...recoverySnapshotBinds(snapshot));
      }),
    );
    failed.forEach((result, index) => {
      const snapshot = staged[index]!;
      if (result.meta.changes)
        reportPersistentEnqueueFailure(env, snapshot.id, snapshot.slack_enqueue_failure_count + 1, message);
    });
    throw error;
  }
  await env.DB.batch(
    staged.map((snapshot) =>
      env.DB.prepare(`UPDATE outbox SET slack_enqueue_failure_count=0
    WHERE id=? AND attempts=? AND slack_enqueue_failure_count=?`).bind(
        snapshot.id,
        snapshot.attempts,
        snapshot.slack_enqueue_failure_count,
      ),
    ),
  );
  if (redrivePending) {
    // A sibling can pause after enqueue while the others record this intent.
    // Bring it up to their budget instead of charging the receipt a second time.
    const count = Math.max(
      ...snapshots.map(
        (snapshot) => snapshot.slack_redrive_count + (snapshot.slack_enqueue_redrive_pending || newIntent ? 1 : 0),
      ),
    );
    // Fast consumers can change errors and deadlines before send() returns. Only
    // the enqueue version, pending intent and captured budget matter to this accounting update.
    await env.DB.batch(
      staged.map((snapshot) =>
        env.DB.prepare(`UPDATE outbox SET slack_redrive_count=?,slack_enqueue_redrive_pending=0
      WHERE id=? AND attempts=? AND slack_redrive_count=? AND slack_enqueue_redrive_pending=1 AND slack_scope_paused_at IS NULL`).bind(
          count,
          snapshot.id,
          snapshot.attempts,
          snapshot.slack_redrive_count,
        ),
      ),
    );
  }
  return "enqueued";
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
    SELECT o.id,o.topic,o.slack_round2_receipt_id receipt_id,o.correlation_id
      FROM candidates c JOIN outbox o ON o.id=c.id ORDER BY c.due_at,c.id`)
    .bind(now, now)
    .all<{
      id: string;
      topic: keyof typeof round2Receipts;
      receipt_id: string | null;
      correlation_id: string | null;
    }>();
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
    seen.add(key);
    const enqueueRetry = siblings.results.some(
      (sibling) => sibling.enqueued_at === null || sibling.slack_enqueue_redrive_pending,
    );
    const coordinationRecheck = siblings.results.some((sibling) => sibling.last_error === "slack_validation_stale");
    const budget = Math.max(0, ...siblings.results.map((sibling) => sibling.slack_redrive_count));
    // A queue consumer can create a newer validation retry during status reads or send().
    const fence = recoverySnapshotSql;
    const status = await round2DeliveryStatus(env, row.topic, id);
    if (status.outcome === "completed") {
      await env.DB.batch(
        siblings.results.map((sibling) =>
          env.DB.prepare(
            `UPDATE outbox SET slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL,slack_enqueue_redrive_pending=0,last_error=CASE WHEN last_error='slack_validation_stale' THEN NULL ELSE last_error END WHERE ${fence}`,
          ).bind(...recoverySnapshotBinds(sibling)),
        ),
      );
      continue;
    }
    if (siblings.results.some((sibling) => sibling.slack_scope_paused_at !== null)) {
      await deferRecoverySnapshots(env, siblings.results, now + 30 * 60_000, true);
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
        slack_claim_recheck_at=CASE WHEN last_error='slack_validation_stale'
          THEN max(coalesce(slack_claim_recheck_at,0),?) ELSE NULL END WHERE ${fence}`).bind(
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
    if (status.outcome === "retryable" && !coordinationRecheck && !enqueueRetry && budget >= 8) {
      await exhaustRound2Receipt(env, row.topic, id, siblings.results);
      continue;
    }
    const due = now + Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** Math.min(budget, 5));
    try {
      await enqueueRound2Outbox(env, row.id, row.topic, id, {
        dueAt: due,
        snapshots: siblings.results,
        correlationId: row.correlation_id ?? undefined,
        ordinaryRedrive: status.outcome === "retryable" && !coordinationRecheck && !enqueueRetry,
      });
    } catch {
      // The checkpoint retains a durable retry deadline when enqueue fails.
    }
  }
}

async function exhaustRound2Receipt(
  env: Env,
  topic: keyof typeof round2Receipts,
  id: string,
  snapshots: Round2OutboxSnapshot[],
) {
  const contract = round2Receipts[topic];
  if (snapshots.some((snapshot) => snapshot.slack_scope_paused_at !== null)) return false;
  const token = crypto.randomUUID();
  const guard = recoverySetGuard(topic, id, snapshots);
  const claim = env.DB.prepare(`UPDATE ${contract.table} SET claim_token=?,claimed_at=? WHERE id=?
    AND (SELECT ${outcomeSql()} FROM (${receiptStatusSql(topic, "?")}))='retryable' AND ${guard.sql}`).bind(
    token,
    Date.now(),
    id,
    id,
    ...guard.binds,
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
  if (topic === "slack_digest") statements.push(...retireDigestReceiptStatements(env, id, token, "redrive_exhausted"));
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
        AND EXISTS(SELECT 1 FROM ${contract.table} WHERE id=? AND claim_token=? ${topic === "slack_digest" ? "AND state='retired'" : ""})`).bind(
      topic,
      id,
      id,
      token,
    ),
    ...(topic === "slack_digest"
      ? [
          env.DB.prepare(`UPDATE slack_digest_receipts SET claim_token=NULL,claimed_at=NULL
      WHERE id=? AND claim_token=?`).bind(id, token),
        ]
      : [
          env.DB.prepare(`UPDATE ${contract.table} SET ${contract.state}=?,claim_token=NULL,claimed_at=NULL
    ${topic === "slack_channel" ? ",suppressed_at=coalesce(suppressed_at,?)" : ",last_error='redrive_exhausted'"}
    WHERE id=? AND claim_token=?`).bind(
            topic === "slack_file_upload" ? "failed" : "retired",
            ...(topic === "slack_channel" ? [Date.now()] : []),
            id,
            token,
          ),
        ]),
  );
  const results = await env.DB.batch(statements);
  return Boolean(results[0]?.meta.changes);
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
