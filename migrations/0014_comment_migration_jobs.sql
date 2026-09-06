-- Queue one coalesced, resumable workspace scan. The existing cron recovery
-- starts these jobs after deployment; page reads continue to migrate lazily
-- until the scan reaches them.
INSERT OR IGNORE INTO jobs
  (id, workspace_id, type, status, requested_by, workflow_instance_id,
   progress_label, options_json, result_json, created_at, updated_at)
SELECT workspace.id || '-comment-migration-v1',
       workspace.id,
       'comment_migration',
       'queued',
       MIN(member.user_id),
       workspace.id || '-comment-migration-v1',
       'Waiting to start',
       '{}',
       '{}',
       unixepoch('subsec') * 1000,
       unixepoch('subsec') * 1000
  FROM workspaces workspace
  JOIN workspace_members member ON member.workspace_id = workspace.id AND member.role = 'owner'
 GROUP BY workspace.id;

PRAGMA optimize;
