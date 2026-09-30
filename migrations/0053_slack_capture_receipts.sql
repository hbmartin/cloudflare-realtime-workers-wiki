-- Keep the source identity and chosen destination after a failed capture so a
-- Slack retry can resume the same receipt instead of creating another page.
ALTER TABLE slack_captures ADD COLUMN destination_space_id TEXT;
ALTER TABLE slack_captures ADD COLUMN destination_parent_id TEXT;
ALTER TABLE slack_captures ADD COLUMN target_kind TEXT CHECK (target_kind IN ('document', 'task'));
ALTER TABLE slack_captures ADD COLUMN title TEXT;
ALTER TABLE slack_captures ADD COLUMN request_hash TEXT;
ALTER TABLE slack_captures ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slack_captures ADD COLUMN error_category TEXT;
ALTER TABLE slack_captures ADD COLUMN published_at INTEGER;

ALTER TABLE slack_product_sessions ADD COLUMN capture_id TEXT REFERENCES slack_captures(id) ON DELETE SET NULL;
CREATE INDEX slack_product_sessions_capture ON slack_product_sessions(capture_id);
CREATE INDEX slack_captures_job ON slack_captures(job_id);
