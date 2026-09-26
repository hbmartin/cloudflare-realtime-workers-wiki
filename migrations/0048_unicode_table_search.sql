ALTER TABLE table_cells ADD COLUMN text_search_value TEXT;
ALTER TABLE table_select_options ADD COLUMN label_search_value TEXT;

CREATE INDEX idx_table_cells_text_search ON table_cells(text_search_value) WHERE text_search_value IS NOT NULL;
CREATE INDEX idx_table_options_label_search ON table_select_options(label_search_value) WHERE label_search_value IS NOT NULL;
