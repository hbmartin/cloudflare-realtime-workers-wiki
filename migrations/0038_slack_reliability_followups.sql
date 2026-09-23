-- Preserve Slack's original reply order while leaving activity timestamps at ingest time.
ALTER TABLE comments ADD COLUMN slack_order_us INTEGER;
UPDATE comments SET
  created_at = CAST(substr(receipt.message_ts, 1, instr(receipt.message_ts, '.') - 1) AS INTEGER) * 1000
    + CAST(substr(substr(receipt.message_ts, instr(receipt.message_ts, '.') + 1) || '000', 1, 3) AS INTEGER),
  slack_order_us = CAST(substr(receipt.message_ts, 1, instr(receipt.message_ts, '.') - 1) AS INTEGER) * 1000000
    + CAST(substr(substr(receipt.message_ts, instr(receipt.message_ts, '.') + 1) || '000000', 1, 6) AS INTEGER)
FROM slack_inbound_receipts receipt
WHERE comments.slack_source_receipt_id = receipt.id AND receipt.message_ts GLOB '[0-9]*.[0-9]*';

-- A new Slack session may resume a redeemed recovery, but issuing an operator
-- reset alone must not create a resumable recovery window.
ALTER TABLE account_security ADD COLUMN recovery_started_at INTEGER;
UPDATE account_security SET recovery_started_at = (
  SELECT MAX(proof.verified_at) FROM session_security proof
  WHERE proof.user_id = account_security.user_id AND proof.generation = account_security.generation
    AND proof.method = 'recovery'
) WHERE recovery_required = 1;
DROP TRIGGER issue_security_reset;
CREATE TRIGGER issue_security_reset AFTER INSERT ON security_resets BEGIN
  INSERT INTO account_security(user_id,generation,recovery_required,codes_saved,recovery_started_at)
    VALUES (NEW.user_id,1,1,0,NULL)
    ON CONFLICT(user_id) DO UPDATE SET generation=generation+1,recovery_required=1,codes_saved=0,
      codes_batch=NULL,recovery_started_at=NULL,failed_attempts=0,locked_until=0;
  DELETE FROM session WHERE userId=NEW.user_id;
  DELETE FROM trusted_browsers WHERE user_id=NEW.user_id;
  DELETE FROM recovery_codes WHERE user_id=NEW.user_id;
  DELETE FROM pending_recovery_codes WHERE user_id=NEW.user_id;
  DELETE FROM twoFactor WHERE userId=NEW.user_id;
  DELETE FROM passkey WHERE userId=NEW.user_id;
  DELETE FROM verification WHERE value=NEW.user_id;
  UPDATE user SET twoFactorEnabled=0 WHERE id=NEW.user_id;
END;

-- Invalid mappings from earlier releases cannot continue creating mirror links.
UPDATE slack_channel_subscriptions SET mirror_enabled = 0
WHERE mirror_enabled = 1 AND validation_state <> 'valid';
CREATE INDEX idx_outbox_slack_redrive ON outbox(topic, enqueued_at, available_at);
PRAGMA optimize;
