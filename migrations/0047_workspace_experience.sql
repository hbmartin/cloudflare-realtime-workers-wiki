ALTER TABLE pages ADD COLUMN full_width INTEGER NOT NULL DEFAULT 0 CHECK (full_width IN (0, 1));
ALTER TABLE pages ADD COLUMN is_task_list INTEGER NOT NULL DEFAULT 0 CHECK (is_task_list IN (0, 1));
CREATE TABLE task_mutation_receipts (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 actor_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 row_id TEXT NOT NULL,
 detail_page_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,actor_id,operation_id)
);

-- Task details and their row have one lifecycle, including permanent deletion.
CREATE TRIGGER task_detail_delete BEFORE DELETE ON pages
WHEN EXISTS(SELECT 1 FROM table_row_pages link JOIN table_rows r ON r.id=link.row_id JOIN pages list ON list.id=r.page_id WHERE link.page_id=OLD.id AND list.is_task_list=1)
BEGIN
 DELETE FROM table_rows WHERE id IN (SELECT row_id FROM table_row_pages WHERE page_id=OLD.id);
END;

CREATE TABLE slack_product_sessions (
 id TEXT PRIMARY KEY,
 installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
 generation INTEGER NOT NULL,
 slack_user_id TEXT NOT NULL,
 identity_json TEXT NOT NULL,
 state_json TEXT NOT NULL,
 view_id TEXT,
 request_hash TEXT,
 result_page_id TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX slack_product_session_age ON slack_product_sessions(created_at);
