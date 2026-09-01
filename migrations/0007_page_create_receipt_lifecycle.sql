-- Page creation receipts prove request identity, while the live page remains the
-- authoritative response. Keep only receipts that still describe a page in the
-- same workspace, then tie their lifetime to that page.
CREATE UNIQUE INDEX idx_pages_workspace_page ON pages(workspace_id, id);

CREATE TABLE page_create_receipts_next (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id       TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  PRIMARY KEY (workspace_id, page_id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages(workspace_id, id) ON DELETE CASCADE
);

INSERT INTO page_create_receipts_next (workspace_id, page_id, request_hash)
SELECT receipt.workspace_id, receipt.page_id, receipt.request_hash
FROM page_create_receipts AS receipt
INNER JOIN pages AS page
  ON page.id = receipt.page_id
 AND page.workspace_id = receipt.workspace_id;

DROP TABLE page_create_receipts;
ALTER TABLE page_create_receipts_next RENAME TO page_create_receipts;
CREATE INDEX idx_page_create_receipts_page ON page_create_receipts(page_id);

PRAGMA optimize;
