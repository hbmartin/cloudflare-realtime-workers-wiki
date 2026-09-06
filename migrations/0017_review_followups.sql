-- Slack link previews must reference the message they belong to.
ALTER TABLE slack_unfurls ADD COLUMN message_ts TEXT;

-- Each retry of a staged import or template clone gets a fresh document epoch.
ALTER TABLE jobs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
