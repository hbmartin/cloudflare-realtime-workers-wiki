-- Match the recipient primary key rather than concatenating every retained row.
DROP VIEW digest_notifications;
CREATE VIEW digest_notifications AS
 SELECT id,workspace_id,user_id,event_type,actor_id,space_id,page_id,thread_id,
 data_json,read_at,archived_at,created_at,emailed_at,slack_at FROM notifications n
 WHERE n.event_type<>'page_edit' OR NOT EXISTS (
   SELECT 1 FROM page_change_recipients r WHERE r.id='change:'||substr(n.id,11)
 )
 UNION ALL
 SELECT r.id,c.workspace_id,r.user_id,'page_edit',c.actor_id,p.space_id,c.page_id,NULL,
 json_object('checkpointId',c.id),NULL,NULL,c.created_at,r.emailed_at,r.slack_at
 FROM page_change_recipients r JOIN page_change_checkpoints c ON c.id=r.checkpoint_id
 JOIN pages p ON p.id=c.page_id;

CREATE INDEX deliveries_outbox_channel ON deliveries(outbox_id,channel);

CREATE TABLE document_changes_cleanup_state (
 id INTEGER PRIMARY KEY CHECK(id=1),
 lease_token TEXT,
 lease_until INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL
);
INSERT INTO document_changes_cleanup_state(id,updated_at) VALUES(1,0);
