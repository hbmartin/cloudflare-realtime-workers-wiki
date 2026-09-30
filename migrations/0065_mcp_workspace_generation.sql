-- Invalidate consent requests already in flight when an owner disables MCP.
ALTER TABLE workspaces ADD COLUMN mcp_generation INTEGER NOT NULL DEFAULT 0 CHECK (mcp_generation >= 0);
CREATE INDEX idx_oauth_codes_workspace ON oauth_authorization_codes(workspace_id, consumed_at);
