-- A move receipt distinguishes one uncertain request from later reorders of the
-- same page. Keep the exact response so an identical retry is idempotent even
-- after another move changes the live page again.
CREATE TABLE page_move_receipts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  page_id       TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, operation_id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_page_move_receipts_page ON page_move_receipts(workspace_id, page_id);

PRAGMA optimize;
