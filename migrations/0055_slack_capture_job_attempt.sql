-- A Slack form can be retried before its job exists, so its attempt counter
-- cannot be compared with the independent Activities job attempt counter.
ALTER TABLE slack_captures ADD COLUMN last_failed_job_attempt INTEGER NOT NULL DEFAULT 0;

UPDATE slack_captures SET last_failed_job_attempt=(
  SELECT attempt FROM jobs WHERE jobs.id=slack_captures.job_id
) WHERE state='failed' AND job_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id=slack_captures.job_id);
