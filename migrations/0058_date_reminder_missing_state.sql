-- Preserve databases that already applied 0057 while allowing a temporarily
-- absent date token to keep its reminder until a cut-and-paste completes.
CREATE TABLE date_reminders_next (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  content_epoch INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token_revision TEXT NOT NULL,
  timezone TEXT NOT NULL,
  choice_json TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'claimed', 'delivered', 'missing', 'canceled')),
  claim_id TEXT,
  claimed_at INTEGER,
  delivery_receipt_id TEXT,
  checked_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (page_id, token_id, user_id)
);

INSERT INTO date_reminders_next
  (id,workspace_id,page_id,content_epoch,token_id,user_id,token_revision,timezone,choice_json,
   due_at,generation,state,claim_id,claimed_at,delivery_receipt_id,checked_at,created_at,updated_at)
SELECT id,workspace_id,page_id,content_epoch,token_id,user_id,token_revision,timezone,choice_json,
       due_at,generation,state,claim_id,claimed_at,delivery_receipt_id,checked_at,created_at,updated_at
  FROM date_reminders;

DROP TABLE date_reminders;
ALTER TABLE date_reminders_next RENAME TO date_reminders;
CREATE INDEX idx_date_reminders_due ON date_reminders(state, due_at, id);
CREATE INDEX idx_date_reminders_sweep ON date_reminders(state, checked_at, id);
CREATE INDEX idx_date_reminders_page ON date_reminders(page_id, state);
