-- SQLite cannot alter a column CHECK constraint directly. Replacing only the
-- column preserves the pages table identity and all of its foreign keys,
-- indices, and triggers.
ALTER TABLE pages ADD COLUMN kind_next TEXT NOT NULL DEFAULT 'document'
  CHECK (kind_next IN ('document', 'table', 'diagram'));
UPDATE pages SET kind_next = kind;
ALTER TABLE pages DROP COLUMN kind;
ALTER TABLE pages RENAME COLUMN kind_next TO kind;

CREATE TABLE diagram_projections (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  content_epoch INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  thumbnail_r2_key TEXT NOT NULL UNIQUE,
  thumbnail_hash TEXT NOT NULL,
  thumbnail_byte_size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
