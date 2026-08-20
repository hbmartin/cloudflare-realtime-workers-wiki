-- Durable import receipts and recoverable attachment completion.
--
-- Existing multipart sessions predate the state machine and are known to still be
-- uploadable, so the ALTER default deliberately adopts them as active. Hash columns
-- stay nullable for those legacy rows; every new API write supplies them.
ALTER TABLE attachment_uploads ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
  CHECK (state IN ('active', 'completing', 'r2_complete', 'committed', 'reaping', 'aborting'));
ALTER TABLE attachment_uploads ADD COLUMN request_hash TEXT;
ALTER TABLE attachment_uploads ADD COLUMN content_sha256 TEXT;

-- Completed attachments created before content hashing remain readable. A NULL hash
-- means "not recorded", never that the object's digest was the empty string.
ALTER TABLE attachments ADD COLUMN content_sha256 TEXT;

-- A durable receipt must be bound to the exact request it answered. Old receipts have
-- no request hash and therefore cannot safely prove that a reused client_request_id is
-- a replay rather than a different write. Clear them once, then retain all newly hashed
-- receipts for the lifetime of their table (the page cascade remains the cleanup).
ALTER TABLE table_bulk_writes ADD COLUMN request_hash TEXT;
DELETE FROM table_bulk_writes WHERE request_hash IS NULL;
DROP INDEX idx_table_bulk_writes_created;

-- Better Auth 1.7 keys accounts by issuer plus account id. The dependency update is
-- shipped with this forward migration, so existing credential rows receive the same
-- synthetic issuer Better Auth now generates for local providers.
ALTER TABLE account ADD COLUMN issuer TEXT NOT NULL DEFAULT '';
UPDATE account SET issuer = 'local:' || providerId WHERE issuer = '';
CREATE UNIQUE INDEX idx_account_issuer_account ON account(issuer, accountId);

DROP INDEX idx_attachment_uploads_due;
CREATE INDEX idx_attachment_uploads_due ON attachment_uploads(state, next_attempt_at, created_at);

PRAGMA optimize;
