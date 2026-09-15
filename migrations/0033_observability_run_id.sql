-- Additive so the prior Worker can finish in-flight scheduled work.
ALTER TABLE observability_task_runs ADD COLUMN run_id TEXT;

-- Once a Worker-generated run ID owns the row, an older Worker must not
-- assign a numeric token and take ownership during the deployment handoff.
CREATE TRIGGER observability_legacy_start_fence
BEFORE UPDATE ON observability_task_runs
WHEN OLD.run_id IS NOT NULL
  AND NEW.run_id IS OLD.run_id
  AND NEW.execution_token IS NOT OLD.execution_token
BEGIN
  SELECT RAISE(IGNORE);
END;
