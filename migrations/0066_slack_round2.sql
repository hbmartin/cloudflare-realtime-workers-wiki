-- Runtime release controls are synchronized from Worker configuration before mutations.
CREATE TABLE round2_runtime (id INTEGER PRIMARY KEY CHECK(id=1), activity_enabled INTEGER NOT NULL DEFAULT 0,
 share_enabled INTEGER NOT NULL DEFAULT 0, validation_enabled INTEGER NOT NULL DEFAULT 0, rich_enabled INTEGER NOT NULL DEFAULT 0,
 activity_started_at INTEGER, timezone TEXT);
INSERT INTO round2_runtime(id) VALUES(1);
ALTER TABLE slack_channel_subscriptions ADD COLUMN digest_time TEXT NOT NULL DEFAULT '09:00';
ALTER TABLE slack_channel_subscriptions ADD COLUMN digest_timezone TEXT;
ALTER TABLE slack_channel_subscriptions ADD COLUMN digest_open_work INTEGER NOT NULL DEFAULT 1;
ALTER TABLE slack_channel_subscriptions ADD COLUMN digest_not_before INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slack_channel_subscriptions ADD COLUMN round2_initialized INTEGER NOT NULL DEFAULT 0;
CREATE TABLE workspace_activity (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE, space_id TEXT NOT NULL,
 previous_space_id TEXT, actor_id TEXT, thread_id TEXT, event_type TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX workspace_activity_feed ON workspace_activity(workspace_id,created_at DESC,id DESC);
CREATE INDEX workspace_activity_page ON workspace_activity(page_id,created_at);
ALTER TABLE slack_channel_events ADD COLUMN previous_space_id TEXT;
CREATE TABLE slack_digest_receipts (
 id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
 installation_generation INTEGER NOT NULL, subscription_id TEXT NOT NULL REFERENCES slack_channel_subscriptions(id) ON DELETE CASCADE,
 window_start INTEGER NOT NULL, window_end INTEGER NOT NULL, channel_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
 event_ids_json TEXT NOT NULL DEFAULT '[]', message_ts TEXT, attempted_at INTEGER, claim_token TEXT, claimed_at INTEGER,
 last_error TEXT, created_at INTEGER NOT NULL, UNIQUE(installation_id,installation_generation,subscription_id,window_end));
ALTER TABLE slack_share_references ADD COLUMN observed_user_id TEXT;
ALTER TABLE slack_share_references ADD COLUMN reference_kind TEXT NOT NULL DEFAULT 'page';
ALTER TABLE slack_share_references ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slack_share_references ADD COLUMN rendered_hash TEXT;
ALTER TABLE slack_share_references ADD COLUMN last_error TEXT;
UPDATE slack_share_references SET observed_user_id=(SELECT user_id FROM slack_unfurls u
 WHERE u.installation_id=slack_share_references.installation_id AND u.channel_id=slack_share_references.channel_id
 AND u.message_ts=slack_share_references.message_ts ORDER BY created_at DESC LIMIT 1);
-- Refresh targets outlive page/reference cascades so unavailable previews can be cleaned up.
CREATE TABLE slack_share_refreshes (
 id TEXT PRIMARY KEY, reference_id TEXT NOT NULL, revision INTEGER NOT NULL,
 installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
 installation_generation INTEGER NOT NULL, workspace_id TEXT NOT NULL, page_id TEXT NOT NULL,
 channel_id TEXT NOT NULL, message_ts TEXT NOT NULL, url TEXT NOT NULL, reference_kind TEXT NOT NULL,
 share_link_id TEXT, observed_user_id TEXT, state TEXT NOT NULL DEFAULT 'pending',
 claim_token TEXT, claimed_at INTEGER, attempted_at INTEGER, fallback_ts TEXT, fallback_thread_ts TEXT, rendered_hash TEXT,
 last_error TEXT, created_at INTEGER NOT NULL, UNIQUE(reference_id,revision));
CREATE INDEX slack_share_refresh_lock ON slack_share_refreshes(installation_id,channel_id,message_ts,state);
ALTER TABLE slack_file_artifacts RENAME TO slack_file_artifacts_old;
CREATE TABLE slack_file_artifacts (
 id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
 installation_generation INTEGER NOT NULL, page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 content_epoch INTEGER NOT NULL, content_sha256 TEXT NOT NULL, thumbnail_r2_key TEXT NOT NULL,
 slack_file_id TEXT, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','uploading','uploaded','failed','retired')),
 last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(installation_id,installation_generation,page_id,content_epoch,content_sha256));
DROP TABLE slack_file_artifacts_old;

CREATE TRIGGER activity_page_create AFTER INSERT ON pages
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,previous_space_id,actor_id,event_type,created_at) SELECT lower(hex(randomblob(16))),NEW.workspace_id,NEW.id,NEW.space_id,NULL,coalesce(NEW.updated_by,NEW.created_by),'page_created',unixepoch('subsec')*1000 WHERE (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1 AND NEW.space_id IS NOT NULL AND NEW.is_template=0 AND NEW.import_job_id IS NULL AND (NEW.archived_at IS NULL);
END;

CREATE TRIGGER activity_page_publish AFTER UPDATE OF import_job_id ON pages WHEN OLD.import_job_id IS NOT NULL AND NEW.import_job_id IS NULL
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,previous_space_id,actor_id,event_type,created_at) SELECT lower(hex(randomblob(16))),NEW.workspace_id,NEW.id,NEW.space_id,NULL,coalesce(NEW.updated_by,NEW.created_by),'page_created',unixepoch('subsec')*1000 WHERE (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1 AND NEW.space_id IS NOT NULL AND NEW.is_template=0 AND NEW.import_job_id IS NULL AND (NEW.archived_at IS NULL);
END;

CREATE TRIGGER activity_page_move AFTER UPDATE OF parent_id,space_id ON pages WHEN OLD.space_id IS NOT NULL AND (OLD.parent_id IS NOT NEW.parent_id OR OLD.space_id IS NOT NEW.space_id)
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,previous_space_id,actor_id,event_type,created_at) SELECT lower(hex(randomblob(16))),NEW.workspace_id,NEW.id,NEW.space_id,OLD.space_id,coalesce(NEW.updated_by,NEW.created_by),'page_moved',unixepoch('subsec')*1000 WHERE (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1 AND NEW.space_id IS NOT NULL AND NEW.is_template=0 AND NEW.import_job_id IS NULL AND (NEW.archived_at IS NULL);
END;

CREATE TRIGGER activity_page_archive AFTER UPDATE OF archived_at ON pages WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,previous_space_id,actor_id,event_type,created_at) SELECT lower(hex(randomblob(16))),NEW.workspace_id,NEW.id,NEW.space_id,NULL,NEW.archived_by,'page_archived',unixepoch('subsec')*1000 WHERE (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1 AND NEW.space_id IS NOT NULL AND NEW.is_template=0 AND NEW.import_job_id IS NULL AND (1);
END;

CREATE TRIGGER activity_page_edit AFTER UPDATE OF title ON pages WHEN OLD.title IS NOT NEW.title
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,previous_space_id,actor_id,event_type,created_at) SELECT lower(hex(randomblob(16))),NEW.workspace_id,NEW.id,NEW.space_id,NULL,coalesce(NEW.updated_by,NEW.created_by),'page_edit',unixepoch('subsec')*1000 WHERE (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1 AND NEW.space_id IS NOT NULL AND NEW.is_template=0 AND NEW.import_job_id IS NULL AND (NEW.archived_at IS NULL);
END;

CREATE TRIGGER activity_task_status AFTER UPDATE OF select_value ON table_cells WHEN OLD.select_value IS NOT NEW.select_value
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,actor_id,event_type,created_at)
SELECT lower(hex(randomblob(16))),p.workspace_id,p.id,p.space_id,coalesce(lease.holder_user_id,p.updated_by,p.created_by),'task_status_changed',NEW.updated_at
FROM table_row_pages link JOIN table_rows row ON row.id=link.row_id JOIN pages list ON list.id=row.page_id AND list.is_task_list=1
JOIN pages p ON p.id=link.page_id LEFT JOIN table_leases lease ON lease.page_id=list.id AND lease.expires_at>NEW.updated_at
WHERE row.id=NEW.row_id AND NEW.column_id=list.id||'-status' AND p.archived_at IS NULL AND p.import_job_id IS NULL
AND NEW.select_value IN (list.id||'-todo',list.id||'-doing',list.id||'-done')
AND (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1;
END;

CREATE TRIGGER activity_channel_lifecycle AFTER INSERT ON workspace_activity
BEGIN
INSERT OR IGNORE INTO slack_channel_events(id,subscription_id,workspace_id,event_type,actor_id,page_id,thread_id,cadence,created_at,previous_space_id)
SELECT 'activity:'||NEW.id||':'||m.id,m.id,NEW.workspace_id,NEW.event_type,NEW.actor_id,NEW.page_id,NEW.thread_id,m.cadence,NEW.created_at,NEW.previous_space_id
FROM slack_channel_subscriptions m JOIN slack_installations i ON i.id=m.installation_id
WHERE i.workspace_id=NEW.workspace_id AND i.disconnected_at IS NULL AND i.auth_error IS NULL AND m.round2_initialized=1
AND (m.space_id=NEW.space_id OR m.space_id=NEW.previous_space_id) AND (m.page_id IS NULL OR m.page_id=NEW.page_id)
AND m.muted_at IS NULL AND (m.snoozed_until IS NULL OR m.snoozed_until<=NEW.created_at) AND m.notification_blocked_at IS NULL
AND EXISTS(SELECT 1 FROM json_each(m.event_types_json) WHERE value=NEW.event_type)
AND NOT EXISTS(SELECT 1 FROM slack_thread_links l WHERE l.installation_id=i.id AND l.channel_id=m.channel_id AND l.thread_id=NEW.thread_id AND l.state IN ('pending','active'))
AND NOT EXISTS(SELECT 1 FROM slack_channel_events prior WHERE NEW.event_type='page_edit' AND m.cadence='immediate' AND prior.subscription_id=m.id AND prior.page_id=NEW.page_id AND prior.actor_id=NEW.actor_id AND prior.event_type='page_edit' AND prior.created_at>NEW.created_at-3600000);
INSERT OR IGNORE INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
SELECT 'outbox:'||id,workspace_id,'slack_channel',json_object('eventId',id),created_at,created_at FROM slack_channel_events WHERE id LIKE 'activity:'||NEW.id||':%' AND cadence='immediate';
END;

CREATE TRIGGER share_refresh_revision AFTER UPDATE OF lifecycle_revision ON slack_share_references WHEN NEW.lifecycle_revision<>OLD.lifecycle_revision AND (SELECT share_enabled FROM round2_runtime WHERE id=1)=1
BEGIN
INSERT OR IGNORE INTO slack_share_refreshes(id,reference_id,revision,installation_id,installation_generation,workspace_id,page_id,channel_id,message_ts,url,reference_kind,share_link_id,observed_user_id,created_at)
SELECT 'refresh:'||NEW.id||':'||NEW.lifecycle_revision,NEW.id,NEW.lifecycle_revision,NEW.installation_id,NEW.installation_generation,i.workspace_id,NEW.page_id,NEW.channel_id,NEW.message_ts,NEW.url,NEW.reference_kind,NEW.share_link_id,NEW.observed_user_id,unixepoch('subsec')*1000 FROM slack_installations i WHERE i.id=NEW.installation_id;
INSERT OR IGNORE INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
SELECT 'outbox:'||id,workspace_id,'slack_share_refresh',json_object('refreshId',id),created_at,created_at FROM slack_share_refreshes WHERE reference_id=NEW.id AND revision=NEW.lifecycle_revision;
END;

CREATE TRIGGER share_refresh_create AFTER INSERT ON share_links
BEGIN
UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1 WHERE page_id=NEW.root_page_id AND (SELECT share_enabled FROM round2_runtime WHERE id=1)=1;
END;

CREATE TRIGGER share_refresh_revoke AFTER UPDATE OF revoked_at ON share_links WHEN OLD.revoked_at IS NOT NEW.revoked_at
BEGIN
UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1 WHERE page_id=NEW.root_page_id AND (SELECT share_enabled FROM round2_runtime WHERE id=1)=1;
END;

CREATE TRIGGER share_refresh_page AFTER UPDATE OF archived_at,space_id,parent_id ON pages WHEN OLD.archived_at IS NOT NEW.archived_at OR OLD.space_id IS NOT NEW.space_id OR OLD.parent_id IS NOT NEW.parent_id
BEGIN
UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1 WHERE page_id=NEW.id AND (SELECT share_enabled FROM round2_runtime WHERE id=1)=1;
END;

CREATE TRIGGER share_refresh_delete_page BEFORE DELETE ON pages
BEGIN
UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1 WHERE page_id=OLD.id AND (SELECT share_enabled FROM round2_runtime WHERE id=1)=1;
END;

CREATE TRIGGER share_refresh_mapping_delete BEFORE DELETE ON slack_channel_subscriptions
BEGIN
UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1 WHERE installation_id=OLD.installation_id AND channel_id=OLD.channel_id AND (SELECT share_enabled FROM round2_runtime WHERE id=1)=1;
END;

CREATE TRIGGER share_refresh_mapping_update AFTER UPDATE OF space_id,page_id,channel_id,validation_state ON slack_channel_subscriptions WHEN OLD.space_id IS NOT NEW.space_id OR OLD.page_id IS NOT NEW.page_id OR OLD.channel_id IS NOT NEW.channel_id OR OLD.validation_state IS NOT NEW.validation_state
BEGIN
UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1 WHERE installation_id=NEW.installation_id AND (channel_id=OLD.channel_id OR channel_id=NEW.channel_id) AND (SELECT share_enabled FROM round2_runtime WHERE id=1)=1;
END;

CREATE TRIGGER share_refresh_workspace_member_update AFTER UPDATE OF role ON workspace_members WHEN OLD.role<>NEW.role
BEGIN
UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1 WHERE installation_id IN (SELECT id FROM slack_installations WHERE workspace_id=NEW.workspace_id) AND (SELECT share_enabled FROM round2_runtime WHERE id=1)=1;
END;

CREATE TRIGGER share_refresh_workspace_member_delete AFTER DELETE ON workspace_members
BEGIN
UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1 WHERE installation_id IN (SELECT id FROM slack_installations WHERE workspace_id=OLD.workspace_id) AND (SELECT share_enabled FROM round2_runtime WHERE id=1)=1;
END;

CREATE TRIGGER share_refresh_space_member_delete AFTER DELETE ON space_members
BEGIN
UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1 WHERE page_id IN (SELECT id FROM pages WHERE space_id=OLD.space_id) AND (SELECT share_enabled FROM round2_runtime WHERE id=1)=1;
END;

CREATE TRIGGER share_refresh_space_member_insert AFTER INSERT ON space_members
BEGIN
UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1 WHERE page_id IN (SELECT id FROM pages WHERE space_id=NEW.space_id) AND (SELECT share_enabled FROM round2_runtime WHERE id=1)=1;
END;

CREATE TRIGGER share_refresh_space_visibility AFTER UPDATE OF visibility ON spaces WHEN OLD.visibility<>NEW.visibility
BEGIN
UPDATE slack_share_references SET lifecycle_revision=lifecycle_revision+1 WHERE page_id IN (SELECT id FROM pages WHERE space_id=NEW.id) AND (SELECT share_enabled FROM round2_runtime WHERE id=1)=1;
END;

CREATE TRIGGER slack_thumbnail_insert AFTER INSERT ON diagram_projections
BEGIN
INSERT OR IGNORE INTO slack_file_artifacts(id,installation_id,installation_generation,page_id,content_epoch,content_sha256,thumbnail_r2_key,created_at,updated_at)
SELECT 'file:'||i.id||':'||i.generation||':'||p.id||':'||NEW.content_epoch||':'||NEW.thumbnail_hash,i.id,i.generation,p.id,NEW.content_epoch,NEW.thumbnail_hash,NEW.thumbnail_r2_key,NEW.updated_at,NEW.updated_at
FROM pages p JOIN slack_channel_subscriptions m ON m.space_id=p.space_id AND (m.page_id IS NULL OR m.page_id=p.id) JOIN slack_installations i ON i.id=m.installation_id
WHERE p.id=NEW.page_id AND p.content_epoch=NEW.content_epoch AND p.archived_at IS NULL AND p.import_job_id IS NULL AND m.cadence='digest' AND i.disconnected_at IS NULL AND m.validation_state='valid' AND (SELECT validation_enabled FROM round2_runtime WHERE id=1)=1 AND (SELECT rich_enabled FROM round2_runtime WHERE id=1)=1;
INSERT OR IGNORE INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
SELECT 'outbox:'||f.id,i.workspace_id,'slack_file_upload',json_object('artifactId',f.id),f.created_at,f.created_at FROM slack_file_artifacts f JOIN slack_installations i ON i.id=f.installation_id WHERE f.page_id=NEW.page_id AND f.content_epoch=NEW.content_epoch AND f.content_sha256=NEW.thumbnail_hash AND f.state='pending';
END;

CREATE TRIGGER slack_thumbnail_update AFTER UPDATE ON diagram_projections
BEGIN
INSERT OR IGNORE INTO slack_file_artifacts(id,installation_id,installation_generation,page_id,content_epoch,content_sha256,thumbnail_r2_key,created_at,updated_at)
SELECT 'file:'||i.id||':'||i.generation||':'||p.id||':'||NEW.content_epoch||':'||NEW.thumbnail_hash,i.id,i.generation,p.id,NEW.content_epoch,NEW.thumbnail_hash,NEW.thumbnail_r2_key,NEW.updated_at,NEW.updated_at
FROM pages p JOIN slack_channel_subscriptions m ON m.space_id=p.space_id AND (m.page_id IS NULL OR m.page_id=p.id) JOIN slack_installations i ON i.id=m.installation_id
WHERE p.id=NEW.page_id AND p.content_epoch=NEW.content_epoch AND p.archived_at IS NULL AND p.import_job_id IS NULL AND m.cadence='digest' AND i.disconnected_at IS NULL AND m.validation_state='valid' AND (SELECT validation_enabled FROM round2_runtime WHERE id=1)=1 AND (SELECT rich_enabled FROM round2_runtime WHERE id=1)=1;
INSERT OR IGNORE INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
SELECT 'outbox:'||f.id,i.workspace_id,'slack_file_upload',json_object('artifactId',f.id),f.created_at,f.created_at FROM slack_file_artifacts f JOIN slack_installations i ON i.id=f.installation_id WHERE f.page_id=NEW.page_id AND f.content_epoch=NEW.content_epoch AND f.content_sha256=NEW.thumbnail_hash AND f.state='pending';
END;
ALTER TABLE slack_channel_events ADD COLUMN round2_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE slack_channel_events ADD COLUMN attempted_at INTEGER;
ALTER TABLE slack_channel_events ADD COLUMN message_ts TEXT;

CREATE TRIGGER mapping_reset_channel_activity AFTER UPDATE OF channel_id,space_id,page_id ON slack_channel_subscriptions
WHEN OLD.channel_id IS NOT NEW.channel_id OR OLD.space_id IS NOT NEW.space_id OR OLD.page_id IS NOT NEW.page_id
BEGIN
UPDATE slack_channel_events SET suppressed_at=unixepoch('subsec')*1000 WHERE subscription_id=NEW.id AND delivered_at IS NULL AND round2_state='pending';
UPDATE slack_digest_receipts SET state='retired',last_error='mapping_changed' WHERE subscription_id=NEW.id AND state='pending';
END;

-- A newly inserted page may receive its default space in an existing AFTER INSERT trigger.
CREATE TRIGGER activity_page_default_space AFTER UPDATE OF space_id ON pages WHEN OLD.space_id IS NULL AND NEW.space_id IS NOT NULL
BEGIN
INSERT INTO workspace_activity(id,workspace_id,page_id,space_id,actor_id,event_type,created_at)
SELECT lower(hex(randomblob(16))),NEW.workspace_id,NEW.id,NEW.space_id,coalesce(NEW.updated_by,NEW.created_by),'page_created',unixepoch('subsec')*1000
WHERE (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1 AND NEW.is_template=0 AND NEW.import_job_id IS NULL AND NEW.archived_at IS NULL;
END;

CREATE TRIGGER mapping_pause_boundary AFTER UPDATE OF muted_at,snoozed_until ON slack_channel_subscriptions
WHEN (OLD.muted_at IS NOT NEW.muted_at OR OLD.snoozed_until IS NOT NEW.snoozed_until) AND NEW.round2_initialized=1
BEGIN
UPDATE slack_channel_subscriptions SET digest_not_before=max(digest_not_before,
 CASE WHEN OLD.muted_at IS NULL AND NEW.muted_at IS NULL AND OLD.snoozed_until IS NOT NULL AND NEW.snoozed_until IS NULL AND OLD.snoozed_until<=unixepoch('subsec')*1000
 THEN OLD.snoozed_until ELSE unixepoch('subsec')*1000 END) WHERE id=NEW.id;
END;
