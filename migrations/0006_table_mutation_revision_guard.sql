ALTER TABLE table_state ADD COLUMN mutation_guard TEXT;

-- A guarded mutation and its revision update run consecutively in one D1
-- batch. Abort the batch if the mutation immediately before the revision
-- update changed no rows, so a failed target write can never advance the
-- revision and a failed revision update can never commit a write on its own.
CREATE TRIGGER require_table_mutation_for_revision
BEFORE UPDATE OF revision, mutation_guard ON table_state
WHEN NEW.revision = OLD.revision + 1
  AND NEW.mutation_guard IS NOT OLD.mutation_guard
  AND changes() = 0
BEGIN
  SELECT RAISE(ABORT, 'table_mutation_not_applied');
END;
