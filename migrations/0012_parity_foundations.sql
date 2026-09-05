-- Spaces, server projections, organization, comments, notifications, jobs and
-- integrations.  The feature tables land together so every later API can use
-- the same authorization and delivery primitives.

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT,
  position TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('workspace', 'private')),
  created_by TEXT REFERENCES user(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, slug),
  UNIQUE (workspace_id, id)
);

CREATE INDEX idx_spaces_workspace_position ON spaces(workspace_id, position, id);

INSERT INTO spaces (id, workspace_id, name, slug, position, created_by, created_at, updated_at)
SELECT w.id || '-general', w.id, 'General', 'general', 'a0',
       (SELECT wm.user_id FROM workspace_members wm
         WHERE wm.workspace_id = w.id AND wm.role = 'owner'
         ORDER BY wm.created_at, wm.user_id LIMIT 1),
       w.created_at, w.created_at
  FROM workspaces w;

CREATE TRIGGER workspaces_create_general_space
AFTER INSERT ON workspaces
BEGIN
  INSERT OR IGNORE INTO spaces
    (id, workspace_id, name, slug, position, created_at, updated_at)
  VALUES (NEW.id || '-general', NEW.id, 'General', 'general', 'a0', NEW.created_at, NEW.created_at);
END;

CREATE TABLE space_members (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by TEXT REFERENCES user(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, user_id)
);

CREATE INDEX idx_space_members_user ON space_members(user_id, space_id);

ALTER TABLE pages ADD COLUMN space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE;
ALTER TABLE pages ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0 CHECK (is_template IN (0, 1));
ALTER TABLE pages ADD COLUMN import_job_id TEXT;

UPDATE pages SET space_id = workspace_id || '-general' WHERE space_id IS NULL;

CREATE INDEX idx_pages_space_tree ON pages(space_id, parent_id, archived_at, is_template, position, id);

CREATE TRIGGER pages_assign_general_space
AFTER INSERT ON pages
WHEN NEW.space_id IS NULL
BEGIN
  UPDATE pages SET space_id = NEW.workspace_id || '-general' WHERE id = NEW.id;
END;

CREATE TRIGGER pages_validate_space_insert
BEFORE INSERT ON pages
WHEN NEW.space_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM spaces s WHERE s.id = NEW.space_id AND s.workspace_id = NEW.workspace_id
  ) THEN RAISE(ABORT, 'invalid_page_space') END;
  SELECT CASE WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pages p
     WHERE p.id = NEW.parent_id AND p.workspace_id = NEW.workspace_id AND p.space_id = NEW.space_id
  ) THEN RAISE(ABORT, 'cross_space_parent') END;
END;

CREATE TRIGGER pages_validate_space_update
BEFORE UPDATE OF space_id, parent_id ON pages
BEGIN
  SELECT CASE WHEN NEW.space_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM spaces s WHERE s.id = NEW.space_id AND s.workspace_id = NEW.workspace_id
  ) THEN RAISE(ABORT, 'invalid_page_space') END;
  SELECT CASE WHEN NEW.parent_id IS NOT OLD.parent_id AND NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pages p
     WHERE p.id = NEW.parent_id AND p.workspace_id = NEW.workspace_id AND p.space_id = NEW.space_id
  ) THEN RAISE(ABORT, 'cross_space_parent') END;
END;

CREATE TABLE document_projections (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  content_epoch INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE page_search_v2 USING fts5(
  page_id UNINDEXED,
  workspace_id UNINDEXED,
  space_id UNINDEXED,
  title,
  tags,
  body,
  comments,
  attachments,
  tokenize = 'unicode61'
);

INSERT INTO page_search_v2 (page_id, workspace_id, space_id, title, tags, body, comments, attachments)
SELECT p.id, p.workspace_id, p.space_id, p.title, '', p.plain_text, '',
       COALESCE((SELECT group_concat(a.name, ' ') FROM attachments a WHERE a.page_id = p.id), '')
  FROM pages p WHERE p.archived_at IS NULL;

CREATE TABLE favorites (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  position TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, page_id)
);

CREATE INDEX idx_favorites_user_position ON favorites(user_id, position, page_id);

CREATE TABLE space_pins (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  position TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, page_id)
);

CREATE INDEX idx_space_pins_position ON space_pins(space_id, position, page_id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'gray',
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE page_tags (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, tag_id)
);

CREATE INDEX idx_page_tags_tag ON page_tags(tag_id, page_id);

CREATE TABLE comment_threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES user(id),
  resolved_at INTEGER,
  resolved_by TEXT REFERENCES user(id),
  anchor_json TEXT,
  legacy_migrated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_comment_threads_page ON comment_threads(page_id, updated_at DESC, id);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id),
  body_json TEXT NOT NULL,
  plain_text TEXT NOT NULL,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_comments_thread ON comments(thread_id, created_at, id);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('page', 'space')),
  resource_id TEXT NOT NULL,
  created_by TEXT REFERENCES user(id),
  muted_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, resource_type, resource_id)
);

CREATE INDEX idx_subscriptions_resource ON subscriptions(resource_type, resource_id, muted_at);

CREATE TABLE notification_preferences (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  in_app INTEGER NOT NULL DEFAULT 1 CHECK (in_app IN (0, 1)),
  email TEXT NOT NULL DEFAULT 'immediate' CHECK (email IN ('off', 'immediate', 'digest')),
  slack TEXT NOT NULL DEFAULT 'off' CHECK (slack IN ('off', 'immediate', 'digest')),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  PRIMARY KEY (user_id, event_type)
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_id TEXT REFERENCES user(id),
  space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES comment_threads(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL,
  read_at INTEGER,
  archived_at INTEGER,
  emailed_at INTEGER,
  slack_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX idx_notifications_inbox ON notifications(user_id, archived_at, created_at DESC, id);
CREATE INDEX idx_notifications_unread ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('import', 'export', 'template_clone', 'comment_migration', 'search_reindex')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_confirmation', 'succeeded', 'failed', 'canceling', 'canceled')),
  requested_by TEXT NOT NULL REFERENCES user(id),
  workflow_instance_id TEXT,
  input_key TEXT,
  output_key TEXT,
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  progress_label TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_jobs_requester ON jobs(requested_by, created_at DESC, id);
CREATE INDEX idx_jobs_expiry ON jobs(expires_at, status);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  available_at INTEGER NOT NULL,
  enqueued_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_outbox_pending ON outbox(enqueued_at, available_at, created_at);

CREATE TABLE deliveries (
  idempotency_key TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('in_app', 'email', 'slack')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE slack_installations (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL UNIQUE,
  team_name TEXT NOT NULL,
  bot_user_id TEXT NOT NULL,
  encrypted_bot_token TEXT NOT NULL,
  installed_by TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE slack_user_links (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id),
  UNIQUE (workspace_id, slack_user_id)
);

CREATE TABLE slack_link_tokens (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE slack_channel_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  events_json TEXT NOT NULL,
  cadence TEXT NOT NULL DEFAULT 'immediate' CHECK (cadence IN ('immediate', 'digest')),
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, space_id, page_id, channel_id)
);

PRAGMA optimize;
