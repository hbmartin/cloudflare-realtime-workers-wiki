CREATE TABLE link_preview_cache (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  site_name TEXT NOT NULL,
  image_key TEXT,
  image_mime TEXT,
  expires_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  UNIQUE (workspace_id, canonical_url)
);

CREATE INDEX idx_link_preview_cache_expiry ON link_preview_cache(expires_at);
