-- Migration 0055 may already have run. A failed receipt can point at a job
-- whose next attempt is queued or running; that attempt has not failed yet.
UPDATE slack_captures
   SET last_failed_job_attempt = (
     SELECT CASE WHEN jobs.status IN ('failed', 'canceled') THEN jobs.attempt
                 ELSE MAX(0, jobs.attempt - 1) END
       FROM jobs WHERE jobs.id = slack_captures.job_id
   )
 WHERE state = 'failed' AND job_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id = slack_captures.job_id);
