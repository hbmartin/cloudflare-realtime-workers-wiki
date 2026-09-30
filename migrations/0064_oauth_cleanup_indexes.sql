CREATE INDEX IF NOT EXISTS idx_oauth_clients_activity ON oauth_clients(updated_at);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_client_expiry ON oauth_authorization_codes(client_id,expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_client ON oauth_grants(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_created ON oauth_grants(created_at);
CREATE INDEX IF NOT EXISTS idx_oauth_access_grant ON oauth_access_tokens(grant_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_grant ON oauth_refresh_tokens(grant_id);
