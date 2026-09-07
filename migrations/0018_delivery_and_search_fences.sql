-- Keep historical migrations immutable. Rebuild the Slack work tables so this
-- upgrade works whether an installation applied the original 0016 or the briefly
-- published variant that already contained claimed_at. Claims are ephemeral and
-- intentionally reset during the rebuild.
ALTER TABLE jobs ADD COLUMN cleanup_token TEXT;
ALTER TABLE jobs ADD COLUMN cleanup_started_at INTEGER;
ALTER TABLE jobs ADD COLUMN cleanup_target TEXT CHECK (cleanup_target IN ('failed', 'canceled'));

ALTER TABLE slack_channel_events RENAME TO slack_channel_events_before_claim_tokens;

CREATE TABLE slack_channel_events (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES slack_channel_subscriptions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_id TEXT REFERENCES user(id),
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  thread_id TEXT REFERENCES comment_threads(id) ON DELETE CASCADE,
  cadence TEXT NOT NULL CHECK (cadence IN ('immediate', 'digest')),
  delivered_at INTEGER,
  claimed_at INTEGER,
  claim_token TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO slack_channel_events
  (id, subscription_id, workspace_id, event_type, actor_id, page_id, thread_id,
   cadence, delivered_at, created_at)
SELECT id, subscription_id, workspace_id, event_type, actor_id, page_id, thread_id,
       cadence, delivered_at, created_at
  FROM slack_channel_events_before_claim_tokens;

DROP TABLE slack_channel_events_before_claim_tokens;
CREATE INDEX idx_slack_channel_events_delivery
  ON slack_channel_events(cadence, delivered_at, created_at);

ALTER TABLE slack_unfurls RENAME TO slack_unfurls_before_claim_tokens;

CREATE TABLE slack_unfurls (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  unfurls_json TEXT NOT NULL,
  delivered_at INTEGER,
  claimed_at INTEGER,
  claim_token TEXT,
  created_at INTEGER NOT NULL,
  message_ts TEXT
);

INSERT INTO slack_unfurls
  (id, installation_id, workspace_id, user_id, channel_id, unfurls_json,
   delivered_at, created_at, message_ts)
SELECT id, installation_id, workspace_id, user_id, channel_id, unfurls_json,
       delivered_at, created_at, message_ts
  FROM slack_unfurls_before_claim_tokens;

DROP TABLE slack_unfurls_before_claim_tokens;

ALTER TABLE deliveries ADD COLUMN claim_token TEXT;

CREATE TABLE digest_delivery_cursors (
  channel TEXT PRIMARY KEY CHECK (channel IN ('email', 'slack')),
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  timezone TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Remove rows that were incorrectly introduced by the broad 0012 backfill.
DELETE FROM page_search_v2 WHERE page_id IN (
  SELECT id FROM pages WHERE import_job_id IS NOT NULL OR is_template = 1
);

-- The original rollout already indexed active pages. Fill its archived complement,
-- while retaining a guard for pages indexed by the running application.
INSERT INTO page_search_v2
  (page_id, workspace_id, space_id, title, tags, body, comments, attachments)
SELECT p.id, p.workspace_id, p.space_id, p.title,
       COALESCE((SELECT group_concat(t.name, ' ') FROM page_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.page_id = p.id), ''),
       COALESCE(p.plain_text, ''),
       COALESCE((SELECT group_concat(c.plain_text, ' ') FROM comment_threads ct JOIN comments c ON c.thread_id = ct.id WHERE ct.page_id = p.id AND c.deleted_at IS NULL), ''),
       COALESCE((SELECT group_concat(a.name, ' ') FROM attachments a WHERE a.page_id = p.id), '')
  FROM pages p
 WHERE p.import_job_id IS NULL AND p.is_template = 0 AND p.archived_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM page_search_v2 search WHERE search.page_id = p.id);

-- Use a new id so workspaces that completed 0015 still receive the corrected pass.
INSERT INTO jobs
  (id, workspace_id, type, status, requested_by, workflow_instance_id,
   progress_current, progress_total, progress_label, options_json, created_at, updated_at)
SELECT w.id || '-search-reindex-v2-followup', w.id, 'search_reindex', 'queued', owner.user_id,
       w.id || '-search-reindex-v2-followup', 0, 0, 'Waiting to start', '{}',
       unixepoch('subsec') * 1000, unixepoch('subsec') * 1000
  FROM workspaces w
  JOIN workspace_members owner ON owner.workspace_id = w.id AND owner.role = 'owner'
 WHERE owner.user_id = (
   SELECT MIN(member.user_id) FROM workspace_members member
    WHERE member.workspace_id = w.id AND member.role = 'owner'
 )
ON CONFLICT(id) DO NOTHING;

PRAGMA optimize;
