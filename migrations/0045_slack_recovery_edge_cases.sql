-- A root is never ordered behind another root. Replies and refreshes each
-- follow their own order, and both wait for the root.
CREATE VIEW slack_thread_delivery_runnable AS
SELECT delivery.id FROM slack_thread_deliveries delivery
JOIN slack_thread_links link ON link.id=delivery.link_id
WHERE delivery.state IN ('pending','sending')
  AND (delivery.operation='root' OR link.root_message_ts IS NOT NULL)
  AND (delivery.operation='root' OR NOT EXISTS (
    SELECT 1 FROM slack_thread_deliveries prior
    WHERE prior.link_id=delivery.link_id AND prior.id<>delivery.id
      AND prior.state IN ('pending','sending','blocked')
      AND (prior.operation='root' OR
        (prior.operation=delivery.operation AND
          (prior.created_at<delivery.created_at OR
            (prior.created_at=delivery.created_at AND prior.id<delivery.id))))));

DROP TRIGGER slack_outbox_eligible_start;
CREATE TRIGGER slack_outbox_eligible_start AFTER INSERT ON outbox
WHEN NEW.topic='slack_thread_reply'
BEGIN
  UPDATE outbox SET slack_eligible_started_at=NEW.created_at
    WHERE id=NEW.id AND EXISTS (
      SELECT 1 FROM slack_thread_delivery_runnable runnable
      JOIN slack_thread_deliveries delivery ON delivery.id=runnable.id
      WHERE runnable.id=json_extract(NEW.payload_json,'$.deliveryId') AND delivery.state='pending');
END;

-- Recover enqueued work missed by the old backfill. Waiting successors get a
-- future due time so they remain a bounded fallback if a completion wake is lost.
UPDATE outbox SET slack_redrive_due_at=
  CASE WHEN EXISTS (SELECT 1 FROM slack_thread_delivery_runnable runnable
      WHERE runnable.id=json_extract(CASE WHEN json_valid(outbox.payload_json)
        THEN outbox.payload_json ELSE '{}' END,'$.deliveryId'))
    THEN MAX(enqueued_at+1800000,available_at)
    ELSE CAST(unixepoch('subsec')*1000 AS INTEGER)+300000 END
WHERE topic='slack_thread_reply' AND enqueued_at IS NOT NULL AND slack_redrive_due_at IS NULL
  AND EXISTS (SELECT 1 FROM slack_thread_deliveries delivery
    WHERE delivery.id=json_extract(CASE WHEN json_valid(outbox.payload_json)
      THEN outbox.payload_json ELSE '{}' END,'$.deliveryId')
      AND (delivery.state IN ('pending','sending') OR
        (delivery.state='blocked' AND delivery.failure_reason LIKE 'reconciliation_%')));

UPDATE outbox SET slack_redrive_due_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+300000
WHERE topic='slack_thread_reply' AND enqueued_at IS NOT NULL
  AND slack_redrive_due_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
  AND EXISTS (SELECT 1 FROM slack_thread_deliveries delivery
    WHERE delivery.id=json_extract(CASE WHEN json_valid(outbox.payload_json)
      THEN outbox.payload_json ELSE '{}' END,'$.deliveryId')
      AND delivery.state='pending'
      AND NOT EXISTS (SELECT 1 FROM slack_thread_delivery_runnable runnable WHERE runnable.id=delivery.id));

-- A claim with no recovery proof was stranded by the old pending-key race.
UPDATE account_security SET recovery_resume_claim_session_id=NULL
WHERE recovery_resume_claim_session_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM session_security proof
    WHERE proof.session_id=account_security.recovery_resume_claim_session_id
      AND proof.user_id=account_security.user_id AND proof.generation=account_security.generation
      AND proof.method='recovery');

-- Fold open local missing-scope outages into auth_paused_ms before clearing their timestamps.
UPDATE slack_installations SET
  auth_paused_ms=auth_paused_ms+CASE WHEN auth_error_at IS NULL THEN 0
    ELSE MAX(0,CAST(unixepoch('subsec')*1000 AS INTEGER)-auth_error_at) END,
  auth_error=NULL,auth_error_at=NULL
WHERE auth_error='missing_scope' AND (
  instr(','||replace(scopes,' ','')||',',',chat:write,')=0 OR
  instr(','||replace(scopes,' ','')||',',',channels:read,')=0 OR
  instr(','||replace(scopes,' ','')||',',',groups:read,')=0 OR
  instr(','||replace(scopes,' ','')||',',',channels:history,')=0 OR
  instr(','||replace(scopes,' ','')||',',',groups:history,')=0 OR
  instr(','||replace(scopes,' ','')||',',',users:read,')=0);

PRAGMA optimize;
