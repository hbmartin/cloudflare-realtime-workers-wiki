-- Complete the v2 corpus before switching reads. Active rows were backfilled by
-- 0012; archived rows are retained so the archive-state search filter works.
INSERT INTO page_search_v2
  (page_id, workspace_id, space_id, title, tags, body, comments, attachments)
SELECT p.id, p.workspace_id, p.space_id, p.title,
       COALESCE((SELECT group_concat(t.name, ' ') FROM page_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.page_id = p.id), ''),
       COALESCE(p.plain_text, ''),
       COALESCE((SELECT group_concat(c.plain_text, ' ') FROM comment_threads ct JOIN comments c ON c.thread_id = ct.id WHERE ct.page_id = p.id AND c.deleted_at IS NULL), ''),
       COALESCE((SELECT group_concat(a.name, ' ') FROM attachments a WHERE a.page_id = p.id), '')
  FROM pages p
 WHERE p.import_job_id IS NULL AND p.is_template = 0
   AND NOT EXISTS (SELECT 1 FROM page_search_v2 search WHERE search.page_id = p.id);

-- One coalesced, resumable verification pass per existing workspace. The
-- scheduled recovery sweep starts these after deployment.
INSERT INTO jobs
  (id, workspace_id, type, status, requested_by, workflow_instance_id,
   progress_current, progress_total, progress_label, options_json, created_at, updated_at)
SELECT w.id || '-search-reindex-v2', w.id, 'search_reindex', 'queued', owner.user_id,
       w.id || '-search-reindex-v2', 0, 0, 'Waiting to start', '{}',
       unixepoch('subsec') * 1000, unixepoch('subsec') * 1000
  FROM workspaces w
  JOIN workspace_members owner ON owner.workspace_id = w.id AND owner.role = 'owner'
 WHERE owner.user_id = (
   SELECT MIN(member.user_id) FROM workspace_members member
    WHERE member.workspace_id = w.id AND member.role = 'owner'
 )
ON CONFLICT(id) DO NOTHING;
