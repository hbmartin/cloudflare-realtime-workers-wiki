-- A Slack form can be retried before its job exists, so its attempt counter
-- cannot be compared with the independent Activities job attempt counter.
ALTER TABLE slack_captures ADD COLUMN last_failed_job_attempt INTEGER NOT NULL DEFAULT 0;
