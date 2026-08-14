CREATE TABLE page_references (
  source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  excerpt TEXT NOT NULL DEFAULT '',
  projection_seq INTEGER NOT NULL,
  PRIMARY KEY (source_page_id, target_page_id)
);

CREATE INDEX idx_page_references_target ON page_references(target_page_id, source_page_id);

CREATE TABLE member_mentions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  excerpt TEXT NOT NULL DEFAULT '',
  first_seen_at INTEGER NOT NULL,
  projection_seq INTEGER NOT NULL,
  PRIMARY KEY (source_page_id, target_user_id)
);

CREATE INDEX idx_member_mentions_inbox
  ON member_mentions(workspace_id, target_user_id, first_seen_at DESC);

CREATE TABLE mention_reads (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE deletion_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  root_page_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_deletion_jobs_due ON deletion_jobs(next_attempt_at, created_at);

CREATE TABLE deletion_targets (
  job_id TEXT NOT NULL REFERENCES deletion_jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('document_do', 'r2_object', 'r2_prefix')),
  target TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (job_id, kind, target)
);

CREATE INDEX idx_deletion_targets_pending ON deletion_targets(job_id, completed_at);

PRAGMA optimize;
