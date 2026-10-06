-- Additive indexes; historical damage is repaired in bounded Worker passes.
CREATE INDEX slack_share_recoverable_receipts ON slack_interaction_receipts(id)
 WHERE outcome='accepted' AND response_delivery_state='blocked'
 AND response_delivery_error IN ('request_identity_unavailable','redrive_exhausted')
 AND response_delivery_attempted_at IS NULL AND denial_sent_at IS NULL;
CREATE INDEX slack_digest_pending_subscription ON slack_channel_events(subscription_id,created_at,id)
 WHERE cadence='digest' AND summary_id IS NULL AND round2_state='pending'
 AND delivered_at IS NULL AND suppressed_at IS NULL;
CREATE INDEX slack_digest_reservations_message ON slack_digest_message_events(message_id,event_id);
CREATE INDEX slack_channel_pending_cleanup ON slack_channel_events(created_at,id)
 WHERE summary_id IS NULL AND round2_state='pending' AND delivered_at IS NULL AND suppressed_at IS NULL;
ALTER TABLE round2_runtime ADD COLUMN bulk_cleanup_created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE round2_runtime ADD COLUMN bulk_cleanup_event_id TEXT NOT NULL DEFAULT '';
CREATE INDEX slack_bulk_pending_cleanup ON slack_channel_events(created_at,id)
 WHERE summary_id IS NOT NULL AND round2_state='pending' AND delivered_at IS NULL AND suppressed_at IS NULL;
