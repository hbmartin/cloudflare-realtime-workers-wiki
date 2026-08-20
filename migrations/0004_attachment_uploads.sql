-- In-flight direct-to-R2 multipart uploads.
--
-- This table is both the upload session store and the reaper's work queue, following
-- the same claim-by-lease idiom as archive_disconnect_targets: the lease value in
-- next_attempt_at is the fencing token, so a second drainer cannot act on a row a
-- first one already claimed.
--
-- page_id deliberately carries NO foreign key. attachments.page_id cascades on page
-- deletion, which is correct there because permanent-delete stages the r2_key into
-- deletion_targets first. Here a cascade would destroy the only record of a live R2
-- multipart upload, orphaning its uploaded parts with nothing left to find them by.
-- A row pointing at a deleted page is harmless: the reaper aborts the upload and
-- removes the row.
CREATE TABLE attachment_uploads (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id         TEXT NOT NULL,
  r2_key          TEXT NOT NULL UNIQUE,
  r2_upload_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  part_size       INTEGER NOT NULL,
  part_count      INTEGER NOT NULL,
  created_by      TEXT NOT NULL REFERENCES user(id),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT
);

CREATE INDEX idx_attachment_uploads_due ON attachment_uploads(next_attempt_at, created_at);
CREATE INDEX idx_attachment_uploads_page ON attachment_uploads(page_id);

CREATE TABLE attachment_upload_parts (
  upload_id   TEXT NOT NULL REFERENCES attachment_uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_number)
);

PRAGMA optimize;
