import { describe, expect, it } from "vitest";
import type { ComputedValue } from "../shared/formula";
import type { CollaborativeColumn, CollaborativeRow } from "../shared/table-protocol";
import type { Env } from "./env";
import { compareTableProjection, compareTableProjectionContent, type TableSnapshot } from "./table-projection";

function fixture() {
  const columns: CollaborativeColumn[] = ["__proto__", "calc-1", "calc-2", "calc-3", "calc-4"].map((id, position) => ({
    id,
    name: id,
    type: "formula",
    position,
    revision: 1,
    generation: 1,
    options: [],
    config: { version: 1, source: "1", resultType: "number" },
  }));
  const rows: CollaborativeRow[] = Array.from({ length: 250 }, (_, position) => {
    const id = `row-${String(position).padStart(3, "0")}`;
    const computedCells = Object.fromEntries(
      columns.map((column): [string, ComputedValue] => [
        column.id,
        {
          version: 1,
          value: position,
          source: {
            version: 1,
            tableId: "table",
            tableRevision: 1,
            schemaRevision: 1,
            rowId: id,
            rowRevision: 1,
            dependencies: [],
          },
        },
      ]),
    );
    return {
      id,
      position,
      revision: 1,
      cells: {},
      cellRevisions: {},
      computedCells,
      detailPageId: null,
      createdAt: 1,
      createdBy: null,
      editedAt: 1,
      editedBy: null,
    };
  });
  let cacheRowReads = 0;
  const caches = rows.flatMap((row) =>
    Object.entries(row.computedCells!).map(([columnId, value]) => ({
      get row_id() {
        cacheRowReads++;
        return row.id;
      },
      column_id: columnId,
      value_json: JSON.stringify(value.value),
      source_json: JSON.stringify(value.source),
    })),
  );
  let projectedRevision = 1;
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          first: async () => ({ generation: 1, projected_revision: projectedRevision }),
          all: async () => {
            if (sql.startsWith("SELECT * FROM table_columns"))
              return {
                results: columns.map((column) => ({
                  id: column.id,
                  name: column.name,
                  type: column.type,
                  position: column.position,
                  property_revision: 1,
                  property_generation: 1,
                  config_json: JSON.stringify(column.config),
                })),
              };
            if (sql.startsWith("SELECT r.*"))
              return {
                results: rows
                  .filter((row) => binds.length < 2 || row.id > String(binds[1]))
                  .slice(0, 100)
                  .map((row) => ({
                    id: row.id,
                    position: row.position,
                    row_revision: 1,
                    detail_page_id: null,
                    created_at: 1,
                    created_by: null,
                    updated_at: 1,
                    updated_by: null,
                  })),
              };
            if (sql.startsWith("SELECT c.* FROM table_computed_cells")) return { results: caches };
            if (
              ["table_select_options", "table_cells", "table_views", "table_people"].some((table) =>
                sql.includes(table),
              )
            )
              return { results: [] };
            throw new Error(`Unexpected projection query: ${sql}`);
          },
        }),
      }),
    },
  } as unknown as Env;
  const canonical: TableSnapshot = { revision: 1, columns, rows, views: [], people: [] };
  return {
    env,
    canonical,
    caches,
    reads: () => cacheRowReads,
    unpublish: () => {
      projectedRevision = 0;
    },
  };
}

describe("table projection parity", () => {
  it("groups caches in linear work across row pages and preserves unusual property IDs", async () => {
    const f = fixture();
    const result = await compareTableProjectionContent(f.env, "table", f.canonical);
    expect(result.contentMatches).toBe(true);
    expect(f.reads()).toBeLessThanOrEqual(f.caches.length * 3);
    f.caches[0]!.value_json = JSON.stringify("different");
    expect((await compareTableProjectionContent(f.env, "table", f.canonical)).contentMatches).toBe(false);
  });

  it("keeps public verification strict when matching content has not been published", async () => {
    const f = fixture();
    f.unpublish();
    expect((await compareTableProjectionContent(f.env, "table", f.canonical)).contentMatches).toBe(true);
    const result = await compareTableProjection(f.env, "table", f.canonical, {
      revision: 1,
      projectedRevision: 0,
      generation: 1,
      rowCount: 250,
      hash: "canonical",
    });
    expect(result.projectionMatches).toBe(false);
    expect(result.consistent).toBe(false);
    expect(result).not.toHaveProperty("contentMatches");
  });
});
