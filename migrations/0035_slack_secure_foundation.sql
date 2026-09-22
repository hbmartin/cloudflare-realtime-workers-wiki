-- Secure Slack identity and inert foundations for the later Slack milestones.
-- All newly introduced product behavior defaults off or unvalidated.

-- Better Auth 1.7.3 restored the pre-1.7 account schema. The application upgrades
-- before enabling social OAuth, so remove the short-lived issuer migration added
-- for 1.7.0-1.7.2 while preserving every account and token.
DROP INDEX IF EXISTS idx_account_issuer_account;
CREATE TABLE account_without_temporary_issuer (
  id TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt INTEGER,
  refreshTokenExpiresAt INTEGER,
  scope TEXT,
  password TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
INSERT INTO account_without_temporary_issuer
  (id, accountId, providerId, userId, accessToken, refreshToken, idToken,
   accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt)
SELECT id, accountId, providerId, userId, accessToken, refreshToken, idToken,
       accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt
  FROM account;
DROP TABLE account;
ALTER TABLE account_without_temporary_issuer RENAME TO account;
CREATE INDEX idx_account_user ON account(userId);

ALTER TABLE slack_oauth_states ADD COLUMN expected_team_id TEXT;

ALTER TABLE slack_user_links ADD COLUMN better_auth_account_id TEXT REFERENCES account(id) ON DELETE SET NULL;
ALTER TABLE slack_user_links ADD COLUMN verification_method TEXT NOT NULL DEFAULT 'legacy_command'
  CHECK (verification_method IN ('legacy_command', 'slack_openid'));
ALTER TABLE slack_user_links ADD COLUMN verified_at INTEGER;
ALTER TABLE slack_user_links ADD COLUMN migration_state TEXT NOT NULL DEFAULT 'legacy'
  CHECK (migration_state IN ('legacy', 'verified'));

CREATE UNIQUE INDEX idx_slack_user_links_verified_account
  ON slack_user_links(better_auth_account_id)
  WHERE better_auth_account_id IS NOT NULL AND migration_state = 'verified';

ALTER TABLE slack_channel_subscriptions ADD COLUMN channel_type TEXT
  CHECK (channel_type IS NULL OR channel_type IN ('public_channel', 'private_channel', 'im', 'mpim'));
ALTER TABLE slack_channel_subscriptions ADD COLUMN validation_state TEXT NOT NULL DEFAULT 'unvalidated'
  CHECK (validation_state IN ('unvalidated', 'valid', 'invalid'));
ALTER TABLE slack_channel_subscriptions ADD COLUMN validated_at INTEGER;
ALTER TABLE slack_channel_subscriptions ADD COLUMN validation_error TEXT;
ALTER TABLE slack_channel_subscriptions ADD COLUMN bot_is_member INTEGER
  CHECK (bot_is_member IS NULL OR bot_is_member IN (0, 1));
ALTER TABLE slack_channel_subscriptions ADD COLUMN mirror_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (mirror_enabled IN (0, 1));
ALTER TABLE slack_channel_subscriptions ADD COLUMN muted_at INTEGER;
ALTER TABLE slack_channel_subscriptions ADD COLUMN snoozed_until INTEGER;

CREATE UNIQUE INDEX idx_slack_space_mirror_enabled
  ON slack_channel_subscriptions(installation_id, space_id)
  WHERE mirror_enabled = 1 AND page_id IS NULL;
CREATE UNIQUE INDEX idx_slack_page_mirror_enabled
  ON slack_channel_subscriptions(installation_id, page_id)
  WHERE mirror_enabled = 1 AND page_id IS NOT NULL;

CREATE TABLE slack_primary_factor_proofs (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_slack_primary_factor_expiry ON slack_primary_factor_proofs(expires_at);

CREATE TABLE slack_thread_links (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  root_message_ts TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active', 'retired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_slack_thread_links_noteflare_active
  ON slack_thread_links(installation_id, thread_id) WHERE state IN ('pending', 'active');
CREATE UNIQUE INDEX idx_slack_thread_links_slack_active
  ON slack_thread_links(installation_id, channel_id, root_message_ts)
  WHERE state = 'active' AND root_message_ts IS NOT NULL;

CREATE TABLE slack_inbound_receipts (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  event_type TEXT NOT NULL,
  comment_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  UNIQUE (installation_id, event_id),
  UNIQUE (installation_id, channel_id, message_ts, event_type)
);

CREATE TABLE slack_interaction_receipts (
  id TEXT PRIMARY KEY,
  installation_id TEXT REFERENCES slack_installations(id) ON DELETE CASCADE,
  interaction_id TEXT NOT NULL UNIQUE,
  callback_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);

CREATE TABLE slack_captures (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'thread')),
  requested_by TEXT REFERENCES user(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'succeeded', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (installation_id, channel_id, source_ts, source_kind)
);

CREATE TABLE slack_share_references (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  share_link_id TEXT REFERENCES share_links(id) ON DELETE SET NULL,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'observed' CHECK (state IN ('observed', 'updated', 'retired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (installation_id, channel_id, message_ts, url)
);

CREATE TABLE slack_file_artifacts (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  content_epoch INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  slack_file_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'uploaded', 'failed', 'retired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (installation_id, content_sha256),
  UNIQUE (installation_id, page_id, content_epoch)
);

CREATE TABLE slack_operations_destinations (
  installation_id TEXT PRIMARY KEY REFERENCES slack_installations(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  validated_at INTEGER,
  updated_by TEXT NOT NULL REFERENCES user(id),
  updated_at INTEGER NOT NULL
);

CREATE TABLE slack_incidents (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  channel_id TEXT,
  message_ts TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'posted', 'resolved', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (installation_id, source_key)
);

PRAGMA optimize;
