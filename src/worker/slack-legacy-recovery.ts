import { blockedShareRecoverySelectSql } from "../shared/slack-share-recovery";
import { digestRetirementGuardSql } from "./slack-delivery";
import type { Env } from "./env";
import { logger, recordMetric } from "./observability";

const activitySignature = `topic='slack_channel' AND last_error='Invalid Slack redrive payload'
  AND slack_scope_paused_at IS NULL AND slack_redrive_due_at IS NULL AND slack_claim_recheck_at IS NULL`;
const identitySignature = `outcome='accepted' AND response_delivery_state='blocked'
  AND response_delivery_error IN ('request_identity_unavailable','redrive_exhausted') AND response_delivery_attempted_at IS NULL AND denial_sent_at IS NULL`;

// Run even during a feature pause: old consumers can recreate this explicit damage.
export async function repairLegacySlackDelivery(env: Env) {
  const now = Date.now();
  const errors: unknown[] = [];
  const stats: Record<string, unknown> = {};
  const operations = [
    {
      name: "channels",
      run: async () => {
        const activity = await env.DB.prepare(`SELECT o.id,o.attempts,o.payload_json,o.available_at,o.enqueued_at,
    e.id event_id,e.round2_state,e.attempted_at,e.claimed_at,e.claim_token
    FROM outbox o INDEXED BY slack_activity_legacy_repair JOIN slack_channel_events e ON e.id=o.slack_round2_receipt_id
    WHERE ${activitySignature}
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
        const failures: unknown[] = [];
        for (const row of activity.results) {
          try {
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
          } catch (error) {
            logger.error(
              "slack.legacy.repair_row_failed",
              "slack",
              "Recovery row failed; retaining work for a later pass.",
              { id: row.id },
              error,
            );
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, "Slack repair rows failed");
        return { activityExamined: activity.results.length, activityRepairs };
      },
    },
    {
      name: "shares",
      run: async () => {
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
        const failures: unknown[] = [];
        for (const row of shares.results) {
          try {
            const results = await env.DB.batch([
              env.DB.prepare(`UPDATE outbox SET payload_json=json_set(payload_json,'$.identity',json(?)),attempts=attempts+1,
        enqueued_at=NULL,available_at=?,last_error=NULL,slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL,slack_redrive_count=0,
        slack_eligible_started_at=NULL,slack_auth_pause_baseline_ms=NULL,slack_scope_paused_ms=0
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
          } catch (error) {
            logger.error(
              "slack.legacy.repair_row_failed",
              "slack",
              "Recovery row failed; retaining work for a later pass.",
              { id: row.id },
              error,
            );
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, "Slack repair rows failed");
        return { identityExamined: shares.results.length, identityRepairs };
      },
    },
    {
      name: "exhausted",
      run: async () => {
        // Only an explicit exhaustion signature permits repairing stranded reservations.
        const stranded = await env.DB.prepare(`WITH exhausted_children AS (
      SELECT id,receipt_id,event_ids_json FROM slack_digest_messages INDEXED BY slack_digest_exhausted_children
        WHERE state='retired' AND last_error='redrive_exhausted'
      UNION SELECT child.id,child.receipt_id,child.event_ids_json FROM slack_digest_receipts root INDEXED BY slack_digest_exhausted_roots
        JOIN slack_digest_messages child ON child.receipt_id=root.id
        WHERE root.state='retired' AND root.last_error='redrive_exhausted' AND child.state='retired')
    SELECT event.id,child.id child_id,root.claimed_at root_claimed_at,root.claim_token root_claim_token,
      root.state root_state,root.last_error root_error,original.claimed_at child_claimed_at,original.claim_token child_claim_token,
      original.last_error child_error FROM exhausted_children child
    JOIN slack_digest_messages original ON original.id=child.id
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
          .all<{
            id: string;
            child_id: string;
            root_claimed_at: number | null;
            root_claim_token: string | null;
            root_state: string;
            root_error: string | null;
            child_claimed_at: number | null;
            child_claim_token: string | null;
            child_error: string | null;
          }>();
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
          AND EXISTS(SELECT 1 FROM json_each(child.event_ids_json) reservation WHERE reservation.value=slack_channel_events.id)
          AND child.state='retired' AND child.claimed_at IS json_extract(captured.value,'$.child_claimed_at')
          AND child.claim_token IS json_extract(captured.value,'$.child_claim_token') AND child.last_error IS json_extract(captured.value,'$.child_error')
          AND root.state=json_extract(captured.value,'$.root_state') AND root.last_error IS json_extract(captured.value,'$.root_error')
          AND root.claimed_at IS json_extract(captured.value,'$.root_claimed_at') AND root.claim_token IS json_extract(captured.value,'$.root_claim_token')
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
        return { exhaustedExamined: stranded.results.length, exhaustedRepairs };
      },
    },
    {
      name: "orphans",
      run: async () => {
        const roots = await env.DB.prepare(`SELECT DISTINCT root.id,root.claim_token,root.claimed_at
    FROM slack_digest_messages candidate INDEXED BY slack_digest_unsent_children
    CROSS JOIN slack_digest_receipts root ON root.id=candidate.receipt_id
    WHERE candidate.state='pending' AND candidate.attempted_at IS NULL
      AND root.state='retired' AND (root.claimed_at IS NULL OR root.claimed_at<=?)
      AND ${digestRetirementGuardSql()} ORDER BY root.id LIMIT 50`)
          .bind(now - 60_000)
          .all<{ id: string; claim_token: string | null; claimed_at: number | null }>();
        let orphanRepairs = 0;
        let orphanEvents = 0;
        const failures: unknown[] = [];
        for (const row of roots.results) {
          if (orphanEvents >= 200) break;
          try {
            const reservations =
              await env.DB.prepare(`SELECT reserved.event_id,reserved.message_id FROM slack_digest_message_events reserved
              JOIN slack_digest_messages child ON child.id=reserved.message_id
              WHERE child.receipt_id=? AND child.state='pending' AND child.attempted_at IS NULL
              ORDER BY child.sequence,reserved.event_id LIMIT ?`)
                .bind(row.id, 200 - orphanEvents)
                .all<{ event_id: string; message_id: string }>();
            orphanEvents += reservations.results.length;
            const capturedJson = JSON.stringify(reservations.results);
            const token = crypto.randomUUID();
            const results = await env.DB.batch([
              env.DB.prepare(`UPDATE slack_digest_receipts SET claim_token=?,claimed_at=? WHERE id=? AND state='retired'
          AND claim_token IS ? AND claimed_at IS ? AND ${digestRetirementGuardSql("slack_digest_receipts")}`).bind(
                token,
                now,
                row.id,
                row.claim_token,
                row.claimed_at,
              ),
              env.DB.prepare(`DELETE FROM slack_digest_message_events WHERE event_id IN (SELECT json_extract(value,'$.event_id') FROM json_each(?))
                AND EXISTS(SELECT 1 FROM json_each(?) captured JOIN slack_digest_messages child ON child.id=json_extract(captured.value,'$.message_id')
                  JOIN slack_digest_receipts root ON root.id=child.receipt_id WHERE root.id=? AND root.claim_token=?
                    AND captured.value->>'event_id'=slack_digest_message_events.event_id AND child.id=slack_digest_message_events.message_id
                    AND child.state='pending' AND child.attempted_at IS NULL AND ${digestRetirementGuardSql()})`).bind(
                capturedJson,
                capturedJson,
                row.id,
                token,
              ),
              env.DB.prepare(`UPDATE slack_digest_messages SET state='retired',last_error='obsolete_receipt',claim_token=NULL,claimed_at=NULL
                WHERE receipt_id=? AND state='pending' AND attempted_at IS NULL
                  AND NOT EXISTS(SELECT 1 FROM slack_digest_message_events reserved WHERE reserved.message_id=slack_digest_messages.id)
                  AND EXISTS(SELECT 1 FROM slack_digest_receipts root WHERE root.id=? AND root.claim_token=? AND ${digestRetirementGuardSql()})`).bind(
                row.id,
                row.id,
                token,
              ),
              env.DB.prepare(
                "UPDATE slack_digest_receipts SET claim_token=NULL,claimed_at=NULL WHERE id=? AND claim_token=?",
              ).bind(row.id, token),
            ]);
            orphanRepairs += results[2]!.meta.changes;
          } catch (error) {
            logger.error(
              "slack.legacy.repair_row_failed",
              "slack",
              "Recovery row failed; retaining work for a later pass.",
              { id: row.id },
              error,
            );
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, "Slack orphan repair failed");
        return { orphanRepairs, orphanEvents };
      },
    },
    {
      name: "remaining",
      run: async () => {
        const remaining = await env.DB.prepare(`SELECT
    (SELECT count(*) FROM outbox INDEXED BY slack_activity_legacy_repair WHERE ${activitySignature}) activity,
    (SELECT count(*) FROM slack_interaction_receipts INDEXED BY slack_share_recoverable_receipts WHERE ${identitySignature}) identity,
    (SELECT count(*) FROM outbox WHERE slack_enqueue_failure_count>0) enqueue_failures`).first();
        return { remaining };
      },
    },
  ];
  for (const operation of operations) {
    try {
      Object.assign(stats, await operation.run());
    } catch (error) {
      errors.push(error);
      logger.error(
        "slack.legacy.repair_failed",
        "slack",
        "Recovery category failed; continuing other repairs.",
        { operation: operation.name },
        error,
      );
    }
  }
  logger.info("slack.legacy.repair", "slack", "Examined explicit Slack recovery damage.", stats);
  recordMetric(env, {
    event: "slack.legacy.repair",
    component: "slack",
    operation: "repair",
    outcome: errors.length ? "failure" : "success",
  });
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "Slack legacy repair failed");
}
