-- Abandoned allocations remain recoverable after page/artifact deletion.
ALTER TABLE slack_file_artifacts ADD COLUMN cleanup_workspace_id TEXT;
ALTER TABLE slack_file_artifacts ADD COLUMN cleanup_team_id TEXT;
ALTER TABLE slack_file_artifacts ADD COLUMN cleanup_bot_user_id TEXT;
UPDATE slack_file_artifacts SET
 cleanup_workspace_id=(SELECT workspace_id FROM slack_installations WHERE id=installation_id),
 cleanup_team_id=(SELECT team_id FROM slack_installations WHERE id=installation_id AND generation=installation_generation),
 cleanup_bot_user_id=(SELECT bot_user_id FROM slack_installations WHERE id=installation_id AND generation=installation_generation);

CREATE TABLE slack_file_cleanup_jobs (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 installation_id TEXT NOT NULL, installation_generation INTEGER NOT NULL,
 team_id TEXT, bot_user_id TEXT, file_id TEXT NOT NULL, artifact_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','paused','completed','failed')),
 next_attempt_at INTEGER, claim_token TEXT, claimed_at INTEGER,
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 2),
 last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 UNIQUE(installation_id,file_id)
);
CREATE INDEX slack_file_cleanup_due ON slack_file_cleanup_jobs(next_attempt_at,id) WHERE state='pending';
CREATE INDEX slack_file_cleanup_paused ON slack_file_cleanup_jobs(workspace_id) WHERE state='paused';

CREATE TRIGGER slack_file_cleanup_failed_insert AFTER INSERT ON slack_file_cleanup_jobs WHEN NEW.state='failed'
BEGIN
 INSERT OR IGNORE INTO slack_delivery_failures(delivery_id,workspace_id,subscription_id,channel_name,reason,created_at)
 VALUES(NEW.id,NEW.workspace_id,'slack-file-cleanup:'||NEW.installation_id,'Slack thumbnail cleanup',NEW.last_error,NEW.updated_at);
END;
CREATE TRIGGER slack_file_cleanup_failed_update AFTER UPDATE OF state ON slack_file_cleanup_jobs
 WHEN NEW.state='failed' AND OLD.state<>'failed'
BEGIN
 INSERT OR IGNORE INTO slack_delivery_failures(delivery_id,workspace_id,subscription_id,channel_name,reason,created_at)
 VALUES(NEW.id,NEW.workspace_id,'slack-file-cleanup:'||NEW.installation_id,'Slack thumbnail cleanup',NEW.last_error,NEW.updated_at);
END;

-- Snapshot ownership when an allocation is saved, before credentials can change.
CREATE TRIGGER slack_file_allocation_owner AFTER UPDATE OF slack_file_id ON slack_file_artifacts
 WHEN NEW.slack_file_id IS NOT NULL AND NEW.slack_file_id IS NOT OLD.slack_file_id
BEGIN
 UPDATE slack_file_artifacts SET
  cleanup_workspace_id=(SELECT workspace_id FROM slack_installations WHERE id=NEW.installation_id),
  cleanup_team_id=(SELECT team_id FROM slack_installations WHERE id=NEW.installation_id AND generation=NEW.installation_generation),
  cleanup_bot_user_id=(SELECT bot_user_id FROM slack_installations WHERE id=NEW.installation_id AND generation=NEW.installation_generation)
 WHERE id=NEW.id;
END;
CREATE TRIGGER slack_file_allocation_owner_insert AFTER INSERT ON slack_file_artifacts
 WHEN NEW.slack_file_id IS NOT NULL AND NEW.cleanup_workspace_id IS NULL
BEGIN
 UPDATE slack_file_artifacts SET
  cleanup_workspace_id=(SELECT workspace_id FROM slack_installations WHERE id=NEW.installation_id),
  cleanup_team_id=(SELECT team_id FROM slack_installations WHERE id=NEW.installation_id AND generation=NEW.installation_generation),
  cleanup_bot_user_id=(SELECT bot_user_id FROM slack_installations WHERE id=NEW.installation_id AND generation=NEW.installation_generation)
 WHERE id=NEW.id;
END;

CREATE TRIGGER slack_file_abandoned BEFORE UPDATE OF slack_file_id ON slack_file_artifacts
 WHEN OLD.slack_file_id IS NOT NULL AND OLD.state<>'uploaded' AND NEW.slack_file_id IS NOT OLD.slack_file_id
