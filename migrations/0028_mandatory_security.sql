ALTER TABLE user ADD COLUMN twoFactorEnabled INTEGER NOT NULL DEFAULT 0;
CREATE TABLE twoFactor (
  id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  backupCodes TEXT NOT NULL,
  userId TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
  verified INTEGER NOT NULL DEFAULT 0,
  failedVerificationCount INTEGER NOT NULL DEFAULT 0,
  lockedUntil INTEGER
);
CREATE TABLE passkey (
  id TEXT PRIMARY KEY,
  name TEXT,
  publicKey TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  credentialID TEXT NOT NULL UNIQUE,
  counter INTEGER NOT NULL,
  deviceType TEXT NOT NULL,
  backedUp INTEGER NOT NULL,
  transports TEXT,
  createdAt INTEGER,
  aaguid TEXT
);
CREATE INDEX idx_passkey_user ON passkey(userId);
CREATE TABLE rateLimit (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, lastRequest INTEGER NOT NULL);
CREATE TABLE account_security (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 0,
  recovery_required INTEGER NOT NULL DEFAULT 0,
  codes_saved INTEGER NOT NULL DEFAULT 0,
  codes_batch TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO account_security(user_id) SELECT id FROM user;
CREATE TABLE session_security (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('totp','passkey','trust','recovery')),
  trust_id TEXT
);
CREATE TABLE trusted_browsers (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  name TEXT NOT NULL
);
CREATE INDEX idx_trusted_browser_user ON trusted_browsers(user_id);
CREATE TABLE recovery_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX idx_recovery_code_user ON recovery_codes(user_id);
CREATE TABLE security_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE pending_totp (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  secret TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE used_totp (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, code_hash)
);
-- Issuing an operator reset is one atomic statement, even through wrangler.
CREATE TRIGGER issue_security_reset AFTER INSERT ON security_resets BEGIN
  INSERT INTO account_security(user_id,generation,recovery_required,codes_saved)
    VALUES (NEW.user_id,1,1,0)
    ON CONFLICT(user_id) DO UPDATE SET generation=generation+1,recovery_required=1,codes_saved=0,codes_batch=NULL,failed_attempts=0,locked_until=0;
  DELETE FROM session WHERE userId=NEW.user_id;
  DELETE FROM trusted_browsers WHERE user_id=NEW.user_id;
  DELETE FROM recovery_codes WHERE user_id=NEW.user_id;
  DELETE FROM twoFactor WHERE userId=NEW.user_id;
  DELETE FROM passkey WHERE userId=NEW.user_id;
  DELETE FROM verification WHERE value=NEW.user_id;
  UPDATE user SET twoFactorEnabled=0 WHERE id=NEW.user_id;
END;
-- A fail-closed cutover: old sessions cannot be grandfathered into MFA.
DELETE FROM session;
DELETE FROM verification;
