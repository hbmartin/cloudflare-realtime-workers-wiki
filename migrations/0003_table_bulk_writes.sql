-- Receipts for bulk table writes.
--
-- A bulk request that times out leaves the caller unable to tell whether its 200 rows
-- landed, and an importer cannot diff thousands of rows to find out. Replaying the
-- same client_request_id returns the recorded outcome instead of appending the rows a
-- second time. The lease already serialises writers to one session, so there is no
-- race here; a conflicting insert simply aborts the batch and rolls back.
CREATE TABLE table_bulk_writes (
  page_id           TEXT NOT NULL REFERENCES table_state(page_id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL,
  revision          INTEGER NOT NULL,
  response_json     TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (page_id, client_request_id)
);

CREATE INDEX idx_table_bulk_writes_created ON table_bulk_writes(created_at);

PRAGMA optimize;
