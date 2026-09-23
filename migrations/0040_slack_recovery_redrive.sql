-- A recovery key is shown once. Its claim belongs to one live replacement session.
ALTER TABLE account_security ADD COLUMN recovery_resume_key_hash TEXT;
ALTER TABLE account_security ADD COLUMN recovery_resume_claim_session_id TEXT;

DROP TRIGGER issue_security_reset;
CREATE TRIGGER issue_security_reset AFTER INSERT ON security_resets BEGIN
  INSERT INTO account_security(user_id,generation,recovery_required,codes_saved,recovery_started_at,
    recovery_resume_key_hash,recovery_resume_claim_session_id)
    VALUES (NEW.user_id,1,1,0,NULL,NULL,NULL)
    ON CONFLICT(user_id) DO UPDATE SET generation=generation+1,recovery_required=1,codes_saved=0,
      codes_batch=NULL,recovery_started_at=NULL,recovery_resume_key_hash=NULL,
      recovery_resume_claim_session_id=NULL,failed_attempts=0,locked_until=0;
  DELETE FROM session WHERE userId=NEW.user_id;
  DELETE FROM trusted_browsers WHERE user_id=NEW.user_id;
  DELETE FROM recovery_codes WHERE user_id=NEW.user_id;
  DELETE FROM pending_recovery_codes WHERE user_id=NEW.user_id;
  DELETE FROM twoFactor WHERE userId=NEW.user_id;
  DELETE FROM passkey WHERE userId=NEW.user_id;
  DELETE FROM verification WHERE value=NEW.user_id;
  UPDATE user SET twoFactorEnabled=0 WHERE id=NEW.user_id;
END;

-- Keep a failed installation token separate from a lost channel or bad mirror.
ALTER TABLE slack_installations ADD COLUMN auth_error TEXT;
ALTER TABLE slack_installations ADD COLUMN auth_error_at INTEGER;
ALTER TABLE slack_channel_subscriptions ADD COLUMN notification_blocked_at INTEGER;
ALTER TABLE slack_channel_subscriptions ADD COLUMN notification_error TEXT;
ALTER TABLE slack_thread_deliveries ADD COLUMN failure_reason TEXT;

-- Delivered outbox history has no due marker and is excluded by this index.
ALTER TABLE outbox ADD COLUMN slack_redrive_due_at INTEGER;
ALTER TABLE outbox ADD COLUMN slack_redrive_count INTEGER NOT NULL DEFAULT 0;
UPDATE outbox SET slack_redrive_due_at = MAX(enqueued_at + 1800000, available_at)
 WHERE enqueued_at IS NOT NULL AND topic IN
  ('slack_thread_reply','slack_inbound_reply','slack_thread_action','slack_workspace_action')
  AND ((topic = 'slack_thread_reply' AND EXISTS (
    SELECT 1 FROM slack_thread_deliveries delivery
     WHERE delivery.id = json_extract(CASE WHEN json_valid(outbox.payload_json) THEN outbox.payload_json ELSE '{}' END, '$.deliveryId')
       AND delivery.state IN ('pending','sending')))
   OR (topic = 'slack_inbound_reply' AND EXISTS (
    SELECT 1 FROM slack_inbound_receipts receipt
     WHERE receipt.id = json_extract(CASE WHEN json_valid(outbox.payload_json) THEN outbox.payload_json ELSE '{}' END, '$.receiptId')
       AND receipt.processed_at IS NULL))
   OR (topic IN ('slack_thread_action','slack_workspace_action') AND EXISTS (
    SELECT 1 FROM slack_interaction_receipts receipt
     WHERE receipt.id = json_extract(CASE WHEN json_valid(outbox.payload_json) THEN outbox.payload_json ELSE '{}' END, '$.receiptId')
       AND receipt.processed_at IS NULL)));
DROP INDEX IF EXISTS idx_outbox_slack_redrive;
CREATE INDEX idx_outbox_slack_redrive_due ON outbox(slack_redrive_due_at, id)
 WHERE slack_redrive_due_at IS NOT NULL;

-- A later real edit has a different updated_at and must keep its edit label.
UPDATE comments SET updated_at = created_at
 WHERE slack_source_receipt_id IS NOT NULL AND EXISTS (
   SELECT 1 FROM slack_inbound_receipts receipt
    WHERE receipt.id = comments.slack_source_receipt_id
      AND comments.updated_at = receipt.processed_at);
PRAGMA optimize;
