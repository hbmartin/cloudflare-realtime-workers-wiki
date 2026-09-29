-- A cut/paste can briefly remove a stable date token between document saves.
-- Keep the first observed absence so a due scan never delivers during that gap.
ALTER TABLE date_reminders ADD COLUMN missing_since INTEGER;
CREATE INDEX idx_date_reminders_canceled_gc ON date_reminders(state, updated_at);
