-- Retain the versioned JSON artifacts while indexing their protected identities.
CREATE INDEX idx_deletion_targets_table_plain ON deletion_targets(target,job_id) WHERE kind='table_do' AND substr(target,1,1)<>'{';
CREATE INDEX idx_deletion_targets_table_identity ON deletion_targets(json_extract(target,'$.pageId'),job_id)
 WHERE kind='table_do' AND json_valid(target);
CREATE INDEX idx_deletion_targets_row_identity ON deletion_targets(json_extract(target,'$.tableId'),json_extract(target,'$.generation'),job_id)
 WHERE kind='table_row' AND json_valid(target);
CREATE TABLE deletion_evidence_lookup (
 job_id TEXT NOT NULL REFERENCES deletion_jobs(id) ON DELETE CASCADE,
 table_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 generation INTEGER,
 detail_page_id TEXT NOT NULL,
 row_id TEXT,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('row','provenance')),
 PRIMARY KEY(job_id,table_id,detail_page_id),
 CHECK(generation IS NULL OR generation>0),
 CHECK((source_kind='row' AND row_id IS NOT NULL) OR (source_kind='provenance' AND row_id IS NULL))
);
CREATE INDEX idx_deletion_evidence_detail ON deletion_evidence_lookup(workspace_id,detail_page_id,job_id);

-- Incompatible accepted evidence cannot be omitted from the new protection index.
CREATE TABLE deletion_evidence_migration_guard (valid INTEGER NOT NULL CHECK(valid=1));
INSERT INTO deletion_evidence_migration_guard SELECT 0 FROM deletion_targets target JOIN deletion_jobs job ON job.id=target.job_id
 WHERE job.phase IN ('rows','cleanup') AND target.kind='table_do' AND json_valid(target.target)
 AND json_extract(target.target,'$.stage')='evidence' AND NOT COALESCE((json_extract(target.target,'$.version')=1 AND json_type(target.target,'$.pageId')='text'
 AND json_type(target.target,'$.workspaceId')='text' AND json_extract(target.target,'$.workspaceId')=job.workspace_id
 AND (json_type(target.target,'$.generation')='null' OR (json_type(target.target,'$.generation')='integer' AND json_extract(target.target,'$.generation')>0))
 AND json_type(target.target,'$.index')='integer' AND json_extract(target.target,'$.index')>=0
 AND json_type(target.target,'$.records')='array' AND json_type(target.target,'$.sealed') IN ('true','false')
 AND NOT EXISTS(SELECT 1 FROM json_each(target.target,'$.records') record WHERE
   record.type<>'object' OR json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.detailPageId') IS NOT 'text'
   OR json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind') IS NULL OR json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind') NOT IN ('row','provenance')
   OR (json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind')='row' AND json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId') IS NOT 'text')
   OR (json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind')='provenance' AND json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId') IS NOT NULL))),0);
CREATE VIEW deletion_evidence_records AS SELECT target.job_id, target.target source_target,
 json_extract(target.target,'$.pageId') table_id,json_extract(target.target,'$.workspaceId') workspace_id,
 json_extract(target.target,'$.generation') generation,json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.detailPageId') detail_page_id,
 json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId') row_id,json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind') source_kind
 FROM deletion_targets target JOIN deletion_jobs job ON job.id=target.job_id
 JOIN json_each(CASE WHEN json_valid(target.target) THEN target.target ELSE '{}' END,'$.records') record
 WHERE target.kind='table_do' AND json_valid(target.target) AND json_extract(target.target,'$.stage')='evidence'
 AND (json_extract(target.target,'$.version')=1 AND json_type(target.target,'$.pageId')='text'
 AND json_type(target.target,'$.workspaceId')='text' AND json_extract(target.target,'$.workspaceId')=job.workspace_id
 AND (json_type(target.target,'$.generation')='null' OR (json_type(target.target,'$.generation')='integer' AND json_extract(target.target,'$.generation')>0))
 AND json_type(target.target,'$.index')='integer' AND json_extract(target.target,'$.index')>=0
 AND json_type(target.target,'$.records')='array' AND json_type(target.target,'$.sealed') IN ('true','false')
)
 AND record.type='object' AND json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.detailPageId')='text'
 AND ((json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind')='row' AND json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId')='text')
  OR (json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind')='provenance' AND json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId') IS NULL));
