import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { ColumnType } from "../shared/types";
import { canonicalJson, sha256Hex } from "../shared/import-integrity";
import { TABLE_MAX_ROWS, TABLE_PAGE_MAX, TABLE_BULK_MAX_BODY_BYTES } from "../shared/table-limits";
import {
  TABLE_COLUMN_TYPES,
  TABLE_PROTOCOL_VERSION,
  metadataColumns,
  normalizedColumnName,
  tableFilterDefaults,
  validateTableValue,
  allowedCalculationKinds,
  versionedPropertyConfig,
  type CollaborativeColumn,
  type CollaborativeRow,
  type TableCommand,
  type TableCommandResult,
  type TableFilter,
  type TableQueryResult,
  type TableValue,
  type TableView,
} from "../shared/table-protocol";
import { normalizeSearchValue } from "../shared/search-normalization";
import {
  computeRowFormulas,
  calculateColumn,
  type CalculationKind,
  type CalculationResult,
} from "../shared/table-computed";
import type { ComputedValue } from "../shared/formula";
import { compileFormula, retypeFormulaProperties } from "../shared/formula";
import { broadcastWorkspaceEvent } from "./workspace-events";
import { calendarDay, moveCalendarDate, validateCalendarZone } from "../shared/table-calendar";
import { validateTaskTableCommand } from "../shared/task-table-policy";

