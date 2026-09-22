-- Mirroring remains opt-in. Generations fence work accepted before disconnect.
ALTER TABLE slack_installations ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slack_user_links ADD COLUMN installation_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slack_thread_links ADD COLUMN subscription_id TEXT REFERENCES slack_channel_subscriptions(id) ON DELETE SET NULL;
ALTER TABLE slack_thread_links ADD COLUMN installation_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slack_thread_links ADD COLUMN claim_token TEXT;
ALTER TABLE slack_thread_links ADD COLUMN claimed_at INTEGER;
UPDATE slack_thread_links SET state = 'retired';

ALTER TABLE slack_inbound_receipts ADD COLUMN thread_id TEXT REFERENCES comment_threads(id) ON DELETE CASCADE;
ALTER TABLE slack_inbound_receipts ADD COLUMN thread_ts TEXT;
ALTER TABLE slack_inbound_receipts ADD COLUMN origin TEXT NOT NULL DEFAULT 'slack';
ALTER TABLE slack_inbound_receipts ADD COLUMN payload_json TEXT;
ALTER TABLE slack_inbound_receipts ADD COLUMN outcome TEXT;
ALTER TABLE slack_interaction_receipts ADD COLUMN payload_json TEXT;
ALTER TABLE slack_interaction_receipts ADD COLUMN outcome TEXT;
ALTER TABLE slack_inbound_receipts ADD COLUMN denial_sent_at INTEGER;
ALTER TABLE slack_interaction_receipts ADD COLUMN denial_sent_at INTEGER;

ALTER TABLE comments ADD COLUMN slack_source_receipt_id TEXT REFERENCES slack_inbound_receipts(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_comments_slack_source ON comments(slack_source_receipt_id) WHERE slack_source_receipt_id IS NOT NULL;

CREATE TABLE slack_thread_deliveries (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES slack_thread_links(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('root', 'reply', 'refresh')),
  source_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES user(id),
  comment_id TEXT REFERENCES comments(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'blocked', 'retired')),
  message_ts TEXT,
  attempted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(link_id, operation, source_id)
);
CREATE INDEX idx_slack_thread_delivery_order ON slack_thread_deliveries(link_id, state, created_at, id);
CREATE INDEX idx_slack_thread_subscription ON slack_thread_links(subscription_id, state);

-- The first statement of an inbound mutation batch asserts fresh SQL authority
-- and claims the receipt. A duplicate or revoked claim rolls the whole batch back.
CREATE TABLE slack_mutation_commits (
  receipt_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  authorized INTEGER NOT NULL CHECK (authorized = 1)
);

-- Deletion keeps receipts and old Slack roots, but immediately removes authority.
CREATE TRIGGER slack_mapping_retired BEFORE DELETE ON slack_channel_subscriptions BEGIN
  UPDATE slack_thread_links SET state = 'retired' WHERE subscription_id = OLD.id;
END;
CREATE TRIGGER slack_mirror_disabled AFTER UPDATE OF mirror_enabled ON slack_channel_subscriptions
WHEN NEW.mirror_enabled = 0 BEGIN
  UPDATE slack_thread_links SET state = 'retired' WHERE subscription_id = NEW.id;
END;
PRAGMA optimize;
