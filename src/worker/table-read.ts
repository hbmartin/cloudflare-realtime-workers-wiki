import type { Env } from "./env";
import { HttpError } from "./http";
import { normalizeSearchValue } from "../shared/search-normalization";
import { TABLE_PAGE_DEFAULT, TABLE_PAGE_MAX, TABLE_SORT_MAX_OFFSET } from "../shared/table-limits";

// Sorting targets a caller-supplied column, so the value expression is chosen from
// this fixed map keyed by the column's declared type and is never interpolated from
// request input.
const SORT_VALUE_EXPRESSIONS: Record<string, string> = {
  text: "sort_cell.text_value",
  number: "sort_cell.number_value",
  checkbox: "sort_cell.boolean_value",
  date: "sort_cell.date_value",
  select: "(SELECT o.label FROM table_select_options o WHERE o.id = sort_cell.select_value)",
};

export type TableRowQuery = {
  sql: string;
  orderSql: string;
  binds: unknown[];
  limit: number;
  offset: number;
  sort: string | null;
  dir: "asc" | "desc";
};

// Builds the row query, which the cell read reuses as a derived table.
//
// Two paging modes, because they are not interchangeable. The default order is
// (position, id), backed by idx_table_rows_page, so a keyset cursor is exact, stays
// cheap at any depth, and is stable while rows are appended - that is the path an
// importer or an export loop walks. An arbitrary-column sort cannot be keyset-paged
// cheaply across five typed value columns, and its only caller is a human scrolling a
// sorted view, so it pages by offset with a hard depth cap instead.
export function buildTableRowQuery(
  pageId: string,
  columns: { id: string; type: string }[],
  query: Record<string, string | undefined>,
): TableRowQuery {
  const filter = normalizeSearchValue((query.q ?? "").slice(0, 200));
  const filterSql = `AND NOT EXISTS(SELECT 1 FROM table_row_pages link JOIN pages detail ON detail.id=link.page_id JOIN pages list ON list.id=r.page_id WHERE link.row_id=r.id AND list.is_task_list=1 AND detail.archived_at IS NOT NULL) AND (? = '' OR EXISTS(SELECT 1 FROM table_cells fc LEFT JOIN table_select_options fo ON fo.id=fc.select_value WHERE fc.row_id=r.id AND instr(coalesce(fc.text_search_value,fo.label_search_value,lower(coalesce(fc.text_value,CAST(fc.number_value AS TEXT),CASE WHEN fc.boolean_value IS NOT NULL THEN CASE WHEN fc.boolean_value=1 THEN 'true' ELSE 'false' END END,fc.date_value,fo.label,''))),?)>0))`;
  const limit = query.limit === undefined ? TABLE_PAGE_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > TABLE_PAGE_MAX) {
    throw new HttpError(422, "invalid_table_cursor", `limit must be an integer between 1 and ${TABLE_PAGE_MAX}.`);
  }
  const dir = query.dir ?? "asc";
  if (dir !== "asc" && dir !== "desc") {
    throw new HttpError(422, "invalid_table_sort", "dir must be asc or desc.");
  }
  const sortColumn = query.sort === undefined ? undefined : columns.find((column) => column.id === query.sort);
  if (query.sort !== undefined && !sortColumn) {
    throw new HttpError(422, "invalid_table_sort", "The sort column does not belong to this table.");
  }

  const afterId = query.afterId;
  const afterPosition = query.afterPosition === undefined ? null : Number(query.afterPosition);
  if ((query.afterPosition === undefined) !== (afterId === undefined)) {
    throw new HttpError(422, "invalid_table_cursor", "The table page cursor is incomplete.");
  }
  if (afterPosition !== null && !Number.isInteger(afterPosition)) {
    throw new HttpError(422, "invalid_table_cursor", "The table page cursor is invalid.");
  }
  if (afterId !== undefined && (!afterId || afterId.length > 100)) {
    throw new HttpError(422, "invalid_table_cursor", "The table page cursor is invalid.");
  }
  if (afterPosition !== null && sortColumn) {
    throw new HttpError(422, "invalid_table_cursor", "A sorted table page uses offset, not a cursor.");
  }

  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new HttpError(422, "invalid_table_cursor", "offset must be a non-negative integer.");
  }
  if (offset > 0 && !sortColumn) {
    throw new HttpError(422, "invalid_table_cursor", "offset is only valid together with sort.");
  }
  if (offset + limit > TABLE_SORT_MAX_OFFSET) {
    throw new HttpError(
      422,
      "invalid_table_cursor",
      `A sorted table page cannot reach beyond row ${TABLE_SORT_MAX_OFFSET}.`,
    );
  }

  if (!sortColumn) {
    return {
      sql: `SELECT r.id, r.position, 0 sort_null, NULL sort_value FROM table_rows r
             WHERE r.page_id = ? ${filterSql}
               AND (? IS NULL OR r.position > ? OR (r.position = ? AND r.id > ?))
             ORDER BY r.position, r.id LIMIT ? OFFSET ?`,
      binds: [pageId, filter, filter, afterPosition, afterPosition, afterPosition, afterId ?? null],
      orderSql: "page_rows.position, page_rows.id",
      limit,
      offset: 0,
      sort: null,
      dir,
    };
  }

  const value = SORT_VALUE_EXPRESSIONS[sortColumn.type];
  if (!value) throw new HttpError(422, "invalid_table_sort", "That column type cannot be sorted.");
  // Empty cells sort last in both directions: the NULL grouping deliberately does not
  // take the sort direction, so reversing a sort does not drag every blank to the top.
  return {
    sql: `SELECT r.id, r.position, CASE WHEN ${value} IS NULL THEN 1 ELSE 0 END sort_null,
                 ${value} sort_value FROM table_rows r
           LEFT JOIN table_cells sort_cell ON sort_cell.row_id = r.id AND sort_cell.column_id = ?
           WHERE r.page_id = ? ${filterSql}
           ORDER BY (CASE WHEN ${value} IS NULL THEN 1 ELSE 0 END), ${value} ${dir === "desc" ? "DESC" : "ASC"},
                    r.position, r.id
           LIMIT ? OFFSET ?`,
    binds: [sortColumn.id, pageId, filter, filter],
    orderSql: `page_rows.sort_null, page_rows.sort_value ${dir === "desc" ? "DESC" : "ASC"}, page_rows.position, page_rows.id`,
    limit,
    offset,
    sort: sortColumn.id,
    dir,
  };
}

