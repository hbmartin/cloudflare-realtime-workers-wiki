-- Suppressed digest events must not occupy the daily subscription scan or reappear after unmute.
ALTER TABLE slack_channel_events ADD COLUMN suppressed_at INTEGER;
UPDATE slack_channel_events SET suppressed_at = unixepoch('subsec') * 1000
 WHERE delivered_at IS NULL AND EXISTS (
   SELECT 1 FROM slack_channel_subscriptions mapping WHERE mapping.id = slack_channel_events.subscription_id
     AND (mapping.muted_at IS NOT NULL OR mapping.snoozed_until > unixepoch('subsec') * 1000)
 );
CREATE INDEX idx_slack_channel_events_pending_digest
  ON slack_channel_events(cadence, delivered_at, suppressed_at, created_at, subscription_id);

-- Earlier projections recorded the last editor, which is not proof of who inserted a mention.
UPDATE member_mentions SET first_seen_actor_id = NULL;

-- Record intended navigation before making a non-transactional Slack view call.
ALTER TABLE slack_view_sessions ADD COLUMN pending_state_json TEXT;
ALTER TABLE slack_view_sessions ADD COLUMN pending_revision INTEGER;
ALTER TABLE slack_view_sessions ADD COLUMN pending_token TEXT;

-- Ephemeral sends cannot be reconciled from Slack history; keep explicit attempt state.
ALTER TABLE slack_interaction_receipts ADD COLUMN response_delivery_state TEXT
  CHECK (response_delivery_state IN ('pending', 'sending', 'sent', 'blocked'));
ALTER TABLE slack_interaction_receipts ADD COLUMN response_delivery_error TEXT;
ALTER TABLE slack_interaction_receipts ADD COLUMN response_delivery_attempted_at INTEGER;
CREATE INDEX idx_slack_share_sending_attempted
  ON slack_interaction_receipts(response_delivery_attempted_at)
  WHERE response_delivery_state = 'sending';
UPDATE slack_interaction_receipts SET response_delivery_state = 'blocked',
  response_delivery_error = 'prior_attempt_unconfirmed'
 WHERE callback_id IN ('noteflare_share_create', 'noteflare_share_view',
   'noteflare_unfurl_share_create', 'noteflare_unfurl_share_view') AND denial_sent_at IS NOT NULL;

PRAGMA optimize;
