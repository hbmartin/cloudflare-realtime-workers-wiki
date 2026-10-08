-- Forward-only: no conversion or replay of legacy deliveries or identities.
DROP TABLE slack_link_tokens;
DROP VIEW slack_authorized_user_links;
CREATE VIEW slack_authorized_user_links AS
 SELECT link.* FROM slack_user_links link
 JOIN slack_protected_accounts security ON security.user_id=link.user_id AND security.generation=link.security_generation
 JOIN slack_installations installation ON installation.id=link.installation_id
   AND installation.generation=link.installation_generation AND installation.disconnected_at IS NULL
 JOIN workspace_members member ON member.workspace_id=installation.workspace_id AND member.user_id=link.user_id
 WHERE link.verification_method='slack_openid' AND link.verified_at IS NOT NULL
   AND EXISTS(SELECT 1 FROM account oauth WHERE oauth.id=link.better_auth_account_id AND oauth.userId=link.user_id
     AND oauth.providerId='slack' AND oauth.accountId=installation.team_id||':'||link.slack_user_id);

CREATE TABLE slack_history_verifications (
 installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
 installation_generation INTEGER NOT NULL,
 delivery_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,
 thread_ts TEXT,
 attempted_at INTEGER NOT NULL,
 oldest TEXT NOT NULL,
 latest TEXT NOT NULL,
 boundary TEXT,
 candidate_ts TEXT,
 status TEXT NOT NULL CHECK(status IN ('incomplete','confirmed','missing','ambiguous')),
 blocked_reason TEXT,
 revision TEXT NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,installation_generation,delivery_id)
);
CREATE TABLE slack_method_cooldowns (
 installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
 installation_generation INTEGER NOT NULL,
 method TEXT NOT NULL,
 retry_at INTEGER NOT NULL,
 PRIMARY KEY(installation_id,installation_generation,method)
);
CREATE INDEX slack_channel_recovery_mapping ON slack_channel_events(subscription_id,created_at,id)
 WHERE delivered_at IS NULL AND (round2_state IN ('sending','blocked') OR (round2_state='pending' AND attempted_at IS NOT NULL));

DROP TRIGGER mapping_pause_boundary;
CREATE TRIGGER mapping_pause_boundary AFTER UPDATE OF muted_at,snoozed_until ON slack_channel_subscriptions
WHEN (OLD.muted_at IS NOT NEW.muted_at OR OLD.snoozed_until IS NOT NEW.snoozed_until)
BEGIN
UPDATE slack_channel_subscriptions SET digest_not_before=max(digest_not_before,
 CASE WHEN OLD.muted_at IS NULL AND NEW.muted_at IS NULL AND OLD.snoozed_until IS NOT NULL AND NEW.snoozed_until IS NULL AND OLD.snoozed_until<=unixepoch('subsec')*1000
 THEN OLD.snoozed_until ELSE unixepoch('subsec')*1000 END) WHERE id=NEW.id;
END;

DROP TRIGGER activity_channel_lifecycle;
CREATE TRIGGER activity_channel_lifecycle AFTER INSERT ON workspace_activity
BEGIN
INSERT OR IGNORE INTO slack_channel_events(id,subscription_id,workspace_id,event_type,actor_id,page_id,thread_id,cadence,created_at,previous_space_id,summary_id)
SELECT 'activity:'||NEW.id||':'||m.id,m.id,NEW.workspace_id,NEW.event_type,nullif(NEW.actor_id,''),NEW.page_id,NEW.thread_id,m.cadence,NEW.created_at,NEW.previous_space_id,
 CASE WHEN NEW.operation_bulk=1 AND NEW.event_type IN ('page_moved','page_archived') THEN 'bulk:'||i.id||':'||i.generation||':'||NEW.operation_id||':'||m.channel_id||':'||NEW.event_type END
FROM slack_channel_subscriptions m JOIN slack_installations i ON i.id=m.installation_id
WHERE NEW.slack_eligible=1 AND i.workspace_id=NEW.workspace_id AND i.disconnected_at IS NULL AND i.auth_error IS NULL
AND (m.space_id=NEW.space_id OR m.space_id=NEW.previous_space_id) AND (m.page_id IS NULL OR m.page_id=NEW.page_id)
AND m.muted_at IS NULL AND (m.snoozed_until IS NULL OR m.snoozed_until<=NEW.created_at) AND m.notification_blocked_at IS NULL
AND EXISTS(SELECT 1 FROM json_each(m.event_types_json) WHERE value=NEW.event_type)
AND NOT EXISTS(SELECT 1 FROM slack_thread_links l WHERE l.installation_id=i.id AND l.channel_id=m.channel_id AND l.thread_id=NEW.thread_id AND l.state IN ('pending','active'))
AND NOT EXISTS(SELECT 1 FROM slack_channel_events prior WHERE NEW.event_type='page_edit' AND m.cadence='immediate' AND prior.subscription_id=m.id AND prior.page_id=NEW.page_id AND prior.actor_id=NEW.actor_id AND prior.event_type='page_edit' AND prior.created_at>NEW.created_at-3600000);
INSERT OR IGNORE INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
SELECT 'outbox:'||id,workspace_id,'slack_channel',json_object('eventId',id),created_at,created_at FROM slack_channel_events WHERE id LIKE 'activity:'||NEW.id||':%' AND cadence='immediate' AND summary_id IS NULL;
INSERT OR IGNORE INTO slack_bulk_receipts(id,installation_id,installation_generation,channel_id,operation_id,event_type,created_at)
 SELECT e.summary_id,i.id,i.generation,m.channel_id,NEW.operation_id,NEW.event_type,NEW.created_at
 FROM slack_channel_events e JOIN slack_channel_subscriptions m ON m.id=e.subscription_id JOIN slack_installations i ON i.id=m.installation_id
 WHERE e.id LIKE 'activity:'||NEW.id||':%' AND e.summary_id IS NOT NULL;
INSERT OR IGNORE INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
 SELECT 'outbox:'||r.id,NEW.workspace_id,'slack_bulk',json_object('summaryId',r.id),NEW.created_at,NEW.created_at FROM slack_bulk_receipts r
 WHERE r.operation_id=NEW.operation_id;
END;
