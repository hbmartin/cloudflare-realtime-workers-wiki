-- Durable, workspace-scoped receipts for client-addressed page creation.
--
-- Page metadata is mutable, so the live page row cannot prove that a reused id
-- carries the same create request after the page is renamed, moved, or archived.
-- Receipts retain the original request hash and response independently of the page.
CREATE TABLE page_create_receipts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id       TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, page_id)
);

PRAGMA optimize;
