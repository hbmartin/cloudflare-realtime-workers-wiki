ALTER TABLE table_columns ADD COLUMN type_next TEXT NOT NULL DEFAULT 'text' CHECK(type_next IN ('text','number','checkbox','date','select','multi_select','person','url','status','created_time','created_by','last_edited_time','last_edited_by','formula'));
UPDATE table_columns SET type_next=type;
ALTER TABLE table_columns DROP COLUMN type;
ALTER TABLE table_columns RENAME COLUMN type_next TO type;
ALTER TABLE table_columns ADD COLUMN config_json TEXT;
ALTER TABLE table_columns ADD COLUMN property_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE table_columns ADD COLUMN property_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE table_columns ADD COLUMN name_key TEXT;
CREATE UNIQUE INDEX table_column_name_key ON table_columns(page_id,name_key) WHERE name_key IS NOT NULL;
ALTER TABLE table_rows ADD COLUMN updated_by TEXT REFERENCES user(id);
ALTER TABLE table_rows ADD COLUMN row_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE table_cells ADD COLUMN json_value TEXT;
ALTER TABLE table_cells ADD COLUMN cell_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE table_select_options ADD COLUMN color TEXT NOT NULL DEFAULT 'gray';
CREATE TABLE table_views (
 page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 owner_id TEXT REFERENCES user(id) ON DELETE CASCADE,
 value_json TEXT NOT NULL CHECK(json_valid(value_json)),
 PRIMARY KEY(page_id,id)
);
CREATE TABLE table_people (
 page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL,
 name TEXT NOT NULL,
 PRIMARY KEY(page_id,user_id)
);
CREATE TRIGGER table_people_authority_insert BEFORE INSERT ON table_people
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=NEW.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_people_authority_update BEFORE UPDATE ON table_people
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=OLD.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_people_authority_delete BEFORE DELETE ON table_people
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=OLD.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_views_authority_insert BEFORE INSERT ON table_views
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=NEW.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_views_authority_update BEFORE UPDATE ON table_views
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=OLD.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
CREATE TRIGGER table_views_authority_delete BEFORE DELETE ON table_views
WHEN EXISTS(SELECT 1 FROM table_authority a WHERE a.page_id=OLD.page_id AND a.state<>'d1'
 AND NOT EXISTS(SELECT 1 FROM table_projection_context c WHERE c.page_id=a.page_id AND c.generation=a.generation))
BEGIN SELECT RAISE(ABORT,'table_authority_required'); END;
