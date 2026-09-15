-- Nullable so the prior Worker version can continue writing during rollout.
ALTER TABLE observability_task_runs ADD COLUMN execution_token INTEGER;
ALTER TABLE observability_task_runs ADD COLUMN first_observed_at INTEGER;

-- Existing never-successful tasks have no durable first-observation time. Fail
-- them immediately instead of granting another grace period at this deploy.
UPDATE observability_task_runs
SET execution_token = last_started_at,
    first_observed_at = CASE WHEN last_succeeded_at IS NULL THEN 0 ELSE last_started_at END;
