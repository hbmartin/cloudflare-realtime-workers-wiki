-- Move receipts only reconcile requests from a live browser operation. Index
-- their creation time so the hourly Worker cleanup can keep that recovery
-- window bounded without scanning receipts that are still current.
CREATE INDEX idx_page_move_receipts_created ON page_move_receipts(created_at);

PRAGMA optimize;
