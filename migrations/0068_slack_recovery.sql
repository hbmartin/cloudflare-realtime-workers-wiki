-- Indexed receipt identity applies to existing and future outbox history without rewriting payloads.
ALTER TABLE outbox ADD COLUMN slack_round2_receipt_id TEXT GENERATED ALWAYS AS (
 CASE WHEN json_valid(payload_json) THEN
  CASE topic
   WHEN 'slack_bulk' THEN CASE WHEN json_type(payload_json,'$.summaryId')='text' THEN json_extract(payload_json,'$.summaryId') END
   WHEN 'slack_channel' THEN CASE WHEN json_type(payload_json,'$.eventId')='text' THEN json_extract(payload_json,'$.eventId') END
   WHEN 'slack_digest' THEN CASE WHEN json_type(payload_json,'$.digestId')='text' THEN json_extract(payload_json,'$.digestId') END
   WHEN 'slack_share_refresh' THEN CASE WHEN json_type(payload_json,'$.refreshId')='text' THEN json_extract(payload_json,'$.refreshId') END
   WHEN 'slack_file_upload' THEN CASE WHEN json_type(payload_json,'$.artifactId')='text' THEN json_extract(payload_json,'$.artifactId') END
  END
 END
) VIRTUAL;
ALTER TABLE outbox ADD COLUMN slack_claim_recheck_at INTEGER;
ALTER TABLE outbox ADD COLUMN slack_scope_required_json TEXT;
ALTER TABLE slack_channel_subscriptions ADD COLUMN validation_scope_error_revision INTEGER;
CREATE INDEX idx_outbox_round2_receipt ON outbox(topic,slack_round2_receipt_id,slack_redrive_count DESC)
 WHERE slack_round2_receipt_id IS NOT NULL;
CREATE INDEX idx_outbox_round2_due ON outbox(topic,slack_scope_paused_at,slack_redrive_due_at,id)
 WHERE topic IN ('slack_bulk','slack_channel','slack_digest','slack_share_refresh','slack_file_upload') AND slack_redrive_due_at IS NOT NULL;
CREATE INDEX idx_outbox_round2_claim_due ON outbox(topic,slack_scope_paused_at,slack_claim_recheck_at,id)
 WHERE topic IN ('slack_bulk','slack_channel','slack_digest','slack_share_refresh','slack_file_upload') AND slack_claim_recheck_at IS NOT NULL;
PRAGMA optimize;
