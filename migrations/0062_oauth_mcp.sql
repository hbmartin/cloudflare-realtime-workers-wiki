-- OAuth credentials and MCP receipts contain no document content. Revoking a
-- grant never removes a page, comment, or other workspace record.
ALTER TABLE workspaces ADD COLUMN mcp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (mcp_enabled IN (0, 1));
CREATE INDEX idx_pages_import_job ON pages(import_job_id, created_at) WHERE import_job_id IS NOT NULL;

CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  metadata_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  security_generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_oauth_codes_expiry ON oauth_authorization_codes(expires_at);

CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  security_generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_oauth_grants_member ON oauth_grants(user_id,workspace_id,revoked_at);
CREATE TRIGGER oauth_revoke_on_security_reset AFTER UPDATE OF generation,recovery_required,codes_saved ON account_security
WHEN NEW.generation<>OLD.generation OR NEW.recovery_required=1 OR NEW.codes_saved=0
BEGIN
  UPDATE oauth_grants SET revoked_at=CAST(strftime('%s','now') AS INTEGER)*1000
    WHERE user_id=NEW.user_id AND revoked_at IS NULL;
END;

CREATE TABLE oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_oauth_access_expiry ON oauth_access_tokens(expires_at);

CREATE TABLE oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  rotation_id TEXT
);
CREATE INDEX idx_oauth_refresh_family ON oauth_refresh_tokens(family_id);
CREATE INDEX idx_oauth_refresh_expiry ON oauth_refresh_tokens(expires_at);

CREATE TABLE oauth_operation_receipts (
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (grant_id,operation_id)
);
CREATE INDEX idx_oauth_receipts_expiry ON oauth_operation_receipts(expires_at);
