-- Tracks the one-way handoff from the legacy Yjs comment map to D1. Thread
-- rows already carry their own legacy bit, but a page-level marker is needed
-- to distinguish "migration complete and there were no comments" from "not
-- inspected yet".
CREATE TABLE comment_migrations (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  completed_at INTEGER NOT NULL
);

-- Page authors are the initial watchers. Existing explicit subscriptions win
-- through the unique key, which keeps this migration idempotent.
INSERT OR IGNORE INTO subscriptions
  (id, workspace_id, user_id, resource_type, resource_id, created_by, created_at)
SELECT 'page:' || p.id || ':' || p.created_by,
       p.workspace_id,
       p.created_by,
       'page',
       p.id,
       p.created_by,
       p.created_at
  FROM pages p
  JOIN workspace_members wm
    ON wm.workspace_id = p.workspace_id AND wm.user_id = p.created_by;

PRAGMA optimize;
