-- Versioned computed values are a disposable projection of the Table authority.
-- Ownership remains local to this table; no relation/rollup storage is added.
CREATE TABLE table_computed_cells (
 row_id TEXT NOT NULL REFERENCES table_rows(id) ON DELETE CASCADE,
 column_id TEXT NOT NULL REFERENCES table_columns(id) ON DELETE CASCADE,
 value_json TEXT NOT NULL CHECK(json_valid(value_json)),
 source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 revision INTEGER NOT NULL,
 PRIMARY KEY(row_id,column_id)
);
CREATE INDEX idx_table_computed_column ON table_computed_cells(column_id,revision);
