import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import { decodeTableResponse, tableReadPages } from "./table-transport";
import { pageForMember, requirePageEditor } from "./page-access";
import { canonicalJson, sha256Hex } from "../shared/import-integrity";
import {
  normalizedColumnName,
  type TableCommand,
  type TableCommandResult,
  type TableQueryResult,
  type TableView,
} from "../shared/table-protocol";
import {
  tableActorSignature,
  type TableActor,
  type ProjectionStatement,
  type TableRepairStatus,
} from "./table-authority";
import { acceptedPageDeletionSql } from "./deletion-policy";
import {
  projectionColumns,
  projectionRows,
  compareTableProjection,
  type TableSnapshot,
  type TableVerification,
} from "./table-projection";
export type { TableSnapshot } from "./table-projection";

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
  return decodeTableResponse<TableCommandResult>(
    await tableFetch(env, member, pageId, "/commands", "POST", command, extras),
  );
}
export async function queryTable(env: Env, member: MemberContext, pageId: string, query = "") {
  const result = await decodeTableResponse<TableQueryResult>(
    await tableFetch(env, member, pageId, `/query${query ? `?${query}` : ""}`),
  );
  const page = await pageForMember(env, member, pageId);
  return { ...result, taskList: Boolean(page.is_task_list), canEdit: page.effective_role !== "viewer" };
}
export async function tableInternal<T>(env: Env, pageId: string, path: string, body?: unknown) {
  return decodeTableResponse<T>(
    await env.TABLE.getByName(pageId).fetch(
      new Request(`https://table.internal${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", "x-table-internal": env.BETTER_AUTH_SECRET },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    ),
  );
}

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
  if (migrated) {
    for await (const chunk of tableReadPages((params) =>
      tableInternal<TableSnapshot & { nextCursor: string | null }>(env, pageId, `/export?${params}`),
    )) {
      snapshot.revision = chunk.revision;
      snapshot.columns = chunk.columns;
      snapshot.views = chunk.views;
      snapshot.people = chunk.people ?? [];
      snapshot.rows.push(...chunk.rows);
      if (snapshot.rows.length > 20000)
        throw new HttpError(422, "table_limit", "This table exceeds the template row limit.");
    }
  } else {
    do {
      const rows = await projectionRows(env, pageId, after);
      snapshot.rows.push(...rows);
      after = rows.length === 100 ? rows.at(-1)!.id : null;
      if (snapshot.rows.length > 20000)
        throw new HttpError(422, "table_limit", "This table exceeds the template row limit.");
    } while (after);
  }
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
/** A generation fence rejects legacy writes while deterministic bounded seed batches resume. */
export async function enableTableAuthority(env: Env, member: MemberContext, pageId: string) {
  const page = await pageForMember(env, member, pageId);
  if (member.role !== "owner") throw new HttpError(403, "owner_required", "Only an owner can migrate a table.");
  requirePageEditor(page);
  if (page.kind !== "table") throw new HttpError(422, "table_required", "Choose a table.");
  let registry = await tableRegistry(env, pageId);
  const seedBatch = async (statements: D1PreparedStatement[]) => {
    const expected = registry;
    try {
      return await env.DB.batch([
        env.DB.prepare(`INSERT OR REPLACE INTO table_publication_guards(page_id,ok)
          SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM pages WHERE id=? AND kind='table' AND workspace_id=? AND archived_at IS NULL AND import_job_id IS NULL)
            AND NOT ${acceptedPageDeletionSql("?", "?")}
            AND ${expected ? "EXISTS(SELECT 1 FROM table_authority WHERE page_id=? AND generation=? AND state=?)" : "NOT EXISTS(SELECT 1 FROM table_authority WHERE page_id=?)"}
            THEN 1 ELSE 0 END`).bind(
          pageId,
          pageId,
          member.workspace.id,
          pageId,
          member.workspace.id,
          pageId,
          ...(expected ? [expected.generation, expected.state] : []),
        ),
        ...statements,
        env.DB.prepare("DELETE FROM table_publication_guards WHERE page_id=?").bind(pageId),
      ]);
    } catch (error) {
      if (String(error).includes("table_publication_conflict")) {
        const deleting = await env.DB.prepare(`SELECT 1 WHERE ${acceptedPageDeletionSql("?", "?")}`)
          .bind(pageId, member.workspace.id)
          .first();
        if (deleting)
          throw new HttpError(409, "deletion_pending", "Permanent deletion has already been accepted for this table.");
        const source = await env.DB.prepare("SELECT workspace_id,kind,archived_at,import_job_id FROM pages WHERE id=?")
          .bind(pageId)
          .first<{ workspace_id: string; kind: string; archived_at: number | null; import_job_id: string | null }>();
        if (!source || source.workspace_id !== member.workspace.id)
          throw new HttpError(404, "page_not_found", "Page not found.");
        if (source.archived_at !== null)
          throw new HttpError(409, "page_archived", "Restore the table before enabling collaboration.");
        if (source.import_job_id !== null)
          throw new HttpError(409, "import_pending", "The table is still importing. Retry after import finishes.");
        if (source.kind !== "table") throw new HttpError(422, "table_required", "Choose a table.");
        throw new HttpError(
          409,
          "table_generation_conflict",
          "Table authority changed during seeding. Reload before retrying.",
        );
      }
      throw error;
    }
  };
  if (registry && ["do", "repairing"].includes(registry.state)) return registry;
  if (registry?.state !== "seeding") {
    const deleting = await env.DB.prepare(`SELECT 1 FROM table_rows row JOIN table_row_pages link ON link.row_id=row.id
      JOIN deletion_job_pages locked ON locked.page_id=link.page_id JOIN deletion_jobs job ON job.id=locked.job_id
      WHERE row.page_id=? AND job.phase='rows' LIMIT 1`)
      .bind(pageId)
      .first();
    if (deleting) throw new HttpError(409, "deletion_pending", "A task in this table is being permanently deleted.");
  }
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
  if (registry?.state !== "seeding") {
    const generation = registry?.generation ?? 1;
    try {
      await seedBatch([
        env.DB.prepare(
          `INSERT INTO table_authority(page_id,state,generation,seed_revision) VALUES(?,'seeding',1,?) ON CONFLICT(page_id) DO UPDATE SET state='seeding',seed_revision=excluded.seed_revision WHERE table_authority.state='d1'`,
        ).bind(pageId, state.revision),
      ]);
    } catch (error) {
      if (String(error).includes("deletion_pending"))
        throw new HttpError(409, "deletion_pending", "A task in this table is being permanently deleted.");
      throw error;
    }
    registry = await tableRegistry(env, pageId);
    if (!registry || registry.generation !== generation)
      throw new HttpError(
        409,
        "table_generation_conflict",
        "Table authority changed during seeding. Reload before retrying.",
      );
    if (["do", "repairing"].includes(registry.state)) return registry;
  }
  const frozen = await env.DB.prepare("SELECT revision FROM table_state WHERE page_id=?")
    .bind(pageId)
    .first<{ revision: number }>();
  if (registry.state === "seeding" && registry.seed_revision !== frozen!.revision) {
    await seedBatch([
      env.DB.prepare("UPDATE table_authority SET seed_revision=? WHERE page_id=? AND state='seeding'").bind(
        frozen!.revision,
        pageId,
      ),
    ]);
    registry = { ...registry, seed_revision: frozen!.revision };
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
  await seedBatch([
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
    await seedBatch([
      env.DB.prepare("INSERT OR REPLACE INTO table_projection_context VALUES(?,?)").bind(pageId, registry.generation),
      ...renames.map((item) => env.DB.prepare(item.sql).bind(...item.binds)),
      env.DB.prepare("DELETE FROM table_projection_context WHERE page_id=?").bind(pageId),
    ]);
  const seeded = await tableInternal<{ seeded: boolean }>(env, pageId, "/seed", {
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
    if (rows.length && !seeded.seeded)
      await tableInternal(env, pageId, "/seed-rows", { generation: registry.generation, rows });
    cursor = rows.length === 100 ? rows.at(-1)!.id : null;
  } while (cursor);
  const verified = await tableInternal<{ hash: string; revision: number }>(env, pageId, "/seed-finish", {});
  if (verified.hash !== hash || verified.revision !== registry.seed_revision)
    throw new HttpError(409, "table_seed_mismatch", "The table seed does not match D1. Legacy writes remain fenced.");
  await seedBatch([
    env.DB.prepare(
      "UPDATE table_authority SET state='do',seed_hash=?,projected_hash=?,projected_revision=?,cutover_at=? WHERE page_id=? AND generation=? AND state='seeding'",
    ).bind(hash, hash, verified.revision, Date.now(), pageId, registry.generation),
    env.DB.prepare("DELETE FROM table_leases WHERE page_id=?").bind(pageId),
  ]);
  return (await tableRegistry(env, pageId))!;
}
type TableRepairResult =
  | Awaited<ReturnType<typeof compareTableProjection>>
  | { repair: TableRepairStatus; verification: null };

export async function repairTableProjection(env: Env, member: MemberContext, pageId: string) {
  await pageForMember(env, member, pageId);
  if (member.role !== "owner") throw new HttpError(403, "owner_required", "Only an owner can repair a projection.");
  return tableInternal<TableRepairResult>(env, pageId, "/repair", {});
}

/** Poll durable progress without initiating repair or exporting canonical rows. */
export async function tableRepairStatus(env: Env, pageId: string) {
  const [registry, status] = await Promise.all([
    tableRegistry(env, pageId),
    tableInternal<TableRepairStatus>(env, pageId, "/repair-status"),
  ]);
  if (!registry || registry.generation !== status.generation)
    throw new HttpError(409, "table_generation_conflict", "Repair generation changed.");
  if (registry.state === "repairing" && status.state === "complete")
    return { ...status, state: "pending" as const, phase: "fence" as const };
  return status;
}

/** Compare the actual disposable projection, including typed values and computed source stamps. */
export async function verifyTableProjection(env: Env, pageId: string) {
  const canonical = await tableTemplateSnapshot(env, pageId);
  const current = await tableInternal<TableVerification>(env, pageId, "/verify");
  return compareTableProjection(env, pageId, canonical, current);
}

/** Serialize trusted statement builders; this adapter never executes SQL. */
export function projectionStatementDatabase(): D1Database {
  return {
    prepare: (sql: string) => ({ sql, binds: [], bind: (...binds: (string | number | null)[]) => ({ sql, binds }) }),
  } as unknown as D1Database;
}