export function tableRowBinds(query: TableRowQuery, limit: number) {
  return [...query.binds, limit, query.offset];
}

/**
 * Runs `read` between two revision reads of table_state and retries once when a
 * concurrent writer moved the table, so no caller can assemble a torn snapshot.
 * The fence lives in exactly one place; every table read route shares it.
 */
export async function stableTableSnapshot<T>(
  env: Env,
  pageId: string,
  wantsCount: boolean,
  read: () => Promise<T>,
): Promise<{ snapshot: T; revision: number; rowCount: number | null }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stateBefore = await env.DB.prepare(`SELECT revision FROM table_state WHERE page_id = ?`)
      .bind(pageId)
      .first<{ revision: number }>();
    const snapshot = await read();
    const stateAfter = await env.DB.prepare(
      `SELECT revision${wantsCount ? ", (SELECT COUNT(*) FROM table_rows WHERE page_id = ?) row_count" : ""}
         FROM table_state WHERE page_id = ?`,
    )
      .bind(...(wantsCount ? [pageId, pageId] : [pageId]))
      .first<{ revision: number; row_count?: number }>();
    if (stateBefore?.revision === stateAfter?.revision) {
      return {
        snapshot,
        revision: stateAfter?.revision ?? 1,
        rowCount: wantsCount ? Number(stateAfter?.row_count ?? 0) : null,
      };
    }
  }
  throw new HttpError(409, "table_snapshot_changed", "The table changed while this page was assembled. Retry it.");
}

/** Folds the joined row/cell statement back into one entry per row, in query order. */
export function collectRowCells(results: Record<string, unknown>[]) {
  const rows = new Map<
    string,
    {
      id: string;
      position: number;
      cells: Record<string, string | number | boolean | null>;
      detailPageId: string | null;
    }
  >();
  for (const item of results) {
    const rowId = String(item.row_id);
    const row = rows.get(rowId) ?? {
      id: rowId,
      position: Number(item.row_position),
      cells: {},
      detailPageId: typeof item.detail_page_id === "string" ? item.detail_page_id : null,
    };
    if (typeof item.column_id === "string") row.cells[item.column_id] = cellValue(item);
    rows.set(rowId, row);
  }
  return [...rows.values()];
}

function cellValue(cell: Record<string, unknown>) {
  if (cell.text_value !== null && cell.text_value !== undefined) return String(cell.text_value);
  if (cell.number_value !== null && cell.number_value !== undefined) return Number(cell.number_value);
  if (cell.boolean_value !== null && cell.boolean_value !== undefined) return Boolean(cell.boolean_value);
  if (cell.date_value !== null && cell.date_value !== undefined) return String(cell.date_value);
  if (cell.select_value !== null && cell.select_value !== undefined) return String(cell.select_value);
  return null;
}
