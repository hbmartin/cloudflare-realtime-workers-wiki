import type { Env } from "./env";
import { HttpError } from "./http";
import { canonicalJson, sha256Hex } from "../shared/import-integrity";
import type { ColumnType } from "../shared/types";
import {
  versionedPropertyConfig,
  metadataColumns,
  type CollaborativeColumn,
  type CollaborativeRow,
  type TableView,
} from "../shared/table-protocol";

export async function projectionColumns(env: Env, pageId: string): Promise<CollaborativeColumn[]> {
  const [columns, options] = await Promise.all([
    env.DB.prepare("SELECT * FROM table_columns WHERE page_id=? ORDER BY position,id").bind(pageId).all<{
      id: string;
      name: string;
      type: ColumnType;
      position: number;
      property_revision: number;
      property_generation: number;
      config_json: string | null;
    }>(),
    env.DB.prepare(
      "SELECT o.* FROM table_select_options o JOIN table_columns p ON p.id=o.column_id WHERE p.page_id=? ORDER BY o.position,o.id",
    )
      .bind(pageId)
      .all<{ id: string; column_id: string; label: string; position: number; color: string }>(),
  ]);
  return columns.results.map((column) => ({
    id: column.id,
    name: column.name,
    type: column.type,
    position: column.position,
    revision: column.property_revision,
    generation: column.property_generation,
    config: versionedPropertyConfig(column.config_json ? JSON.parse(column.config_json) : {}),
    options: options.results
      .filter((option) => option.column_id === column.id)
      .map((option) => ({ id: option.id, label: option.label, position: option.position, color: option.color })),
  }));
}

export type TableSnapshot = {
  revision: number;
  columns: CollaborativeColumn[];
  views: TableView[];
  rows: CollaborativeRow[];
  taskList?: boolean;
  people?: Array<{ id: string; name: string }>;
};

export async function projectionRows(env: Env, pageId: string, after: string | null): Promise<CollaborativeRow[]> {
  const rows = await env.DB.prepare(
    `SELECT r.*,detail.page_id detail_page_id FROM table_rows r LEFT JOIN table_row_pages detail ON detail.row_id=r.id WHERE r.page_id=? ${after ? "AND r.id>?" : ""} ORDER BY r.id LIMIT 100`,
  )
    .bind(pageId, ...(after ? [after] : []))
    .all<{
      id: string;
      position: number;
      created_at: number;
      created_by: string | null;
      updated_at: number;
      updated_by: string | null;
      row_revision: number;
      detail_page_id: string | null;
    }>();
  const cells = rows.results.length
    ? await env.DB.prepare(
        "SELECT * FROM table_cells WHERE row_id IN (SELECT value FROM json_each(?)) ORDER BY row_id,column_id",
      )
        .bind(JSON.stringify(rows.results.map((row) => row.id)))
        .all<{
          row_id: string;
          column_id: string;
          text_value: string | null;
          number_value: number | null;
          boolean_value: number | null;
          date_value: string | null;
          select_value: string | null;
          json_value: string | null;
          cell_revision: number;
        }>()
    : { results: [] };
  return rows.results.map((row) => {
    const values = cells.results.filter((cell) => cell.row_id === row.id);
    return {
      id: row.id,
      revision: row.row_revision,
      position: row.position,
      cells: Object.fromEntries(
        values.map((cell) => [
          cell.column_id,
          cell.json_value !== null
            ? JSON.parse(cell.json_value)
            : (cell.text_value ??
              cell.number_value ??
              (cell.boolean_value === null ? null : Boolean(cell.boolean_value)) ??
              cell.date_value ??
              cell.select_value ??
              null),
        ]),
      ),
      cellRevisions: Object.fromEntries(values.map((cell) => [cell.column_id, cell.cell_revision])),
      detailPageId: row.detail_page_id,
      createdAt: row.created_at,
      createdBy: row.created_by,
      editedAt: row.updated_at,
      editedBy: row.updated_by,
    };
  });
}

/** Compare the actual disposable projection, including typed values and computed source stamps. */
export type TableVerification = {
  revision: number;
  projectedRevision: number;
  generation: number;
  hash: string;
  rowCount: number;
};

export async function compareTableProjection(
  env: Env,
  pageId: string,
  canonical: TableSnapshot,
  current: TableVerification,
) {
  const projected: TableSnapshot = {
    revision: canonical.revision,
    columns: await projectionColumns(env, pageId),
    rows: [],
    views: (
      await env.DB.prepare("SELECT value_json FROM table_views WHERE page_id=? ORDER BY id")
        .bind(pageId)
        .all<{ value_json: string }>()
    ).results.map((view) => JSON.parse(view.value_json) as TableView),
    people: (
      await env.DB.prepare("SELECT user_id id,name FROM table_people WHERE page_id=? ORDER BY user_id")
        .bind(pageId)
        .all<{ id: string; name: string }>()
    ).results,
  };
  let after: string | null = null;
  do {
    const rows = await projectionRows(env, pageId, after);
    projected.rows.push(...rows);
    if (projected.rows.length > 20000)
      throw new HttpError(422, "table_limit", "This table exceeds the verification row limit.");
    after = rows.length === 100 ? rows.at(-1)!.id : null;
  } while (after);
  const caches = (
    await env.DB.prepare(
      "SELECT c.* FROM table_computed_cells c JOIN table_rows r ON r.id=c.row_id WHERE r.page_id=? ORDER BY c.row_id,c.column_id",
    )
      .bind(pageId)
      .all<{ row_id: string; column_id: string; value_json: string; source_json: string }>()
  ).results;
  for (const row of projected.rows)
    row.computedCells = Object.fromEntries(
      caches
        .filter((cache) => cache.row_id === row.id)
        .map((cache) => [
          cache.column_id,
          { version: 1 as const, value: JSON.parse(cache.value_json), source: JSON.parse(cache.source_json) },
        ]),
    );
  const hashSnapshot = async (snapshot: TableSnapshot) => {
    let hash = await sha256Hex(
      canonicalJson({
        columns: snapshot.columns.map(({ conversion: _conversion, ...column }) => column),
        views: snapshot.views,
        people: snapshot.people ?? [],
      }),
    );
    for (const row of snapshot.rows) {
      const value = { ...row, cells: { ...row.cells }, computedCells: row.computedCells ?? {} };
      for (const property of snapshot.columns) if (metadataColumns.has(property.type)) delete value.cells[property.id];
      hash = await sha256Hex(`${hash}:${canonicalJson(value)}`);
    }
    return hash;
  };
  const [canonicalHash, projectionHash] = await Promise.all([hashSnapshot(canonical), hashSnapshot(projected)]);
  const registry = await env.DB.prepare("SELECT generation,projected_revision FROM table_authority WHERE page_id=?")
    .bind(pageId)
    .first<{ generation: number; projected_revision: number }>();
  const consistent =
    current.revision === canonical.revision &&
    registry?.projected_revision === canonical.revision &&
    registry?.generation === current.generation;
  return {
    ...current,
    canonicalHash,
    projectionHash,
    projectionMatches: consistent && canonicalHash === projectionHash,
    consistent,
  };
}
