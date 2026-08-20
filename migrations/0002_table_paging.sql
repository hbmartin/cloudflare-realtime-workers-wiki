-- Sorting a table by one of its columns joins table_cells on column_id, which the
-- (row_id, column_id) primary key cannot serve: its leading column is row_id, so a
-- sort would scan every cell on the page. This index also speeds the cascade when a
-- column is deleted.
CREATE INDEX idx_table_cells_column ON table_cells(column_id, row_id);

PRAGMA optimize;
