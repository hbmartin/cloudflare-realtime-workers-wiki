-- Scheduling versions and enqueue failure streaks have independent lifetimes.
ALTER TABLE outbox ADD COLUMN slack_enqueue_failure_count INTEGER NOT NULL DEFAULT 0 CHECK(slack_enqueue_failure_count>=0);
ALTER TABLE round2_runtime ADD COLUMN digest_cleanup_created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE round2_runtime ADD COLUMN digest_cleanup_event_id TEXT NOT NULL DEFAULT '';
CREATE INDEX slack_digest_receipts_subscription_window ON slack_digest_receipts(subscription_id,window_start,window_end);
CREATE INDEX slack_digest_pending_cleanup ON slack_channel_events(created_at,id)
 WHERE cadence='digest' AND summary_id IS NULL AND round2_state='pending' AND delivered_at IS NULL AND suppressed_at IS NULL;
CREATE INDEX slack_activity_legacy_repair ON outbox(id)
 WHERE topic='slack_channel' AND last_error='Invalid Slack redrive payload' AND slack_scope_paused_at IS NULL
 AND slack_redrive_due_at IS NULL AND slack_claim_recheck_at IS NULL;
CREATE INDEX IF NOT EXISTS slack_share_response_receipt ON outbox(json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.receiptId'),id)
 WHERE topic='slack_share_response';
CREATE INDEX slack_share_identity_repair ON slack_interaction_receipts(id)
 WHERE outcome='accepted' AND response_delivery_state='blocked' AND response_delivery_error='request_identity_unavailable'
 AND response_delivery_attempted_at IS NULL AND denial_sent_at IS NULL;
CREATE INDEX slack_digest_exhausted_children ON slack_digest_messages(receipt_id,id)
 WHERE state='retired' AND last_error='redrive_exhausted';
CREATE INDEX slack_enqueue_failures ON outbox(slack_enqueue_failure_count) WHERE slack_enqueue_failure_count>0;
CREATE INDEX slack_digest_exhausted_roots ON slack_digest_receipts(id) WHERE state='retired' AND last_error='redrive_exhausted';
