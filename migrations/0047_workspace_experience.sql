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
