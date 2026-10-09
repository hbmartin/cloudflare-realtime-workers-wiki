CREATE TABLE ai_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL
);
CREATE TABLE ai_preferences (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  funding TEXT NOT NULL CHECK(funding IN ('chatgpt','api')),
  PRIMARY KEY(workspace_id,user_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id) ON DELETE CASCADE
);
CREATE TABLE ai_connections (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  label TEXT NOT NULL,
  tokens_ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  refresh_lease TEXT,
  refresh_lease_until INTEGER,
  PRIMARY KEY(workspace_id,user_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id) ON DELETE CASCADE
);
CREATE TABLE ai_oauth_states (
  state_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  verifier_ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id) ON DELETE CASCADE
);
CREATE TABLE ai_conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  title TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id) ON DELETE CASCADE
);
CREATE INDEX ai_conversations_member ON ai_conversations(workspace_id,user_id,updated_at DESC);
CREATE TABLE ai_conversation_pages (
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  PRIMARY KEY(conversation_id,page_id)
);
CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  prompt TEXT NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('running','complete','cancelled','failed')),
  funding TEXT NOT NULL,
  quality TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ai_messages_conversation ON ai_messages(conversation_id,created_at,id);
-- Dispatch receipts outlive deleted conversations, so retrying a deleted operation
-- cannot run the provider twice or bypass the daily quota.
CREATE TABLE ai_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  day INTEGER NOT NULL,
  claim_id TEXT NOT NULL,
  funding TEXT NOT NULL,
  counted INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_members(workspace_id,user_id) ON DELETE CASCADE
);
CREATE INDEX ai_requests_quota ON ai_requests(workspace_id,user_id,day,counted);
CREATE UNIQUE INDEX ai_member_active_generation ON ai_messages(conversation_id) WHERE status='running';
