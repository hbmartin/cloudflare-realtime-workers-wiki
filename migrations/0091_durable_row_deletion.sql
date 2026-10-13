-- Accept permanent deletion before changing canonical rows. Existing jobs already
-- removed their page metadata and continue directly with physical cleanup.
ALTER TABLE deletion_jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'cleanup'
 CHECK (phase IN ('staging','rows','cleanup'));
ALTER TABLE deletion_jobs ADD COLUMN actor_id TEXT;
CREATE TABLE deletion_job_pages (
 job_id TEXT NOT NULL REFERENCES deletion_jobs(id) ON DELETE CASCADE,
 page_id TEXT NOT NULL,
 archive_operation_id TEXT,
 archived_at INTEGER NOT NULL,
 PRIMARY KEY(job_id,page_id)
);
CREATE INDEX idx_deletion_job_pages_page ON deletion_job_pages(page_id,job_id);
CREATE TABLE deletion_targets_next (
 job_id TEXT NOT NULL REFERENCES deletion_jobs(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('document_do','table_do','table_row','r2_object','r2_prefix')),
 target TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, completed_at INTEGER, last_error TEXT,
 PRIMARY KEY(job_id,kind,target)
);
INSERT INTO deletion_targets_next SELECT * FROM deletion_targets;
DROP TABLE deletion_targets;
ALTER TABLE deletion_targets_next RENAME TO deletion_targets;
CREATE INDEX idx_deletion_targets_pending ON deletion_targets(job_id,completed_at);

-- Old queued restore effects must finish projection without restoring a page
-- whose permanent deletion has already been accepted.
CREATE TRIGGER pages_deletion_pending_restore BEFORE UPDATE OF archived_at ON pages
WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL AND EXISTS (
 SELECT 1 FROM deletion_job_pages lock JOIN deletion_jobs job ON job.id=lock.job_id
 WHERE lock.page_id=OLD.id AND job.phase='rows' AND job.workspace_id=OLD.workspace_id
 AND lock.archived_at IS OLD.archived_at AND lock.archive_operation_id IS OLD.archive_operation_id
)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER archive_disconnect_deletion_pending BEFORE DELETE ON archive_disconnect_targets
WHEN EXISTS (
 SELECT 1 FROM deletion_job_pages lock JOIN deletion_jobs job ON job.id=lock.job_id
 JOIN pages p ON p.id=lock.page_id
 WHERE lock.page_id=OLD.page_id AND job.phase='rows' AND job.workspace_id=p.workspace_id
 AND lock.archived_at IS p.archived_at AND lock.archive_operation_id IS p.archive_operation_id
)
BEGIN SELECT RAISE(IGNORE); END;
-- Keep the accepted subtree closed while cleanup targets are fixed.
CREATE TRIGGER pages_deletion_pending_insert BEFORE INSERT ON pages
WHEN EXISTS (
 SELECT 1 FROM deletion_job_pages lock JOIN deletion_jobs job ON job.id=lock.job_id
 WHERE lock.page_id=NEW.parent_id AND job.phase='rows'
 ) OR EXISTS (
 SELECT 1 FROM deletion_job_pages lock JOIN deletion_jobs job ON job.id=lock.job_id
 WHERE lock.page_id=NEW.id AND job.phase IN ('rows','cleanup')
)
BEGIN SELECT RAISE(ABORT,'deletion_pending'); END;
-- A legacy row cannot change authority halfway through accepted deletion.
CREATE TRIGGER table_authority_deletion_pending_insert BEFORE INSERT ON table_authority
WHEN NEW.state='seeding' AND EXISTS (
 SELECT 1 FROM table_rows row JOIN table_row_pages link ON link.row_id=row.id
 JOIN deletion_job_pages lock ON lock.page_id=link.page_id JOIN deletion_jobs job ON job.id=lock.job_id
 WHERE row.page_id=NEW.page_id AND job.phase='rows'
)
BEGIN SELECT RAISE(ABORT,'deletion_pending'); END;
CREATE TRIGGER table_authority_deletion_pending_seed BEFORE UPDATE OF state ON table_authority
WHEN NEW.state='seeding' AND OLD.state='d1' AND EXISTS (
 SELECT 1 FROM table_rows row JOIN table_row_pages link ON link.row_id=row.id
 JOIN deletion_job_pages lock ON lock.page_id=link.page_id JOIN deletion_jobs job ON job.id=lock.job_id
 WHERE row.page_id=NEW.page_id AND job.phase='rows'
)
BEGIN SELECT RAISE(ABORT,'deletion_pending'); END;
CREATE TRIGGER pages_deletion_pending_move BEFORE UPDATE OF parent_id,workspace_id,space_id ON pages
WHEN (OLD.parent_id IS NOT NEW.parent_id OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.space_id IS NOT NEW.space_id)
 AND EXISTS (
 SELECT 1 FROM deletion_job_pages lock JOIN deletion_jobs job ON job.id=lock.job_id
 WHERE lock.page_id IN (OLD.id,NEW.parent_id) AND job.phase='rows'
)
BEGIN SELECT RAISE(ABORT,'deletion_pending'); END;
