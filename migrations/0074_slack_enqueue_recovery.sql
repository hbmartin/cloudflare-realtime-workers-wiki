ALTER TABLE outbox ADD COLUMN slack_enqueue_redrive_pending INTEGER NOT NULL DEFAULT 0 CHECK (slack_enqueue_redrive_pending IN (0,1));

-- Activity events always belong to Round 2, including while validation is off.
UPDATE outbox SET enqueued_at=NULL,available_at=unixepoch('subsec')*1000,
  slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL,last_error=NULL,attempts=attempts+1
WHERE topic='slack_channel' AND slack_round2_receipt_id LIKE 'activity:%'
  AND last_error='Invalid Slack redrive payload' AND slack_scope_paused_at IS NULL
  AND EXISTS(SELECT 1 FROM slack_channel_events e WHERE e.id=outbox.slack_round2_receipt_id
    AND e.round2_state='pending' AND e.delivered_at IS NULL AND e.suppressed_at IS NULL
    AND (e.claimed_at IS NULL OR e.claimed_at<=unixepoch('subsec')*1000-60000));

-- Only accepted requests with continuous, verified authorization can recover.
-- The temporary ledger fences every repair against the captured scheduling version.
CREATE TABLE slack_share_recovery_0074 AS
SELECT o.id,o.attempts,o.payload_json,o.enqueued_at,o.available_at,o.slack_redrive_due_at,o.slack_claim_recheck_at,
  receipt.id receipt_id,receipt.response_delivery_state,receipt.response_delivery_error,receipt.response_delivery_attempted_at,
  json_object('userId',link.user_id,'accountId',link.better_auth_account_id,
    'verifiedAt',link.verified_at,'slackUserId',link.slack_user_id) identity_json
FROM outbox o JOIN slack_interaction_receipts receipt ON receipt.id=json_extract(CASE WHEN json_valid(o.payload_json) THEN o.payload_json ELSE '{}' END,'$.receiptId')
JOIN slack_installations installation ON installation.id=receipt.installation_id
JOIN slack_authorized_user_links link ON link.installation_id=installation.id
WHERE o.topic='slack_share_response' AND json_valid(o.payload_json) AND json_type(o.payload_json,'$.identity') IS NULL
  AND o.slack_scope_paused_at IS NULL AND receipt.outcome='accepted' AND receipt.denial_sent_at IS NULL
  AND (receipt.response_delivery_state IS NULL OR receipt.response_delivery_state='pending'
    OR (receipt.response_delivery_state='blocked' AND receipt.response_delivery_error='request_identity_unavailable'
      AND receipt.response_delivery_attempted_at IS NULL))
  AND installation.id=json_extract(o.payload_json,'$.installationId')
  AND installation.generation=json_extract(o.payload_json,'$.generation') AND installation.auth_error IS NULL
  AND link.installation_generation=installation.generation AND link.slack_user_id=json_extract(o.payload_json,'$.userId')
  AND link.migration_state='verified' AND link.verification_method='slack_openid'
  AND link.verified_at<=receipt.received_at AND link.authorization_started_at<=receipt.received_at
  AND (SELECT count(*) FROM slack_authorized_user_links candidate WHERE candidate.installation_id=installation.id
    AND candidate.slack_user_id=link.slack_user_id)=1;

UPDATE outbox SET payload_json=json_set(payload_json,'$.identity',json((SELECT identity_json FROM slack_share_recovery_0074 repair WHERE repair.id=outbox.id))),
  attempts=attempts+1,enqueued_at=NULL,available_at=unixepoch('subsec')*1000,
  slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL,last_error=NULL
WHERE slack_scope_paused_at IS NULL AND EXISTS(SELECT 1 FROM slack_share_recovery_0074 repair
  WHERE repair.id=outbox.id AND repair.attempts=outbox.attempts AND repair.payload_json=outbox.payload_json
    AND repair.enqueued_at IS outbox.enqueued_at AND repair.available_at=outbox.available_at
    AND repair.slack_redrive_due_at IS outbox.slack_redrive_due_at AND repair.slack_claim_recheck_at IS outbox.slack_claim_recheck_at
    AND EXISTS(SELECT 1 FROM slack_interaction_receipts receipt WHERE receipt.id=repair.receipt_id
      AND receipt.outcome='accepted' AND receipt.denial_sent_at IS NULL
      AND receipt.response_delivery_state IS repair.response_delivery_state
      AND receipt.response_delivery_error IS repair.response_delivery_error
      AND receipt.response_delivery_attempted_at IS repair.response_delivery_attempted_at));

UPDATE slack_interaction_receipts SET response_delivery_state='pending',response_delivery_error=NULL
WHERE outcome='accepted' AND response_delivery_state='blocked' AND response_delivery_error='request_identity_unavailable'
  AND response_delivery_attempted_at IS NULL AND denial_sent_at IS NULL
  AND EXISTS(SELECT 1 FROM slack_share_recovery_0074 repair JOIN outbox o ON o.id=repair.id
    WHERE repair.receipt_id=slack_interaction_receipts.id AND o.attempts=repair.attempts+1
      AND o.payload_json=json_set(repair.payload_json,'$.identity',json(repair.identity_json)) AND o.slack_scope_paused_at IS NULL);
DROP TABLE slack_share_recovery_0074;