BEGIN
 INSERT OR IGNORE INTO slack_file_cleanup_jobs
 (id,workspace_id,installation_id,installation_generation,team_id,bot_user_id,file_id,artifact_id,state,next_attempt_at,last_error,created_at,updated_at)
 SELECT 'slack-file-cleanup:'||OLD.installation_id||':'||OLD.slack_file_id,
 OLD.cleanup_workspace_id,OLD.installation_id,OLD.installation_generation,OLD.cleanup_team_id,OLD.cleanup_bot_user_id,OLD.slack_file_id,OLD.id,
 CASE WHEN OLD.cleanup_team_id IS NOT NULL AND OLD.cleanup_bot_user_id IS NOT NULL THEN 'pending' ELSE 'failed' END,
 CASE WHEN OLD.cleanup_team_id IS NOT NULL AND OLD.cleanup_bot_user_id IS NOT NULL THEN unixepoch('subsec')*1000 ELSE NULL END,
 CASE WHEN OLD.cleanup_team_id IS NULL OR OLD.cleanup_bot_user_id IS NULL THEN 'cleanup_identity_unverified' END,
 unixepoch('subsec')*1000,unixepoch('subsec')*1000
 WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.cleanup_workspace_id);
END;

CREATE TRIGGER slack_file_terminal BEFORE UPDATE OF state ON slack_file_artifacts
 WHEN OLD.slack_file_id IS NOT NULL AND OLD.state<>'uploaded' AND NEW.state IN ('failed','retired')
BEGIN
 INSERT OR IGNORE INTO slack_file_cleanup_jobs
 (id,workspace_id,installation_id,installation_generation,team_id,bot_user_id,file_id,artifact_id,state,next_attempt_at,last_error,created_at,updated_at)
 SELECT 'slack-file-cleanup:'||OLD.installation_id||':'||OLD.slack_file_id,
 OLD.cleanup_workspace_id,OLD.installation_id,OLD.installation_generation,OLD.cleanup_team_id,OLD.cleanup_bot_user_id,OLD.slack_file_id,OLD.id,
 CASE WHEN OLD.cleanup_team_id IS NOT NULL AND OLD.cleanup_bot_user_id IS NOT NULL THEN 'pending' ELSE 'failed' END,
 CASE WHEN OLD.cleanup_team_id IS NOT NULL AND OLD.cleanup_bot_user_id IS NOT NULL THEN unixepoch('subsec')*1000 ELSE NULL END,
 CASE WHEN OLD.cleanup_team_id IS NULL OR OLD.cleanup_bot_user_id IS NULL THEN 'cleanup_identity_unverified' END,
 unixepoch('subsec')*1000,unixepoch('subsec')*1000
 WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.cleanup_workspace_id);
END;

CREATE TRIGGER slack_file_removed BEFORE DELETE ON slack_file_artifacts
 WHEN OLD.slack_file_id IS NOT NULL AND OLD.state<>'uploaded' AND 1
BEGIN
 INSERT OR IGNORE INTO slack_file_cleanup_jobs
 (id,workspace_id,installation_id,installation_generation,team_id,bot_user_id,file_id,artifact_id,state,next_attempt_at,last_error,created_at,updated_at)
 SELECT 'slack-file-cleanup:'||OLD.installation_id||':'||OLD.slack_file_id,
 OLD.cleanup_workspace_id,OLD.installation_id,OLD.installation_generation,OLD.cleanup_team_id,OLD.cleanup_bot_user_id,OLD.slack_file_id,OLD.id,
 CASE WHEN OLD.cleanup_team_id IS NOT NULL AND OLD.cleanup_bot_user_id IS NOT NULL THEN 'pending' ELSE 'failed' END,
 CASE WHEN OLD.cleanup_team_id IS NOT NULL AND OLD.cleanup_bot_user_id IS NOT NULL THEN unixepoch('subsec')*1000 ELSE NULL END,
 CASE WHEN OLD.cleanup_team_id IS NULL OR OLD.cleanup_bot_user_id IS NULL THEN 'cleanup_identity_unverified' END,
 unixepoch('subsec')*1000,unixepoch('subsec')*1000
 WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.cleanup_workspace_id);
END;

INSERT OR IGNORE INTO slack_file_cleanup_jobs
 (id,workspace_id,installation_id,installation_generation,team_id,bot_user_id,file_id,artifact_id,state,next_attempt_at,last_error,created_at,updated_at)
 SELECT 'slack-file-cleanup:'||installation_id||':'||slack_file_id,
 cleanup_workspace_id,installation_id,installation_generation,cleanup_team_id,cleanup_bot_user_id,slack_file_id,id,
 CASE WHEN cleanup_team_id IS NOT NULL AND cleanup_bot_user_id IS NOT NULL THEN 'pending' ELSE 'failed' END,
 CASE WHEN cleanup_team_id IS NOT NULL AND cleanup_bot_user_id IS NOT NULL THEN unixepoch('subsec')*1000 ELSE NULL END,
 CASE WHEN cleanup_team_id IS NULL OR cleanup_bot_user_id IS NULL THEN 'cleanup_identity_unverified' END,
 unixepoch('subsec')*1000,unixepoch('subsec')*1000
 FROM slack_file_artifacts WHERE state IN ('failed','retired') AND slack_file_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM workspaces WHERE id=cleanup_workspace_id);
