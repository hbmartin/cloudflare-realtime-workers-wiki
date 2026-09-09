-- Some databases may have recorded an earlier 0022 before this index was
-- included. Keep the forward repair safe for databases that already have it.
CREATE INDEX IF NOT EXISTS idx_comment_threads_page_block ON comment_threads(page_id, block_id);

-- Archive cascades need an operation identity distinct from their display
-- timestamp so same-millisecond nested archives remain independent.
ALTER TABLE pages ADD COLUMN archive_operation_id TEXT;
