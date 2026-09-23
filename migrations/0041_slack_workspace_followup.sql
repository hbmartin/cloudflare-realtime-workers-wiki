-- A projected mention's introduction survives a committed D1 batch even if
-- DocumentRoom is restarted before clearing its local introduction record.
ALTER TABLE member_mentions ADD COLUMN introduction_epoch INTEGER;
ALTER TABLE member_mentions ADD COLUMN introduction_seq INTEGER;
UPDATE member_mentions SET introduction_epoch =
  (SELECT content_epoch FROM pages WHERE id = source_page_id),
  introduction_seq = projection_seq;

-- Keep the hash of the loading modal after the first result update replaces it.
ALTER TABLE slack_view_sessions ADD COLUMN opening_view_hash TEXT;
UPDATE slack_view_sessions SET opening_view_hash = view_hash
 WHERE kind = 'search' AND revision = 0;

PRAGMA optimize;
