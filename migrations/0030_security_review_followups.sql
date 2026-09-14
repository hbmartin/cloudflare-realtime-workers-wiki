ALTER TABLE invites ADD COLUMN claim_token TEXT;
ALTER TABLE invites ADD COLUMN claim_expires_at INTEGER;

-- Drop reservations that never reached an account, and collapse legacy duplicate
-- claims to the newest live invitation (or newest expired invitation when none
-- remain live) for each account/workspace.
UPDATE invites SET claimed_email=NULL WHERE used_at IS NULL AND claimed_by IS NULL;
DELETE FROM invites
 WHERE used_at IS NULL AND claimed_by IS NOT NULL
   AND EXISTS(
     SELECT 1 FROM workspace_members member
      WHERE member.workspace_id=invites.workspace_id AND member.user_id=invites.claimed_by
   );
DELETE FROM invites
 WHERE used_at IS NULL AND claimed_by IS NOT NULL
   AND EXISTS(
     SELECT 1 FROM invites newer
      WHERE newer.workspace_id=invites.workspace_id
        AND newer.claimed_by=invites.claimed_by
        AND newer.used_at IS NULL
        AND (
          CASE WHEN newer.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) THEN 1 ELSE 0 END>
            CASE WHEN invites.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) THEN 1 ELSE 0 END OR
          (CASE WHEN newer.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) THEN 1 ELSE 0 END=
             CASE WHEN invites.expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) THEN 1 ELSE 0 END AND
           (newer.created_at>invites.created_at OR
             (newer.created_at=invites.created_at AND newer.id>invites.id)))
        )
   );
UPDATE invites SET claim_expires_at=expires_at WHERE used_at IS NULL AND claimed_by IS NOT NULL;

CREATE TABLE pending_recovery_codes (
  code_hash TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_recovery_batch ON pending_recovery_codes(user_id,batch_id);
CREATE INDEX idx_pending_recovery_expiry ON pending_recovery_codes(expires_at);
CREATE INDEX idx_rate_limit_last_request ON rateLimit(lastRequest);

DROP TRIGGER complete_invite;
CREATE TRIGGER validate_invite_completion BEFORE UPDATE OF used_at ON invites
WHEN OLD.used_at IS NULL AND NEW.used_at IS NOT NULL AND (
  NEW.used_by IS NULL OR NEW.claimed_by IS NULL OR NEW.claimed_email IS NULL OR NEW.used_by!=NEW.claimed_by OR
  NEW.used_at>=NEW.expires_at OR
  NOT EXISTS(SELECT 1 FROM user WHERE id=NEW.used_by AND lower(email)=lower(NEW.claimed_email))
)
BEGIN
  SELECT RAISE(ABORT, 'invite_completion_invalid');
END;
CREATE TRIGGER complete_invite AFTER UPDATE OF used_at ON invites
WHEN OLD.used_at IS NULL AND NEW.used_at IS NOT NULL
BEGIN
  INSERT INTO workspace_members(workspace_id,user_id,role,created_at)
    VALUES (NEW.workspace_id,NEW.used_by,NEW.role,NEW.used_at);
END;

DROP TRIGGER initialize_account_security;
CREATE TRIGGER initialize_account_security AFTER INSERT ON user BEGIN
  INSERT OR IGNORE INTO account_security(user_id) VALUES (NEW.id);
END;

-- Operator resets are issued directly through D1, so pending replacement codes
-- must be invalidated by the database trigger rather than only by the Worker.
DROP TRIGGER issue_security_reset;
CREATE TRIGGER issue_security_reset AFTER INSERT ON security_resets BEGIN
  INSERT INTO account_security(user_id,generation,recovery_required,codes_saved)
    VALUES (NEW.user_id,1,1,0)
    ON CONFLICT(user_id) DO UPDATE SET generation=generation+1,recovery_required=1,codes_saved=0,codes_batch=NULL,failed_attempts=0,locked_until=0;
  DELETE FROM session WHERE userId=NEW.user_id;
  DELETE FROM trusted_browsers WHERE user_id=NEW.user_id;
  DELETE FROM recovery_codes WHERE user_id=NEW.user_id;
  DELETE FROM pending_recovery_codes WHERE user_id=NEW.user_id;
  DELETE FROM twoFactor WHERE userId=NEW.user_id;
  DELETE FROM passkey WHERE userId=NEW.user_id;
  DELETE FROM verification WHERE value=NEW.user_id;
  UPDATE user SET twoFactorEnabled=0 WHERE id=NEW.user_id;
END;
