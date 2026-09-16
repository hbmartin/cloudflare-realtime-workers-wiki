-- Replace the deployment-handoff fence without editing an already-applied
-- migration. Keep this trigger until Workers predating run_id are retired.
DROP TRIGGER IF EXISTS observability_legacy_start_fence;

CREATE TRIGGER observability_legacy_start_fence
BEFORE UPDATE ON observability_task_runs
WHEN OLD.run_id IS NOT NULL
  AND NEW.run_id IS OLD.run_id
  AND (
    NEW.last_started_at > OLD.last_started_at
    OR NEW.execution_token IS NOT OLD.execution_token
  )
BEGIN
  SELECT RAISE(IGNORE);
END;
