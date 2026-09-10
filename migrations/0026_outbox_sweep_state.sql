-- Only one Worker isolate may sweep the delivery outbox at a time. The
-- continuation bit prevents unrelated producers from multiplying sweep jobs.
CREATE TABLE outbox_sweep_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  continuation_pending INTEGER NOT NULL DEFAULT 0 CHECK (continuation_pending IN (0, 1)),
  updated_at INTEGER NOT NULL
);

INSERT INTO outbox_sweep_state (id, updated_at) VALUES (1, 0);
