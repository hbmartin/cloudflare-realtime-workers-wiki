-- Only one Worker isolate may sweep the delivery outbox at a time. Producers
-- that encounter the lease request a rescan so the owner cannot miss new rows.
CREATE TABLE outbox_sweep_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  rescan_requested INTEGER NOT NULL DEFAULT 0 CHECK (rescan_requested IN (0, 1)),
  updated_at INTEGER NOT NULL
);

INSERT INTO outbox_sweep_state (id, updated_at) VALUES (1, 0);