export type ProjectionStatement = { sql: string; binds: (string | number | null)[] };
export type TableActor = {
  pageId: string;
  workspaceId: string;
  userId: string;
  generation: number;
  expiresAt: number;
  creation?: { board: boolean; calendar: boolean };
  authorization?: { sql: string; binds: unknown[] };
  effects?: ProjectionStatement[];
  effectsAfter?: ProjectionStatement[];
  detailPageId?: string;
  allowDeleteDetail?: boolean;
  cancelRowOnPublicationFailure?: string;
  taskMutation?: true;
  taskList?: boolean;
};
type Meta = TableActor & { revision: number; projectedRevision: number; seeded: boolean; schemaRevision?: number };
type StoredRow = {
  id: string;
  position: number;
  created_at: number;
  created_by: string | null;
  edited_at: number;
  edited_by: string | null;
  detail_page_id: string | null;
};
const fail = (message: string, status = 422, code = "table_validation") => {
  throw Object.assign(new Error(message), { status, code });
};
function id(value: unknown, name = "ID"): string {
  if (typeof value !== "string" || !/^[\w:-]{1,300}$/.test(value)) return fail(`${name} is invalid.`);
  return value;
}
function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200)
    return fail("Enter a name of up to 200 characters.");
  return value.trim();
}
function type(value: unknown): ColumnType {
  if (!TABLE_COLUMN_TYPES.includes(value as never)) return fail("Unknown property type.");
  return value as ColumnType;
}
function base64(value: unknown) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}
function unbase64(value: string) {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(value))));
  } catch {
    return fail("Invalid table cursor.");
  }
}
export async function tableActorSignature(secret: string, actor: TableActor) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonicalJson(actor))))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/** SQLite owns table ordering and receipts. D1 is rebuilt from durable projection events. */
export class TableAuthority extends DurableObject<Env> {
  private projecting: Promise<void> | null = null;
  private repairing = false;
  private purged = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS properties(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rows(id TEXT PRIMARY KEY,position REAL NOT NULL,created_at INTEGER NOT NULL,created_by TEXT,edited_at INTEGER NOT NULL,edited_by TEXT,detail_page_id TEXT);
      CREATE TABLE IF NOT EXISTS row_revisions(id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS rows_position ON rows(position,id);
      CREATE TABLE IF NOT EXISTS cells(row_id TEXT NOT NULL,column_id TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(row_id,column_id));
      CREATE INDEX IF NOT EXISTS cells_column ON cells(column_id,row_id);
      CREATE TABLE IF NOT EXISTS views(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversions(id TEXT PRIMARY KEY,column_id TEXT NOT NULL,type TEXT NOT NULL,revision INTEGER NOT NULL,failures INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS converted_cells(conversion_id TEXT NOT NULL,row_id TEXT NOT NULL,value TEXT NOT NULL,invalid INTEGER NOT NULL,source_revision INTEGER NOT NULL,PRIMARY KEY(conversion_id,row_id));
      CREATE TABLE IF NOT EXISTS receipts(actor_id TEXT NOT NULL,operation_id TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(actor_id,operation_id));
      CREATE TABLE IF NOT EXISTS computed(row_id TEXT NOT NULL,column_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(row_id,column_id));
      CREATE TABLE IF NOT EXISTS staged_computed(row_id TEXT NOT NULL,column_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(row_id,column_id));
      CREATE TABLE IF NOT EXISTS events(revision INTEGER PRIMARY KEY,operation_id TEXT NOT NULL,value TEXT NOT NULL,cancel_row_id TEXT,next_step INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS projection_steps(revision INTEGER NOT NULL,position INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(revision,position));`);
  }
  private rows<T>(sql: string, ...binds: (string | number | null)[]): T[] {
    return this.ctx.storage.sql.exec(sql, ...binds).toArray() as unknown as T[];
  }
  private meta(): Meta {
    const result = this.rows<{ value: string }>("SELECT value FROM meta WHERE id=1")[0];
    if (!result) return fail("Table has not been seeded.", 503, "table_not_seeded");
    return JSON.parse(result.value) as Meta;
  }
  private putMeta(meta: Meta) {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES(1,?)", JSON.stringify(meta));
  }
  private columns(): CollaborativeColumn[] {
    return this.rows<{ value: string }>("SELECT value FROM properties")
      .map((row) => {
        const column = JSON.parse(row.value) as CollaborativeColumn;
        return { ...column, config: versionedPropertyConfig(column.config) };
      })
      .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  private column(columnId: unknown): CollaborativeColumn {
    const value = this.rows<{ value: string }>("SELECT value FROM properties WHERE id=?", id(columnId))[0];
    if (!value) return fail("Property not found.", 404, "column_not_found");
    const column = JSON.parse(value.value) as CollaborativeColumn;
    return { ...column, config: versionedPropertyConfig(column.config) };
  }
  private row(rowId: unknown): StoredRow {
    const row = this.rows<StoredRow>("SELECT * FROM rows WHERE id=?", id(rowId))[0];
    if (!row) return fail("Row not found.", 404, "row_not_found");
    return row;
  }
  private views(actor: TableActor): TableView[] {
    return this.rows<{ value: string }>("SELECT value FROM views")
      .map((row) => JSON.parse(row.value) as TableView)
      .filter((view) => !view.ownerId || view.ownerId === actor.userId);
  }
  private view(viewId: unknown, actor: TableActor): TableView {
    const view = this.views(actor).find((item) => item.id === viewId);
    if (!view) return fail("View not found.", 404, "view_not_found");
    return view;
  }
  private rowValue(row: StoredRow): CollaborativeRow {
    const cells: Record<string, TableValue> = {},
      cellRevisions: Record<string, number> = {};
    for (const cell of this.rows<{ column_id: string; value: string; revision: number }>(
      "SELECT * FROM cells WHERE row_id=?",
      row.id,
    )) {
      cells[cell.column_id] = JSON.parse(cell.value) as TableValue;
      cellRevisions[cell.column_id] = cell.revision;
    }
    for (const column of this.columns())
      if (metadataColumns.has(column.type))
        cells[column.id] =
          column.type === "created_time"
            ? new Date(row.created_at).toISOString()
            : column.type === "created_by"
              ? row.created_by
              : column.type === "last_edited_time"
                ? new Date(row.edited_at).toISOString()
                : row.edited_by;
    return {
      id: row.id,
      revision: this.rowRevision(row.id),
      position: row.position,
      cells,
      cellRevisions,
      computedCells: Object.fromEntries(
        this.rows<{ column_id: string; value: string }>(
          "SELECT column_id,value FROM computed WHERE row_id=?",
          row.id,
        ).map((cell) => [cell.column_id, JSON.parse(cell.value) as ComputedValue]),
      ),
      detailPageId: row.detail_page_id,
      createdAt: row.created_at,
      createdBy: row.created_by,
      editedAt: row.edited_at,
      editedBy: row.edited_by,
    };
  }
  private rowRevision(rowId: string): number {
    return (
      this.rows<{ revision: number }>("SELECT revision FROM row_revisions WHERE id=?", rowId)[0]?.revision ??
      this.meta().revision
    );
  }
  private async authorize(request: Request, write: boolean): Promise<TableActor> {
    const raw = request.headers.get("x-table-actor"),
      signature = request.headers.get("x-table-signature");
    if (!raw || !signature) return fail("Missing table authorization.", 403, "table_forbidden");
    const actor = JSON.parse(raw) as TableActor;
    if (
      !actor ||
      actor.expiresAt < Date.now() ||
      actor.expiresAt > Date.now() + 90_000 ||
      signature !== (await tableActorSignature(this.env.BETTER_AUTH_SECRET, actor))
    )
      return fail("Expired table authorization.", 403, "table_forbidden");
    const page =
      await this.env.DB.prepare(`SELECT p.id,p.is_task_list,wm.role,s.visibility,sm.role space_role,a.state,a.generation FROM pages p JOIN spaces s ON s.id=p.space_id
      JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=? LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=wm.user_id
      JOIN table_authority a ON a.page_id=p.id WHERE p.id=? AND p.workspace_id=? AND p.kind='table' AND p.archived_at IS NULL AND p.import_job_id IS NULL ${actor.authorization ? `AND (${actor.authorization.sql})` : ""}`)
        .bind(actor.userId, actor.pageId, actor.workspaceId, ...(actor.authorization?.binds ?? []))
        .first<{
          is_task_list: number;
          role: string;
          visibility: string;
          space_role: string | null;
          generation: number;
          state: string;
        }>();
    if (
      !page ||
      page.generation !== actor.generation ||
      !["do", "repairing"].includes(page.state) ||
      (page.role !== "owner" && page.visibility !== "workspace" && !page.space_role)
    )
      return fail("Table is unavailable.", 403, "table_forbidden");
    if (write && (page.state === "repairing" || this.repairing))
      return fail("Projection repair is running. Retry shortly.", 503, "table_projection_repairing");
    if (write && (page.role === "viewer" || (page.role !== "owner" && page.space_role === "viewer")))
      return fail("This table is read-only.", 403, "read_only");
    return { ...actor, taskList: Boolean(page.is_task_list) };
  }
  // fallow-ignore-next-line unused-class-member -- Called by Cloudflare Durable Object runtime.
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (this.purged) return fail("This table was permanently deleted.", 410, "table_purged");
      if (["/seed", "/seed-rows", "/seed-finish", "/verify", "/repair", "/export", "/purge"].includes(path)) {
        if (request.headers.get("x-table-internal") !== this.env.BETTER_AUTH_SECRET)
          return fail("Forbidden.", 403, "table_forbidden");
        if (path === "/purge") {
          this.purged = true;
          for (const socket of this.ctx.getWebSockets()) socket.close(1008, "Table permanently deleted.");
          await this.ctx.storage.deleteAlarm();
          await this.ctx.storage.deleteAll();
          return Response.json({ ok: true });
        }
        if (path === "/seed") {
          const body = await request.json<{
            meta: Meta;
            columns: CollaborativeColumn[];
            views?: TableView[];
            people?: Array<{ id: string; name: string }>;
          }>();
          this.ctx.storage.transactionSync((): void => {
            const existing = this.rows<{ value: string }>("SELECT value FROM meta WHERE id=1")[0];
            if (existing) {
              const previous = JSON.parse(existing.value) as Meta;
              if (previous.generation !== body.meta.generation) return fail("Another table generation exists.", 409);
              return;
            }
            this.putMeta(body.meta);
            for (const column of body.columns)
              this.ctx.storage.sql.exec(
                "INSERT INTO properties VALUES(?,?)",
                column.id,
                JSON.stringify({ ...column, config: versionedPropertyConfig(column.config) }),
              );
            for (const view of body.views ?? [])
              this.ctx.storage.sql.exec("INSERT INTO views VALUES(?,?)", view.id, JSON.stringify(view));
            for (const person of body.people ?? [])
              this.ctx.storage.sql.exec("INSERT INTO people VALUES(?,?)", person.id, person.name);
          });
          return Response.json({ ok: true });
        }
        if (path === "/seed-rows") {
          const body = await request.json<{ generation: number; rows: CollaborativeRow[] }>();
          const meta = this.meta();
          if (body.generation !== meta.generation) return fail("Seed generation mismatch.", 409);
          if (body.rows.length > 100) return fail("Seed batch is too large.");
          this.ctx.storage.transactionSync(() => {
            for (const row of body.rows) {
              this.ctx.storage.sql.exec(
                "INSERT OR REPLACE INTO rows VALUES(?,?,?,?,?,?,?)",
                row.id,
                row.position,
                row.createdAt,
                row.createdBy,
                row.editedAt,
                row.editedBy,
                row.detailPageId,
              );
              this.ctx.storage.sql.exec(
                "INSERT OR REPLACE INTO row_revisions VALUES(?,?)",
                row.id,
                row.revision ?? meta.revision,
              );
              for (const [column, value] of Object.entries(row.cells))
                this.ctx.storage.sql.exec(
                  "INSERT OR REPLACE INTO cells VALUES(?,?,?,?)",
                  row.id,
                  column,
                  JSON.stringify(value),
                  row.cellRevisions[column] ?? 1,
                );
            }
          });
          return Response.json({ ok: true });
        }
        if (path === "/seed-finish") {
          const meta = this.meta();
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec("DELETE FROM computed");
            for (const row of this.rows<StoredRow>("SELECT * FROM rows ORDER BY id")) {
              const computed = computeRowFormulas({
                tableId: meta.pageId,
                tableRevision: meta.revision,
                schemaRevision: meta.schemaRevision ?? 0,
                rowId: row.id,
                rowRevision: this.rowRevision(row.id),
                cells: this.rowValue(row).cells,
                properties: this.columns(),
              });
              for (const [columnId, value] of Object.entries(computed))
                this.ctx.storage.sql.exec(
                  "INSERT INTO computed VALUES(?,?,?)",
                  row.id,
                  columnId,
                  JSON.stringify(value),
                );
            }
          });
          await this.repair(true);
          this.putMeta({ ...meta, seeded: true, projectedRevision: meta.revision });
          return Response.json(await this.verification());
        }
        if (path === "/verify") return Response.json(await this.verification());
        if (path === "/export") {
          const url = new URL(request.url);
          const cursor = url.searchParams.get("after");
          const revision = this.meta().revision;
          if (url.searchParams.has("revision") && Number(url.searchParams.get("revision")) !== revision)
            return fail("The table changed while its snapshot was captured. Retry.", 409, "table_snapshot_changed");
          const rows = this.rows<StoredRow>(
            `SELECT * FROM rows ${cursor ? "WHERE id>?" : ""} ORDER BY id LIMIT 100`,
            ...(cursor ? [cursor] : []),
          );
          return Response.json({
            columns: this.columns(),
            views: this.rows<{ value: string }>("SELECT value FROM views ORDER BY id").map(
              (view) => JSON.parse(view.value) as TableView,
            ),
            people: this.rows<{ id: string; name: string }>("SELECT * FROM people ORDER BY id"),
            revision,
            rows: rows.map((row) => this.rowValue(row)),
            nextCursor: rows.length === 100 ? rows.at(-1)!.id : null,
          });
        }
        await this.repair();
        return Response.json(await this.verification());
      }
      const actor = await this.authorize(request, path === "/commands");
      const meta = this.meta();
      if (meta.pageId !== actor.pageId || meta.generation !== actor.generation || !meta.seeded)
        return fail("Table generation is not active.", 503);
      if (path === "/commands") {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > TABLE_BULK_MAX_BODY_BYTES)
          return fail("Command exceeds the table body limit.");
        const command = JSON.parse(raw) as TableCommand;
        id(command.operationId, "Operation ID");
        if (!command.payload || typeof command.payload !== "object" || Array.isArray(command.payload))
          return fail("Invalid command payload.");
        if (actor.taskList && !actor.taskMutation) validateTaskTableCommand(actor.pageId, command);
        const hash = await sha256Hex(canonicalJson(command));
        const receipt = this.rows<{ hash: string }>(
          "SELECT hash FROM receipts WHERE actor_id=? AND operation_id=?",
          actor.userId,
          command.operationId,
        )[0];
        if (receipt && receipt.hash !== hash)
          return fail("That operation ID describes a different command.", 409, "idempotency_key_reused");
        if (!receipt) await this.validateReferences(actor, command);
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        await this.authorize(request, true);
        const result = this.ctx.storage.transactionSync(() => this.command(actor, command, hash));
        try {
          await this.project();
        } catch {
          if (!this.purged) await this.ctx.storage.setAlarm(Date.now() + 1000);
        }
        const committed = this.rows<{ result: string }>(
          "SELECT result FROM receipts WHERE actor_id=? AND operation_id=?",
          actor.userId,
          command.operationId,
        )[0];
        if (committed && (JSON.parse(committed.result) as TableCommandResult).result.publicationFailed)
          return fail(
            "The publication destination changed. The table row was cancelled.",
            409,
            "table_publication_conflict",
          );
        return Response.json({ ...result, projectionPending: this.meta().projectedRevision < result.revision });
      }
      if (path === "/query") {
        const result = { ...this.query(new URL(request.url), actor), people: await this.people(actor) };
        await this.authorize(request, false);
        return Response.json(result);
      }
      if (path === "/changes") {
        const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
        const events = this.rows<{ revision: number; operation_id: string }>(
          "SELECT revision,operation_id FROM events WHERE revision>? ORDER BY revision LIMIT 100",
          after,
        );
        return Response.json({
          revision: meta.revision,
          events,
          snapshotRequired: after < Math.max(0, meta.revision - 100),
        });
      }
      if (path === "/socket") {
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], [actor.userId]);
        pair[1].serializeAttachment(actor);
        pair[1].send(JSON.stringify({ type: "table-ready", revision: meta.revision }));
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      const failure = error as Error & { status?: number; code?: string };
      return Response.json(
        { error: { code: failure.code ?? "table_failed", message: failure.message } },
        { status: failure.status ?? 500 },
      );
    }
  }
  private async validateReferences(actor: TableActor, command: TableCommand): Promise<void> {
    const items =
      command.kind === "bulk" && Array.isArray(command.payload.commands)
        ? (command.payload.commands as Array<{ kind: string; payload: Record<string, unknown> }>)
        : [command];
    if (items.length > 2250) return fail("Too many bulk actions.");
    const columns = new Map(this.columns().map((column) => [column.id, column.type]));
    for (const item of items)
      if (item?.kind === "create_column" && typeof item.payload?.id === "string")
        columns.set(item.payload.id, item.payload.type as ColumnType);
    for (const item of items) {
      if (!item || !item.payload || typeof item.payload !== "object") return fail("Invalid command payload.");
      const kind =
        item.kind === "create_column"
          ? "column"
          : item.kind === "create_row"
            ? "row"
            : item.kind === "add_option"
              ? "option"
              : null;
      if (kind && item.payload.id) {
        const requested = id(item.payload.id),
          sql =
            kind === "column"
              ? "SELECT page_id FROM table_columns WHERE id=?"
              : kind === "row"
                ? "SELECT page_id FROM table_rows WHERE id=?"
                : "SELECT c.page_id FROM table_select_options o JOIN table_columns c ON c.id=o.column_id WHERE o.id=?";
        const existing = await this.env.DB.prepare(sql).bind(requested).first<{ page_id: string }>();
        if (existing && existing.page_id !== actor.pageId)
          return fail("That ID belongs to another table.", 409, "table_id_collision");
        await this.env.DB.prepare("INSERT OR IGNORE INTO table_id_claims(kind,id,page_id,operation_id) VALUES(?,?,?,?)")
          .bind(kind, requested, actor.pageId, command.operationId)
          .run();
        const claim = await this.env.DB.prepare(
          "SELECT page_id,operation_id FROM table_id_claims WHERE kind=? AND id=?",
        )
          .bind(kind, requested)
          .first<{ page_id: string; operation_id: string | null }>();
        if (claim?.page_id !== actor.pageId || (claim.operation_id !== command.operationId && !existing))
          return fail("That ID has already been used.", 409, "table_id_collision");
      }
      for (const [columnId, value] of Object.entries((item.payload.values as Record<string, unknown>) ?? {})) {
        if (columns.get(columnId) !== "person" || !Array.isArray(value)) continue;
        if (value.length > 100) return fail("Too many people.");
        const rows = await this.env.DB.prepare(
          `SELECT wm.user_id id,u.name FROM workspace_members wm JOIN user u ON u.id=wm.user_id JOIN pages p ON p.workspace_id=wm.workspace_id JOIN spaces s ON s.id=p.space_id LEFT JOIN space_members sm ON sm.user_id=wm.user_id AND sm.space_id=s.id WHERE p.id=? AND wm.user_id IN (SELECT value FROM json_each(?)) AND (wm.role='owner' OR s.visibility='workspace' OR sm.user_id IS NOT NULL)`,
        )
          .bind(actor.pageId, JSON.stringify(value))
          .all<{ id: string; name: string }>();
        const previous =
          item.kind === "update_cells" ? this.rowValue(this.row(item.payload.rowId)).cells[columnId] : null;
        if (
          value.some(
            (userId) =>
              !rows.results.some((row) => row.id === userId) && !(Array.isArray(previous) && previous.includes(userId)),
          )
        )
          return fail("A selected person no longer has access to this table.");
        for (const person of rows.results)
          this.ctx.storage.sql.exec("INSERT OR REPLACE INTO people VALUES(?,?)", person.id, person.name);
      }
    }
  }
  private async people(actor: TableActor) {
    const current = await this.env.DB.prepare(
      "SELECT u.id,u.name FROM user u JOIN workspace_members wm ON wm.user_id=u.id JOIN pages p ON p.workspace_id=wm.workspace_id JOIN spaces s ON s.id=p.space_id LEFT JOIN space_members sm ON sm.user_id=u.id AND sm.space_id=s.id WHERE p.id=? AND (wm.role='owner' OR s.visibility='workspace' OR sm.user_id IS NOT NULL) ORDER BY u.name,u.id",
    )
      .bind(actor.pageId)
      .all<{ id: string; name: string }>();
    const active = new Set(current.results.map((person) => person.id));
    return [
      ...current.results.map((person) => ({ ...person, active: true })),
      ...this.rows<{ id: string; name: string }>("SELECT * FROM people")
        .filter((person) => !active.has(person.id))
        .map((person) => ({ ...person, active: false })),
    ];
  }
  private columnProjection(column: CollaborativeColumn): ProjectionStatement[] {
    const pageId = this.meta().pageId;
    return [
      {
        sql: "INSERT INTO table_columns(id,page_id,name,type,position,config_json,property_revision,property_generation,name_key) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,position=excluded.position,config_json=excluded.config_json,property_revision=excluded.property_revision,property_generation=excluded.property_generation,name_key=excluded.name_key",
        binds: [
          column.id,
          pageId,
          column.name,
          column.type,
          column.position,
          JSON.stringify(column.config ?? {}),
          column.revision,
          column.generation ?? 1,
          normalizedColumnName(column.name),
        ],
      },
      ...column.options.map((option) => ({
        sql: "INSERT INTO table_select_options(id,column_id,label,label_search_value,position,color) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,label_search_value=excluded.label_search_value,position=excluded.position,color=excluded.color",
        binds: [
          option.id,
          column.id,
          option.label,
          normalizeSearchValue(option.label),
          option.position,
          option.color ?? "gray",
        ],
      })),
    ];
  }
  private viewProjection(view: TableView): ProjectionStatement {
    return {
      sql: "INSERT INTO table_views(page_id,id,owner_id,value_json) VALUES(?,?,?,?) ON CONFLICT(page_id,id) DO UPDATE SET owner_id=excluded.owner_id,value_json=excluded.value_json",
      binds: [this.meta().pageId, view.id, view.ownerId, JSON.stringify(view)],
    };
  }
  private computedProjection(rowId: string, revision: number): ProjectionStatement[] {
    return [
      { sql: "DELETE FROM table_computed_cells WHERE row_id=?", binds: [rowId] },
      ...this.rows<{ column_id: string; value: string }>(
        "SELECT column_id,value FROM computed WHERE row_id=?",
        rowId,
      ).map((cell) => {
        const computed = JSON.parse(cell.value) as ComputedValue;
        return {
          sql: "INSERT INTO table_computed_cells(row_id,column_id,value_json,source_json,revision) VALUES(?,?,?,?,?) ON CONFLICT(row_id,column_id) DO UPDATE SET value_json=excluded.value_json,source_json=excluded.source_json,revision=excluded.revision",
          binds: [rowId, cell.column_id, JSON.stringify(computed.value), JSON.stringify(computed.source), revision],
        };
      }),
    ];
  }
  private rowProjection(row: StoredRow): ProjectionStatement[] {
    return [
      {
        sql: "INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at,updated_by,row_revision) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,updated_at=excluded.updated_at,updated_by=excluded.updated_by,row_revision=excluded.row_revision",
        binds: [
          row.id,
          this.meta().pageId,
          row.position,
          row.created_by,
          row.created_at,
          row.edited_at,
          row.edited_by,
          this.rowRevision(row.id),
        ],
      },
      ...(row.detail_page_id
        ? [
            {
              sql: "INSERT INTO table_row_pages(row_id,page_id,created_at) VALUES(?,?,?) ON CONFLICT(row_id) DO NOTHING",
              binds: [row.id, row.detail_page_id, row.created_at],
            },
          ]
        : []),
    ];
  }
  private cellProjection(
    rowId: string,
    columnId: string,
    value: TableValue,
    revision: number,
    time: number,
  ): ProjectionStatement {
    const column = this.column(columnId);
    return {
      sql: "INSERT INTO table_cells(row_id,column_id,text_value,text_search_value,number_value,boolean_value,date_value,select_value,json_value,cell_revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(row_id,column_id) DO UPDATE SET text_value=excluded.text_value,text_search_value=excluded.text_search_value,number_value=excluded.number_value,boolean_value=excluded.boolean_value,date_value=excluded.date_value,select_value=excluded.select_value,json_value=excluded.json_value,cell_revision=excluded.cell_revision,updated_at=excluded.updated_at",
      binds: [
        rowId,
        columnId,
        ["text", "url"].includes(column.type) && typeof value === "string" ? value : null,
        ["text", "url"].includes(column.type) && typeof value === "string" ? normalizeSearchValue(value) : null,
        column.type === "number" && typeof value === "number" ? value : null,
        column.type === "checkbox" && typeof value === "boolean" ? Number(value) : null,
        column.type === "date" && typeof value === "string" ? value : null,
        ["select", "status"].includes(column.type) &&
        typeof value === "string" &&
        column.options.some((option) => option.id === value)
          ? value
          : null,
        JSON.stringify(value),
        revision,
        time,
      ],
    };
  }
  private command(
    actor: TableActor,
    command: TableCommand,
    hash: string,
    sub?: { revision: number; time: number; projection: ProjectionStatement[] },
  ): TableCommandResult {
    const receipt = this.rows<{ hash: string; result: string }>(
      "SELECT hash,result FROM receipts WHERE actor_id=? AND operation_id=?",
      actor.userId,
      command.operationId,
    )[0];
    if (receipt && !sub) {
      if (receipt.hash !== hash)
        return fail("That operation ID describes a different command.", 409, "idempotency_key_reused");
      return { ...(JSON.parse(receipt.result) as TableCommandResult), replayed: true };
    }
    const meta = this.meta();
    if (command.expectedRevision !== undefined && command.expectedRevision !== meta.revision)
      return fail(`Table changed. Current revision is ${meta.revision}.`, 409, "table_revision_conflict");
    const revision = sub?.revision ?? meta.revision + 1,
      time = sub?.time ?? Date.now(),
      p = command.payload,
      projection: ProjectionStatement[] = sub?.projection ?? [];
    const schemaChanged =
      !sub &&
      (["create_column", "update_column", "delete_column", "commit_type"].includes(command.kind) ||
        (command.kind === "bulk" &&
          Array.isArray(p.commands) &&
          p.commands.some((item) => item?.kind === "create_column")));
    const previousColumns = schemaChanged ? this.columns() : [];
    let result: Record<string, unknown> = {};
    const saveColumn = (column: CollaborativeColumn) => {
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO properties VALUES(?,?)", column.id, JSON.stringify(column));
      projection.push(...this.columnProjection(column));
    };
    const setCells = (
      rowId: string,
      values: Record<string, unknown>,
      expected?: Record<string, unknown>,
      creating = false,
    ): void => {
      const row = this.row(rowId);
      if (!values || typeof values !== "object" || Array.isArray(values)) return fail("Invalid cell values.");
      for (const [columnId, input] of Object.entries(values)) {
        const column = this.column(columnId);
        if (column.conversion && !creating)
          return fail("This property has a pending type conversion.", 409, "property_conversion_pending");
        const previous =
          this.rows<{ revision: number }>(
            "SELECT revision FROM cells WHERE row_id=? AND column_id=?",
            rowId,
            columnId,
          )[0]?.revision ?? 0;
        if (expected?.[columnId] !== undefined && expected[columnId] !== previous)
          return fail("This cell changed. Reload before retrying.", 409, "cell_revision_conflict");
        let value: TableValue;
        try {
          value = validateTableValue(column, input);
        } catch (error) {
          return fail(
            error instanceof Error ? error.message : "Invalid cell value.",
            422,
            (error as { code?: string }).code ?? "table_validation",
          );
        }
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO cells VALUES(?,?,?,?)",
          rowId,
          columnId,
          JSON.stringify(value),
          revision,
        );
        projection.push(this.cellProjection(rowId, columnId, value, revision, time));
      }
      this.ctx.storage.sql.exec("UPDATE rows SET edited_at=?,edited_by=? WHERE id=?", time, actor.userId, rowId);
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO row_revisions VALUES(?,?)", rowId, revision);
      projection.push(...this.rowProjection({ ...row, edited_at: time, edited_by: actor.userId }));
    };
    if (command.kind === "create_column") {
      const name = title(p.name),
        columnType = type(p.type);
      if (this.columns().length >= 50) return fail("This table has reached its property limit.");
      if (this.columns().some((column) => normalizedColumnName(column.name) === normalizedColumnName(name)))
        return fail("Property names must be unique.");
      const column: CollaborativeColumn = {
        id: typeof p.id === "string" ? id(p.id) : crypto.randomUUID(),
        name,
        type: columnType,
        position: this.columns().length,
        revision: 1,
        generation: 1,
        options: [],
        config: p.config as Record<string, unknown> | undefined,
      };
      if (this.rows("SELECT id FROM properties WHERE id=?", column.id).length)
        return fail("Property ID already exists.", 409);
      column.config = this.propertyConfig(column, p);
      saveColumn(column);
      result = { column };
    } else if (command.kind === "update_column") {
      const column = this.column(p.columnId);
      if (column.conversion) return fail("This property has a pending conversion.", 409, "property_conversion_pending");
      if (p.revision !== column.revision) return fail("Property changed.", 409);
      const name = p.name === undefined ? column.name : title(p.name);
      if (
        this.columns().some(
          (other) => other.id !== column.id && normalizedColumnName(other.name) === normalizedColumnName(name),
        )
      )
        return fail("Property names must be unique.");
      saveColumn({
        ...column,
        name,
        config: this.propertyConfig(column, p),
        revision: column.revision + 1,
      });
    } else if (command.kind === "delete_column") {
      const column = this.column(p.columnId);
      this.ctx.storage.sql.exec("DELETE FROM cells WHERE column_id=?", column.id);
      this.ctx.storage.sql.exec("DELETE FROM properties WHERE id=?", column.id);
      this.ctx.storage.sql.exec("DELETE FROM conversions WHERE column_id=?", column.id);
      if (column.conversion)
        this.ctx.storage.sql.exec("DELETE FROM converted_cells WHERE conversion_id=?", column.conversion.id);
      projection.push({ sql: "DELETE FROM table_columns WHERE id=? AND page_id=?", binds: [column.id, meta.pageId] });
      for (const view of this.rows<{ value: string }>("SELECT value FROM views").map(
        (row) => JSON.parse(row.value) as TableView,
      ))
        if (
          view.columnId === column.id ||
          view.sorts.some((sort) => sort.columnId === column.id) ||
          JSON.stringify(view.filters).includes(column.id) ||
          Object.hasOwn(view.calculations ?? {}, column.id)
        ) {
          this.ctx.storage.sql.exec(
            "UPDATE views SET value=? WHERE id=?",
            JSON.stringify({ ...view, invalid: true, revision: view.revision + 1 }),
            view.id,
          );
        }
    } else if (command.kind === "add_option") {
      const column = this.column(p.columnId);
      if (!["select", "status", "multi_select"].includes(column.type)) return fail("This is not an option property.");
      const option = {
        id: typeof p.id === "string" ? id(p.id) : crypto.randomUUID(),
        label: title(p.label),
        position: column.options.length,
        color: typeof p.color === "string" ? p.color : "gray",
      };
      if (this.columns().some((property) => property.options.some((existing) => existing.id === option.id)))
        return fail("Option ID has already been used.", 409, "table_id_collision");
      if (column.options.some((item) => item.label === option.label)) return fail("Option labels must be unique.");
      saveColumn({ ...column, revision: column.revision + 1, options: [...column.options, option] });
      result = { option };
    } else if (command.kind === "delete_option") {
      const column = this.column(p.columnId),
        optionId = id(p.optionId);
      if (!column.options.some((option) => option.id === optionId)) return fail("Option not found.", 404);
      saveColumn({
        ...column,
        revision: column.revision + 1,
        options: column.options.filter((option) => option.id !== optionId),
      });
      projection.push({
        sql: "DELETE FROM table_select_options WHERE id=? AND column_id=?",
        binds: [optionId, column.id],
      });
    } else if (command.kind === "create_row") {
      if (this.rows<{ count: number }>("SELECT count(*) count FROM rows")[0]!.count >= TABLE_MAX_ROWS)
        return fail("This table has reached its row limit.");
      const rowId = typeof p.id === "string" ? id(p.id) : crypto.randomUUID();
      if (this.rows("SELECT id FROM rows WHERE id=?", rowId).length) return fail("Row ID already exists.", 409);
      const position = this.rows<{ position: number }>("SELECT coalesce(max(position)+1,0) position FROM rows")[0]!
        .position;
      const row: StoredRow = {
        id: rowId,
        position,
        created_at: time,
        created_by: actor.userId,
        edited_at: time,
        edited_by: actor.userId,
        detail_page_id:
          typeof p.detailPageId === "string" && actor.detailPageId === p.detailPageId ? id(p.detailPageId) : null,
      };
      if (p.detailPageId && actor.detailPageId !== p.detailPageId)
        return fail("Row detail pages must be created through the page service.");
      this.ctx.storage.sql.exec(
        "INSERT INTO rows VALUES(?,?,?,?,?,?,?)",
        row.id,
        row.position,
        row.created_at,
        row.created_by,
        row.edited_at,
        row.edited_by,
        row.detail_page_id,
      );
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO row_revisions VALUES(?,?)", rowId, revision);
      projection.push(...this.rowProjection(row));
      let values = { ...(p.values as Record<string, unknown>) };
      if (p.viewId) {
        const view = this.view(p.viewId, actor);
        if (view.invalid) return fail("Repair this view before adding rows.");
        values = { ...tableFilterDefaults(view.filters, this.columns()), ...values };
        if (view.kind === "board" && view.columnId && Object.hasOwn(p, "groupId"))
          values[view.columnId] = p.groupId ?? null;
        if (view.kind === "calendar" && view.columnId && p.date !== undefined) values[view.columnId] = p.date;
      }
      setCells(rowId, values, undefined, true);
      for (const column of this.columns())
        if (column.conversion) {
          this.stageConversionRow(column, rowId);
          saveColumn({
            ...column,
            conversion: { ...column.conversion, ...this.conversionCounts(column.conversion.id) },
          });
        }
      result = { rowId, detailPageId: row.detail_page_id };
    } else if (command.kind === "update_cells") {
      setCells(
        id(p.rowId),
        p.values as Record<string, unknown>,
        p.expectedCellRevisions as Record<string, unknown> | undefined,
      );
      result = { rowId: p.rowId };
    } else if (command.kind === "delete_row") {
      const row = this.row(p.rowId);
      if (row.detail_page_id && !actor.allowDeleteDetail)
        return fail("Archive the row detail page before deleting its row.", 409, "row_detail_archive_required");
      this.ctx.storage.sql.exec("DELETE FROM computed WHERE row_id=?", row.id);
      this.ctx.storage.sql.exec("DELETE FROM cells WHERE row_id=?", row.id);
      this.ctx.storage.sql.exec("DELETE FROM rows WHERE id=?", row.id);
      this.ctx.storage.sql.exec("DELETE FROM row_revisions WHERE id=?", row.id);
      this.ctx.storage.sql.exec("DELETE FROM converted_cells WHERE row_id=?", row.id);
      for (const column of this.columns())
        if (column.conversion)
          saveColumn({
            ...column,
            conversion: { ...column.conversion, ...this.conversionCounts(column.conversion.id) },
          });
      projection.push({ sql: "DELETE FROM table_rows WHERE id=? AND page_id=?", binds: [row.id, meta.pageId] });
    } else if (command.kind === "save_view") {
      const viewId = typeof p.id === "string" ? id(p.id) : crypto.randomUUID(),
        previous = this.views(actor).find((view) => view.id === viewId);
      if (previous && p.revision !== previous.revision) return fail("View changed.", 409);
      if (!previous && this.rows<{ count: number }>("SELECT count(*) count FROM views")[0]!.count >= 100)
        return fail("This table has reached its saved-view limit.");
      if (this.rows("SELECT id FROM views WHERE id=?", viewId).length && !previous) return fail("View not found.", 404);
      const kind = p.kind ?? previous?.kind ?? "grid";
      if (!["grid", "board", "calendar"].includes(String(kind))) return fail("Unknown view kind.");
      if (
        previous?.kind !== kind &&
        ((kind === "board" && !(actor.creation?.board ?? this.env.TABLE_BOARD_ENABLED === "true")) ||
          (kind === "calendar" && !(actor.creation?.calendar ?? this.env.TABLE_CALENDAR_ENABLED === "true")))
      )
        return fail("This view layout is awaiting release acceptance.", 503, "table_view_creation_disabled");
      const columnId =
        p.columnId === undefined ? (previous?.columnId ?? null) : p.columnId === null ? null : id(p.columnId);
      if (kind !== "grid") {
        const column = this.column(columnId);
        if (kind === "board" && !["select", "status"].includes(column.type))
          return fail("Boards group by select or status.");
        if (kind === "calendar" && column.type !== "date") return fail("Calendars use a date property.");
      }
      const filters = (p.filters === undefined ? (previous?.filters ?? null) : p.filters) as TableFilter | null;
      this.filterSql(filters);
      const sorts = (p.sorts ?? previous?.sorts ?? []) as TableView["sorts"];
      if (!Array.isArray(sorts) || sorts.length > 10) return fail("Too many sort clauses.");
      for (const sort of sorts) {
        this.column(sort.columnId);
        if (!["asc", "desc"].includes(sort.direction)) return fail("Invalid sort.");
      }
      const visibleColumnIds = (p.visibleColumnIds ??
        previous?.visibleColumnIds ??
        this.columns().map((column) => column.id)) as string[];
      if (
        !Array.isArray(visibleColumnIds) ||
        visibleColumnIds.some(
          (value) => typeof value !== "string" || !this.columns().some((column) => column.id === value),
        )
      )
        return fail("Invalid visible properties.");
      const calculations = (p.calculations ?? previous?.calculations ?? {}) as Record<string, CalculationKind>;
      for (const [calculationColumnId, calculationKind] of Object.entries(calculations)) {
        const property = this.column(calculationColumnId);
        if (!allowedCalculationKinds(property).includes(calculationKind))
          return fail("This calculation is not supported by the property type.");
      }
      const view: TableView = {
        id: viewId,
        name: title(p.name ?? previous?.name),
        kind: kind as TableView["kind"],
        revision: (previous?.revision ?? 0) + 1,
        ownerId: p.personal === undefined ? (previous?.ownerId ?? null) : p.personal ? actor.userId : null,
        columnId,
        filters,
        sorts,
        visibleColumnIds,
        calculations,
      };
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO views VALUES(?,?)", view.id, JSON.stringify(view));
      result = { view };
    } else if (command.kind === "delete_view") {
      const view = this.view(p.viewId, actor);
      this.ctx.storage.sql.exec("DELETE FROM views WHERE id=?", view.id);
      projection.push({ sql: "DELETE FROM table_views WHERE page_id=? AND id=?", binds: [meta.pageId, view.id] });
    } else if (command.kind === "move_row") {
      const view = this.view(p.viewId, actor);
      if (view.invalid || !view.columnId || !["board", "calendar"].includes(view.kind))
        return fail("Repair this view before moving rows.");
      let value = view.kind === "board" ? (p.targetOptionId ?? null) : p.targetDate;
      if (view.kind === "calendar" && value !== null && typeof value !== "string") return fail("Choose a date.");
      if (view.kind === "calendar") {
        try {
          value = moveCalendarDate(
            this.rowValue(this.row(p.rowId)).cells[view.columnId],
            value,
            this.column(view.columnId).config?.timeZone as string | undefined,
            p.timeZone === undefined ? undefined : validateCalendarZone(p.timeZone),
          );
        } catch (error) {
          return fail(error instanceof Error ? error.message : "Invalid calendar move.");
        }
      }
      setCells(id(p.rowId), { [view.columnId]: value }, { [view.columnId]: p.expectedCellRevision });
      result = { rowId: p.rowId };
    } else if (command.kind === "prepare_type") {
      const column = this.column(p.columnId),
        nextType = type(p.type),
        conversionId = crypto.randomUUID();
      if (column.conversion) return fail("A conversion is already pending.", 409);
      if (column.type === "formula" || nextType === "formula")
        return fail("Formula configuration uses the formula editor.");
      if (p.revision !== column.revision) return fail("Property changed.", 409);
      const conversion = {
        id: conversionId,
        type: nextType,
        failures: 0,
        revision: meta.revision,
        generation: (column.generation ?? 1) + 1,
        schemaRevision: meta.schemaRevision ?? 0,
        converted: 0,
        empty: 0,
        total: 0,
      };
      const stagedColumn = { ...column, conversion };
      for (const row of this.rows<StoredRow>("SELECT * FROM rows ORDER BY id"))
        this.stageConversionRow(stagedColumn, row.id);
      Object.assign(conversion, this.conversionCounts(conversionId));
      this.ctx.storage.sql.exec(
        "INSERT INTO conversions VALUES(?,?,?,?,?)",
        conversionId,
        column.id,
        nextType,
        revision,
        conversion.failures,
      );
      saveColumn({ ...column, conversion, revision: column.revision + 1 });
      result = { conversion };
    } else if (command.kind === "cancel_type") {
      const column = this.column(p.columnId);
      if (!column.conversion || column.conversion.id !== p.conversionId) return fail("Conversion not found.", 404);
      this.ctx.storage.sql.exec("DELETE FROM converted_cells WHERE conversion_id=?", column.conversion.id);
      delete column.conversion;
      this.ctx.storage.sql.exec("DELETE FROM conversions WHERE column_id=?", column.id);
      saveColumn({ ...column, revision: column.revision + 1 });
    } else if (command.kind === "commit_type") {
      const column = this.column(p.columnId),
        conversion = column.conversion;
      if (!conversion || conversion.id !== p.conversionId) return fail("Conversion not found.", 404);
      if (conversion.schemaRevision !== (meta.schemaRevision ?? 0))
        return fail("The schema changed. Cancel and preview the conversion again.", 409, "conversion_schema_changed");
      if (conversion.failures && p.clearInvalid !== true)
        return fail("Confirm clearing values that cannot be converted.", 409);
      const next = {
        ...column,
        type: conversion.type,
        generation: conversion.generation,
        revision: column.revision + 1,
      };
      delete next.conversion;
      saveColumn(next);
      for (const cell of this.rows<{ row_id: string; value: string; source_revision: number }>(
        "SELECT row_id,value,source_revision FROM converted_cells WHERE conversion_id=?",
        conversion.id,
      )) {
        const source =
          this.rows<{ revision: number }>(
            "SELECT revision FROM cells WHERE row_id=? AND column_id=?",
            cell.row_id,
            column.id,
          )[0]?.revision ?? 0;
        if (source !== cell.source_revision)
          return fail("A source cell changed. Preview the conversion again.", 409, "conversion_source_changed");
        const value = JSON.parse(cell.value) as TableValue;
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO cells VALUES(?,?,?,?)",
          cell.row_id,
          column.id,
          JSON.stringify(value),
          revision,
        );
        this.ctx.storage.sql.exec(
          "UPDATE rows SET edited_at=?,edited_by=? WHERE id=?",
          time,
          actor.userId,
          cell.row_id,
        );
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO row_revisions VALUES(?,?)", cell.row_id, revision);
        projection.push(...this.rowProjection(this.row(cell.row_id)));
        projection.push(this.cellProjection(cell.row_id, column.id, value, revision, time));
      }
      this.ctx.storage.sql.exec("DELETE FROM converted_cells WHERE conversion_id=?", conversion.id);
      this.ctx.storage.sql.exec("DELETE FROM conversions WHERE column_id=?", column.id);
      for (const row of this.rows<{ id: string; value: string }>("SELECT id,value FROM views")) {
        const view = JSON.parse(row.value) as TableView;
        if (
          view.columnId === column.id ||
          view.sorts.some((sort) => sort.columnId === column.id) ||
          JSON.stringify(view.filters).includes(column.id) ||
          Object.hasOwn(view.calculations ?? {}, column.id)
        )
          this.ctx.storage.sql.exec(
            "UPDATE views SET value=? WHERE id=?",
            JSON.stringify({ ...view, invalid: true, revision: view.revision + 1 }),
            view.id,
          );
      }
    } else if (command.kind === "bulk") {
      const commands = p.commands;
      if (!Array.isArray(commands) || commands.length > 2250 || !commands.length) return fail("Invalid bulk command.");
      let rowCount = 0,
        cellCount = 0,
        columnCount = 0;
      for (const item of commands) {
        if (
          !item ||
          typeof item !== "object" ||
          !["create_row", "update_cells", "delete_row", "create_column", "add_option"].includes(item.kind)
        )
          return fail("Unsupported bulk action.");
        if (item.kind === "create_row") rowCount++;
        if (item.kind === "create_column") columnCount++;
        cellCount += Object.keys(item.payload?.values ?? {}).length;
      }
      if (rowCount > 200 || cellCount > 2000 || columnCount > 50) return fail("Bulk command exceeds table limits.");
      const results = commands.map(
        (item, index) =>
          this.command(
            { ...actor, effects: [], effectsAfter: [] },
            { operationId: `${command.operationId}:${index}`, kind: item.kind, payload: item.payload },
            hash,
            { revision, time, projection },
          ).result,
      );
      result = { results };
    } else return fail("Unsupported command.");
    if (sub) return { revision, operationId: command.operationId, replayed: false, result, projectionPending: true };
    const schemaRevision = (meta.schemaRevision ?? 0) + (schemaChanged ? 1 : 0);
    if (schemaChanged) {
      const original = this.columns();
      const invalidTypes = new Set<string>();
      for (const property of retypeFormulaProperties(original)) {
        const current = original.find((column) => column.id === property.id)!;
        const previous = previousColumns.find((column) => column.id === property.id);
        if (property.type !== "formula") continue;
        if (
          previous?.type === "formula" &&
          ((property.config?.validationError && property.config.validationError !== previous.config?.validationError) ||
            property.config?.resultType !== previous.config?.resultType)
        )
          invalidTypes.add(property.id);
        if (canonicalJson(property.config) === canonicalJson(current.config)) continue;
        saveColumn({
          ...property,
          config: versionedPropertyConfig(property.config),
          revision:
            property.revision + (invalidTypes.has(property.id) && property.revision === previous?.revision ? 1 : 0),
        });
      }
      for (const stored of this.rows<{ id: string; value: string }>("SELECT id,value FROM views")) {
        const view = JSON.parse(stored.value) as TableView;
        const references = [
          view.columnId,
          ...view.sorts.map((sort) => sort.columnId),
          ...Object.keys(view.calculations ?? {}),
        ];
        if (
          references.some((reference) => reference && invalidTypes.has(reference)) ||
          [...invalidTypes].some((propertyId) => JSON.stringify(view.filters).includes(propertyId))
        )
          this.ctx.storage.sql.exec(
            "UPDATE views SET value=? WHERE id=?",
            JSON.stringify({ ...view, invalid: true, revision: view.revision + 1 }),
            stored.id,
          );
      }
    }
    // Stage every affected computed value before activating a schema/config revision.
    // The enclosing SQLite transaction publishes properties and the complete cache together.
    const affectedRows = schemaChanged
      ? this.rows<StoredRow>("SELECT * FROM rows ORDER BY id")
      : result.rowId
        ? [this.row(result.rowId)]
        : command.kind === "bulk"
          ? this.rows<StoredRow>("SELECT * FROM rows ORDER BY id")
          : [];
    this.ctx.storage.sql.exec("DELETE FROM staged_computed");
    for (const row of affectedRows) {
      const computed = computeRowFormulas({
        tableId: meta.pageId,
        tableRevision: revision,
        schemaRevision,
        rowId: row.id,
        rowRevision: this.rowRevision(row.id),
        cells: this.rowValue(row).cells,
        properties: this.columns(),
      });
      for (const [columnId, value] of Object.entries(computed))
        this.ctx.storage.sql.exec("INSERT INTO staged_computed VALUES(?,?,?)", row.id, columnId, JSON.stringify(value));
    }
    if (schemaChanged) this.ctx.storage.sql.exec("DELETE FROM computed");
    for (const row of affectedRows) this.ctx.storage.sql.exec("DELETE FROM computed WHERE row_id=?", row.id);
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO computed SELECT * FROM staged_computed");
    this.ctx.storage.sql.exec("DELETE FROM staged_computed");
    if (command.kind === "create_row" && p.viewId) {
      const view = this.view(p.viewId, actor),
        filter = this.filterSql(view.filters);
      result.visibleInView = Boolean(
        this.rows(
          `SELECT r.id FROM rows r WHERE (${filter.sql}) AND r.id=?${filter.binds.length + 1}`,
          ...filter.binds,
          String(result.rowId),
        ).length,
      );
    }
    for (const row of affectedRows) {
      projection.push({ sql: "DELETE FROM table_computed_cells WHERE row_id=?", binds: [row.id] });
      for (const cell of this.rows<{ column_id: string; value: string }>(
        "SELECT column_id,value FROM computed WHERE row_id=?",
        row.id,
      )) {
        const computed = JSON.parse(cell.value) as ComputedValue;
        projection.push({
          sql: "INSERT INTO table_computed_cells(row_id,column_id,value_json,source_json,revision) VALUES(?,?,?,?,?) ON CONFLICT(row_id,column_id) DO UPDATE SET value_json=excluded.value_json,source_json=excluded.source_json,revision=excluded.revision",
          binds: [row.id, cell.column_id, JSON.stringify(computed.value), JSON.stringify(computed.source), revision],
        });
      }
    }
    for (const view of this.rows<{ value: string }>("SELECT value FROM views"))
      projection.push(this.viewProjection(JSON.parse(view.value) as TableView));
    for (const person of this.rows<{ id: string; name: string }>("SELECT * FROM people"))
      projection.push({
        sql: "INSERT INTO table_people(page_id,user_id,name) VALUES(?,?,?) ON CONFLICT(page_id,user_id) DO UPDATE SET name=excluded.name",
        binds: [meta.pageId, person.id, person.name],
      });
    projection.unshift(...(actor.effects ?? []));
    projection.push(...(actor.effectsAfter ?? []));
    projection.push({
      sql: "INSERT INTO page_contributors(page_id,user_id,first_edit_at,last_edit_at) VALUES(?,?,?,?) ON CONFLICT(page_id,user_id) DO UPDATE SET last_edit_at=max(last_edit_at,excluded.last_edit_at)",
      binds: [meta.pageId, actor.userId, time, time],
    });
    projection.push({
      sql: "UPDATE pages SET updated_by=?,updated_at=? WHERE id=?",
      binds: [actor.userId, time, meta.pageId],
    });
    this.putMeta({ ...meta, revision, schemaRevision });
    const answer: TableCommandResult = {
      revision,
      operationId: command.operationId,
      replayed: false,
      result,
      projectionPending: true,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO receipts VALUES(?,?,?,?)",
      actor.userId,
      command.operationId,
      hash,
      JSON.stringify(answer),
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO events(revision,operation_id,value,cancel_row_id) VALUES(?,?,?,?)",
      revision,
      command.operationId,
      "[]",
      actor.cancelRowOnPublicationFailure ?? null,
    );
    const steps = projectionBatches(compactProjection(projection));
    if (actor.cancelRowOnPublicationFailure && steps.length > 1)
      return fail("Task publication exceeds its atomic projection limit.");
    for (const [position, statements] of steps.entries())
      this.ctx.storage.sql.exec(
        "INSERT INTO projection_steps VALUES(?,?,?)",
        revision,
        position,
        JSON.stringify(statements),
      );
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(JSON.stringify({ type: "table-changed", revision, operationId: command.operationId }));
      } catch {
        socket.close();
      }
    }
    return answer;
  }
  private propertyConfig(column: CollaborativeColumn, payload: Record<string, unknown>): Record<string, unknown> {
    const existing = versionedPropertyConfig(column.config);
    if (payload.config !== undefined) versionedPropertyConfig(payload.config);
    if (column.type === "formula") {
      if (
        payload.source === undefined &&
        payload.formula === undefined &&
        (payload.config as Record<string, unknown> | undefined)?.source === undefined &&
        existing.ast
      )
        return existing;
      const source =
        payload.source ??
        payload.formula ??
        (payload.config as { source?: unknown } | undefined)?.source ??
        column.config?.source;
      if (typeof source !== "string" || source.length > 10000)
        return fail("Enter a formula of up to 10,000 characters.");
      try {
        return versionedPropertyConfig(
          compileFormula(
            source,
            this.columns()
              .filter((item) => item.id !== column.id)
              .concat(column),
            column.id,
          ),
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : "Invalid formula.");
      }
    }
    if (payload.config === undefined) return existing;
    if (
      !payload.config ||
      typeof payload.config !== "object" ||
      Array.isArray(payload.config) ||
      JSON.stringify(payload.config).length > 10000
    )
      return fail("Invalid property configuration.");
    if (column.type === "date" && (payload.config as Record<string, unknown>).timeZone !== undefined) {
      try {
        validateCalendarZone((payload.config as Record<string, unknown>).timeZone);
      } catch {
        return fail("Choose a valid property timezone.");
      }
    }
    return versionedPropertyConfig(payload.config);
  }
  private convert(column: CollaborativeColumn, next: ColumnType, value: TableValue): TableValue {
    if (value === null) return null;
    let input: unknown = value;
    if (next === "text") {
      if (Array.isArray(value)) return fail("Array values require an explicit conversion mapping.");
      input = String(value);
    }
    if (next === "number" && typeof value === "string") {
      if (!value.trim()) input = null;
      else input = Number(value);
    }
    return validateTableValue({ ...column, type: next }, input);
  }
  private stageConversionRow(column: CollaborativeColumn, rowId: string) {
    const conversion = column.conversion!;
    const cell = this.rows<{ value: string; revision: number }>(
      "SELECT value,revision FROM cells WHERE row_id=? AND column_id=?",
      rowId,
      column.id,
    )[0];
    let value: TableValue = null,
      invalid = 0;
    try {
      value = this.convert(column, conversion.type, cell ? JSON.parse(cell.value) : null);
    } catch {
      invalid = 1;
    }
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO converted_cells VALUES(?,?,?,?,?)",
      conversion.id,
      rowId,
      JSON.stringify(value),
      invalid,
      cell?.revision ?? 0,
    );
  }
  private conversionCounts(conversionId: string) {
    const counts = this.rows<{ total: number; failures: number; empty: number; converted: number }>(
      "SELECT count(*) total,coalesce(sum(invalid),0) failures,coalesce(sum(invalid=0 AND value='null'),0) empty,coalesce(sum(invalid=0 AND value<>'null'),0) converted FROM converted_cells WHERE conversion_id=?",
      conversionId,
    )[0]!;
    return counts;
  }
  private expression(columnId: string): string {
    const column = this.column(columnId);
    if (column.type === "formula")
      return `(SELECT json_extract(c.value,'$.value') FROM computed c WHERE c.row_id=r.id AND c.column_id='${column.id}')`;
    if (metadataColumns.has(column.type))
      return column.type === "created_time"
        ? "r.created_at"
        : column.type === "last_edited_time"
          ? "r.edited_at"
          : column.type === "created_by"
            ? "r.created_by"
            : "r.edited_by";
    return `(SELECT json_extract(c.value,'$') FROM cells c WHERE c.row_id=r.id AND c.column_id='${column.id.replaceAll("'", "''")}')`;
  }
  private filterSql(filter: TableFilter | null, depth = 0): { sql: string; binds: (string | number | null)[] } {
    if (filter === null) return { sql: "1", binds: [] };
    let clauses = 0;
    const compile = (node: TableFilter, nesting: number): { sql: string; binds: (string | number | null)[] } => {
      if (++clauses > 200) return fail("Too many filter clauses.");
      if (nesting > 8) return fail("Filter nesting is too deep.");
      if (!node || typeof node !== "object" || Array.isArray(node)) return fail("Invalid filter.");
      if (node.kind === "group") {
        if (!["and", "or"].includes(node.operator) || !Array.isArray(node.filters) || node.filters.length > 50)
          return fail("Invalid filter group.");
        const children = node.filters.map((child) => compile(child, nesting + 1));
        return {
          sql: children.length
            ? `(${children.map((child) => child.sql).join(node.operator === "and" ? " AND " : " OR ")})`
            : "1",
          binds: children.flatMap((child) => child.binds),
        };
      }
      if (node.kind !== "condition") return fail("Invalid filter.");
      const column = this.column(node.columnId),
        expression = this.expression(column.id),
        value = node.value ?? null;
      const propertyType = column.type === "formula" ? column.config?.resultType : column.type;
      const collection = propertyType === "person" || propertyType === "multi_select";
      const numeric = ["number", "created_time", "last_edited_time"].includes(String(propertyType));
      const checkbox = propertyType === "checkbox" || propertyType === "boolean";
      const date = propertyType === "date";
      const text = ["text", "string", "url", "select", "status", "created_by", "last_edited_by"].includes(
        String(propertyType),
      );
      if (!collection && !numeric && !checkbox && !date && !text && propertyType !== "null")
        return fail("The property's filter type is unavailable.");
      // Typed guards keep formula error objects and corrupt scalar values out of every normal predicate.
      const scalarTypes =
        numeric || checkbox ? "'null','integer','real'" : propertyType === "null" ? "'null'" : "'null','text'";
      let valid = collection
        ? `(${expression} IS NULL OR CASE WHEN json_valid(${expression}) THEN json_type(${expression})='array' ELSE 0 END)`
        : `(typeof(${expression}) IN (${scalarTypes}))`;
      if (checkbox) valid = `(${expression} IS NULL OR (typeof(${expression})='integer' AND ${expression} IN (0,1)))`;
      if (date)
        valid = `(${expression} IS NULL OR (typeof(${expression})='text' AND julianday(${expression}) IS NOT NULL))`;
      if (column.type === "formula")
        valid = `(${valid} AND COALESCE((SELECT json_type(c.value,'$.value') FROM computed c WHERE c.row_id=r.id AND c.column_id='${column.id}'),'null') NOT IN ('object','array'))`;
      const safeArray = `CASE WHEN json_valid(${expression}) THEN CASE WHEN json_type(${expression})='array' THEN ${expression} ELSE '[]' END ELSE '[]' END`;
      const empty = collection
        ? `json_array_length(${safeArray})=0`
        : `(${expression} IS NULL${text ? ` OR ${expression}=''` : ""})`;
      const result = (sql: string, binds: (string | number | null)[] = []) => ({
        sql: `(${valid} AND (${sql}))`,
        binds,
      });
      const scalar = (input: unknown): string | number | null => {
        if (input === null) return null;
        if (numeric && typeof input === "number" && Number.isFinite(input)) return input;
        if (checkbox && typeof input === "boolean") return Number(input);
        if ((text || date) && typeof input === "string" && input.length <= 10000) {
          if (date && (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(input) || !Number.isFinite(Date.parse(input))))
            return fail("Date filters require an ISO date or timestamp.");
          return input;
        }
        return fail("Filter value does not match the property's type.");
      };
      const ids = (input: unknown): string[] => {
        if (
          !Array.isArray(input) ||
          input.length > 100 ||
          input.some((item) => typeof item !== "string" || !item || item.length > 100)
        )
          return fail("Collection filters require at most 100 IDs.");
        return [...new Set(input as string[])].sort();
      };
      if (node.operator === "empty" || node.operator === "not_empty")
        return result(node.operator === "empty" ? empty : `NOT (${empty})`);
      if (collection) {
        if (node.operator === "contains") {
          const member = ids([value])[0]!;
          return result(`EXISTS(SELECT 1 FROM json_each(${safeArray}) item WHERE item.type='text' AND item.value=?)`, [
            member,
          ]);
        }
        if (node.operator === "in")
          return result(
            `EXISTS(SELECT 1 FROM json_each(${safeArray}) item WHERE item.type='text' AND item.value IN (SELECT value FROM json_each(?)))`,
            [JSON.stringify(ids(value))],
          );
        if (node.operator !== "eq" && node.operator !== "neq")
          return fail("Collections support membership, equality or empty filters.");
        const values = JSON.stringify(value === null ? [] : ids(value));
        const equal = `NOT EXISTS(SELECT value FROM json_each(${safeArray}) EXCEPT SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT value FROM json_each(?) EXCEPT SELECT value FROM json_each(${safeArray}))`;
        return result(node.operator === "eq" ? equal : `NOT (${equal})`, [values, values]);
      }
      if (node.operator === "contains") {
        if (!text || typeof value !== "string") return fail("Contains requires a text property and text value.");
        return result(`instr(lower(${expression}),lower(?))>0`, [scalar(value)]);
      }
      if (node.operator === "in") {
        if (!Array.isArray(value) || value.length > 100) return fail("Membership requires at most 100 scalar values.");
        const values = value.map(scalar);
        return result(`${expression} IN (SELECT value FROM json_each(?))`, [JSON.stringify(values)]);
      }
      const operators = { eq: "IS", neq: "IS NOT", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
      const operator = operators[node.operator as keyof typeof operators];
      if (!operator || (!["eq", "neq"].includes(node.operator) && !numeric && !date))
        return fail("Invalid comparison for this property.");
      const comparison = scalar(value);
      return result(
        date && comparison !== null
          ? `julianday(${expression}) ${operator} julianday(?)`
          : `${expression} ${operator} ?`,
        [comparison],
      );
    };
    const compiled = compile(filter, depth);
    if (!compiled.binds.length) return compiled;
    // One packed binding supports the full clause budget within SQLite's variable limit.
    let parameter = 0;
    return {
      sql: compiled.sql.replaceAll("?", () => `json_extract(?1,'$[${parameter++}]')`),
      binds: [JSON.stringify(compiled.binds)],
    };
  }
  private query(url: URL, actor: TableActor): TableQueryResult {
    const meta = this.meta(),
      columns = this.columns(),
      views = this.views(actor),
      viewId = url.searchParams.get("viewId"),
      view = viewId ? this.view(viewId, actor) : null,
      invalidView = Boolean(view?.invalid);
    const filter = this.filterSql(invalidView ? null : (view?.filters ?? null));
    const q = url.searchParams.get("q")?.trim().slice(0, 200);
    if (q) {
      const matchedOptions = columns.flatMap((column) =>
        column.options
          .filter((option) => normalizeSearchValue(option.label).includes(normalizeSearchValue(q)))
          .map((option) => option.id),
      );
      filter.sql += ` AND EXISTS(SELECT 1 FROM cells search JOIN properties property ON property.id=search.column_id WHERE search.row_id=r.id AND
        CASE WHEN json_extract(property.value,'$.type') IN ('select','status','multi_select') THEN
          EXISTS(SELECT 1 FROM json_each(CASE WHEN json_type(search.value)='array' THEN search.value ELSE json_array(json_extract(search.value,'$')) END) selected WHERE selected.value IN (SELECT value FROM json_each(?)))
        ELSE instr(lower(search.value),lower(?))>0 END)`;
      filter.binds.push(JSON.stringify(matchedOptions), q);
    }
    if (url.searchParams.has("groupId") && view?.columnId) {
      filter.sql += ` AND ${this.expression(view.columnId)} IS ?`;
      filter.binds.push(url.searchParams.get("groupId") || null);
    }
    if (url.searchParams.has("month") && view?.kind === "calendar" && view.columnId && !invalidView) {
      const month = url.searchParams.get("month")!;
      if (!/^\d{4}-\d{2}$/.test(month)) return fail("Invalid calendar month.");
      let zone: string;
      try {
        zone = validateCalendarZone(url.searchParams.get("timeZone") ?? "UTC");
      } catch {
        return fail("Choose a valid calendar display timezone.");
      }
      const matching = this.rows<StoredRow>(`SELECT r.* FROM rows r WHERE ${filter.sql}`, ...filter.binds).filter(
        (row) => {
          const day = calendarDay(this.rowValue(row).cells[view.columnId!], zone);
          return day ? day.startsWith(month) : url.searchParams.get("includeUnscheduled") === "true";
        },
      );
      filter.sql += " AND r.id IN (SELECT value FROM json_each(?))";
      filter.binds.push(JSON.stringify(matching.map((row) => row.id)));
    }
    const limit = Math.min(TABLE_PAGE_MAX, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
    if (!Number.isSafeInteger(limit)) return fail("Invalid page size.");
    const cursor = url.searchParams.get("cursor"),
      decoded = cursor
        ? (unbase64(cursor) as { revision: number; offset: number; viewId: string | null; query: string })
        : null;
    if (
      decoded &&
      (decoded.revision !== meta.revision ||
        decoded.viewId !== viewId ||
        decoded.query !== JSON.stringify([...url.searchParams].filter(([key]) => key !== "cursor")))
    )
      return fail("The table changed. Restart pagination.", 409, "table_cursor_stale");
    const offset = decoded?.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > TABLE_MAX_ROWS) return fail("Invalid cursor.");
    const count = this.rows<{ count: number }>(
      `SELECT count(*) count FROM rows r WHERE ${filter.sql}`,
      ...filter.binds,
    )[0]!.count;
    const order =
      view && !invalidView
        ? view.sorts.map((sort) => `${this.expression(sort.columnId)} ${sort.direction === "desc" ? "DESC" : "ASC"}`)
        : [];
    if (!order.length) order.push("r.position");
    order.push("r.id");
    const rows = this.rows<StoredRow>(
      `SELECT r.* FROM rows r WHERE ${filter.sql} ORDER BY ${order.join(",")} LIMIT ? OFFSET ?`,
      ...filter.binds,
      limit,
      offset,
    );
    const groupCounts: Record<string, number> = {};
    if (view?.kind === "board" && view.columnId && !invalidView)
      for (const group of this.rows<{ key: string | null; count: number }>(
        `SELECT ${this.expression(view.columnId)} key,count(*) count FROM rows r WHERE ${filter.sql} GROUP BY key`,
        ...filter.binds,
      ))
        groupCounts[group.key ?? ""] = group.count;
    const calculations: Record<string, CalculationResult> = {};
    for (const [columnId, kind] of Object.entries(invalidView ? {} : (view?.calculations ?? {}))) {
      const property = this.column(columnId);
      const inputs = this.rows<StoredRow>(`SELECT r.* FROM rows r WHERE ${filter.sql}`, ...filter.binds).map((row) => {
        const value = this.rowValue(row);
        return property.type === "formula" ? value.computedCells?.[columnId]?.value : value.cells[columnId];
      });
      calculations[columnId] = calculateColumn(kind, inputs);
    }
    return {
      calculations,
      protocolVersion: TABLE_PROTOCOL_VERSION,
      pageId: meta.pageId,
      generation: meta.generation,
      revision: meta.revision,
      projectedRevision: meta.projectedRevision,
      columns,
      views,
      view,
      rows: rows.map((row) => this.rowValue(row)),
      rowCount: count,
      groupCounts,
      nextCursor:
        offset + rows.length < count
          ? base64({
              revision: meta.revision,
              offset: offset + rows.length,
              viewId,
              query: JSON.stringify([...url.searchParams].filter(([key]) => key !== "cursor")),
            })
          : null,
      invalidView,
    };
  }
  private async verification() {
    const meta = this.meta();
    const views = this.rows<{ value: string }>("SELECT value FROM views ORDER BY id").map(
      (view) => JSON.parse(view.value) as TableView,
    );
    const people = this.rows<{ id: string; name: string }>("SELECT * FROM people ORDER BY id");
    let hash = await sha256Hex(canonicalJson({ columns: this.columns(), views, people }));
    for (const row of this.rows<StoredRow>("SELECT * FROM rows ORDER BY id")) {
      const { computedCells: _computed, ...value } = this.rowValue(row);
      for (const column of this.columns()) if (metadataColumns.has(column.type)) delete value.cells[column.id];
      hash = await sha256Hex(`${hash}:${canonicalJson(value)}`);
    }
    return {
      pageId: meta.pageId,
      generation: meta.generation,
      revision: meta.revision,
      projectedRevision: meta.projectedRevision,
      hash,
      rowCount: this.rows<{ count: number }>("SELECT count(*) count FROM rows")[0]!.count,
    };
  }
  private async applyProjection(statements: ProjectionStatement[], revision: number, advance = true) {
    const meta = this.meta();
    await this.env.DB.batch([
      this.env.DB.prepare("INSERT OR REPLACE INTO table_projection_context VALUES(?,?)").bind(
        meta.pageId,
        meta.generation,
      ),
      ...compactProjection(statements).map((statement) => this.env.DB.prepare(statement.sql).bind(...statement.binds)),
      ...(advance
        ? [
            this.env.DB.prepare("UPDATE table_state SET revision=? WHERE page_id=?").bind(revision, meta.pageId),
            this.env.DB.prepare(
              "UPDATE table_authority SET projected_revision=? WHERE page_id=? AND generation=?",
            ).bind(revision, meta.pageId, meta.generation),
          ]
        : []),
      this.env.DB.prepare("DELETE FROM table_projection_context WHERE page_id=?").bind(meta.pageId),
    ]);
  }
  private async project() {
    if (this.projecting) return this.projecting;
    this.projecting = (async () => {
      while (true) {
        const meta = this.meta(),
          event = this.rows<{ revision: number; value: string; cancel_row_id: string | null; next_step: number }>(
            "SELECT revision,value,cancel_row_id,next_step FROM events WHERE revision>? ORDER BY revision LIMIT 1",
            meta.projectedRevision,
          )[0];
        if (!event) break;
        try {
          const steps = this.rows<{ position: number; value: string }>(
            "SELECT position,value FROM projection_steps WHERE revision=? AND position>=? ORDER BY position",
            event.revision,
            event.next_step,
          );
          if (!steps.length) await this.applyProjection([], event.revision);
          for (const [index, step] of steps.entries()) {
            if (this.purged) return;
            await this.applyProjection(
              JSON.parse(step.value) as ProjectionStatement[],
              event.revision,
              index === steps.length - 1,
            );
            if (this.purged) return;
            this.ctx.storage.sql.exec(
              "UPDATE events SET next_step=? WHERE revision=?",
              step.position + 1,
              event.revision,
            );
          }
        } catch (error) {
          if (!event.cancel_row_id || !String(error).includes("table_publication_conflict")) throw error;
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec("DELETE FROM computed WHERE row_id=?", event.cancel_row_id!);
            this.ctx.storage.sql.exec("DELETE FROM cells WHERE row_id=?", event.cancel_row_id!);
            this.ctx.storage.sql.exec("DELETE FROM rows WHERE id=?", event.cancel_row_id!);
            this.ctx.storage.sql.exec("DELETE FROM row_revisions WHERE id=?", event.cancel_row_id!);
            this.ctx.storage.sql.exec("DELETE FROM converted_cells WHERE row_id=?", event.cancel_row_id!);
            for (const receipt of this.rows<{ actor_id: string; operation_id: string; result: string }>(
              "SELECT actor_id,operation_id,result FROM receipts",
            )) {
              const answer = JSON.parse(receipt.result) as TableCommandResult;
              if (answer.revision === event.revision) {
                answer.result.publicationFailed = true;
                this.ctx.storage.sql.exec(
                  "UPDATE receipts SET result=? WHERE actor_id=? AND operation_id=?",
                  JSON.stringify(answer),
                  receipt.actor_id,
                  receipt.operation_id,
                );
              }
            }
          });
          await this.applyProjection([], event.revision);
        }
        if (this.purged) return;
        this.putMeta({ ...this.meta(), projectedRevision: event.revision });
        await broadcastWorkspaceEvent(this.env, meta.workspaceId, {
          type: "task-list-invalidated",
          pageId: meta.pageId,
          forceRefresh: true,
        });
      }
    })();
    try {
      await this.projecting;
    } finally {
      this.projecting = null;
    }
  }
  private async repair(seedBaseline = false): Promise<void> {
    if (this.repairing) return fail("Repair is already running.", 409);
    this.repairing = true;
    try {
      if (seedBaseline && this.rows("SELECT revision FROM events LIMIT 1").length)
        return fail("A seed baseline cannot replace committed table events.", 409, "table_seed_conflict");
      await this.project();
      const meta = this.meta();
      if (!seedBaseline && meta.projectedRevision !== meta.revision)
        return fail("Pending table publications must complete before repair.", 503, "table_projection_pending");
      await this.applyProjection(
        [
          // Until cutover, D1 is the frozen seed source. Preserve it for retries.
          ...(!seedBaseline
            ? [
                { sql: "DELETE FROM table_rows WHERE page_id=?", binds: [meta.pageId] },
                { sql: "DELETE FROM table_columns WHERE page_id=?", binds: [meta.pageId] },
                { sql: "DELETE FROM table_views WHERE page_id=?", binds: [meta.pageId] },
                { sql: "DELETE FROM table_people WHERE page_id=?", binds: [meta.pageId] },
              ]
            : []),
          ...this.columns().flatMap((column) => this.columnProjection(column)),
          ...this.rows<{ value: string }>("SELECT value FROM views").map((view) =>
            this.viewProjection(JSON.parse(view.value) as TableView),
          ),
          ...this.rows<{ id: string; name: string }>("SELECT * FROM people").map((person) => ({
            sql: "INSERT INTO table_people(page_id,user_id,name) VALUES(?,?,?) ON CONFLICT(page_id,user_id) DO UPDATE SET name=excluded.name",
            binds: [meta.pageId, person.id, person.name],
          })),
        ],
        meta.revision,
        false,
      );
      for (const row of this.rows<StoredRow>("SELECT * FROM rows ORDER BY id")) {
        const statements = this.rowProjection(row);
        for (const cell of this.rows<{ column_id: string; value: string; revision: number }>(
          "SELECT * FROM cells WHERE row_id=?",
          row.id,
        ))
          statements.push(
            this.cellProjection(row.id, cell.column_id, JSON.parse(cell.value), cell.revision, row.edited_at),
          );
        statements.push(...this.computedProjection(row.id, meta.revision));
        await this.applyProjection(statements, meta.revision, false);
      }
      await this.applyProjection([], meta.revision);
      this.putMeta({ ...this.meta(), projectedRevision: meta.revision });
    } catch (error) {
      if (!this.purged) await this.ctx.storage.setAlarm(Date.now() + 1000);
      throw error;
    } finally {
      this.repairing = false;
    }
  }
  // fallow-ignore-next-line unused-class-member -- Called by Cloudflare Durable Object runtime.
  async alarm() {
    if (this.purged) return;
    try {
      await this.project();
    } catch {
      if (!this.purged) await this.ctx.storage.setAlarm(Date.now() + 10_000);
    }
  }
  // fallow-ignore-next-line unused-class-member -- Called by Cloudflare Durable Object runtime.
  async webSocketMessage(socket: WebSocket) {
    const actor = { ...(socket.deserializeAttachment() as TableActor), expiresAt: Date.now() + 60_000 };
    try {
      await this.authorize(
        new Request("https://table.internal/query", {
          headers: {
            "x-table-actor": JSON.stringify(actor),
            "x-table-signature": await tableActorSignature(this.env.BETTER_AUTH_SECRET, actor),
          },
        }),
        false,
      );
      socket.send(JSON.stringify({ type: "table-ready", revision: this.meta().revision }));
    } catch {
      socket.close(1008, "Access expired.");
    }
  }
}

/** Bulk inserts bind JSON pages instead of issuing one D1 query per cell. Keep effects in order. */
function compactProjection(statements: ProjectionStatement[]): ProjectionStatement[] {
  const result: ProjectionStatement[] = [];
  let groups = new Map<string, ProjectionStatement[]>();
  const flush = () => {
    for (const [sql, items] of groups) {
      if (sql === "DELETE FROM table_computed_cells WHERE row_id=?") {
        result.push({
          sql: "DELETE FROM table_computed_cells WHERE row_id IN (SELECT value FROM json_each(?))",
          binds: [JSON.stringify(items.map((item) => item.binds[0]))],
        });
        continue;
      }
      const match =
        /^INSERT INTO (table_cells|table_rows|table_columns|table_select_options|table_computed_cells|table_people)\(([^)]+)\) VALUES\(([^)]+)\)(.*)$/.exec(
          sql,
        )!;
      let chunk: ProjectionStatement[] = [];
      let bytes = 0;
      const emit = () => {
        if (!chunk.length) return;
        if (chunk.length === 1) result.push(chunk[0]!);
        else
          result.push({
            sql: `INSERT INTO ${match[1]}(${match[2]}) SELECT ${chunk[0]!.binds.map((_, index) => `json_extract(value,'$[${index}]')`).join(",")} FROM json_each(?) WHERE 1 ${match[4]}`,
            binds: [JSON.stringify(chunk.map((item) => item.binds))],
          });
        chunk = [];
        bytes = 0;
      };
      for (const item of items) {
        const size = JSON.stringify(item.binds).length;
        if (chunk.length && (chunk.length >= 100 || bytes + size > 500000)) emit();
        chunk.push(item);
        bytes += size;
      }
      emit();
    }
    groups = new Map();
  };
  for (const statement of statements) {
    if (
      /^INSERT INTO (table_cells|table_rows|table_columns|table_select_options|table_computed_cells|table_people)\([^)]+\) VALUES\([^)]+\)/.test(
        statement.sql,
      ) ||
      statement.sql === "DELETE FROM table_computed_cells WHERE row_id=?"
    ) {
      const group = groups.get(statement.sql) ?? [];
      group.push(statement);
      groups.set(statement.sql, group);
    } else {
      flush();
      result.push(statement);
    }
  }
  flush();
  return result;
}

/** A projection may be larger than one D1 request. Progress is durable and every step is replayable. */
function projectionBatches(statements: ProjectionStatement[]): ProjectionStatement[][] {
  const result: ProjectionStatement[][] = [];
  let batch: ProjectionStatement[] = [];
  let bytes = 0;
  for (const statement of statements) {
    const size = JSON.stringify(statement).length;
    if (batch.length && (batch.length >= 200 || bytes + size > 1000000)) {
      result.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(statement);
    bytes += size;
  }
  if (batch.length) result.push(batch);
  return result;
}