INSERT INTO deletion_evidence_migration_guard SELECT 0 FROM deletion_targets target JOIN deletion_jobs job ON job.id=target.job_id
 WHERE job.phase IN ('rows','cleanup') AND target.kind='table_do' AND json_valid(target.target)
 AND json_extract(target.target,'$.stage')='evidence'
 GROUP BY target.job_id,json_extract(target.target,'$.pageId')
 HAVING count(DISTINCT json_array(json_extract(target.target,'$.workspaceId'),json_extract(target.target,'$.generation')))>1;
INSERT INTO deletion_evidence_migration_guard SELECT 0 FROM deletion_targets evidence JOIN deletion_jobs job ON job.id=evidence.job_id
 JOIN deletion_targets captured ON captured.job_id=evidence.job_id AND captured.kind='table_do' AND json_valid(captured.target)
 AND json_extract(captured.target,'$.stage') IN ('stop','purge')
 AND json_extract(captured.target,'$.pageId')=json_extract(evidence.target,'$.pageId')
 WHERE job.phase IN ('rows','cleanup') AND evidence.kind='table_do' AND json_valid(evidence.target)
 AND json_extract(evidence.target,'$.stage')='evidence'
 AND (json_extract(captured.target,'$.generation') IS NOT json_extract(evidence.target,'$.generation')
 OR json_extract(captured.target,'$.workspaceId') IS NOT json_extract(evidence.target,'$.workspaceId'));
INSERT INTO deletion_evidence_migration_guard SELECT 0 FROM deletion_evidence_records
 GROUP BY job_id,table_id,detail_page_id
 HAVING count(DISTINCT json_array(workspace_id,generation,row_id,source_kind))>1;
DROP TABLE deletion_evidence_migration_guard;
INSERT INTO deletion_evidence_lookup SELECT DISTINCT job_id,table_id,workspace_id,generation,detail_page_id,row_id,source_kind
 FROM deletion_evidence_records;

CREATE TRIGGER deletion_evidence_activation BEFORE UPDATE OF phase ON deletion_jobs
 WHEN NEW.phase IN ('rows','cleanup') AND OLD.phase='staging'
 BEGIN
 SELECT RAISE(ABORT,'deletion_evidence_incompatible') WHERE EXISTS(
  SELECT 1 FROM deletion_targets target JOIN deletion_jobs job ON job.id=target.job_id
  WHERE target.job_id=NEW.id AND target.kind='table_do' AND json_valid(target.target)
   AND json_extract(target.target,'$.stage')='evidence' AND NOT COALESCE((json_extract(target.target,'$.version')=1 AND json_type(target.target,'$.pageId')='text'
 AND json_type(target.target,'$.workspaceId')='text' AND json_extract(target.target,'$.workspaceId')=job.workspace_id
 AND (json_type(target.target,'$.generation')='null' OR (json_type(target.target,'$.generation')='integer' AND json_extract(target.target,'$.generation')>0))
 AND json_type(target.target,'$.index')='integer' AND json_extract(target.target,'$.index')>=0
 AND json_type(target.target,'$.records')='array' AND json_type(target.target,'$.sealed') IN ('true','false')
 AND NOT EXISTS(SELECT 1 FROM json_each(target.target,'$.records') record WHERE
   record.type<>'object' OR json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.detailPageId') IS NOT 'text'
   OR json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind') IS NULL OR json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind') NOT IN ('row','provenance')
   OR (json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind')='row' AND json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId') IS NOT 'text')
   OR (json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind')='provenance' AND json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId') IS NOT NULL))),0));
 SELECT RAISE(ABORT,'deletion_evidence_incompatible') WHERE EXISTS(
  SELECT 1 FROM deletion_targets evidence JOIN deletion_targets captured ON captured.job_id=evidence.job_id
   AND captured.kind='table_do' AND json_valid(captured.target)
   AND json_extract(captured.target,'$.pageId')=json_extract(evidence.target,'$.pageId')
   AND json_extract(captured.target,'$.stage') IN ('evidence','stop','purge')
  WHERE evidence.job_id=NEW.id AND evidence.kind='table_do' AND json_valid(evidence.target)
   AND json_extract(evidence.target,'$.stage')='evidence'
   AND (json_extract(captured.target,'$.generation') IS NOT json_extract(evidence.target,'$.generation')
    OR json_extract(captured.target,'$.workspaceId') IS NOT json_extract(evidence.target,'$.workspaceId')));
 END;

