-- Preserve published import provenance and attach Notion row-page bodies to
-- table rows without exposing those backing pages in the ordinary sidebar.
CREATE TABLE page_import_sources (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  source_path TEXT NOT NULL,
  notion_id TEXT,
  source_group TEXT,
  parent_source_path TEXT,
  source_role TEXT NOT NULL DEFAULT 'page'
    CHECK (source_role IN ('page', 'table_row_detail', 'unmatched_table_page', 'generated_folder')),
  created_at INTEGER NOT NULL,
  UNIQUE (job_id, source_path)
);

CREATE INDEX idx_page_import_sources_job ON page_import_sources(job_id, source_path);
CREATE INDEX idx_page_import_sources_notion ON page_import_sources(notion_id);

CREATE TABLE table_row_pages (
  row_id TEXT PRIMARY KEY REFERENCES table_rows(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_table_row_pages_page ON table_row_pages(page_id);
