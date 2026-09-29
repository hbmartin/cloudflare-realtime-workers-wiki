CREATE TABLE link_preview_image_gc (
  image_key TEXT PRIMARY KEY,
  queued_at INTEGER NOT NULL
);

CREATE INDEX idx_link_preview_image_gc_queued ON link_preview_image_gc(queued_at);
