CREATE TABLE contributor_tracking (
 id INTEGER PRIMARY KEY CHECK(id=1), started_at INTEGER NOT NULL
);
INSERT INTO contributor_tracking VALUES(1,unixepoch('subsec')*1000);

CREATE TABLE page_contributors (
 page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL,
 first_edit_at INTEGER NOT NULL,
 last_edit_at INTEGER NOT NULL,
 PRIMARY KEY(page_id,user_id)
);
CREATE INDEX page_contributors_recent ON page_contributors(page_id,last_edit_at DESC,user_id);
CREATE TABLE page_version_contributors (
 version_id TEXT NOT NULL REFERENCES page_versions(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL,
 PRIMARY KEY(version_id,user_id)
);
ALTER TABLE page_change_checkpoints ADD COLUMN contributor_ids_json TEXT NOT NULL DEFAULT '[]';

-- Historical logs were compacted away; seed only identities supported by saved evidence.
INSERT INTO page_contributors(page_id,user_id,first_edit_at,last_edit_at)
 SELECT page_id,user_id,min(at),max(at) FROM (
  SELECT id page_id,created_by user_id,created_at at FROM pages
  UNION ALL SELECT id,updated_by,updated_at FROM pages WHERE updated_by IS NOT NULL
  UNION ALL SELECT page_id,last_editor_id,created_at FROM page_versions WHERE last_editor_id IS NOT NULL
 ) WHERE user_id IS NOT NULL AND user_id<>'' GROUP BY page_id,user_id;
INSERT INTO page_version_contributors(version_id,user_id)
 SELECT id,last_editor_id FROM page_versions WHERE last_editor_id IS NOT NULL AND last_editor_id<>'';

CREATE TRIGGER page_contributor_created AFTER INSERT ON pages
BEGIN
 INSERT OR IGNORE INTO page_contributors VALUES(NEW.id,NEW.created_by,NEW.created_at,NEW.created_at);
END;
