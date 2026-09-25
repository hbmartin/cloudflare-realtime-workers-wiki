-- Scope failures pause only the affected outbox work until reauthorization.
ALTER TABLE outbox ADD COLUMN slack_scope_paused_at INTEGER;
ALTER TABLE outbox ADD COLUMN slack_scope_paused_ms INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_outbox_scope_paused_workspace ON outbox(workspace_id,slack_scope_paused_at)
  WHERE slack_scope_paused_at IS NOT NULL;

-- Repeat the claim repair for databases that already applied 0045.
UPDATE account_security SET recovery_resume_claim_session_id=NULL
WHERE recovery_resume_claim_session_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM session_security proof
    WHERE proof.session_id=account_security.recovery_resume_claim_session_id
      AND proof.user_id=account_security.user_id AND proof.generation=account_security.generation
      AND proof.method='recovery');

-- Legacy method-specific scope errors were stored as installation-wide outages.
UPDATE slack_installations SET
  auth_paused_ms=auth_paused_ms+CASE WHEN auth_error_at IS NULL THEN 0
    ELSE MAX(0,CAST(unixepoch('subsec')*1000 AS INTEGER)-auth_error_at) END,
  auth_error=NULL,auth_error_at=NULL
WHERE auth_error='missing_scope';

PRAGMA optimize;
