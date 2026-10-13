-- Retain table storage cleanup receipts independently of page metadata.
CREATE TABLE deletion_targets_next (
 job_id TEXT NOT NULL REFERENCES deletion_jobs(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('document_do','table_do','r2_object','r2_prefix')),
 target TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, completed_at INTEGER, last_error TEXT,
 PRIMARY KEY(job_id,kind,target)
);
INSERT INTO deletion_targets_next SELECT * FROM deletion_targets;
DROP TABLE deletion_targets;
ALTER TABLE deletion_targets_next RENAME TO deletion_targets;
CREATE INDEX idx_deletion_targets_pending ON deletion_targets(job_id,completed_at);