CREATE TRIGGER deletion_evidence_validate_insert BEFORE INSERT ON deletion_targets
 WHEN NEW.kind='table_do' AND json_valid(NEW.target) AND json_extract(NEW.target,'$.stage')='evidence'
 BEGIN
 SELECT RAISE(ABORT,'deletion_evidence_incompatible') WHERE NOT COALESCE((json_extract(NEW.target,'$.version')=1 AND json_type(NEW.target,'$.pageId')='text'
 AND json_type(NEW.target,'$.workspaceId')='text' AND json_extract(NEW.target,'$.workspaceId')=(SELECT workspace_id FROM deletion_jobs WHERE id=NEW.job_id)
 AND (json_type(NEW.target,'$.generation')='null' OR (json_type(NEW.target,'$.generation')='integer' AND json_extract(NEW.target,'$.generation')>0))
 AND json_type(NEW.target,'$.index')='integer' AND json_extract(NEW.target,'$.index')>=0
 AND json_type(NEW.target,'$.records')='array' AND json_type(NEW.target,'$.sealed') IN ('true','false')
 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.target,'$.records') record WHERE
   record.type<>'object' OR json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.detailPageId') IS NOT 'text'
   OR json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind') IS NULL OR json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind') NOT IN ('row','provenance')
   OR (json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind')='row' AND json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId') IS NOT 'text')
   OR (json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind')='provenance' AND json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId') IS NOT NULL))),0);
 SELECT RAISE(ABORT,'deletion_evidence_incompatible') WHERE EXISTS(
  SELECT 1 FROM deletion_targets existing WHERE existing.job_id=NEW.job_id AND existing.kind='table_do' AND json_valid(existing.target)
  AND json_extract(existing.target,'$.pageId')=json_extract(NEW.target,'$.pageId')
  AND json_extract(existing.target,'$.stage') IN ('evidence','stop','purge')
  AND (json_extract(existing.target,'$.generation') IS NOT json_extract(NEW.target,'$.generation')
   OR json_extract(existing.target,'$.workspaceId') IS NOT json_extract(NEW.target,'$.workspaceId')));
 SELECT RAISE(ABORT,'deletion_evidence_conflict') WHERE EXISTS(
  SELECT 1 FROM json_each(NEW.target,'$.records') record CROSS JOIN deletion_evidence_lookup existing
   ON existing.job_id=NEW.job_id AND existing.table_id=json_extract(NEW.target,'$.pageId')
   AND existing.detail_page_id=json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.detailPageId')
  WHERE existing.workspace_id IS NOT json_extract(NEW.target,'$.workspaceId')
   OR existing.generation IS NOT json_extract(NEW.target,'$.generation')
   OR existing.row_id IS NOT json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId')
   OR existing.source_kind IS NOT json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind'));
 SELECT RAISE(ABORT,'deletion_evidence_conflict') WHERE EXISTS(
  SELECT 1 FROM json_each(NEW.target,'$.records') record GROUP BY json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.detailPageId')
  HAVING count(DISTINCT json_array(json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId'),json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind')))>1);
 END;

