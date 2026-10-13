-- Preserve repaired Unicode titles while moving page identity lookups to a B-tree.
DROP TRIGGER title_trigrams_insert;
DROP TRIGGER title_trigrams_update;
DROP TRIGGER title_trigrams_delete;

CREATE TABLE page_title_titles (
 id INTEGER PRIMARY KEY,
 page_id TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
 normalized_title TEXT NOT NULL
);
INSERT INTO page_title_titles(page_id,normalized_title)
 SELECT f.page_id,f.normalized_title FROM page_title_trigrams f JOIN pages p ON p.id=f.page_id
 WHERE p.import_job_id IS NULL AND p.is_template=0;
INSERT INTO page_title_titles(page_id,normalized_title)
 SELECT p.id,lower(trim(p.title)) FROM pages p WHERE p.import_job_id IS NULL AND p.is_template=0
 AND NOT EXISTS(SELECT 1 FROM page_title_titles t WHERE t.page_id=p.id);

DROP TABLE page_title_trigrams;
CREATE VIRTUAL TABLE page_title_trigrams USING fts5(
 page_id UNINDEXED,normalized_title,content='page_title_titles',content_rowid='id',tokenize='trigram'
);
INSERT INTO page_title_trigrams(page_title_trigrams) VALUES('rebuild');

CREATE TRIGGER page_title_titles_insert AFTER INSERT ON page_title_titles BEGIN
 INSERT INTO page_title_trigrams(rowid,page_id,normalized_title) VALUES(NEW.id,NEW.page_id,NEW.normalized_title);
END;
CREATE TRIGGER page_title_titles_delete AFTER DELETE ON page_title_titles BEGIN
 INSERT INTO page_title_trigrams(page_title_trigrams,rowid,page_id,normalized_title)
 VALUES('delete',OLD.id,OLD.page_id,OLD.normalized_title);
END;
CREATE TRIGGER page_title_titles_update AFTER UPDATE ON page_title_titles BEGIN
 INSERT INTO page_title_trigrams(page_title_trigrams,rowid,page_id,normalized_title)
 VALUES('delete',OLD.id,OLD.page_id,OLD.normalized_title);
 INSERT INTO page_title_trigrams(rowid,page_id,normalized_title) VALUES(NEW.id,NEW.page_id,NEW.normalized_title);
END;

CREATE TRIGGER title_trigrams_insert AFTER INSERT ON pages WHEN NEW.import_job_id IS NULL AND NEW.is_template=0 BEGIN
 INSERT INTO page_title_titles(page_id,normalized_title) VALUES(NEW.id,lower(trim(NEW.title)));
 INSERT OR IGNORE INTO page_title_normalization_queue VALUES(NEW.id);
END;
CREATE TRIGGER title_trigrams_update AFTER UPDATE OF title,workspace_id,space_id,archived_at,import_job_id,is_template ON pages BEGIN
 DELETE FROM page_title_titles WHERE page_id=OLD.id;
 INSERT INTO page_title_titles(page_id,normalized_title)
 SELECT NEW.id,lower(trim(NEW.title)) WHERE NEW.import_job_id IS NULL AND NEW.is_template=0;
 INSERT OR IGNORE INTO page_title_normalization_queue VALUES(NEW.id);
END;
