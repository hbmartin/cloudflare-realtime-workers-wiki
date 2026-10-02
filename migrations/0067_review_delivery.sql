-- Forward-only delivery checkpoints and transaction-scoped lifecycle context.
ALTER TABLE workspace_activity ADD COLUMN slack_eligible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workspace_activity ADD COLUMN operation_id TEXT;
ALTER TABLE workspace_activity ADD COLUMN source TEXT;
ALTER TABLE workspace_activity ADD COLUMN operation_bulk INTEGER NOT NULL DEFAULT 0;
CREATE TABLE activity_mutation_context (
 page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL, source TEXT NOT NULL, slack_eligible INTEGER NOT NULL DEFAULT 1,
 bulk INTEGER NOT NULL DEFAULT 0);
ALTER TABLE slack_channel_events ADD COLUMN summary_id TEXT;
ALTER TABLE slack_channel_events ADD COLUMN installation_generation INTEGER;
ALTER TABLE slack_channel_events ADD COLUMN delivery_channel_id TEXT;
UPDATE slack_channel_events SET installation_generation=(SELECT i.generation FROM slack_channel_subscriptions m JOIN slack_installations i ON i.id=m.installation_id WHERE m.id=subscription_id),delivery_channel_id=(SELECT channel_id FROM slack_channel_subscriptions m WHERE m.id=subscription_id);
CREATE TRIGGER slack_channel_event_destination AFTER INSERT ON slack_channel_events BEGIN
 UPDATE slack_channel_events SET installation_generation=(SELECT i.generation FROM slack_channel_subscriptions m JOIN slack_installations i ON i.id=m.installation_id WHERE m.id=NEW.subscription_id),delivery_channel_id=(SELECT channel_id FROM slack_channel_subscriptions m WHERE m.id=NEW.subscription_id) WHERE id=NEW.id;
END;

CREATE INDEX slack_channel_events_summary ON slack_channel_events(summary_id);
CREATE TABLE slack_bulk_receipts (
 id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
 installation_generation INTEGER NOT NULL, channel_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 event_type TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',event_ids_json TEXT NOT NULL DEFAULT '[]',
 claim_token TEXT,claimed_at INTEGER,attempted_at INTEGER,message_ts TEXT,last_error TEXT,created_at INTEGER NOT NULL);
