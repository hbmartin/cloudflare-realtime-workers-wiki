CREATE TABLE archive_disconnect_targets (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_epoch INTEGER NOT NULL,
  room TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_archive_disconnect_targets_due
  ON archive_disconnect_targets(next_attempt_at, created_at);

PRAGMA optimize;
