import { blockedShareRecoverySelectSql } from "../shared/slack-share-recovery";
import type { Env } from "./env";
import { logger, recordMetric } from "./observability";

const activitySignature = `topic='slack_channel' AND last_error='Invalid Slack redrive payload'
  AND slack_scope_paused_at IS NULL AND slack_redrive_due_at IS NULL AND slack_claim_recheck_at IS NULL`;
const identitySignature = `outcome='accepted' AND response_delivery_state='blocked'
  AND response_delivery_error='request_identity_unavailable' AND response_delivery_attempted_at IS NULL AND denial_sent_at IS NULL`;

// Run even during a feature pause: old consumers can recreate this explicit damage.
export async function repairLegacySlackDelivery(env: Env) {
  const now = Date.now();
  const activity = await env.DB.prepare(`SELECT o.id,o.attempts,o.payload_json,o.available_at,o.enqueued_at,
    e.id event_id,e.round2_state,e.attempted_at,e.claimed_at,e.claim_token
    FROM outbox o INDEXED BY slack_activity_legacy_repair JOIN slack_channel_events e ON e.id=o.slack_round2_receipt_id
    WHERE ${activitySignature} AND o.slack_round2_receipt_id LIKE 'activity:%'
      AND e.round2_state IN ('pending','sending') AND e.delivered_at IS NULL AND e.suppressed_at IS NULL
      AND (e.claimed_at IS NULL OR e.claimed_at<=?) ORDER BY o.id LIMIT 50`)
    .bind(now - 60_000)
    .all<{
      id: string;
      attempts: number;
      payload_json: string;
      available_at: number;
      enqueued_at: number | null;
      event_id: string;
      round2_state: string;
      attempted_at: number | null;
      claimed_at: number | null;
      claim_token: string | null;
    }>();
  let activityRepairs = 0;
  for (const row of activity.results) {
    const repaired = await env.DB.prepare(`UPDATE outbox SET attempts=attempts+1,last_error=NULL,
      enqueued_at=CASE WHEN ?='pending' THEN NULL ELSE enqueued_at END,
      available_at=CASE WHEN ?='pending' THEN ? ELSE available_at END,
      slack_redrive_due_at=CASE WHEN ?='sending' THEN ? ELSE NULL END
      WHERE id=? AND attempts=? AND payload_json=? AND available_at=? AND enqueued_at IS ? AND ${activitySignature}
        AND EXISTS(SELECT 1 FROM slack_channel_events e WHERE e.id=? AND e.round2_state=?
          AND e.attempted_at IS ? AND e.claimed_at IS ? AND e.claim_token IS ?
          AND e.delivered_at IS NULL AND e.suppressed_at IS NULL AND (e.claimed_at IS NULL OR e.claimed_at<=?))`)
      .bind(
        row.round2_state,
        row.round2_state,
        now,
        row.round2_state,
        now,
        row.id,
        row.attempts,
        row.payload_json,
        row.available_at,
        row.enqueued_at,
        row.event_id,
        row.round2_state,
        row.attempted_at,
        row.claimed_at,
        row.claim_token,
        now - 60_000,
      )
      .run();
    activityRepairs += repaired.meta.changes;
  }
  const shares = await env.DB.prepare(`SELECT * FROM (${blockedShareRecoverySelectSql})
    ORDER BY receipt_id,id LIMIT 50`).all<{
    id: string;
    attempts: number;
    payload_json: string;
    available_at: number;
    enqueued_at: number | null;
    slack_redrive_due_at: number | null;
    slack_claim_recheck_at: number | null;
    receipt_id: string;
    identity_json: string;
  }>();
  let identityRepairs = 0;
  for (const row of shares.results) {
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE outbox SET payload_json=json_set(payload_json,'$.identity',json(?)),attempts=attempts+1,
        enqueued_at=NULL,available_at=?,last_error=NULL,slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL
        WHERE id=? AND attempts=? AND payload_json=? AND available_at=? AND enqueued_at IS ?
          AND slack_redrive_due_at IS ? AND slack_claim_recheck_at IS ? AND slack_scope_paused_at IS NULL
          AND EXISTS(SELECT 1 FROM (${blockedShareRecoverySelectSql}) proof WHERE proof.id=outbox.id AND proof.identity_json=?)`).bind(
        row.identity_json,
        now,
        row.id,
        row.attempts,
        row.payload_json,
        row.available_at,
        row.enqueued_at,
        row.slack_redrive_due_at,
        row.slack_claim_recheck_at,
        row.identity_json,
      ),
      env.DB.prepare(`UPDATE slack_interaction_receipts SET response_delivery_state='pending',response_delivery_error=NULL
        WHERE id=? AND ${identitySignature}
          AND EXISTS(SELECT 1 FROM outbox WHERE id=? AND attempts=? AND payload_json=json_set(?,'$.identity',json(?))
            AND slack_scope_paused_at IS NULL AND available_at=? AND enqueued_at IS NULL)`).bind(
        row.receipt_id,
        row.id,
        row.attempts + 1,
        row.payload_json,
        row.identity_json,
        now,
      ),
    ]);
    identityRepairs += results[1]!.meta.changes;
  }
  // Only an explicit exhaustion signature permits repairing stranded reservations.
  const stranded = await env.DB.prepare(`WITH exhausted_children AS (
      SELECT id,receipt_id,event_ids_json FROM slack_digest_messages INDEXED BY slack_digest_exhausted_children
        WHERE state='retired' AND last_error='redrive_exhausted'
      UNION SELECT child.id,child.receipt_id,child.event_ids_json FROM slack_digest_receipts root INDEXED BY slack_digest_exhausted_roots
        JOIN slack_digest_messages child ON child.receipt_id=root.id
        WHERE root.state='retired' AND root.last_error='redrive_exhausted' AND child.state='retired')
    SELECT event.id,child.id child_id,child.event_ids_json FROM exhausted_children child
    JOIN slack_digest_receipts root ON root.id=child.receipt_id
    JOIN json_each(child.event_ids_json) reservation
    JOIN slack_channel_events event ON event.id=reservation.value
    WHERE event.round2_state='pending' AND event.delivered_at IS NULL AND event.suppressed_at IS NULL
      AND (root.claimed_at IS NULL OR root.claimed_at<=?)
      AND (event.claimed_at IS NULL OR event.claimed_at<=?)
      AND NOT EXISTS(SELECT 1 FROM slack_digest_message_events live JOIN slack_digest_messages uncertain ON uncertain.id=live.message_id
        WHERE live.event_id=event.id AND uncertain.state IN ('pending','sending','blocked'))
    ORDER BY event.id LIMIT 200`)
    .bind(now - 60_000, now - 60_000)
    .all<{ id: string; child_id: string; event_ids_json: string }>();
  const exhaustedRepairs = stranded.results.length
    ? (
        await env.DB.prepare(`UPDATE slack_channel_events
    SET round2_state='retired',suppressed_at=? WHERE id IN (SELECT value FROM json_each(?))
      AND round2_state='pending' AND delivered_at IS NULL AND suppressed_at IS NULL
      AND (claimed_at IS NULL OR claimed_at<=?)
      AND EXISTS(SELECT 1 FROM json_each(?) captured
        JOIN slack_digest_messages child ON child.id=json_extract(captured.value,'$.child_id')
        JOIN slack_digest_receipts root ON root.id=child.receipt_id
        WHERE json_extract(captured.value,'$.id')=slack_channel_events.id
          AND child.event_ids_json=json_extract(captured.value,'$.event_ids_json') AND child.state='retired'
          AND (child.last_error='redrive_exhausted' OR (root.state='retired' AND root.last_error='redrive_exhausted'))
          AND (root.claimed_at IS NULL OR root.claimed_at<=${now - 60_000}))
      AND NOT EXISTS(SELECT 1 FROM slack_digest_message_events live JOIN slack_digest_messages uncertain ON uncertain.id=live.message_id
        WHERE live.event_id=slack_channel_events.id AND uncertain.state IN ('pending','sending','blocked'))`)
          .bind(
            now,
            JSON.stringify(stranded.results.map((row) => row.id)),
            now - 60_000,
            JSON.stringify(stranded.results),
          )
          .run()
      ).meta.changes
    : 0;
  const remaining = await env.DB.prepare(`SELECT
    (SELECT count(*) FROM outbox WHERE ${activitySignature} AND slack_round2_receipt_id LIKE 'activity:%') activity,
    (SELECT count(*) FROM slack_interaction_receipts WHERE ${identitySignature}) identity,
    (SELECT count(*) FROM outbox WHERE slack_enqueue_failure_count>0) enqueue_failures`).first();
  logger.info("slack.legacy.repair", "slack", "Examined explicit Slack recovery damage.", {
    activityExamined: activity.results.length,
    activityRepairs,
    identityExamined: shares.results.length,
    identityRepairs,
    exhaustedRepairs,
    remaining,
  });
  recordMetric(env, {
    event: "slack.legacy.repair",
    component: "slack",
    operation: "repair",
    outcome: "success",
    attempts: activityRepairs + identityRepairs + exhaustedRepairs,
  });
}
