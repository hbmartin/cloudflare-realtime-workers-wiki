PRAGMA foreign_keys = ON;

CREATE TABLE user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  expiresAt INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);

CREATE TABLE account (
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

CREATE TABLE verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER,
  updatedAt INTEGER
);

CREATE INDEX idx_session_user ON session(userId);
CREATE INDEX idx_account_user ON account(userId);
CREATE INDEX idx_verification_identifier ON verification(identifier);

CREATE TABLE install_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  workspace_id TEXT NOT NULL,
  initialized_at INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  location_hint TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  expires_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  used_by TEXT REFERENCES user(id),
  used_at INTEGER
);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('document', 'table')),
  position TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Untitled',
  icon TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  content_epoch INTEGER NOT NULL DEFAULT 1,
  plain_text TEXT NOT NULL DEFAULT '',
  indexed_seq INTEGER NOT NULL DEFAULT 0,
  oversized INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  archived_by TEXT REFERENCES user(id),
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_pages_workspace_tree ON pages(workspace_id, parent_id, archived_at, position);

CREATE VIRTUAL TABLE page_search USING fts5(
  page_id UNINDEXED,
  workspace_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61'
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_attachments_page ON attachments(page_id);

CREATE TABLE page_versions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  title TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL,
  last_editor_id TEXT REFERENCES user(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_page_versions_page_created ON page_versions(page_id, created_at DESC);

CREATE TABLE table_state (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE table_columns (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES table_state(page_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'number', 'checkbox', 'date', 'select')),
  position INTEGER NOT NULL
);

CREATE INDEX idx_table_columns_page ON table_columns(page_id, position);

CREATE TABLE table_select_options (
  id TEXT PRIMARY KEY,
  column_id TEXT NOT NULL REFERENCES table_columns(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INTEGER NOT NULL
);

CREATE TABLE table_rows (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES table_state(page_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES user(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_table_rows_page ON table_rows(page_id, position);

CREATE TABLE table_cells (
  row_id TEXT NOT NULL REFERENCES table_rows(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL REFERENCES table_columns(id) ON DELETE CASCADE,
  text_value TEXT,
  number_value REAL,
  boolean_value INTEGER,
  date_value TEXT,
  select_value TEXT REFERENCES table_select_options(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (row_id, column_id)
);

CREATE TABLE table_leases (
  page_id TEXT PRIMARY KEY REFERENCES table_state(page_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  holder_user_id TEXT NOT NULL REFERENCES user(id),
  holder_session_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

PRAGMA optimize;
