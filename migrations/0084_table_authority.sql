CREATE TABLE table_authority (
 page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
 state TEXT NOT NULL DEFAULT 'd1' CHECK(state IN ('d1','seeding','do','repairing')),
 generation INTEGER NOT NULL DEFAULT 1,
 seed_revision INTEGER NOT NULL DEFAULT 1,
 seed_hash TEXT,
 projected_revision INTEGER NOT NULL DEFAULT 0,
 projected_hash TEXT,
 cutover_at INTEGER
);
CREATE TABLE table_publication_guards (page_id TEXT PRIMARY KEY,ok INTEGER NOT NULL CONSTRAINT table_publication_conflict CHECK(ok=1));
CREATE TABLE table_projection_context (page_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
CREATE TRIGGER table_state_authority_insert BEFORE INSERT ON table_state
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=NEW.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_state_authority_update BEFORE UPDATE ON table_state
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=NEW.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_state_authority_delete BEFORE DELETE ON table_state
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=OLD.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_columns_authority_insert BEFORE INSERT ON table_columns
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=NEW.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_columns_authority_update BEFORE UPDATE ON table_columns
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=NEW.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_columns_authority_delete BEFORE DELETE ON table_columns
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=OLD.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_rows_authority_insert BEFORE INSERT ON table_rows
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=NEW.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_rows_authority_update BEFORE UPDATE ON table_rows
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=NEW.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_rows_authority_delete BEFORE DELETE ON table_rows
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=OLD.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_cells_authority_insert BEFORE INSERT ON table_cells
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=(SELECT page_id FROM table_rows WHERE id=NEW.row_id) AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_cells_authority_update BEFORE UPDATE ON table_cells
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=(SELECT page_id FROM table_rows WHERE id=NEW.row_id) AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_cells_authority_delete BEFORE DELETE ON table_cells
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=(SELECT page_id FROM table_rows WHERE id=OLD.row_id) AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_select_options_authority_insert BEFORE INSERT ON table_select_options
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=(SELECT page_id FROM table_columns WHERE id=NEW.column_id) AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_select_options_authority_update BEFORE UPDATE ON table_select_options
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=(SELECT page_id FROM table_columns WHERE id=NEW.column_id) AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_select_options_authority_delete BEFORE DELETE ON table_select_options
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=(SELECT page_id FROM table_columns WHERE id=OLD.column_id) AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;

-- Stable IDs are global in D1. Claims prevent concurrent migrated/legacy tables from sharing an ID.
CREATE TABLE table_id_claims(kind TEXT NOT NULL,id TEXT NOT NULL,page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,operation_id TEXT,PRIMARY KEY(kind,id));
INSERT INTO table_id_claims(kind,id,page_id) SELECT 'column',id,page_id FROM table_columns;
INSERT INTO table_id_claims(kind,id,page_id) SELECT 'row',id,page_id FROM table_rows;
INSERT INTO table_id_claims(kind,id,page_id) SELECT 'option',o.id,c.page_id FROM table_select_options o JOIN table_columns c ON c.id=o.column_id;
CREATE TRIGGER table_columns_id_scope BEFORE INSERT ON table_columns WHEN EXISTS(SELECT 1 FROM table_id_claims WHERE kind='column' AND id=NEW.id AND page_id<>NEW.page_id) BEGIN SELECT RAISE(ABORT,'table_id_collision'); END;
CREATE TRIGGER table_rows_id_scope BEFORE INSERT ON table_rows WHEN EXISTS(SELECT 1 FROM table_id_claims WHERE kind='row' AND id=NEW.id AND page_id<>NEW.page_id) BEGIN SELECT RAISE(ABORT,'table_id_collision'); END;
CREATE TRIGGER table_options_id_scope BEFORE INSERT ON table_select_options WHEN EXISTS(SELECT 1 FROM table_id_claims WHERE kind='option' AND id=NEW.id AND page_id<>(SELECT page_id FROM table_columns WHERE id=NEW.column_id)) BEGIN SELECT RAISE(ABORT,'table_id_collision'); END;
CREATE TRIGGER table_cells_scope_insert BEFORE INSERT ON table_cells WHEN (SELECT page_id FROM table_rows WHERE id=NEW.row_id)<>(SELECT page_id FROM table_columns WHERE id=NEW.column_id) BEGIN SELECT RAISE(ABORT,'table_cell_scope'); END;
CREATE TRIGGER table_cells_scope_update BEFORE UPDATE ON table_cells WHEN (SELECT page_id FROM table_rows WHERE id=NEW.row_id)<>(SELECT page_id FROM table_columns WHERE id=NEW.column_id) BEGIN SELECT RAISE(ABORT,'table_cell_scope'); END;
