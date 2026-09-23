-- Keep mention provenance stable when later projections refresh the excerpt.
ALTER TABLE member_mentions ADD COLUMN first_seen_actor_id TEXT REFERENCES user(id) ON DELETE SET NULL;

-- An unfurl from a previous installation generation must never authorize an action.
ALTER TABLE slack_share_references ADD COLUMN installation_generation INTEGER NOT NULL DEFAULT -1;
ALTER TABLE slack_unfurls ADD COLUMN installation_generation INTEGER NOT NULL DEFAULT 0;

-- Search modals and the per-user Home view carry cursors, not authority.
CREATE TABLE slack_view_sessions (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  installation_generation INTEGER NOT NULL,
  slack_user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('search', 'home')),
  view_id TEXT,
  view_hash TEXT,
  state_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_slack_view_sessions_user ON slack_view_sessions(installation_id, slack_user_id, kind);
CREATE INDEX idx_slack_view_sessions_expiry ON slack_view_sessions(kind, updated_at);

CREATE TABLE slack_action_commits (
  receipt_id TEXT PRIMARY KEY REFERENCES slack_interaction_receipts(id) ON DELETE CASCADE,
  authorized INTEGER NOT NULL CHECK (authorized = 1)
);

PRAGMA optimize;
