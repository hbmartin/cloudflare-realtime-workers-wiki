ALTER TABLE slack_channel_subscriptions RENAME TO slack_channel_subscriptions_legacy;
ALTER TABLE slack_link_tokens RENAME TO slack_link_tokens_legacy;
ALTER TABLE slack_user_links RENAME TO slack_user_links_legacy;
ALTER TABLE slack_installations RENAME TO slack_installations_legacy;

CREATE TABLE slack_installations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL UNIQUE,
  team_name TEXT NOT NULL,
  bot_user_id TEXT NOT NULL,
  bot_token_ciphertext TEXT NOT NULL,
  bot_refresh_token_ciphertext TEXT,
  token_expires_at INTEGER,
  scopes TEXT NOT NULL DEFAULT '',
  installed_by TEXT NOT NULL REFERENCES user(id),
  disconnected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE slack_oauth_states (
  nonce_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_slack_oauth_expiry ON slack_oauth_states(expires_at, used_at);

CREATE TABLE slack_user_links (
  installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, user_id),
  UNIQUE (installation_id, slack_user_id)
);

CREATE TABLE slack_link_tokens (
  token_hash TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_slack_link_expiry ON slack_link_tokens(expires_at, used_at);

CREATE TABLE slack_channel_subscriptions (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL DEFAULT '',
  event_types_json TEXT NOT NULL DEFAULT '["mention","reply","thread_resolved","thread_reopened","page_edit"]',
  cadence TEXT NOT NULL DEFAULT 'immediate' CHECK (cadence IN ('immediate', 'digest')),
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_slack_channels_resource ON slack_channel_subscriptions(space_id, page_id, cadence);
CREATE UNIQUE INDEX idx_slack_channels_unique
  ON slack_channel_subscriptions(installation_id, channel_id, space_id, ifnull(page_id, ''));

CREATE TABLE slack_channel_events (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES slack_channel_subscriptions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_id TEXT REFERENCES user(id),
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES comment_threads(id) ON DELETE CASCADE,
  cadence TEXT NOT NULL CHECK (cadence IN ('immediate', 'digest')),
  delivered_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_slack_channel_events_delivery ON slack_channel_events(cadence, delivered_at, created_at);

CREATE TABLE slack_unfurls (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  unfurls_json TEXT NOT NULL,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE slack_request_replays (
  signature TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_slack_request_replay_expiry ON slack_request_replays(expires_at);

INSERT INTO slack_installations
  (id, workspace_id, team_id, team_name, bot_user_id, bot_token_ciphertext, scopes,
   installed_by, created_at, updated_at)
SELECT workspace_id, workspace_id, team_id, team_name, bot_user_id, encrypted_bot_token, '',
       installed_by, created_at, updated_at
  FROM slack_installations_legacy;

INSERT INTO slack_user_links (installation_id, user_id, slack_user_id, linked_at)
SELECT workspace_id, user_id, slack_user_id, created_at FROM slack_user_links_legacy;

INSERT INTO slack_link_tokens (token_hash, installation_id, slack_user_id, expires_at, used_at, created_at)
SELECT token_hash, workspace_id, slack_user_id, expires_at, used_at,
       max(0, expires_at - 600000)
  FROM slack_link_tokens_legacy;

INSERT INTO slack_channel_subscriptions
  (id, installation_id, space_id, page_id, channel_id, channel_name, event_types_json, cadence,
   created_by, created_at, updated_at)
SELECT id, workspace_id, space_id, page_id, channel_id, channel_name, events_json, cadence,
       created_by, created_at, created_at
  FROM slack_channel_subscriptions_legacy;

DROP TABLE slack_channel_subscriptions_legacy;
DROP TABLE slack_link_tokens_legacy;
DROP TABLE slack_user_links_legacy;
DROP TABLE slack_installations_legacy;

PRAGMA optimize;