CREATE TABLE slack_digest_messages (
 id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL REFERENCES slack_digest_receipts(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',page_ids_json TEXT NOT NULL,
 event_ids_json TEXT NOT NULL,claim_token TEXT,claimed_at INTEGER,attempted_at INTEGER,message_ts TEXT,last_error TEXT,
 UNIQUE(receipt_id,sequence));
CREATE TABLE slack_digest_message_events (
 event_id TEXT PRIMARY KEY REFERENCES slack_channel_events(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL REFERENCES slack_digest_messages(id) ON DELETE CASCADE);
ALTER TABLE slack_file_artifacts ADD COLUMN claim_token TEXT;
ALTER TABLE slack_file_artifacts ADD COLUMN claimed_at INTEGER;
ALTER TABLE slack_file_artifacts ADD COLUMN upload_phase TEXT NOT NULL DEFAULT 'prepare';
ALTER TABLE slack_file_artifacts ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER share_refresh_workspace_member_insert AFTER INSERT ON workspace_members
BEGIN
 UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1
 WHERE installation_id IN (SELECT id FROM slack_installations WHERE workspace_id=NEW.workspace_id)
 AND (SELECT share_enabled FROM round2_runtime WHERE id=1)=1;
END;

DROP TRIGGER activity_page_create;
CREATE TRIGGER activity_page_create AFTER INSERT ON pages
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,previous_space_id,actor_id,event_type,created_at,slack_eligible,operation_id,operation_bulk,source)
 SELECT lower(hex(randomblob(16))),NEW.workspace_id,NEW.id,NEW.space_id,NULL,nullif(coalesce(NEW.updated_by,NEW.created_by),''),'page_created',unixepoch('subsec')*1000,
 coalesce((SELECT slack_eligible FROM activity_mutation_context WHERE page_id=NEW.id),1),
 (SELECT operation_id FROM activity_mutation_context WHERE page_id=NEW.id),coalesce((SELECT bulk FROM activity_mutation_context WHERE page_id=NEW.id),0),
 coalesce((SELECT source FROM activity_mutation_context WHERE page_id=NEW.id),'api')
 WHERE (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1 AND NEW.space_id IS NOT NULL
 AND NEW.is_template=0 AND NEW.import_job_id IS NULL AND (NEW.archived_at IS NULL);
END;

DROP TRIGGER activity_page_publish;
CREATE TRIGGER activity_page_publish AFTER UPDATE OF import_job_id ON pages WHEN OLD.import_job_id IS NOT NULL AND NEW.import_job_id IS NULL
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,previous_space_id,actor_id,event_type,created_at,slack_eligible,operation_id,operation_bulk,source)
 SELECT lower(hex(randomblob(16))),NEW.workspace_id,NEW.id,NEW.space_id,NULL,nullif(coalesce(NEW.updated_by,NEW.created_by),''),'page_created',unixepoch('subsec')*1000,
 coalesce((SELECT slack_eligible FROM activity_mutation_context WHERE page_id=NEW.id),1),
 (SELECT operation_id FROM activity_mutation_context WHERE page_id=NEW.id),coalesce((SELECT bulk FROM activity_mutation_context WHERE page_id=NEW.id),0),
 coalesce((SELECT source FROM activity_mutation_context WHERE page_id=NEW.id),'api')
 WHERE (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1 AND NEW.space_id IS NOT NULL
 AND NEW.is_template=0 AND NEW.import_job_id IS NULL AND (NEW.archived_at IS NULL);
END;

DROP TRIGGER activity_page_move;
CREATE TRIGGER activity_page_move AFTER UPDATE OF parent_id,space_id ON pages WHEN OLD.space_id IS NOT NULL AND (OLD.parent_id IS NOT NEW.parent_id OR OLD.space_id IS NOT NEW.space_id)
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,previous_space_id,actor_id,event_type,created_at,slack_eligible,operation_id,operation_bulk,source)
 SELECT lower(hex(randomblob(16))),NEW.workspace_id,NEW.id,NEW.space_id,OLD.space_id,nullif(coalesce(NEW.updated_by,NEW.created_by),''),'page_moved',unixepoch('subsec')*1000,
 coalesce((SELECT slack_eligible FROM activity_mutation_context WHERE page_id=NEW.id),1),
 (SELECT operation_id FROM activity_mutation_context WHERE page_id=NEW.id),coalesce((SELECT bulk FROM activity_mutation_context WHERE page_id=NEW.id),0),
 coalesce((SELECT source FROM activity_mutation_context WHERE page_id=NEW.id),'api')
 WHERE (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1 AND NEW.space_id IS NOT NULL
 AND NEW.is_template=0 AND NEW.import_job_id IS NULL AND (NEW.archived_at IS NULL);
END;

DROP TRIGGER activity_page_archive;
CREATE TRIGGER activity_page_archive AFTER UPDATE OF archived_at ON pages WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,previous_space_id,actor_id,event_type,created_at,slack_eligible,operation_id,operation_bulk,source)
 SELECT lower(hex(randomblob(16))),NEW.workspace_id,NEW.id,NEW.space_id,NULL,nullif(NEW.archived_by,''),'page_archived',unixepoch('subsec')*1000,
 coalesce((SELECT slack_eligible FROM activity_mutation_context WHERE page_id=NEW.id),1),
 (SELECT operation_id FROM activity_mutation_context WHERE page_id=NEW.id),coalesce((SELECT bulk FROM activity_mutation_context WHERE page_id=NEW.id),0),
 coalesce((SELECT source FROM activity_mutation_context WHERE page_id=NEW.id),'api')
 WHERE (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1 AND NEW.space_id IS NOT NULL
 AND NEW.is_template=0 AND NEW.import_job_id IS NULL AND (1);
END;

DROP TRIGGER activity_page_edit;
CREATE TRIGGER activity_page_edit AFTER UPDATE OF title ON pages WHEN OLD.title IS NOT NEW.title
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,previous_space_id,actor_id,event_type,created_at,slack_eligible,operation_id,operation_bulk,source)
 SELECT lower(hex(randomblob(16))),NEW.workspace_id,NEW.id,NEW.space_id,NULL,nullif(coalesce(NEW.updated_by,NEW.created_by),''),'page_edit',unixepoch('subsec')*1000,
 coalesce((SELECT slack_eligible FROM activity_mutation_context WHERE page_id=NEW.id),1),
 (SELECT operation_id FROM activity_mutation_context WHERE page_id=NEW.id),coalesce((SELECT bulk FROM activity_mutation_context WHERE page_id=NEW.id),0),
 coalesce((SELECT source FROM activity_mutation_context WHERE page_id=NEW.id),'api')
 WHERE (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1 AND NEW.space_id IS NOT NULL
 AND NEW.is_template=0 AND NEW.import_job_id IS NULL AND (NEW.archived_at IS NULL);
END;

DROP TRIGGER activity_page_default_space;
CREATE TRIGGER activity_page_default_space AFTER UPDATE OF space_id ON pages WHEN OLD.space_id IS NULL AND NEW.space_id IS NOT NULL
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,previous_space_id,actor_id,event_type,created_at,slack_eligible,operation_id,operation_bulk,source)
 SELECT lower(hex(randomblob(16))),NEW.workspace_id,NEW.id,NEW.space_id,NULL,nullif(coalesce(NEW.updated_by,NEW.created_by),''),'page_created',unixepoch('subsec')*1000,
 coalesce((SELECT slack_eligible FROM activity_mutation_context WHERE page_id=NEW.id),1),
 (SELECT operation_id FROM activity_mutation_context WHERE page_id=NEW.id),coalesce((SELECT bulk FROM activity_mutation_context WHERE page_id=NEW.id),0),
 coalesce((SELECT source FROM activity_mutation_context WHERE page_id=NEW.id),'api')
 WHERE (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1 AND NEW.space_id IS NOT NULL
 AND NEW.is_template=0 AND NEW.import_job_id IS NULL AND (NEW.archived_at IS NULL);
END;

DROP TRIGGER activity_task_status;
CREATE TRIGGER activity_task_status AFTER UPDATE OF select_value ON table_cells WHEN OLD.select_value IS NOT NEW.select_value
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,actor_id,event_type,created_at,slack_eligible,operation_id,operation_bulk,source)
SELECT lower(hex(randomblob(16))),p.workspace_id,p.id,p.space_id,nullif(coalesce(lease.holder_user_id,p.updated_by,p.created_by),''),'task_status_changed',NEW.updated_at,
 coalesce((SELECT slack_eligible FROM activity_mutation_context WHERE page_id=p.id),1),
 (SELECT operation_id FROM activity_mutation_context WHERE page_id=p.id),coalesce((SELECT bulk FROM activity_mutation_context WHERE page_id=p.id),0),
 coalesce((SELECT source FROM activity_mutation_context WHERE page_id=p.id),'api')
FROM table_row_pages link JOIN table_rows row ON row.id=link.row_id JOIN pages list ON list.id=row.page_id AND list.is_task_list=1
JOIN pages p ON p.id=link.page_id LEFT JOIN table_leases lease ON lease.page_id=list.id AND lease.expires_at>NEW.updated_at
WHERE row.id=NEW.row_id AND NEW.column_id=list.id||'-status' AND p.archived_at IS NULL AND p.import_job_id IS NULL
AND NEW.select_value IN (list.id||'-todo',list.id||'-doing',list.id||'-done')
AND (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1;
END;

CREATE TRIGGER activity_task_status_insert AFTER INSERT ON table_cells
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,actor_id,event_type,created_at,slack_eligible,operation_id,operation_bulk,source)
SELECT lower(hex(randomblob(16))),p.workspace_id,p.id,p.space_id,nullif(coalesce(lease.holder_user_id,p.updated_by,p.created_by),''),'task_status_changed',NEW.updated_at,
 coalesce((SELECT slack_eligible FROM activity_mutation_context WHERE page_id=p.id),1),
 (SELECT operation_id FROM activity_mutation_context WHERE page_id=p.id),coalesce((SELECT bulk FROM activity_mutation_context WHERE page_id=p.id),0),
 coalesce((SELECT source FROM activity_mutation_context WHERE page_id=p.id),'api')
FROM table_row_pages link JOIN table_rows row ON row.id=link.row_id JOIN pages list ON list.id=row.page_id AND list.is_task_list=1
JOIN pages p ON p.id=link.page_id LEFT JOIN table_leases lease ON lease.page_id=list.id AND lease.expires_at>NEW.updated_at
WHERE row.id=NEW.row_id AND NEW.column_id=list.id||'-status' AND p.archived_at IS NULL AND p.import_job_id IS NULL
AND NEW.select_value IN (list.id||'-todo',list.id||'-doing',list.id||'-done')
AND (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1;
END;

DROP TRIGGER activity_channel_lifecycle;
CREATE TRIGGER activity_channel_lifecycle AFTER INSERT ON workspace_activity
BEGIN
INSERT OR IGNORE INTO slack_channel_events(id,subscription_id,workspace_id,event_type,actor_id,page_id,thread_id,cadence,created_at,previous_space_id,summary_id)
SELECT 'activity:'||NEW.id||':'||m.id,m.id,NEW.workspace_id,NEW.event_type,nullif(NEW.actor_id,''),NEW.page_id,NEW.thread_id,m.cadence,NEW.created_at,NEW.previous_space_id,
 CASE WHEN NEW.operation_bulk=1 AND NEW.event_type IN ('page_moved','page_archived') THEN 'bulk:'||i.id||':'||i.generation||':'||NEW.operation_id||':'||m.channel_id||':'||NEW.event_type END
FROM slack_channel_subscriptions m JOIN slack_installations i ON i.id=m.installation_id
WHERE NEW.slack_eligible=1 AND i.workspace_id=NEW.workspace_id AND i.disconnected_at IS NULL AND i.auth_error IS NULL AND m.round2_initialized=1
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
ALTER TABLE slack_file_artifacts ADD COLUMN upload_url TEXT;
-- Convert definite pending legacy work. Sending/blocked roots keep their original
-- IDs for reconciliation; sent historical receipts are never rewritten.
INSERT INTO slack_digest_messages(id,receipt_id,sequence,page_ids_json,event_ids_json)
SELECT r.id||':message:0',r.id,0,
 (SELECT json_group_array(page_id) FROM (
   SELECT e.page_id,max(e.created_at) changed_at FROM slack_channel_events e
   WHERE e.subscription_id=r.subscription_id AND e.cadence='digest' AND e.delivered_at IS NULL AND e.suppressed_at IS NULL
     AND e.created_at>=r.window_start AND e.created_at<r.window_end
   GROUP BY e.page_id ORDER BY changed_at DESC,e.page_id LIMIT 10)),
 '[]'
FROM slack_digest_receipts r WHERE r.state='pending' AND EXISTS(
 SELECT 1 FROM slack_channel_events e WHERE e.subscription_id=r.subscription_id AND e.cadence='digest'
 AND e.delivered_at IS NULL AND e.suppressed_at IS NULL AND e.created_at>=r.window_start AND e.created_at<r.window_end);
UPDATE slack_digest_messages SET event_ids_json=(SELECT json_group_array(e.id) FROM slack_channel_events e
 JOIN slack_digest_receipts r ON r.id=slack_digest_messages.receipt_id
 WHERE e.subscription_id=r.subscription_id AND e.cadence='digest' AND e.delivered_at IS NULL AND e.suppressed_at IS NULL
 AND e.created_at>=r.window_start AND e.created_at<r.window_end AND e.page_id IN (SELECT value FROM json_each(slack_digest_messages.page_ids_json)));
INSERT INTO slack_digest_message_events(event_id,message_id)
 SELECT member.value,m.id FROM slack_digest_messages m,json_each(m.event_ids_json) member;
