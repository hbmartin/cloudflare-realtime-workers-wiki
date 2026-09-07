ALTER TABLE digest_delivery_cursors RENAME TO digest_delivery_cursors_by_channel;

CREATE TABLE digest_delivery_cursors (
  channel TEXT NOT NULL CHECK (channel IN ('email', 'slack')),
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  timezone TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel, timezone)
);

INSERT INTO digest_delivery_cursors (channel, user_id, workspace_id, timezone, updated_at)
SELECT channel, user_id, workspace_id, timezone, updated_at
  FROM digest_delivery_cursors_by_channel;

DROP TABLE digest_delivery_cursors_by_channel;
