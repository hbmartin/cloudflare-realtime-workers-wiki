-- Pending thread deliveries spend their retry lifetime only while runnable.
ALTER TABLE outbox ADD COLUMN slack_eligible_started_at INTEGER;

CREATE TRIGGER slack_outbox_eligible_start AFTER INSERT ON outbox
WHEN NEW.topic='slack_thread_reply'
BEGIN
  UPDATE outbox SET slack_eligible_started_at=NEW.created_at
    WHERE id=NEW.id AND EXISTS (
      SELECT 1 FROM slack_thread_deliveries d
      JOIN slack_thread_links link ON link.id=d.link_id
      WHERE d.id=json_extract(NEW.payload_json,'$.deliveryId') AND d.state='pending'
        AND (d.operation='root' OR link.root_message_ts IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM slack_thread_deliveries prior
          WHERE prior.link_id=d.link_id AND prior.id<>d.id AND prior.state IN ('pending','sending','blocked')
            AND (d.operation<>'root' AND (prior.operation='root' OR
              (d.operation='reply' AND prior.operation='reply' AND
                (prior.created_at<d.created_at OR (prior.created_at=d.created_at AND prior.id<d.id))) OR
              (d.operation='refresh' AND prior.operation='refresh' AND
                (prior.created_at<d.created_at OR (prior.created_at=d.created_at AND prior.id<d.id)))))));
END;

DROP TRIGGER slack_outbox_auth_baseline;
CREATE TRIGGER slack_outbox_auth_baseline AFTER INSERT ON outbox
WHEN NEW.topic IN ('slack_thread_reply','slack_inbound_reply','slack_thread_action','slack_workspace_action','slack_unfurl')
BEGIN
  UPDATE outbox SET slack_auth_pause_baseline_ms=(SELECT i.auth_paused_ms +
    CASE WHEN i.auth_error_at IS NULL THEN 0 ELSE MAX(0,NEW.created_at-i.auth_error_at) END
    FROM slack_installations i WHERE i.workspace_id=NEW.workspace_id AND i.disconnected_at IS NULL)
    WHERE id=NEW.id;
END;
