ALTER TABLE invites ADD COLUMN claimed_email TEXT;
ALTER TABLE invites ADD COLUMN claimed_by TEXT REFERENCES user(id);
CREATE INDEX idx_invites_claimant ON invites(claimed_by) WHERE used_at IS NULL;

-- Membership is created only by the first consumption, never by a retry.
CREATE TRIGGER complete_invite AFTER UPDATE OF used_at ON invites
WHEN OLD.used_at IS NULL AND NEW.used_at IS NOT NULL
BEGIN
  INSERT INTO workspace_members(workspace_id,user_id,role,created_at)
    VALUES (NEW.workspace_id,NEW.used_by,NEW.role,NEW.used_at);
END;

-- Initialize once at account creation instead of on authenticated requests.
CREATE TRIGGER initialize_account_security AFTER INSERT ON user BEGIN
  INSERT INTO account_security(user_id) VALUES (NEW.id);
END;
INSERT OR IGNORE INTO account_security(user_id) SELECT id FROM user;

-- Bind the vendor's passkey INSERT to the session and generation that verified it.
CREATE TABLE pending_passkeys (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL
);
CREATE TRIGGER authorize_passkey_insert BEFORE INSERT ON passkey BEGIN
  SELECT RAISE(ABORT, 'passkey_registration_revoked') WHERE NOT EXISTS(
    SELECT 1 FROM pending_passkeys p JOIN account_security a ON a.user_id=p.user_id AND a.generation=p.generation
      JOIN session s ON s.id=p.session_id AND s.userId=p.user_id
    WHERE p.credential_id=NEW.credentialID AND p.user_id=NEW.userId AND julianday(s.expiresAt)>julianday('now')
  );
END;
CREATE TRIGGER consume_passkey_registration AFTER INSERT ON passkey BEGIN
  DELETE FROM pending_passkeys WHERE credential_id=NEW.credentialID;
END;
