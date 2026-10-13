ALTER TABLE workspace_activity ADD COLUMN contributor_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE slack_channel_events ADD COLUMN contributor_ids_json TEXT NOT NULL DEFAULT '[]';
UPDATE workspace_activity SET contributor_ids_json=json_array(actor_id) WHERE nullif(actor_id,'') IS NOT NULL;
UPDATE slack_channel_events SET contributor_ids_json=json_array(actor_id) WHERE nullif(actor_id,'') IS NOT NULL;

CREATE TRIGGER workspace_activity_contributor_default AFTER INSERT ON workspace_activity
WHEN json_array_length(NEW.contributor_ids_json)=0 AND nullif(NEW.actor_id,'') IS NOT NULL
BEGIN UPDATE workspace_activity SET contributor_ids_json=json_array(NEW.actor_id) WHERE id=NEW.id; END;
CREATE TRIGGER slack_event_contributor_default AFTER INSERT ON slack_channel_events
WHEN json_array_length(NEW.contributor_ids_json)=0 AND nullif(NEW.actor_id,'') IS NOT NULL
BEGIN UPDATE slack_channel_events SET contributor_ids_json=json_array(NEW.actor_id) WHERE id=NEW.id; END;

DROP TRIGGER activity_channel_lifecycle;
CREATE TRIGGER activity_channel_lifecycle AFTER INSERT ON workspace_activity
BEGIN
INSERT OR IGNORE INTO slack_channel_events(id,subscription_id,workspace_id,event_type,actor_id,page_id,thread_id,cadence,created_at,previous_space_id,summary_id,contributor_ids_json)
SELECT 'activity:'||NEW.id||':'||m.id,m.id,NEW.workspace_id,NEW.event_type,nullif(NEW.actor_id,''),NEW.page_id,NEW.thread_id,m.cadence,NEW.created_at,NEW.previous_space_id,
 CASE WHEN NEW.operation_bulk=1 AND NEW.event_type IN ('page_moved','page_archived') THEN 'bulk:'||i.id||':'||i.generation||':'||NEW.operation_id||':'||m.channel_id||':'||NEW.event_type END,
 CASE WHEN json_array_length(NEW.contributor_ids_json)>0 THEN NEW.contributor_ids_json WHEN nullif(NEW.actor_id,'') IS NOT NULL THEN json_array(NEW.actor_id) ELSE '[]' END
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

DROP VIEW digest_notifications;
CREATE VIEW digest_notifications AS
 SELECT id,workspace_id,user_id,event_type,actor_id,space_id,page_id,thread_id,
 data_json,read_at,archived_at,created_at,emailed_at,slack_at FROM notifications n
 WHERE n.event_type<>'page_edit' OR NOT EXISTS (
   SELECT 1 FROM page_change_recipients r WHERE r.id='change:'||substr(n.id,11)
 )
 UNION ALL
 SELECT r.id,c.workspace_id,r.user_id,'page_edit',c.actor_id,p.space_id,c.page_id,NULL,
 json_object('checkpointId',c.id,'contributorIds',json(c.contributor_ids_json)),NULL,NULL,c.created_at,r.emailed_at,r.slack_at
 FROM page_change_recipients r JOIN page_change_checkpoints c ON c.id=r.checkpoint_id
 JOIN pages p ON p.id=c.page_id;
