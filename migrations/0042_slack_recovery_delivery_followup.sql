-- Search intents have an absolute lifetime and a separate lease for each API attempt.
ALTER TABLE slack_view_sessions ADD COLUMN pending_started_at INTEGER;
ALTER TABLE slack_view_sessions ADD COLUMN pending_lease_until INTEGER;
ALTER TABLE slack_view_sessions ADD COLUMN pending_attempts INTEGER NOT NULL DEFAULT 0;
UPDATE slack_view_sessions SET pending_started_at = updated_at
  WHERE kind = 'search' AND pending_token IS NOT NULL;

-- Only one worker may rotate a Slack refresh token at a time.
ALTER TABLE slack_installations ADD COLUMN refresh_lease_token TEXT;
ALTER TABLE slack_installations ADD COLUMN refresh_lease_until INTEGER;
ALTER TABLE slack_channel_subscriptions ADD COLUMN controls_error TEXT;

-- A restored page may have retained a projection from its previous content epoch.
-- Keep the epoch unknown when there is no matching stored projection sequence.
UPDATE member_mentions SET introduction_epoch = CASE
  WHEN (SELECT kind FROM pages WHERE id=source_page_id)='diagram' THEN
    (SELECT d.content_epoch FROM diagram_projections d
      WHERE d.page_id=member_mentions.source_page_id AND d.sequence=member_mentions.projection_seq)
  ELSE (SELECT d.content_epoch FROM document_projections d
    WHERE d.page_id=member_mentions.source_page_id AND d.sequence=member_mentions.projection_seq)
END WHERE introduction_epoch IS NOT NULL;
UPDATE member_mentions SET introduction_seq = NULL WHERE introduction_epoch IS NULL;

CREATE INDEX IF NOT EXISTS idx_slack_view_sessions_created ON slack_view_sessions(kind, created_at);
PRAGMA optimize;
