-- Bind delayed capture work to the exact OAuth installation generation used
-- when the Slack interaction was verified.
ALTER TABLE slack_captures ADD COLUMN installation_generation INTEGER;
ALTER TABLE slack_captures ADD COLUMN body TEXT;
ALTER TABLE slack_captures ADD COLUMN task_fields_json TEXT;
