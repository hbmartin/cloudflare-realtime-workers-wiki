-- Async Markdown requests are immutable commands. The document room remains
-- the only content store; task rows and results are disposable receipts.
CREATE TABLE notion_markdown_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  page_epoch INTEGER NOT NULL,
  request_json TEXT NOT NULL,
  request_key_hash TEXT,
  target_signature TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','retrying','succeeded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  result_json TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_notion_markdown_tasks_due
  ON notion_markdown_tasks(status,next_attempt_at,lease_expires_at);
CREATE INDEX idx_notion_markdown_tasks_expiry ON notion_markdown_tasks(expires_at);
CREATE UNIQUE INDEX idx_notion_markdown_tasks_request_key
  ON notion_markdown_tasks(integration_id,request_key_hash);
