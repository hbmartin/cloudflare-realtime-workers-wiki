-- Trigram MATCH retrieves substrings, not edit distance. The Worker ORs trigrams
-- and ranks the bounded authorized candidate set by overlap.
CREATE VIRTUAL TABLE page_title_trigrams USING fts5(page_id UNINDEXED, normalized_title, tokenize='trigram');
CREATE TABLE page_title_normalization_queue(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE);
INSERT INTO page_title_normalization_queue SELECT id FROM pages;
INSERT INTO page_title_trigrams(page_id,normalized_title)
 SELECT id,lower(trim(title)) FROM pages WHERE import_job_id IS NULL AND is_template=0;
CREATE TRIGGER title_trigrams_insert AFTER INSERT ON pages WHEN NEW.import_job_id IS NULL AND NEW.is_template=0 BEGIN
 INSERT INTO page_title_trigrams(page_id,normalized_title) VALUES(NEW.id,lower(trim(NEW.title)));
 INSERT OR IGNORE INTO page_title_normalization_queue VALUES(NEW.id);
END;
CREATE TRIGGER title_trigrams_update AFTER UPDATE OF title,workspace_id,space_id,archived_at,import_job_id,is_template ON pages BEGIN
 DELETE FROM page_title_trigrams WHERE page_id=OLD.id;
 INSERT INTO page_title_trigrams(page_id,normalized_title)
 SELECT NEW.id,lower(trim(NEW.title)) WHERE NEW.import_job_id IS NULL AND NEW.is_template=0;
 INSERT OR IGNORE INTO page_title_normalization_queue VALUES(NEW.id);
END;
CREATE TRIGGER title_trigrams_delete AFTER DELETE ON pages BEGIN
 DELETE FROM page_title_trigrams WHERE page_id=OLD.id;
END;
