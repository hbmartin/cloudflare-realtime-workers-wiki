-- Initialized mappings keep Round 2 ownership across validation rollback.
-- Older producers could enqueue their legacy-ID events without a recovery marker.
-- Preserve existing schedules, scope pauses, claims, budgets and repair signatures.
UPDATE outbox SET slack_redrive_due_at=max(available_at,
  enqueued_at+1800000,CAST(strftime('%s','now') AS INTEGER)*1000)
WHERE topic='slack_channel' AND enqueued_at IS NOT NULL
  AND slack_redrive_due_at IS NULL AND slack_claim_recheck_at IS NULL
  AND slack_scope_paused_at IS NULL AND slack_enqueue_redrive_pending=0
  AND coalesce(last_error,'') NOT IN ('Invalid Slack redrive payload','invalid_round2_payload','slack_validation_stale')
  AND EXISTS(SELECT 1 FROM slack_channel_events event
    JOIN slack_channel_subscriptions mapping ON mapping.id=event.subscription_id
    WHERE event.id=outbox.slack_round2_receipt_id
      AND (event.id LIKE 'activity:%' OR mapping.round2_initialized=1)
      AND event.delivered_at IS NULL AND event.suppressed_at IS NULL
      AND event.round2_state IN ('pending','sending','blocked')
      AND coalesce(event.claimed_at,0)<=CAST(strftime('%s','now') AS INTEGER)*1000-60000);
