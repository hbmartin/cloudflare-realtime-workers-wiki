-- Immutable projection references are published with the document's D1 projection.
CREATE TABLE page_change_checkpoints (
 id TEXT PRIMARY KEY,
 page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 content_epoch INTEGER NOT NULL,
 sequence INTEGER NOT NULL,
 before_key TEXT,
 before_epoch INTEGER,
 before_sequence INTEGER,
 after_key TEXT NOT NULL,
 actor_id TEXT REFERENCES user(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL,
 UNIQUE(page_id,content_epoch,sequence)
);
CREATE INDEX page_change_window ON page_change_checkpoints(page_id,created_at,id);
CREATE INDEX page_change_retention ON page_change_checkpoints(created_at);
CREATE INDEX page_change_before_key ON page_change_checkpoints(before_key);
CREATE INDEX page_change_after_key ON page_change_checkpoints(after_key);
CREATE TABLE page_change_recipients (
 id TEXT PRIMARY KEY,
 checkpoint_id TEXT NOT NULL REFERENCES page_change_checkpoints(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 emailed_at INTEGER,
 slack_at INTEGER,
 UNIQUE(checkpoint_id,user_id)
);
CREATE INDEX page_change_recipient_pending ON page_change_recipients(user_id,emailed_at,slack_at);
CREATE TRIGGER page_change_recipient_cleanup AFTER DELETE ON page_change_recipients BEGIN
 DELETE FROM outbox WHERE id='outbox:'||OLD.id;
END;
-- Digest-only rows never appear in the public notification feed or affect unread counts.
CREATE VIEW digest_notifications AS
 SELECT id,workspace_id,user_id,event_type,actor_id,space_id,page_id,thread_id,
 data_json,read_at,archived_at,created_at,emailed_at,slack_at FROM notifications n
 WHERE n.event_type<>'page_edit' OR NOT EXISTS (
   SELECT 1 FROM page_change_checkpoints c JOIN page_change_recipients r ON r.checkpoint_id=c.id
   WHERE n.id='page_edit:'||c.id||':'||r.user_id
 )
 UNION ALL
 SELECT r.id,c.workspace_id,r.user_id,'page_edit',c.actor_id,p.space_id,c.page_id,NULL,
 json_object('checkpointId',c.id),NULL,NULL,c.created_at,r.emailed_at,r.slack_at
 FROM page_change_recipients r JOIN page_change_checkpoints c ON c.id=r.checkpoint_id
 JOIN pages p ON p.id=c.page_id;
ALTER TABLE deliveries ADD COLUMN comparison_json TEXT;
ALTER TABLE slack_digest_messages ADD COLUMN comparison_refs_json TEXT NOT NULL DEFAULT '{}';

-- Keep failed R2 deletions retryable, including checkpoints removed by page cascades.
CREATE TABLE page_change_projection_gc (r2_key TEXT PRIMARY KEY);
CREATE TRIGGER page_change_projection_cleanup AFTER DELETE ON page_change_checkpoints BEGIN
 INSERT OR IGNORE INTO page_change_projection_gc(r2_key) SELECT OLD.before_key WHERE OLD.before_key IS NOT NULL;
 INSERT OR IGNORE INTO page_change_projection_gc(r2_key) VALUES(OLD.after_key);
END;
