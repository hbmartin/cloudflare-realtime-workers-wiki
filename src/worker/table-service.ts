import type { Env, MemberContext } from "./env";
import { HttpError, type HttpErrorStatus } from "./http";
import { pageForMember, requirePageEditor } from "./page-access";
import { canonicalJson, sha256Hex } from "../shared/import-integrity";
import type { ColumnType } from "../shared/types";
import {
  normalizedColumnName,
  versionedPropertyConfig,
  metadataColumns,
  type CollaborativeColumn,
  type CollaborativeRow,
  type TableCommand,
  type TableCommandResult,
  type TableQueryResult,
  type TableView,
} from "../shared/table-protocol";
import { tableActorSignature, type TableActor, type ProjectionStatement } from "./table-authority";

type TableRegistry = {
  page_id: string;
  state: "d1" | "seeding" | "do" | "repairing";
  generation: number;
  seed_revision: number;
  seed_hash: string | null;
  projected_revision: number;
};
export async function tableRegistry(env: Env, pageId: string) {
  return env.DB.prepare("SELECT * FROM table_authority WHERE page_id=?").bind(pageId).first<TableRegistry>();
}
export async function collaborativeTable(env: Env, pageId: string) {
  const registry = await tableRegistry(env, pageId);
  return registry?.state === "do" || registry?.state === "repairing";
}
async function parse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const result = await response.json<{ error: { code: string; message: string } }>();
    throw new HttpError(response.status as HttpErrorStatus, result.error.code, result.error.message);
  }
  return response.json<T>();
}
export async function tableFetch(
  env: Env,
  member: MemberContext,
  pageId: string,
  path: string,
  method = "GET",
  body?: unknown,
  extras?: {
    authorization?: { sql: string; binds: unknown[] };
    effects?: ProjectionStatement[];
    effectsAfter?: ProjectionStatement[];
    detailPageId?: string;
    allowDeleteDetail?: boolean;
    cancelRowOnPublicationFailure?: string;
    taskMutation?: true;
  },
) {
  const page = await pageForMember(env, member, pageId);
  if (page.kind !== "table") throw new HttpError(422, "table_required", "Choose a table.");
  if (method !== "GET") requirePageEditor(page);
  const registry = await tableRegistry(env, pageId);
  if (!registry || !["do", "repairing"].includes(registry.state))
    throw new HttpError(409, "table_authority_required", "Enable collaboration for this table first.");
  if (method !== "GET" && registry.state === "repairing")
    throw new HttpError(503, "table_projection_repairing", "Table projection repair is running. Retry shortly.");
  const actor: TableActor = {
    pageId,
    workspaceId: member.workspace.id,
    userId: member.user.id,
    generation: registry.generation,
    expiresAt: Date.now() + 60_000,
    creation: { board: env.TABLE_BOARD_ENABLED === "true", calendar: env.TABLE_CALENDAR_ENABLED === "true" },
    ...extras,
  };
  return env.TABLE.getByName(pageId).fetch(
    new Request(`https://table.internal${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-table-actor": JSON.stringify(actor),
        "x-table-signature": await tableActorSignature(env.BETTER_AUTH_SECRET, actor),
        ...(path.startsWith("/socket") ? { Upgrade: "websocket" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
export async function tableCommand(
  env: Env,
  member: MemberContext,
  pageId: string,
  command: TableCommand,
  extras?: {
    authorization?: { sql: string; binds: unknown[] };
    effects?: ProjectionStatement[];
    effectsAfter?: ProjectionStatement[];
    detailPageId?: string;
    allowDeleteDetail?: boolean;
    cancelRowOnPublicationFailure?: string;
    taskMutation?: true;
  },
) {
  return parse<TableCommandResult>(await tableFetch(env, member, pageId, "/commands", "POST", command, extras));
}
export async function queryTable(env: Env, member: MemberContext, pageId: string, query = "") {
  const result = await parse<TableQueryResult>(
    await tableFetch(env, member, pageId, `/query${query ? `?${query}` : ""}`),
  );
  const page = await pageForMember(env, member, pageId);
  return { ...result, taskList: Boolean(page.is_task_list), canEdit: page.effective_role !== "viewer" };
}
export async function tableInternal<T>(env: Env, pageId: string, path: string, body?: unknown) {
  return parse<T>(
    await env.TABLE.getByName(pageId).fetch(
      new Request(`https://table.internal${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", "x-table-internal": env.BETTER_AUTH_SECRET },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );
}

async function projectionColumns(env: Env, pageId: string): Promise<CollaborativeColumn[]> {
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

/** Internal template snapshots bind every page to one revision; D1 is never read for migrated data. */
export async function tableTemplateSnapshot(env: Env, pageId: string): Promise<TableSnapshot> {
  const registry = await tableRegistry(env, pageId);
  if (registry && registry.state !== "d1" && registry.state !== "do" && registry.state !== "repairing")
    throw new HttpError(409, "table_seed_pending", "Resume table migration before cloning this table.");
  const migrated = registry && ["do", "repairing"].includes(registry.state);
  const revision = migrated
    ? null
    : ((
        await env.DB.prepare("SELECT revision FROM table_state WHERE page_id=?")
          .bind(pageId)
          .first<{ revision: number }>()
      )?.revision ?? 1);
  const snapshot: TableSnapshot = { revision: revision ?? 0, columns: [], views: [], rows: [] };
  snapshot.taskList = Boolean(
    (await env.DB.prepare("SELECT is_task_list FROM pages WHERE id=?").bind(pageId).first<{ is_task_list: number }>())
      ?.is_task_list,
  );
  let after: string | null = null;
  if (!migrated) {
    snapshot.columns = await projectionColumns(env, pageId);
    snapshot.views = (
      await env.DB.prepare("SELECT value_json FROM table_views WHERE page_id=? ORDER BY id")
        .bind(pageId)
        .all<{ value_json: string }>()
    ).results.map((view) => JSON.parse(view.value_json) as TableView);
    snapshot.people = (
      await env.DB.prepare("SELECT user_id id,name FROM table_people WHERE page_id=? ORDER BY user_id")
        .bind(pageId)
        .all<{ id: string; name: string }>()
    ).results;
  }
  do {
    if (migrated) {
      const params = new URLSearchParams();
      if (after) {
        params.set("after", after);
        params.set("revision", String(snapshot.revision));
      }
      const chunk = await tableInternal<TableSnapshot & { nextCursor: string | null }>(
        env,
        pageId,
        `/export?${params}`,
      );
      snapshot.revision = chunk.revision;
      snapshot.columns = chunk.columns;
      snapshot.views = chunk.views;
      snapshot.people = chunk.people ?? [];
      snapshot.rows.push(...chunk.rows);
      after = chunk.nextCursor;
    } else {
      const rows = await projectionRows(env, pageId, after);
      snapshot.rows.push(...rows);
      after = rows.length === 100 ? rows.at(-1)!.id : null;
    }
    if (snapshot.rows.length > 20000)
      throw new HttpError(422, "table_limit", "This table exceeds the template row limit.");
  } while (after);
  if (!migrated) {
    const current = await env.DB.prepare("SELECT revision FROM table_state WHERE page_id=?")
      .bind(pageId)
      .first<{ revision: number }>();
    if (current?.revision !== snapshot.revision)
      throw new HttpError(
        409,
        "table_snapshot_changed",
        "The table changed while its template snapshot was captured. Retry.",
      );
  }
  return snapshot;
}
async function projectionRows(env: Env, pageId: string, after: string | null): Promise<CollaborativeRow[]> {
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

/** A generation fence rejects legacy writes while deterministic bounded seed batches resume. */
export async function enableTableAuthority(env: Env, member: MemberContext, pageId: string) {
  const page = await pageForMember(env, member, pageId);
  if (member.role !== "owner") throw new HttpError(403, "owner_required", "Only an owner can migrate a table.");
  requirePageEditor(page);
  if (page.kind !== "table") throw new HttpError(422, "table_required", "Choose a table.");
  let registry = await tableRegistry(env, pageId);
  if (registry && ["do", "repairing"].includes(registry.state)) return registry;
  const lease = await env.DB.prepare(
    "SELECT holder_user_id,holder_session_id FROM table_leases WHERE page_id=? AND expires_at>?",
  )
    .bind(pageId, Date.now())
    .first<{ holder_user_id: string; holder_session_id: string }>();
  if (lease && (lease.holder_user_id !== member.user.id || lease.holder_session_id !== member.session.id))
    throw new HttpError(409, "lease_conflict", "Release the active table lease before migrating.");
  if (lease)
    await env.DB.prepare("DELETE FROM table_leases WHERE page_id=? AND holder_user_id=? AND holder_session_id=?")
      .bind(pageId, member.user.id, member.session.id)
      .run();
  const state = await env.DB.prepare("SELECT revision FROM table_state WHERE page_id=?")
    .bind(pageId)
    .first<{ revision: number }>();
  if (!state) throw new HttpError(409, "table_state_missing", "Table state is missing.");
  await env.DB.prepare(
    `INSERT INTO table_authority(page_id,state,generation,seed_revision) VALUES(?,'seeding',1,?) ON CONFLICT(page_id) DO UPDATE SET state='seeding',seed_revision=excluded.seed_revision WHERE table_authority.state='d1'`,
  )
    .bind(pageId, state.revision)
    .run();
  registry = (await tableRegistry(env, pageId))!;
  const frozen = await env.DB.prepare("SELECT revision FROM table_state WHERE page_id=?")
    .bind(pageId)
    .first<{ revision: number }>();
  if (registry.state === "seeding" && registry.seed_revision !== frozen!.revision) {
    await env.DB.prepare("UPDATE table_authority SET seed_revision=? WHERE page_id=? AND state='seeding'")
      .bind(frozen!.revision, pageId)
      .run();
    registry = (await tableRegistry(env, pageId))!;
  }
  const columns = await projectionColumns(env, pageId);
  const views = (
    await env.DB.prepare("SELECT value_json FROM table_views WHERE page_id=? ORDER BY id")
      .bind(pageId)
      .all<{ value_json: string }>()
  ).results.map((row) => JSON.parse(row.value_json) as TableView);
  const people = (
    await env.DB.prepare("SELECT user_id id,name FROM table_people WHERE page_id=? ORDER BY user_id")
      .bind(pageId)
      .all<{ id: string; name: string }>()
  ).results;
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO table_projection_context VALUES(?,?)").bind(pageId, registry.generation),
    env.DB.prepare("UPDATE table_rows SET row_revision=? WHERE page_id=? AND row_revision<?").bind(
      registry.seed_revision,
      pageId,
      registry.seed_revision,
    ),
    env.DB.prepare("DELETE FROM table_projection_context WHERE page_id=?").bind(pageId),
  ]);
  const used = new Set<string>();
  const renames: ProjectionStatement[] = [];
  for (const column of columns) {
    let name = column.name;
    let suffix = 2;
    while (used.has(normalizedColumnName(name))) name = `${column.name.slice(0, 190)} (${suffix++})`;
    used.add(normalizedColumnName(name));
    if (name !== column.name) {
      column.name = name;
      renames.push({
        sql: "UPDATE table_columns SET name=?,property_revision=property_revision+1 WHERE id=?",
        binds: [name, column.id],
      });
      column.revision++;
    }
  }
  if (renames.length)
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO table_projection_context VALUES(?,?)").bind(pageId, registry.generation),
      ...renames.map((item) => env.DB.prepare(item.sql).bind(...item.binds)),
      env.DB.prepare("DELETE FROM table_projection_context WHERE page_id=?").bind(pageId),
    ]);
  await tableInternal(env, pageId, "/seed", {
    meta: {
      pageId,
      workspaceId: member.workspace.id,
      userId: member.user.id,
      generation: registry.generation,
      expiresAt: 0,
      revision: registry.seed_revision,
      projectedRevision: 0,
      seeded: false,
    },
    columns,
    views,
    people,
  });
  let cursor: string | null = null,
    hash = await sha256Hex(canonicalJson({ columns, views, people }));
  do {
    const rows = await projectionRows(env, pageId, cursor);
    for (const row of rows) hash = await sha256Hex(`${hash}:${canonicalJson(row)}`);
    if (rows.length) await tableInternal(env, pageId, "/seed-rows", { generation: registry.generation, rows });
    cursor = rows.length === 100 ? rows.at(-1)!.id : null;
  } while (cursor);
  const verified = await tableInternal<{ hash: string; revision: number }>(env, pageId, "/seed-finish", {});
  if (verified.hash !== hash || verified.revision !== registry.seed_revision)
    throw new HttpError(409, "table_seed_mismatch", "The table seed does not match D1. Legacy writes remain fenced.");
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE table_authority SET state='do',seed_hash=?,projected_hash=?,projected_revision=?,cutover_at=? WHERE page_id=? AND generation=? AND state='seeding'",
    ).bind(hash, hash, verified.revision, Date.now(), pageId, registry.generation),
    env.DB.prepare("DELETE FROM table_leases WHERE page_id=?").bind(pageId),
  ]);
  return (await tableRegistry(env, pageId))!;
}
export async function repairTableProjection(env: Env, member: MemberContext, pageId: string) {
  await pageForMember(env, member, pageId);
  if (member.role !== "owner") throw new HttpError(403, "owner_required", "Only an owner can repair a projection.");
  await env.DB.prepare("UPDATE table_authority SET state='repairing' WHERE page_id=? AND state='do'")
    .bind(pageId)
    .run();
  await tableInternal(env, pageId, "/repair", {});
  const result = await verifyTableProjection(env, pageId);
  if (!result.projectionMatches)
    throw new HttpError(
      503,
      "table_projection_mismatch",
      "Projection verification failed. The write fence remains active; retry repair.",
    );
  await env.DB.prepare("UPDATE table_authority SET state='do' WHERE page_id=? AND state='repairing'")
    .bind(pageId)
    .run();
  return result;
}

/** Compare the actual disposable projection, including typed values and computed source stamps. */
export async function verifyTableProjection(env: Env, pageId: string) {
  const canonical = await tableTemplateSnapshot(env, pageId);
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
  const current = await tableInternal<{
    revision: number;
    projectedRevision: number;
    generation: number;
    hash: string;
    rowCount: number;
  }>(env, pageId, "/verify");
  const registry = await tableRegistry(env, pageId);
  const consistent = current.revision === canonical.revision && registry?.projected_revision === canonical.revision;
  return {
    ...current,
    canonicalHash,
    projectionHash,
    projectionMatches: consistent && canonicalHash === projectionHash,
    consistent,
  };
}

/** Serialize trusted statement builders; this adapter never executes SQL. */
export function projectionStatementDatabase(): D1Database {
  return {
    prepare: (sql: string) => ({ sql, binds: [], bind: (...binds: (string | number | null)[]) => ({ sql, binds }) }),
  } as unknown as D1Database;
}
