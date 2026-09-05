const SEARCH_COLUMNS = `(page_id, workspace_id, space_id, title, tags, body, comments, attachments)`;

const SEARCH_PROJECTION = `SELECT p.id, p.workspace_id, p.space_id, p.title,
    COALESCE((SELECT group_concat(t.name, ' ') FROM page_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.page_id = p.id), ''),
    COALESCE(p.plain_text, ''),
    COALESCE((SELECT group_concat(c.plain_text, ' ') FROM comment_threads ct JOIN comments c ON c.thread_id = ct.id WHERE ct.page_id = p.id AND c.deleted_at IS NULL), ''),
    COALESCE((SELECT group_concat(a.name, ' ') FROM attachments a WHERE a.page_id = p.id), '')
  FROM pages p`;

const SEARCHABLE_PAGE = `p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template = 0`;

export function refreshPageSearchV2Statements(database: D1Database, pageId: string, expectedContentEpoch?: number) {
  const epochGuard = expectedContentEpoch === undefined ? "" : ` AND p.content_epoch = ?`;
  const deleteStatement =
    expectedContentEpoch === undefined
      ? database.prepare(`DELETE FROM page_search_v2 WHERE page_id = ?`).bind(pageId)
      : database
          .prepare(
            `DELETE FROM page_search_v2 WHERE page_id = ?
              AND EXISTS (SELECT 1 FROM pages p WHERE p.id = ? AND p.content_epoch = ?)`,
          )
          .bind(pageId, pageId, expectedContentEpoch);
  const insertStatement = database
    .prepare(
      `INSERT INTO page_search_v2 ${SEARCH_COLUMNS}
       ${SEARCH_PROJECTION}
       WHERE p.id = ?${epochGuard} AND ${SEARCHABLE_PAGE}`,
    )
    .bind(pageId, ...(expectedContentEpoch === undefined ? [] : [expectedContentEpoch]));
  return [deleteStatement, insertStatement];
}

export function refreshPageSearchV2ForIdsStatements(database: D1Database, pageIds: readonly string[]) {
  const ids = JSON.stringify([...new Set(pageIds)]);
  return [
    database.prepare(`DELETE FROM page_search_v2 WHERE page_id IN (SELECT value FROM json_each(?))`).bind(ids),
    database
      .prepare(
        `INSERT INTO page_search_v2 ${SEARCH_COLUMNS}
         ${SEARCH_PROJECTION}
         WHERE p.id IN (SELECT value FROM json_each(?)) AND ${SEARCHABLE_PAGE}`,
      )
      .bind(ids),
  ];
}

export function refreshPageSearchV2SubtreeStatements(database: D1Database, rootPageId: string) {
  const subtree = `WITH RECURSIVE subtree(id) AS (
    SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree parent ON p.parent_id = parent.id
  ) SELECT id FROM subtree`;
  return [
    database.prepare(`DELETE FROM page_search_v2 WHERE page_id IN (${subtree})`).bind(rootPageId),
    database
      .prepare(
        `INSERT INTO page_search_v2 ${SEARCH_COLUMNS}
         ${SEARCH_PROJECTION}
         WHERE p.id IN (${subtree}) AND ${SEARCHABLE_PAGE}`,
      )
      .bind(rootPageId),
  ];
}
