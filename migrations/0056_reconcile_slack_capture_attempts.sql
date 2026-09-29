-- Migration 0055 may already have run. A failed receipt can point at a job
-- whose next attempt is queued or running. Timestamps change on installation
-- rebind and job progress, so they cannot identify which attempt failed. A
-- running attempt may itself have failed while it was processing the receipt;
-- preserve that attempt to avoid a duplicate failure notification.
UPDATE slack_captures
   SET last_failed_job_attempt = (
     SELECT CASE WHEN jobs.status = 'queued' THEN MAX(0, jobs.attempt - 1)
                 ELSE jobs.attempt END
       FROM jobs WHERE jobs.id = slack_captures.job_id
   )
 WHERE state = 'failed' AND job_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id = slack_captures.job_id);
