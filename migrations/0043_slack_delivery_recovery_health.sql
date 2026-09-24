-- Recovery keys become active only after the session acknowledges saving them.
ALTER TABLE account_security ADD COLUMN recovery_pending_key_hash TEXT;
ALTER TABLE account_security ADD COLUMN recovery_pending_session_id TEXT;
ALTER TABLE account_security ADD COLUMN recovery_pending_until INTEGER;
ALTER TABLE account_security ADD COLUMN recovery_pending_repair_at INTEGER;
ALTER TABLE account_security ADD COLUMN recovery_origin_session_id TEXT;
CREATE TABLE recovery_session_repairs (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('creating','delivered')),
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_recovery_session_repairs_due ON recovery_session_repairs(state,due_at);
CREATE TRIGGER revoke_superseded_recovery_session
AFTER UPDATE OF recovery_pending_session_id ON account_security
WHEN OLD.recovery_pending_session_id IS NOT NULL AND NEW.recovery_pending_session_id IS NOT NULL
  AND OLD.recovery_pending_session_id <> NEW.recovery_pending_session_id
BEGIN
  DELETE FROM session WHERE id=OLD.recovery_pending_session_id;
END;

DROP TRIGGER issue_security_reset;
CREATE TRIGGER issue_security_reset AFTER INSERT ON security_resets BEGIN
  INSERT INTO account_security(user_id,generation,recovery_required,codes_saved,recovery_started_at,
    recovery_resume_key_hash,recovery_resume_claim_session_id,recovery_pending_key_hash,
    recovery_pending_session_id,recovery_pending_until,recovery_pending_repair_at,recovery_origin_session_id)
    VALUES (NEW.user_id,1,1,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)
    ON CONFLICT(user_id) DO UPDATE SET generation=generation+1,recovery_required=1,codes_saved=0,
      codes_batch=NULL,recovery_started_at=NULL,recovery_resume_key_hash=NULL,
      recovery_resume_claim_session_id=NULL,recovery_pending_key_hash=NULL,
      recovery_pending_session_id=NULL,recovery_pending_until=NULL,recovery_pending_repair_at=NULL,
      recovery_origin_session_id=NULL,
      failed_attempts=0,locked_until=0;
  DELETE FROM session WHERE userId=NEW.user_id;
  DELETE FROM trusted_browsers WHERE user_id=NEW.user_id;
  DELETE FROM recovery_codes WHERE user_id=NEW.user_id;
  DELETE FROM pending_recovery_codes WHERE user_id=NEW.user_id;
  DELETE FROM twoFactor WHERE userId=NEW.user_id;
  DELETE FROM passkey WHERE userId=NEW.user_id;
  DELETE FROM verification WHERE value=NEW.user_id;
  UPDATE user SET twoFactorEnabled=0 WHERE id=NEW.user_id;
END;

-- A credential revision fences stale API failures across refresh and reauthorization.
ALTER TABLE slack_installations ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slack_installations ADD COLUMN auth_paused_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN slack_auth_pause_baseline_ms INTEGER;

-- Reconciliation time excludes unavailable history and installation auth outages.
ALTER TABLE slack_thread_deliveries ADD COLUMN auth_pause_baseline_ms INTEGER;
ALTER TABLE slack_thread_deliveries ADD COLUMN history_paused_at INTEGER;
ALTER TABLE slack_thread_deliveries ADD COLUMN history_pause_total_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slack_thread_deliveries ADD COLUMN history_pause_auth_ms INTEGER;

CREATE TRIGGER slack_outbox_auth_baseline AFTER INSERT ON outbox
WHEN NEW.topic IN ('slack_thread_reply','slack_inbound_reply','slack_thread_action','slack_workspace_action')
BEGIN
  UPDATE outbox SET slack_auth_pause_baseline_ms=(SELECT i.auth_paused_ms +
    CASE WHEN i.auth_error_at IS NULL THEN 0 ELSE MAX(0,NEW.created_at-i.auth_error_at) END
    FROM slack_installations i WHERE i.workspace_id=NEW.workspace_id AND i.disconnected_at IS NULL)
    WHERE id=NEW.id;
END;

-- Health survives a mapping or link being retired or deleted. Acknowledgment never
-- changes the underlying delivery or its deduplication receipt.
CREATE TABLE slack_delivery_failures (
  delivery_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER
);
CREATE INDEX idx_slack_delivery_failures_workspace
  ON slack_delivery_failures(workspace_id, acknowledged_at, subscription_id);

CREATE INDEX idx_slack_thread_delivery_wait
  ON slack_thread_deliveries(link_id, state, operation, created_at, id);
PRAGMA optimize;