CREATE TRIGGER deletion_evidence_validate_update BEFORE UPDATE OF job_id,kind,target ON deletion_targets
 WHEN NEW.kind='table_do' AND json_valid(NEW.target) AND json_extract(NEW.target,'$.stage')='evidence'
 BEGIN
 SELECT RAISE(ABORT,'deletion_evidence_incompatible') WHERE NOT COALESCE((json_extract(NEW.target,'$.version')=1 AND json_type(NEW.target,'$.pageId')='text'
 AND json_type(NEW.target,'$.workspaceId')='text' AND json_extract(NEW.target,'$.workspaceId')=(SELECT workspace_id FROM deletion_jobs WHERE id=NEW.job_id)
 AND (json_type(NEW.target,'$.generation')='null' OR (json_type(NEW.target,'$.generation')='integer' AND json_extract(NEW.target,'$.generation')>0))
 AND json_type(NEW.target,'$.index')='integer' AND json_extract(NEW.target,'$.index')>=0
 AND json_type(NEW.target,'$.records')='array' AND json_type(NEW.target,'$.sealed') IN ('true','false')
 AND NOT EXISTS(SELECT 1 FROM json_each(NEW.target,'$.records') record WHERE
   record.type<>'object' OR json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.detailPageId') IS NOT 'text'
   OR json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind') IS NULL OR json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind') NOT IN ('row','provenance')
   OR (json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind')='row' AND json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId') IS NOT 'text')
   OR (json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind')='provenance' AND json_type(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId') IS NOT NULL))),0);
 SELECT RAISE(ABORT,'deletion_evidence_incompatible') WHERE EXISTS(
  SELECT 1 FROM deletion_targets existing WHERE existing.job_id=NEW.job_id AND existing.kind='table_do' AND json_valid(existing.target)
  AND json_extract(existing.target,'$.pageId')=json_extract(NEW.target,'$.pageId')
  AND json_extract(existing.target,'$.stage') IN ('evidence','stop','purge')
  AND (json_extract(existing.target,'$.generation') IS NOT json_extract(NEW.target,'$.generation')
   OR json_extract(existing.target,'$.workspaceId') IS NOT json_extract(NEW.target,'$.workspaceId')));
 SELECT RAISE(ABORT,'deletion_evidence_conflict') WHERE EXISTS(
  SELECT 1 FROM json_each(NEW.target,'$.records') record CROSS JOIN deletion_evidence_lookup existing
   ON existing.job_id=NEW.job_id AND existing.table_id=json_extract(NEW.target,'$.pageId')
   AND existing.detail_page_id=json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.detailPageId')
  WHERE existing.workspace_id IS NOT json_extract(NEW.target,'$.workspaceId')
   OR existing.generation IS NOT json_extract(NEW.target,'$.generation')
   OR existing.row_id IS NOT json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId')
   OR existing.source_kind IS NOT json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind'));
 SELECT RAISE(ABORT,'deletion_evidence_conflict') WHERE EXISTS(
  SELECT 1 FROM json_each(NEW.target,'$.records') record GROUP BY json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.detailPageId')
  HAVING count(DISTINCT json_array(json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.rowId'),json_extract(CASE WHEN record.type='object' THEN record.value ELSE json_object() END,'$.kind')))>1);
 END;

CREATE TRIGGER deletion_evidence_lookup_insert AFTER INSERT ON deletion_targets WHEN NEW.kind='table_do' AND json_valid(NEW.target) AND json_extract(NEW.target,'$.stage')='evidence' BEGIN
 INSERT OR IGNORE INTO deletion_evidence_lookup
  SELECT DISTINCT job_id,table_id,workspace_id,generation,detail_page_id,row_id,source_kind
  FROM deletion_evidence_records WHERE job_id=NEW.job_id AND source_target=NEW.target;
END;

CREATE TRIGGER deletion_evidence_lookup_update AFTER UPDATE OF job_id,kind,target ON deletion_targets WHEN (OLD.kind='table_do' AND json_valid(OLD.target) AND json_extract(OLD.target,'$.stage')='evidence') OR (NEW.kind='table_do' AND json_valid(NEW.target) AND json_extract(NEW.target,'$.stage')='evidence') BEGIN
 DELETE FROM deletion_evidence_lookup WHERE job_id=OLD.job_id
  AND OLD.kind='table_do' AND json_valid(OLD.target) AND json_extract(OLD.target,'$.stage')='evidence'
  AND table_id=json_extract(OLD.target,'$.pageId')
  AND detail_page_id IN(SELECT json_extract(value,'$.detailPageId') FROM json_each(OLD.target,'$.records'))
  AND detail_page_id NOT IN(SELECT detail_page_id FROM deletion_evidence_records
    WHERE job_id=OLD.job_id AND table_id=json_extract(OLD.target,'$.pageId'));
 INSERT OR IGNORE INTO deletion_evidence_lookup
  SELECT DISTINCT job_id,table_id,workspace_id,generation,detail_page_id,row_id,source_kind
  FROM deletion_evidence_records WHERE job_id=NEW.job_id AND source_target=NEW.target;
END;

CREATE TRIGGER deletion_evidence_lookup_delete AFTER DELETE ON deletion_targets WHEN OLD.kind='table_do' AND json_valid(OLD.target) AND json_extract(OLD.target,'$.stage')='evidence' BEGIN
 DELETE FROM deletion_evidence_lookup WHERE job_id=OLD.job_id
  AND OLD.kind='table_do' AND json_valid(OLD.target) AND json_extract(OLD.target,'$.stage')='evidence'
  AND table_id=json_extract(OLD.target,'$.pageId')
  AND detail_page_id IN(SELECT json_extract(value,'$.detailPageId') FROM json_each(OLD.target,'$.records'))
  AND detail_page_id NOT IN(SELECT detail_page_id FROM deletion_evidence_records
    WHERE job_id=OLD.job_id AND table_id=json_extract(OLD.target,'$.pageId'));
END;
