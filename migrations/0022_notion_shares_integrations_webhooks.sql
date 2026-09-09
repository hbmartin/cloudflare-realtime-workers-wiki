-- Public publishing, Notion-compatible integrations, block metadata, and webhooks.

ALTER TABLE user
  ADD COLUMN account_type TEXT NOT NULL DEFAULT 'person'
  CHECK (account_type IN ('person', 'bot'));

ALTER TABLE pages ADD COLUMN updated_by TEXT REFERENCES user(id);
UPDATE pages SET updated_by = created_by WHERE updated_by IS NULL;

ALTER TABLE comment_threads ADD COLUMN block_id TEXT;

CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  root_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  url_key TEXT NOT NULL UNIQUE,
  include_subpages INTEGER NOT NULL DEFAULT 0 CHECK (include_subpages IN (0, 1)),
  allow_indexing INTEGER NOT NULL DEFAULT 0 CHECK (allow_indexing IN (0, 1)),
  show_toc INTEGER NOT NULL DEFAULT 1 CHECK (show_toc IN (0, 1)),
  show_last_updated INTEGER NOT NULL DEFAULT 1 CHECK (show_last_updated IN (0, 1)),
  views INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  created_by TEXT NOT NULL REFERENCES user(id),
  revoked_by TEXT REFERENCES user(id),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_share_links_active_page
  ON share_links(root_page_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_share_links_workspace ON share_links(workspace_id, updated_at DESC);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_user_id TEXT NOT NULL UNIQUE REFERENCES user(id),
  name TEXT NOT NULL,
  read_content INTEGER NOT NULL DEFAULT 1 CHECK (read_content IN (0, 1)),
  insert_content INTEGER NOT NULL DEFAULT 0 CHECK (insert_content IN (0, 1)),
  update_content INTEGER NOT NULL DEFAULT 0 CHECK (update_content IN (0, 1)),
  read_comments INTEGER NOT NULL DEFAULT 0 CHECK (read_comments IN (0, 1)),
  insert_comments INTEGER NOT NULL DEFAULT 0 CHECK (insert_comments IN (0, 1)),
  user_information TEXT NOT NULL DEFAULT 'none'
    CHECK (user_information IN ('none', 'basic', 'email')),
  created_by TEXT NOT NULL REFERENCES user(id),
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_integrations_workspace ON integrations(workspace_id, revoked_at, created_at DESC);

CREATE TABLE integration_tokens (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  token_last_four TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE UNIQUE INDEX idx_integration_tokens_active
  ON integration_tokens(integration_id) WHERE revoked_at IS NULL;

CREATE TABLE integration_grants (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  root_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (integration_id, root_page_id)
);

CREATE INDEX idx_integration_grants_page ON integration_grants(root_page_id, integration_id);

CREATE TABLE api_page_ids (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- Stable public UUID aliases and per-block authorship metadata. Internal BlockNote
-- ids are only unique within a document, while public ids are globally unique.
CREATE TABLE api_blocks (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  internal_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by TEXT REFERENCES user(id),
  updated_by TEXT REFERENCES user(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (page_id, internal_id)
);

CREATE INDEX idx_api_blocks_page ON api_blocks(page_id, deleted_at, internal_id);

CREATE TABLE transclusion_sources (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  content_json TEXT NOT NULL,
  projection_seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, block_id)
);

CREATE TABLE transclusion_references (
  reference_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  projection_seq INTEGER NOT NULL,
  PRIMARY KEY (reference_page_id, source_page_id, block_id)
);

CREATE INDEX idx_transclusion_references_source
  ON transclusion_references(source_page_id, block_id, reference_page_id);

CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'active', 'paused', 'deleted')),
  encrypted_verification_token TEXT NOT NULL,
  verification_token_hash TEXT NOT NULL,
  verified_at INTEGER,
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_webhook_subscriptions_integration
  ON webhook_subscriptions(integration_id, status, created_at DESC);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('page', 'block', 'comment')),
  entity_id TEXT NOT NULL,
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES user(id),
  data_json TEXT NOT NULL DEFAULT '{}',
  source_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_webhook_events_workspace ON webhook_events(workspace_id, created_at DESC);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  response_status INTEGER,
  response_headers_json TEXT,
  response_body TEXT,
  last_error TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (event_id, subscription_id)
);

CREATE INDEX idx_webhook_deliveries_subscription
  ON webhook_deliveries(subscription_id, created_at DESC);
CREATE INDEX idx_webhook_deliveries_due
  ON webhook_deliveries(status, next_attempt_at);

PRAGMA optimize;
