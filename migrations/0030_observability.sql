CREATE TABLE observability_task_runs (
  task_name TEXT PRIMARY KEY,
  last_started_at INTEGER NOT NULL,
  last_succeeded_at INTEGER,
  last_failed_at INTEGER,
  last_duration_ms INTEGER,
  last_error TEXT
);

-- Nullable columns preserve compatibility with rows and in-flight messages
-- created before this migration. Consumers fall back to the durable row id.
ALTER TABLE jobs ADD COLUMN correlation_id TEXT;
ALTER TABLE outbox ADD COLUMN correlation_id TEXT;

-- Give a new deployment one cron interval plus grace before readiness reports a
-- missing heartbeat. Each row is replaced with a real result on the next tick.
INSERT INTO observability_task_runs (task_name, last_started_at, last_succeeded_at)
VALUES
  ('archive_disconnects', unixepoch() * 1000, unixepoch() * 1000),
  ('deletion_jobs', unixepoch() * 1000, unixepoch() * 1000),
  ('upload_reaps', unixepoch() * 1000, unixepoch() * 1000),
  ('page_move_receipts', unixepoch() * 1000, unixepoch() * 1000),
  ('queued_jobs', unixepoch() * 1000, unixepoch() * 1000),
  ('outbox', unixepoch() * 1000, unixepoch() * 1000),
  ('job_artifacts', unixepoch() * 1000, unixepoch() * 1000),
  ('notification_digests', unixepoch() * 1000, unixepoch() * 1000),
  ('slack_digests', unixepoch() * 1000, unixepoch() * 1000),
  ('slack_security_records', unixepoch() * 1000, unixepoch() * 1000),
  ('webhook_history', unixepoch() * 1000, unixepoch() * 1000),
  ('security_state', unixepoch() * 1000, unixepoch() * 1000);
