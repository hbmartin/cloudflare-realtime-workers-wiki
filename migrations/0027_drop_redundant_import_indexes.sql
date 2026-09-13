-- These indexes duplicate the indexes created by the corresponding UNIQUE constraints.
DROP INDEX IF EXISTS idx_page_import_sources_job;
DROP INDEX IF EXISTS idx_table_row_pages_page;
