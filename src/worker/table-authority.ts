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
import { compileFormula, retypeFormulaProperties, prepareFormulaEvaluation } from "../shared/formula";
import { compareTableProjectionContent, type TableSnapshot } from "./table-projection";
import { broadcastWorkspaceEvent } from "./workspace-events";
import { calendarDay, moveCalendarDate, validateCalendarZone } from "../shared/table-calendar";
import { validateTaskTableCommand } from "../shared/task-table-policy";
import { acceptedPageDeletionSql } from "./deletion-policy";

export type ProjectionStatement = { sql: string; binds: (string | number | null)[] };
const TABLE_ID_PATTERN = /^[\w:-]{1,300}$/;
const REPAIR_ENTITY_LIMIT = 100;
const PROJECTION_MAX_BYTES = 1_000_000;
const PROJECTION_INSERT_SQL = {
  table_columns:
    "INSERT INTO table_columns(id,page_id,name,type,position,config_json,property_revision,property_generation,name_key) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,position=excluded.position,config_json=excluded.config_json,property_revision=excluded.property_revision,property_generation=excluded.property_generation,name_key=excluded.name_key",
  table_select_options:
    "INSERT INTO table_select_options(id,column_id,label,label_search_value,position,color) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,label_search_value=excluded.label_search_value,position=excluded.position,color=excluded.color",
  table_rows:
    "INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at,updated_by,row_revision) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,updated_at=excluded.updated_at,updated_by=excluded.updated_by,row_revision=excluded.row_revision",
  table_row_pages:
    "INSERT INTO table_row_pages(row_id,page_id,created_at) VALUES(?,?,?) ON CONFLICT(row_id) DO NOTHING",
  table_cells:
    "INSERT INTO table_cells(row_id,column_id,text_value,text_search_value,number_value,boolean_value,date_value,select_value,json_value,cell_revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(row_id,column_id) DO UPDATE SET text_value=excluded.text_value,text_search_value=excluded.text_search_value,number_value=excluded.number_value,boolean_value=excluded.boolean_value,date_value=excluded.date_value,select_value=excluded.select_value,json_value=excluded.json_value,cell_revision=excluded.cell_revision,updated_at=excluded.updated_at",
  table_computed_cells:
    "INSERT INTO table_computed_cells(row_id,column_id,value_json,source_json,revision) VALUES(?,?,?,?,?) ON CONFLICT(row_id,column_id) DO UPDATE SET value_json=excluded.value_json,source_json=excluded.source_json,revision=excluded.revision",
  table_views:
    "INSERT INTO table_views(page_id,id,owner_id,value_json) VALUES(?,?,?,?) ON CONFLICT(page_id,id) DO UPDATE SET owner_id=excluded.owner_id,value_json=excluded.value_json",
  table_people:
    "INSERT INTO table_people(page_id,user_id,name) VALUES(?,?,?) ON CONFLICT(page_id,user_id) DO UPDATE SET name=excluded.name",
};

const COMPUTED_DELETE_SQL =
  "DELETE FROM table_computed_cells WHERE row_id IN (SELECT value FROM json_each(?)) AND row_id IN (SELECT id FROM table_rows WHERE page_id=?)";
type Prerequisite = { table: string; columns: string[]; binds: ProjectionStatement["binds"] };
type PendingEvent = {
  revision: number;
  operation_id: string;
  value: string;
  cancel_row_id: string | null;
  next_step: number;
};
type CommandProjection = {
  revision: number;
  time: number;
  projection: ProjectionStatement[];
  prerequisites: Map<string, Prerequisite>;
  createdRows: Set<string>;
  createdColumns: Set<string>;
  createdOptions: Set<string>;
};
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
  deletionJob?: string;
};
type DeletionIntent = {
  jobId: string;
  pageId: string;
  workspaceId: string;
  generation: number | null;
  stopped: boolean;
  purged: boolean;
};
type RecoveryCursor = { generation: number; revision: number; position: number; table: string; key: string };
type RepairIntent = {
  generation: number;
  version?: 2;
  phase: NonNullable<TableRepairStatus["phase"]>;
  mode?: "pure";
  pureFrom?: number;
  bookkeeping?: { revision: number; position: number; statement: number };
  reconcileCursor?: string;
  blocked?: {
    revision: number;
    position: number;
    reason: string;
    resumePhase: Exclude<RepairIntent["phase"], "blocked">;
  };
  hashes?: { canonicalHash: string; projectionHash: string };
  mismatches?: number;
  revision?: number;
  headerStep?: number;
  headerFormat?: 1;
  rowCursor?: string;
};
type Meta = TableActor & {
  revision: number;
  projectedRevision: number;
  seeded: boolean;
  schemaRevision?: number;
  repairIntent?: RepairIntent;
};
export type TableRepairStatus = {
  state: "pending" | "blocked" | "complete";
  generation: number;
  revision: number;
  phase: "fence" | "drain" | "bookkeeping" | "headers" | "rows" | "reconcile" | "verify" | "publish" | "blocked" | null;
  reason?: string;
};
type StoredRow = {
  id: string;
  position: number;
  created_at: number;
  created_by: string | null;
  edited_at: number;
  edited_by: string | null;
  detail_page_id: string | null;
};
type LinkTarget = [rowId: string, detailPageId: string | null, createdAt: number, oldPageId: string | null];
function fail(message: string, status = 422, code = "table_validation"): never {
  throw Object.assign(new Error(message), { status, code });
}
function id(value: unknown, name = "ID"): string {
  if (typeof value !== "string" || !TABLE_ID_PATTERN.test(value)) return fail(`${name} is invalid.`);
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
  private projecting: Promise<boolean> | null = null;
  private repairWork: Promise<unknown> | null = null;
  private deletionIntent: DeletionIntent | null = null;
  private purged = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS properties(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rows(id TEXT PRIMARY KEY,position REAL NOT NULL,created_at INTEGER NOT NULL,created_by TEXT,edited_at INTEGER NOT NULL,edited_by TEXT,detail_page_id TEXT);
      CREATE TABLE IF NOT EXISTS row_revisions(id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS rows_position ON rows(position,id);
      CREATE INDEX IF NOT EXISTS rows_linked ON rows(id) WHERE detail_page_id IS NOT NULL;
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
    const deletion = this.rows<{ value: string }>("SELECT value FROM meta WHERE id=2")[0];
    if (deletion) {
      this.deletionIntent = JSON.parse(deletion.value) as DeletionIntent;
      this.purged = this.deletionIntent.purged;
    }
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
    this.requireActive();
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES(1,?)", JSON.stringify(meta));
  }
  private requireActive() {
    if (this.deletionIntent || this.purged)
      fail("Permanent deletion has been accepted for this table.", 409, "deletion_pending");
  }
  private async scheduleAlarm(delay: number) {
    if (!this.deletionIntent && !this.purged) await this.ctx.storage.setAlarm(Date.now() + delay);
  }
  private async trackRepair<T>(work: () => Promise<T>): Promise<T> {
    this.requireActive();
    if (this.repairWork) fail("Repair is already running.", 409);
    const pending = work();
    this.repairWork = pending;
    try {
      return await pending;
    } finally {
      this.repairWork = null;
    }
  }
  private repairStatus(): TableRepairStatus {
    const meta = this.meta(),
      intent = meta.repairIntent;
    return {
      state: intent?.phase === "blocked" ? "blocked" : intent || this.repairWork ? "pending" : "complete",
      generation: meta.generation,
      revision: meta.revision,
      phase: intent?.phase ?? null,
      ...(intent?.blocked ? { reason: intent.blocked.reason.slice(0, 500) } : {}),
    };
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
    if (write && (page.state === "repairing" || this.repairWork || this.meta().repairIntent))
      return fail("Projection repair is running. Retry shortly.", 503, "table_projection_repairing");
    if (write && (page.role === "viewer" || (page.role !== "owner" && page.space_role === "viewer")))
      return fail("This table is read-only.", 403, "read_only");
    return { ...actor, taskList: Boolean(page.is_task_list) };
  }
  // fallow-ignore-next-line unused-class-member -- Called by Cloudflare Durable Object runtime.
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (path === "/row-deletion-proof" || path === "/deletion-evidence") {
        if (request.headers.get("x-table-internal") !== this.env.BETTER_AUTH_SECRET)
          fail("Forbidden.", 403, "table_forbidden");
        return Response.json(
          path === "/row-deletion-proof" ? await this.purgedRowProof(request) : await this.deletionEvidence(request),
        );
      }
      if (["/purge", "/stop-repair-for-deletion"].includes(path)) {
        if (request.headers.get("x-table-internal") !== this.env.BETTER_AUTH_SECRET)
          fail("Forbidden.", 403, "table_forbidden");
        return Response.json(
          path === "/purge" ? await this.purgeForDeletion(request) : await this.stopForDeletion(request),
        );
      }
      if (this.purged) return fail("This table was permanently deleted.", 410, "table_purged");
      if (
        path === "/export" &&
        request.method === "GET" &&
        request.headers.get("x-table-internal") === this.env.BETTER_AUTH_SECRET &&
        this.deletionIntent?.stopped &&
        url.searchParams.get("deletionJob") === this.deletionIntent.jobId
      ) {
        await this.authorizeDeletion(this.deletionIntent, "stop");
      } else this.requireActive();
      if (
        [
          "/seed",
          "/seed-rows",
          "/seed-finish",
          "/verify",
          "/repair",
          "/repair-status",
          "/export",
          "/delete-row",
        ].includes(path)
      ) {
        if (request.headers.get("x-table-internal") !== this.env.BETTER_AUTH_SECRET)
          return fail("Forbidden.", 403, "table_forbidden");
        if (path === "/delete-row") return Response.json(await this.deleteJobRow(request));
        if (path === "/repair-status") return Response.json(this.repairStatus());
        if (path === "/seed") {
          const body = await request.json<{
            meta: Meta;
            columns: CollaborativeColumn[];
            views?: TableView[];
            people?: Array<{ id: string; name: string }>;
          }>();
          const seeded = this.ctx.storage.transactionSync((): boolean => {
            this.requireActive();
            const existing = this.rows<{ value: string }>("SELECT value FROM meta WHERE id=1")[0];
            if (existing) {
              const previous = JSON.parse(existing.value) as Meta;
              if (previous.generation !== body.meta.generation) return fail("Another table generation exists.", 409);
              return previous.seeded;
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
            return body.meta.seeded;
          });
          return Response.json({ ok: true, seeded });
        }
        if (path === "/seed-rows") {
          const body = await request.json<{ generation: number; rows: CollaborativeRow[] }>();
          this.requireActive();
          const meta = this.meta();
          if (body.generation !== meta.generation) return fail("Seed generation mismatch.", 409);
          if (meta.seeded) return fail("The table seed is already complete.", 409, "table_seed_conflict");
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
          if (this.rows("SELECT revision FROM events LIMIT 1").length)
            return fail("A seed baseline cannot replace committed table events.", 409, "table_seed_conflict");
          if (meta.seeded) return Response.json(await this.verification());
          const properties = this.columns(),
            prepared = prepareFormulaEvaluation(properties);
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
                properties,
                prepared,
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
          const cursor = url.searchParams.get("after");
          const meta = this.meta(),
            revision = meta.revision;
          if (url.searchParams.has("revision") && Number(url.searchParams.get("revision")) !== revision)
            return fail("The table changed while its snapshot was captured. Retry.", 409, "table_snapshot_changed");
          const rows = this.rows<StoredRow>(
            `SELECT * FROM rows ${cursor ? "WHERE id>?" : ""} ORDER BY id LIMIT 100`,
            ...(cursor ? [cursor] : []),
          );
          return Response.json({
            pageId: meta.pageId,
            workspaceId: meta.workspaceId,
            generation: meta.generation,
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
        if (this.repairWork) return Response.json({ repair: this.repairStatus(), verification: null }, { status: 202 });
        const repaired = await this.resumeRepair(true);
        if ("pending" in repaired)
          return Response.json({ repair: this.repairStatus(), verification: null }, { status: 202 });
        return Response.json(repaired);
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
        await this.scheduleAlarm(1000);
        await this.authorize(request, true);
        const result = this.ctx.storage.transactionSync(() => this.command(actor, command, hash));
        try {
          await this.project();
        } catch {
          if (!this.purged) await this.scheduleAlarm(1000);
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
  private columnProjection(column: CollaborativeColumn, includeOptions = true): ProjectionStatement[] {
    const pageId = this.meta().pageId;
    return [
      {
        sql: PROJECTION_INSERT_SQL.table_columns,
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
      ...(includeOptions ? column.options : []).map((option) => ({
        sql: PROJECTION_INSERT_SQL.table_select_options,
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
      sql: PROJECTION_INSERT_SQL.table_views,
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
          sql: PROJECTION_INSERT_SQL.table_computed_cells,
          binds: [rowId, cell.column_id, JSON.stringify(computed.value), JSON.stringify(computed.source), revision],
        };
      }),
    ];
  }
  private rowProjection(
    row: StoredRow,
    meta = this.meta(),
    revision = this.rowRevision(row.id),
  ): ProjectionStatement[] {
    return [
      {
        sql: PROJECTION_INSERT_SQL.table_rows,
        binds: [
          row.id,
          meta.pageId,
          row.position,
          row.created_by,
          row.created_at,
          row.edited_at,
          row.edited_by,
          revision,
        ],
      },
      ...(row.detail_page_id
        ? [
            {
              sql: PROJECTION_INSERT_SQL.table_row_pages,
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
    column = this.column(columnId),
  ): ProjectionStatement {
    return {
      sql: PROJECTION_INSERT_SQL.table_cells,
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
  private command(actor: TableActor, command: TableCommand, hash: string, sub?: CommandProjection): TableCommandResult {
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
    const prerequisites = sub?.prerequisites ?? new Map<string, Prerequisite>(),
      createdRows = sub?.createdRows ?? new Set<string>(),
      createdColumns = sub?.createdColumns ?? new Set<string>(),
      createdOptions = sub?.createdOptions ?? new Set<string>();
    const remember = (statement: ProjectionStatement) => {
      const record = insertRecords(statement)[0];
      if (!record) return;
      const key = prerequisiteKey(record);
      if (!prerequisites.has(key)) prerequisites.set(key, record);
    };
    const rememberColumn = (column: CollaborativeColumn, selected?: TableValue) => {
      if (createdColumns.has(column.id)) return;
      const selectedId =
        ["select", "status"].includes(column.type) && typeof selected === "string" ? selected : undefined;
      if (!prerequisites.has(`table_columns:${column.id}`)) remember(this.columnProjection(column, false)[0]!);
      if (!selectedId || createdOptions.has(selectedId) || prerequisites.has(`table_select_options:${selectedId}`))
        return;
      const option = column.options.find((item) => item.id === selectedId);
      if (option)
        remember({
          sql: PROJECTION_INSERT_SQL.table_select_options,
          binds: [
            option.id,
            column.id,
            option.label,
            normalizeSearchValue(option.label),
            option.position,
            option.color ?? "gray",
          ],
        });
    };
    const rememberRow = (row: StoredRow) => {
      if (!createdRows.has(row.id) && !prerequisites.has(`table_rows:${row.id}`))
        for (const statement of this.rowProjection(row)) remember(statement);
    };
    const schemaChanged =
      !sub &&
      (["create_column", "update_column", "delete_column", "commit_type"].includes(command.kind) ||
        (command.kind === "bulk" &&
          Array.isArray(p.commands) &&
          p.commands.some((item) => item?.kind === "create_column")));
    const previousColumns = schemaChanged ? this.columns() : [];
    const optionChanged =
      !sub &&
      (["add_option", "delete_option"].includes(command.kind) ||
        (command.kind === "bulk" &&
          Array.isArray(p.commands) &&
          p.commands.some((item) => item?.kind === "add_option")));
    let result: Record<string, unknown> = {};
    const saveColumn = (column: CollaborativeColumn) => {
      const original = this.rows<{ value: string }>("SELECT value FROM properties WHERE id=?", column.id)[0];
      if (original) rememberColumn(JSON.parse(original.value) as CollaborativeColumn);
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
      rememberRow(row);
      if (!values || typeof values !== "object" || Array.isArray(values)) return fail("Invalid cell values.");
      for (const [columnId, input] of Object.entries(values)) {
        const column = this.column(columnId);
        rememberColumn(column, input as TableValue);
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
      createdColumns.add(column.id);
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
      )) {
        const invalid =
          view.columnId === column.id ||
          view.sorts.some((sort) => sort.columnId === column.id) ||
          JSON.stringify(view.filters).includes(column.id) ||
          Object.hasOwn(view.calculations ?? {}, column.id);
        if (invalid || view.visibleColumnIds.includes(column.id)) {
          this.ctx.storage.sql.exec(
            "UPDATE views SET value=? WHERE id=?",
            JSON.stringify({
              ...view,
              visibleColumnIds: view.visibleColumnIds.filter((propertyId) => propertyId !== column.id),
              invalid: view.invalid || invalid,
              revision: view.revision + 1,
            }),
            view.id,
          );
        }
      }
    } else if (command.kind === "add_option") {
      const column = this.column(p.columnId);
      if (column.conversion)
        return fail("This property has a pending type conversion.", 409, "property_conversion_pending");
      if (!["select", "status", "multi_select"].includes(column.type)) return fail("This is not an option property.");
      const option = {
        id: typeof p.id === "string" ? id(p.id) : crypto.randomUUID(),
        label: title(p.label),
        position: Math.max(-1, ...column.options.map((item) => item.position)) + 1,
        color: typeof p.color === "string" ? p.color : "gray",
      };
      if (this.columns().some((property) => property.options.some((existing) => existing.id === option.id)))
        return fail("Option ID has already been used.", 409, "table_id_collision");
      if (column.options.some((item) => item.label === option.label)) return fail("Option labels must be unique.");
      createdOptions.add(option.id);
      saveColumn({ ...column, revision: column.revision + 1, options: [...column.options, option] });
      result = { option };
    } else if (command.kind === "delete_option") {
      const column = this.column(p.columnId),
        optionId = id(p.optionId);
      if (column.conversion)
        return fail("This property has a pending type conversion.", 409, "property_conversion_pending");
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
      createdRows.add(rowId);
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
      rememberRow(row);
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
        previous?.visibleColumnIds.filter((propertyId) => this.columns().some((column) => column.id === propertyId)) ??
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
        rememberRow(this.row(cell.row_id));
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
            { revision, time, projection, prerequisites, createdRows, createdColumns, createdOptions },
          ).result,
      );
      result = { results };
    } else return fail("Unsupported command.");
    if (sub) return { revision, operationId: command.operationId, replayed: false, result, projectionPending: true };
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
    const properties = this.columns(),
      prepared = prepareFormulaEvaluation(properties);
    const labelsChanged = optionChanged && prepared.usesOptionLabels;
    const schemaRevision = (meta.schemaRevision ?? 0) + (schemaChanged || labelsChanged ? 1 : 0);
    // Stage every affected computed value before activating a schema/config revision.
    // The enclosing SQLite transaction publishes properties and the complete cache together.
    const affectedRows =
      schemaChanged || labelsChanged
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
        properties,
        prepared,
      });
      if (Object.keys(computed).length) rememberRow(row);
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
    for (let start = 0; start < affectedRows.length; start += 100)
      projection.push({
        sql: COMPUTED_DELETE_SQL,
        binds: [JSON.stringify(affectedRows.slice(start, start + 100).map((row) => row.id)), meta.pageId],
      });
    const propertyById = new Map(properties.map((property) => [property.id, property]));
    for (const row of affectedRows) {
      for (const cell of this.rows<{ column_id: string; value: string }>(
        "SELECT column_id,value FROM computed WHERE row_id=?",
        row.id,
      )) {
        const computed = JSON.parse(cell.value) as ComputedValue;
        const property = propertyById.get(cell.column_id);
        if (property) rememberColumn(property);
        projection.push({
          sql: PROJECTION_INSERT_SQL.table_computed_cells,
          binds: [row.id, cell.column_id, JSON.stringify(computed.value), JSON.stringify(computed.source), revision],
        });
      }
    }
    for (const view of this.rows<{ value: string }>("SELECT value FROM views"))
      projection.push(this.viewProjection(JSON.parse(view.value) as TableView));
    for (const person of this.rows<{ id: string; name: string }>("SELECT * FROM people"))
      projection.push({
        sql: PROJECTION_INSERT_SQL.table_people,
        binds: [meta.pageId, person.id, person.name],
      });
    projection.unshift(...(actor.effects ?? []));
    projection.push(...(actor.effectsAfter ?? []));
    if (!actor.deletionJob)
      projection.push({
        sql: "INSERT INTO page_contributors(page_id,user_id,first_edit_at,last_edit_at) VALUES(?,?,?,?) ON CONFLICT(page_id,user_id) DO UPDATE SET last_edit_at=max(last_edit_at,excluded.last_edit_at)",
        binds: [meta.pageId, actor.userId, time, time],
      });
    if (!actor.deletionJob)
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
    const prerequisiteChunks = chunkPrerequisites([...prerequisites.values()]);
    this.ctx.storage.sql.exec(
      "INSERT INTO events(revision,operation_id,value,cancel_row_id) VALUES(?,?,?,?)",
      revision,
      command.operationId,
      JSON.stringify({ projectionFormat: 2, prerequisiteFormat: 1, prerequisiteChunks: prerequisiteChunks.length }),
      actor.cancelRowOnPublicationFailure ?? null,
    );
    const steps = projectionBatches(compactProjection(projection));
    if (actor.cancelRowOnPublicationFailure && steps.length > 1)
      return fail("Task publication exceeds its atomic projection limit.");
    for (const [index, value] of prerequisiteChunks.entries())
      this.ctx.storage.sql.exec("INSERT INTO projection_steps VALUES(?,?,?)", revision, -index - 1, value);
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
      if (["select", "status"].includes(column.type)) {
        const option = column.options.find((item) => item.id === value);
        if (!option) return fail("The selected option is unavailable.");
        input = option.label;
      } else input = String(value);
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
  private projectionGuard() {
    const meta = this.meta();
    return this.env.DB.prepare(
      `INSERT OR REPLACE INTO table_publication_guards(page_id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM table_authority WHERE page_id=? AND generation=?) AND NOT ${acceptedPageDeletionSql("?", "?")} THEN 1 ELSE 0 END`,
    ).bind(meta.pageId, meta.pageId, meta.generation, meta.pageId, meta.workspaceId);
  }
  private async classifyProjectionFailure(error: unknown): Promise<never> {
    this.requireActive();
    const constraint = projectionConstraint(error);
    if (constraint === "table_publication_conflict") {
      const meta = this.meta();
      const deletion = await this.env.DB.prepare(`SELECT 1 WHERE ${acceptedPageDeletionSql("?", "?")}`)
        .bind(meta.pageId, meta.workspaceId)
        .first();
      if (deletion) fail("Permanent deletion has been accepted for this table.", 409, "deletion_pending");
      const registry = await this.env.DB.prepare("SELECT generation FROM table_authority WHERE page_id=?")
        .bind(meta.pageId)
        .first<{ generation: number }>();
      if (registry?.generation !== meta.generation)
        fail("Projection generation changed.", 409, "table_generation_conflict");
      fail("Projection publication ownership changed.", 409, "table_publication_conflict");
    }
    if (constraint === "missing_parent")
      fail("Projection prerequisite is missing.", 503, "table_projection_missing_parent");
    if (constraint === "ownership") fail("Projection ownership changed.", 503, "table_projection_ownership_conflict");
    throw error;
  }
  private async authorizeDeletion(
    body: { jobId: string; pageId: string; workspaceId?: string; generation?: number | null },
    stage: "stop" | "purge",
  ) {
    id(body.jobId);
    id(body.pageId);
    if (this.ctx.id.name !== body.pageId) fail("Deletion target names another authority.", 403, "table_forbidden");
    const job = await this.env.DB.prepare("SELECT workspace_id,phase FROM deletion_jobs WHERE id=?")
      .bind(body.jobId)
      .first<{ workspace_id: string; phase: string }>();
    if (
      !job ||
      (stage === "stop" ? !["rows", "cleanup"].includes(job.phase) : job.phase !== "cleanup") ||
      (body.workspaceId !== undefined && body.workspaceId !== job.workspace_id)
    )
      fail("Deletion job is unavailable.", 403, "table_forbidden");
    const targets = (
      await this.env.DB.prepare("SELECT target,completed_at FROM deletion_targets WHERE job_id=? AND kind='table_do'")
        .bind(body.jobId)
        .all<{ target: string; completed_at: number | null }>()
    ).results;
    const matches = (target: { target: string; completed_at: number | null }, selectedStage: "stop" | "purge") => {
      try {
        const parsed = JSON.parse(target.target);
        return (
          parsed.version === 1 &&
          parsed.pageId === body.pageId &&
          parsed.workspaceId === job.workspace_id &&
          parsed.generation === body.generation &&
          parsed.stage === selectedStage
        );
      } catch {
        return false;
      }
    };
    const tuple = targets.find((target) => matches(target, stage));
    const legacy =
      stage === "purge" && body.generation === undefined && targets.some((target) => target.target === body.pageId);
    if (!tuple && !legacy) fail("Deletion target is unavailable.", 403, "table_forbidden");
    const page = await this.env.DB.prepare(
      "SELECT p.workspace_id,p.kind,p.archived_at,p.archive_operation_id,locked.archived_at locked_at,locked.archive_operation_id locked_operation FROM deletion_job_pages locked JOIN pages p ON p.id=locked.page_id WHERE locked.job_id=? AND locked.page_id=?",
    )
      .bind(body.jobId, body.pageId)
      .first<{
        workspace_id: string;
        kind: string;
        archived_at: number | null;
        archive_operation_id: string | null;
        locked_at: number;
        locked_operation: string | null;
      }>();
    const registry = await this.env.DB.prepare("SELECT generation,state FROM table_authority WHERE page_id=?")
      .bind(body.pageId)
      .first<{ generation: number; state: string }>();
    if (job.phase === "rows") {
      if (
        !page ||
        page.workspace_id !== job.workspace_id ||
        page.kind !== "table" ||
        page.archived_at === null ||
        page.archived_at !== page.locked_at ||
        page.archive_operation_id !== page.locked_operation
      )
        fail("Deletion table ownership changed.", 403, "table_forbidden");
      if ((registry?.generation ?? null) !== body.generation)
        fail("Deletion generation changed.", 409, "table_generation_conflict");
    } else {
      if (registry || (await this.env.DB.prepare("SELECT id FROM pages WHERE id=?").bind(body.pageId).first()))
        fail("Deletion table identity is still live.", 409, "table_generation_conflict");
      if (
        !(await this.env.DB.prepare("SELECT page_id FROM deletion_job_pages WHERE job_id=? AND page_id=?")
          .bind(body.jobId, body.pageId)
          .first())
      )
        fail("Deletion identity is not reserved.", 403, "table_forbidden");
      if (!legacy && !targets.some((target) => matches(target, "stop") && target.completed_at !== null))
        fail("Deletion stop is incomplete.", 409, "deletion_pending");
    }
    const canonical = this.rows<{ value: string }>("SELECT value FROM meta WHERE id=1")[0];
    if (canonical) {
      const meta = JSON.parse(canonical.value) as Meta;
      if (
        meta.pageId !== body.pageId ||
        meta.workspaceId !== job.workspace_id ||
        (!legacy && meta.generation !== body.generation)
      )
        fail("Deletion canonical ownership changed.", 409, "table_generation_conflict");
    }
    if (
      this.deletionIntent &&
      (this.deletionIntent.jobId !== body.jobId ||
        this.deletionIntent.pageId !== body.pageId ||
        this.deletionIntent.workspaceId !== job.workspace_id ||
        (!legacy && this.deletionIntent.generation !== body.generation))
    )
      fail("Another deletion owns this table.", 403, "table_forbidden");
    return {
      job,
      registry,
      legacy,
      generation: body.generation ?? (canonical ? (JSON.parse(canonical.value) as Meta).generation : null),
    };
  }
  /** Capture linked identities without exporting cells or evaluating formulas. */
  private async deletionEvidence(request: Request) {
    if (request.method !== "GET") fail("Use GET.", 405);
    const url = new URL(request.url),
      jobId = id(url.searchParams.get("deletionJob")),
      target = url.searchParams.get("stopTarget"),
      generationText = url.searchParams.get("generation"),
      generation = generationText === "null" ? null : Number(generationText);
    if (
      !target ||
      generationText === null ||
      (generation !== null && (!Number.isSafeInteger(generation) || generation < 1))
    )
      fail("Deletion evidence target is invalid.", 403, "table_forbidden");
    const authorize = async () => {
      const captured = await this.env.DB.prepare(`SELECT job.workspace_id,job.phase,locked.page_id,
        page.workspace_id page_workspace,page.kind,page.archived_at,page.archive_operation_id,
        locked.archived_at locked_at,locked.archive_operation_id locked_operation,authority.generation
        FROM deletion_jobs job JOIN deletion_targets target ON target.job_id=job.id
        JOIN deletion_job_pages locked ON locked.job_id=job.id AND locked.page_id=?
        LEFT JOIN pages page ON page.id=locked.page_id LEFT JOIN table_authority authority ON authority.page_id=locked.page_id
        WHERE job.id=? AND job.phase IN ('staging','rows','cleanup') AND target.kind='table_do' AND target.target=?
          AND json_valid(target.target) AND json_extract(target.target,'$.version')=1
          AND json_extract(target.target,'$.stage')='stop' AND json_extract(target.target,'$.pageId')=locked.page_id
          AND json_extract(target.target,'$.workspaceId')=job.workspace_id AND json_extract(target.target,'$.generation') IS ?`)
        .bind(this.ctx.id.name, jobId, target, generation)
        .first<{
          workspace_id: string;
          phase: string;
          page_id: string;
          page_workspace: string | null;
          kind: string | null;
          archived_at: number | null;
          archive_operation_id: string | null;
          locked_at: number;
          locked_operation: string | null;
          generation: number | null;
        }>();
      if (!captured) fail("Deletion evidence target is unavailable.", 403, "table_forbidden");
      if (captured.phase === "cleanup") {
        if (captured.kind !== null || captured.generation !== null)
          fail("Deletion table identity is still live.", 409, "table_generation_conflict");
        const stopped = await this.env.DB.prepare(
          "SELECT 1 FROM deletion_targets WHERE job_id=? AND kind='table_do' AND target=? AND completed_at IS NOT NULL",
        )
          .bind(jobId, target)
          .first();
        if (!stopped) fail("Deletion stop is incomplete.", 409, "deletion_pending");
      } else if (
        captured.page_workspace !== captured.workspace_id ||
        captured.kind !== "table" ||
        captured.archived_at === null ||
        captured.archived_at !== captured.locked_at ||
        captured.archive_operation_id !== captured.locked_operation ||
        captured.generation !== generation
      )
        fail("Deletion evidence ownership changed.", 409, "deletion_pending");
      if (this.deletionIntent) {
        if (
          captured.phase === "staging" ||
          this.deletionIntent.jobId !== jobId ||
          this.deletionIntent.pageId !== captured.page_id ||
          this.deletionIntent.workspaceId !== captured.workspace_id ||
          this.deletionIntent.generation !== generation
        )
          fail("Another deletion owns this table.", 403, "table_forbidden");
        if (this.deletionIntent.purged) fail("This table was permanently deleted.", 410, "table_purged");
      }
      const meta = this.meta();
      if (
        meta.pageId !== captured.page_id ||
        meta.workspaceId !== captured.workspace_id ||
        meta.generation !== generation
      )
        fail("Deletion evidence generation changed.", 409, "table_generation_conflict");
      return meta;
    };
    let meta = await authorize();
    if (this.deletionIntent && !this.deletionIntent.stopped) {
      await Promise.allSettled(
        [this.projecting, this.repairWork].filter((work): work is Promise<unknown> => work !== null),
      );
      meta = await authorize();
    }
    const after = url.searchParams.has("after") ? id(url.searchParams.get("after"), "Row cursor") : "";
    if (url.searchParams.has("revision") && Number(url.searchParams.get("revision")) !== meta.revision)
      fail("The table changed while its snapshot was captured. Retry.", 409, "table_snapshot_changed");
    const linked = this.rows<{ id: string; detail_page_id: string }>(
      "SELECT id,detail_page_id FROM rows WHERE detail_page_id IS NOT NULL AND id>? ORDER BY id LIMIT 1001",
      after,
    );
    const result = {
      pageId: meta.pageId,
      workspaceId: meta.workspaceId,
      generation: meta.generation,
      revision: meta.revision,
      rows: [] as Array<{ id: string; detailPageId: string }>,
      nextCursor: null as string | null,
    };
    let bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    for (const row of linked.slice(0, 1000)) {
      const value = { id: row.id, detailPageId: row.detail_page_id },
        size = new TextEncoder().encode(JSON.stringify(value)).byteLength + 1;
      // Include the encoded cursor and framing in the response limit.
      if (bytes + size + 2000 > PROJECTION_MAX_BYTES) break;
      result.rows.push(value);
      bytes += size;
    }
    if (linked.length > result.rows.length) {
      if (!result.rows.length)
        fail("Deletion evidence row exceeds its response limit.", 503, "table_projection_blocked");
      result.nextCursor = result.rows.at(-1)!.id;
    }
    return result;
  }
  /** A durable purge tombstone proves a dependent row's captured generation was removed. */
  private async purgedRowProof(request: Request) {
    if (request.method !== "POST") fail("Use POST.", 405);
    const body = await request.json<{
      jobId: string;
      pageId: string;
      workspaceId: string;
      generation: number;
      rowId: string;
      detailPageId: string;
      target: string;
      leaseUntil: number;
    }>();
    for (const value of [body.jobId, body.pageId, body.workspaceId, body.rowId, body.detailPageId]) id(value);
    if (
      body.pageId !== this.ctx.id.name ||
      !Number.isSafeInteger(body.generation) ||
      body.generation < 1 ||
      !Number.isSafeInteger(body.leaseUntil) ||
      typeof body.target !== "string"
    )
      fail("Deletion proof target is invalid.", 403, "table_forbidden");
    const tombstone = this.deletionIntent;
    if (!tombstone?.purged || tombstone.generation === null)
      fail("The original table purge cannot be verified.", 503, "table_deletion_proof_unavailable");
    if (
      tombstone.pageId !== body.pageId ||
      tombstone.workspaceId !== body.workspaceId ||
      tombstone.generation !== body.generation
    )
      fail("Deletion proof generation changed.", 409, "table_generation_conflict");
    const owned = await this.env.DB.prepare(`SELECT locked.archived_at,locked.archive_operation_id
      FROM deletion_jobs job JOIN deletion_targets target ON target.job_id=job.id
      JOIN deletion_job_pages locked ON locked.job_id=job.id AND locked.page_id=?
      JOIN pages detail ON detail.id=locked.page_id AND detail.workspace_id=job.workspace_id
        AND detail.archived_at IS locked.archived_at AND detail.archive_operation_id IS locked.archive_operation_id
      WHERE job.id=? AND job.workspace_id=? AND job.phase='rows' AND job.next_attempt_at=?
        AND target.kind='table_row' AND target.target=? AND target.completed_at IS NULL AND json_valid(target.target)
        AND json_extract(target.target,'$.tableId')=? AND json_extract(target.target,'$.rowId')=?
        AND json_extract(target.target,'$.detailPageId')=? AND json_extract(target.target,'$.generation')=?
        AND NOT EXISTS(SELECT 1 FROM pages WHERE id=?) AND NOT EXISTS(SELECT 1 FROM table_authority WHERE page_id=?)
        AND NOT EXISTS(SELECT 1 FROM table_rows WHERE id=?)
        AND NOT EXISTS(SELECT 1 FROM table_row_pages WHERE row_id=? OR page_id=?)
        AND NOT EXISTS(SELECT 1 FROM table_id_claims WHERE kind='row' AND id=? AND page_id<>?)`)
      .bind(
        body.detailPageId,
        body.jobId,
        body.workspaceId,
        body.leaseUntil,
        body.target,
        body.pageId,
        body.rowId,
        body.detailPageId,
        body.generation,
        body.pageId,
        body.pageId,
        body.rowId,
        body.rowId,
        body.detailPageId,
        body.rowId,
        body.pageId,
      )
      .first<{ archived_at: number; archive_operation_id: string | null }>();
    if (!owned || owned.archived_at === null) fail("Deletion proof ownership changed.", 409, "deletion_pending");
    return {
      purged: true,
      pageId: body.pageId,
      workspaceId: body.workspaceId,
      generation: body.generation,
      purgeJobId: tombstone.jobId,
      archivedAt: owned.archived_at,
      archiveOperationId: owned.archive_operation_id,
    };
  }
  private async stopForDeletion(request: Request) {
    if (request.method !== "POST") fail("Use POST.", 405);
    const body = await request.json<{
      jobId: string;
      pageId: string;
      workspaceId: string;
      generation: number | null;
    }>();
    const proof = await this.authorizeDeletion(body, "stop");
    this.deletionIntent ??= {
      jobId: body.jobId,
      pageId: body.pageId,
      workspaceId: proof.job.workspace_id,
      generation: body.generation,
      stopped: false,
      purged: false,
    };
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES(2,?)", JSON.stringify(this.deletionIntent));
    await this.ctx.storage.deleteAlarm();
    await Promise.allSettled(
      [this.projecting, this.repairWork].filter((work): work is Promise<unknown> => work !== null),
    );
    await this.authorizeDeletion(body, "stop");
    this.deletionIntent.stopped = true;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES(2,?)", JSON.stringify(this.deletionIntent));
    await this.ctx.storage.deleteAlarm();
    return { ok: true, stopped: true, generation: body.generation };
  }
  private async purgeForDeletion(request: Request) {
    if (request.method !== "POST") fail("Use POST.", 405);
    const body = await request.json<{
      jobId: string;
      pageId: string;
      workspaceId?: string;
      generation?: number | null;
    }>();
    const proof = await this.authorizeDeletion(body, "purge");
    if (!proof.legacy && !this.deletionIntent?.stopped) fail("Deletion stop is incomplete.", 409, "deletion_pending");
    this.deletionIntent ??= {
      jobId: body.jobId,
      pageId: body.pageId,
      workspaceId: proof.job.workspace_id,
      generation: proof.generation,
      stopped: true,
      purged: false,
    };
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES(2,?)", JSON.stringify(this.deletionIntent));
    await Promise.allSettled(
      [this.projecting, this.repairWork].filter((work): work is Promise<unknown> => work !== null),
    );
    await this.authorizeDeletion(body, "purge");
    await this.ctx.storage.deleteAlarm();
    for (const socket of this.ctx.getWebSockets()) socket.close(1008, "Table permanently deleted.");
    this.ctx.storage.transactionSync(() => {
      this.deletionIntent!.purged = true;
      for (const table of [
        "properties",
        "rows",
        "row_revisions",
        "cells",
        "views",
        "people",
        "conversions",
        "converted_cells",
        "receipts",
        "computed",
        "staged_computed",
        "events",
        "projection_steps",
      ])
        this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
      this.ctx.storage.sql.exec("DELETE FROM meta WHERE id=1");
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta VALUES(2,?)", JSON.stringify(this.deletionIntent));
    });
    this.purged = true;
    return {
      ok: true,
      purged: true,
      jobId: this.deletionIntent.jobId,
      pageId: this.deletionIntent.pageId,
      workspaceId: this.deletionIntent.workspaceId,
      generation: this.deletionIntent.generation,
    };
  }
  private async applyProjection(statements: ProjectionStatement[], revision: number, advance = true) {
    this.requireActive();
    const meta = this.meta();
    try {
      await this.env.DB.batch([
        this.projectionGuard(),
        this.env.DB.prepare("INSERT OR REPLACE INTO table_projection_context VALUES(?,?)").bind(
          meta.pageId,
          meta.generation,
        ),
        ...compactProjection(statements).map((statement) =>
          this.env.DB.prepare(statement.sql).bind(...statement.binds),
        ),
        ...(advance
          ? [
              this.env.DB.prepare("UPDATE table_state SET revision=? WHERE page_id=?").bind(revision, meta.pageId),
              this.env.DB.prepare(
                "UPDATE table_authority SET projected_revision=? WHERE page_id=? AND generation=?",
              ).bind(revision, meta.pageId, meta.generation),
            ]
          : []),
        this.env.DB.prepare("DELETE FROM table_publication_guards WHERE page_id=?").bind(meta.pageId),
        this.env.DB.prepare("DELETE FROM table_projection_context WHERE page_id=?").bind(meta.pageId),
      ]);
    } catch (error) {
      await this.classifyProjectionFailure(error);
    }
    this.requireActive();
  }
  /** Guard recovery upserts and their foreign keys inside the same D1 transaction. */
  private async applyOwnedProjection(
    statements: ProjectionStatement[],
    revision: number,
    advance = false,
    cancellable = false,
  ) {
    const pageId = this.meta().pageId,
      references = new Map<string, Map<string, (string | number | null)[]>>();
    const remember = (table: string, values: (string | number | null)[]) => {
      if (!references.has(table)) references.set(table, new Map());
      references.get(table)!.set(JSON.stringify(values), values);
    };
    const guarded = statements.map((statement) => {
      const records = insertRecords(statement);
      for (const record of records) {
        if (["table_columns", "table_rows"].includes(record.table))
          remember(record.table, [recordValue(record, "id")!]);
        if (record.columns.includes("row_id")) remember("table_rows", [recordValue(record, "row_id")!]);
        if (record.columns.includes("column_id")) remember("table_columns", [recordValue(record, "column_id")!]);
        if (record.table === "table_select_options")
          remember("table_select_options", [recordValue(record, "id")!, recordValue(record, "column_id")!]);
        if (record.table === "table_cells" && recordValue(record, "select_value"))
          remember("table_select_options", [recordValue(record, "select_value")!, recordValue(record, "column_id")!]);
      }
      const table = records[0]?.table;
      if (table === "table_rows" || table === "table_columns")
        return { ...statement, sql: `${statement.sql} WHERE ${table}.page_id=excluded.page_id` };
      if (table === "table_select_options")
        return { ...statement, sql: `${statement.sql} WHERE table_select_options.column_id=excluded.column_id` };
      return statement;
    });
    for (const [table, values] of references) {
      const condition =
        table === "table_select_options"
          ? "EXISTS(SELECT 1 FROM table_select_options o JOIN table_columns c ON c.id=o.column_id WHERE o.id=json_extract(value,'$[0]') AND o.column_id=json_extract(value,'$[1]') AND c.page_id=?)"
          : `EXISTS(SELECT 1 FROM ${table} WHERE id=json_extract(value,'$[0]') AND page_id=?)`;
      const kind = table === "table_rows" ? "row" : table === "table_columns" ? "column" : "option";
      const tuples = [...values.values()];
      for (let offset = 0; offset < tuples.length; offset += REPAIR_ENTITY_LIMIT)
        guarded.push({
          sql: `INSERT OR REPLACE INTO table_publication_guards(page_id,ok) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(?) WHERE NOT (${condition}) OR EXISTS(SELECT 1 FROM table_id_claims WHERE kind='${kind}' AND id=json_extract(value,'$[0]') AND page_id<>?)) THEN 1 ELSE 0 END`,
          binds: [pageId, JSON.stringify(tuples.slice(offset, offset + REPAIR_ENTITY_LIMIT)), pageId, pageId],
        });
    }
    guarded.push({ sql: "DELETE FROM table_publication_guards WHERE page_id=?", binds: [pageId] });
    try {
      await this.applyProjection(guarded, revision, advance);
    } catch (error) {
      if (
        ["table_publication_conflict", "table_projection_ownership_conflict"].includes(
          (error as { code?: string }).code ?? "",
        )
      ) {
        if (cancellable)
          fail(
            "table_publication_conflict: Projection ownership changed during publication.",
            409,
            "table_publication_conflict",
          );
        fail("Projection ownership changed during recovery.", 503, "table_projection_blocked");
      }
      throw error;
    }
  }
  private normalizeEventProjection(event: { revision: number; value: string; next_step: number }) {
    if (JSON.parse(event.value)?.projectionFormat === 2) return;
    const remaining = this.rows<{ value: string }>(
      "SELECT value FROM projection_steps WHERE revision=? AND position>=? ORDER BY position",
      event.revision,
      event.next_step,
    ).flatMap((step) => {
      const statements = JSON.parse(step.value) as ProjectionStatement[];
      if (
        !Array.isArray(statements) ||
        statements.some((statement) => typeof statement.sql !== "string" || !Array.isArray(statement.binds))
      )
        return fail("Invalid persisted projection artifact.", 503, "table_projection_invalid");
      return statements;
    });
    const steps = projectionBatches(compactProjection(normalizeLegacyProjection(remaining)));
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM projection_steps WHERE revision=? AND position>=?",
        event.revision,
        event.next_step,
      );
      for (const [position, statements] of steps.entries())
        this.ctx.storage.sql.exec(
          "INSERT INTO projection_steps VALUES(?,?,?)",
          event.revision,
          event.next_step + position,
          JSON.stringify(statements),
        );
      this.ctx.storage.sql.exec(
        "UPDATE events SET value=? WHERE revision=?",
        JSON.stringify({ ...JSON.parse(event.value), projectionFormat: 2 }),
        event.revision,
      );
    });
  }
  private pruneCompletedProjection() {
    const projected = this.meta().projectedRevision;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM projection_steps WHERE rowid IN (SELECT rowid FROM projection_steps WHERE revision<=? LIMIT 500)",
        projected,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM events WHERE revision IN (SELECT revision FROM events WHERE revision<=? ORDER BY revision DESC LIMIT 500 OFFSET 100)",
        projected,
      );
    });
    return (
      this.rows("SELECT 1 FROM projection_steps WHERE revision<=? LIMIT 1", projected).length > 0 ||
      this.rows("SELECT 1 FROM events WHERE revision<=? ORDER BY revision DESC LIMIT 1 OFFSET 100", projected).length >
        0
    );
  }
  private eventPrerequisites(event: PendingEvent): Prerequisite[] {
    const marker = prerequisiteJson(event.value);
    if (marker.prerequisiteFormat === undefined) return [];
    if (
      marker.prerequisiteFormat !== 1 ||
      !Number.isSafeInteger(marker.prerequisiteChunks) ||
      marker.prerequisiteChunks < 0
    )
      return fail("Invalid prerequisite marker.", 503, "table_projection_blocked");
    const chunks = this.rows<{ position: number; value: string }>(
      "SELECT position,value FROM projection_steps WHERE revision=? AND position<0 ORDER BY position DESC",
      event.revision,
    );
    if (chunks.length !== marker.prerequisiteChunks)
      return fail("Missing prerequisite chunk.", 503, "table_projection_blocked");
    const records: Prerequisite[] = [];
    let fragmented = "",
      nextPart = 0,
      expectedParts = 0,
      entry = -1;
    for (const [index, chunk] of chunks.entries()) {
      if (chunk.position !== -index - 1 || new TextEncoder().encode(chunk.value).byteLength > PROJECTION_MAX_BYTES)
        return fail("Invalid prerequisite chunk.", 503, "table_projection_blocked");
      const packet = prerequisiteJson(chunk.value);
      if (Array.isArray(packet.records)) {
        if (nextPart) return fail("Incomplete prerequisite entry.", 503, "table_projection_blocked");
        records.push(...packet.records);
      } else {
        if (
          typeof packet.data !== "string" ||
          packet.part !== nextPart ||
          !Number.isSafeInteger(packet.parts) ||
          packet.parts < 1 ||
          packet.part >= packet.parts ||
          (nextPart > 0 && packet.parts !== expectedParts) ||
          packet.entry !== (nextPart ? entry : records.length)
        )
          return fail("Invalid prerequisite fragment.", 503, "table_projection_blocked");
        entry = packet.entry;
        expectedParts = packet.parts;
        fragmented += packet.data;
        nextPart++;
        if (nextPart === packet.parts) {
          records.push(prerequisiteJson(fragmented));
          fragmented = "";
          nextPart = 0;
          expectedParts = 0;
        }
      }
    }
    if (nextPart) return fail("Incomplete prerequisite entry.", 503, "table_projection_blocked");
    for (const record of records) {
      if (!record || typeof record !== "object") fail("Invalid prerequisite record.", 503, "table_projection_blocked");
      const template = PROJECTION_INSERT_SQL[record.table as keyof typeof PROJECTION_INSERT_SQL];
      if (
        !template ||
        !["table_columns", "table_select_options", "table_rows", "table_row_pages"].includes(record.table) ||
        !Array.isArray(record.columns) ||
        !Array.isArray(record.binds) ||
        insertRecords({ sql: template, binds: record.binds })[0]?.columns.join(",") !== record.columns.join(",")
      )
        return fail("Invalid prerequisite record.", 503, "table_projection_blocked");
      if (!validProjectionRecord(record)) return fail("Invalid prerequisite bind.", 503, "table_projection_blocked");
    }
    return records;
  }
  private async recoverProjectionParents(
    event: PendingEvent,
    statements: ProjectionStatement[],
  ): Promise<false | ProjectionStatement[]> {
    const meta = this.meta(),
      sources = new Map(this.eventPrerequisites(event).map((record) => [prerequisiteKey(record), record]));
    for (const step of this.rows<{ value: string }>(
      "SELECT value FROM projection_steps WHERE revision=? AND position>=0 AND position<? ORDER BY position",
      event.revision,
      event.next_step,
    ))
      for (const statement of JSON.parse(step.value) as ProjectionStatement[])
        for (const record of insertRecords(statement))
          if (["table_columns", "table_select_options", "table_rows", "table_row_pages"].includes(record.table))
            sources.set(prerequisiteKey(record), record);
    const needed = new Set<string>(),
      provided = new Set<string>(),
      optionColumns = new Map<string, string>();
    for (const statement of statements)
      for (const record of insertRecords(statement)) {
        for (const [table, field] of [
          ["table_columns", "column_id"],
          ["table_rows", "row_id"],
          ["table_select_options", "select_value"],
        ] as const) {
          const value = recordValue(record, field);
          if (typeof value === "string" && !provided.has(`${table}:${value}`)) needed.add(`${table}:${value}`);
        }
        if (record.table === "table_cells" && typeof recordValue(record, "select_value") === "string")
          optionColumns.set(String(recordValue(record, "select_value")), String(recordValue(record, "column_id")));
        provided.add(prerequisiteKey(record));
      }
    // A latest ordinary event can use unchanged current metadata. Older queues
    // require their captured preimages; future schema is never installed early.
    if (event.revision === meta.revision && !event.cancel_row_id) {
      const changed = new Set(
        this.rows<{ value: string }>(
          "SELECT value FROM projection_steps WHERE revision=? AND position>=0",
          event.revision,
        )
          .flatMap((step) => (JSON.parse(step.value) as ProjectionStatement[]).flatMap(insertRecords))
          .filter((record) => record.table === "table_columns")
          .map(prerequisiteKey),
      );
      for (const column of this.columns()) {
        if (changed.has(`table_columns:${column.id}`)) continue;
        for (const statement of this.columnProjection(column)) {
          const record = insertRecords(statement)[0]!;
          if (!sources.has(prerequisiteKey(record))) sources.set(prerequisiteKey(record), record);
        }
      }
    }
    // Selected options depend on their owning column, even if no cell references it.
    for (const key of needed) {
      const record = sources.get(key);
      if (record?.table === "table_select_options") needed.add(`table_columns:${recordValue(record, "column_id")}`);
    }
    // A task link is itself a prerequisite for status activity triggers.
    for (const statement of statements)
      for (const record of insertRecords(statement))
        if (record.table === "table_row_pages" && !sources.has(prerequisiteKey(record)))
          sources.set(prerequisiteKey(record), record);
    for (const key of needed)
      if (key.startsWith("table_rows:") && sources.has(`table_row_pages:${key.slice(11)}`))
        needed.add(`table_row_pages:${key.slice(11)}`);
    const marker = prerequisiteJson(event.value);
    const order = ["table_columns", "table_select_options", "table_rows", "table_row_pages"];
    const required = marker.recoveryRequired;
    if (
      required !== undefined &&
      (!required ||
        typeof required !== "object" ||
        required.generation !== meta.generation ||
        required.revision !== event.revision ||
        required.position !== event.next_step)
    )
      fail("Invalid prerequisite recovery retry marker.", 503, "table_projection_blocked");
    const keys = [...needed].sort(
      (left, right) =>
        order.indexOf(left.split(":")[0]!) - order.indexOf(right.split(":")[0]!) ||
        (left < right ? -1 : left > right ? 1 : 0),
    );
    let cursor = marker.recovery as RecoveryCursor | undefined;
    if (cursor !== undefined) {
      if (
        !cursor ||
        typeof cursor !== "object" ||
        cursor.revision !== event.revision ||
        cursor.position !== event.next_step ||
        !order.includes(cursor.table) ||
        !keys.includes(cursor.key) ||
        !cursor.key.startsWith(`${cursor.table}:`)
      )
        fail("Invalid prerequisite recovery cursor.", 503, "table_projection_blocked");
      if (cursor.generation === undefined) {
        this.clearRecovery(event.revision);
        delete marker.recovery;
        marker.recoveryRequired = { generation: meta.generation, revision: event.revision, position: event.next_step };
        cursor = undefined;
      } else if (cursor.generation !== meta.generation)
        fail("Prerequisite recovery generation changed.", 503, "table_projection_blocked");
    }
    const remaining = keys.filter(
      (key) =>
        !cursor ||
        order.indexOf(key.split(":")[0]!) > order.indexOf(cursor.table) ||
        (key.startsWith(`${cursor.table}:`) && key > cursor.key),
    );
    const selected = remaining.slice(0, REPAIR_ENTITY_LIMIT);
    let recovered = false;
    for (const table of order) {
      const restored: ProjectionStatement[] = [];
      const links: LinkTarget[] = [];
      const ids = selected.filter((key) => key.startsWith(`${table}:`)).map((key) => key.slice(table.length + 1));
      if (!ids.length) continue;
      const records = ids.flatMap((targetId) => sources.get(`${table}:${targetId}`) ?? []);
      const state = await this.structuralState(table, ids, records);
      for (const targetId of ids) {
        const key = `${table}:${targetId}`,
          record = sources.get(key),
          current = state.current.get(targetId);
        if (state.claims.get(targetId) && state.claims.get(targetId) !== meta.pageId)
          fail("Prerequisite identity belongs to another table.", 503, "table_projection_blocked");
        if (
          current &&
          (current.page_id !== meta.pageId ||
            (table === "table_select_options" &&
              current.column_id !==
                (optionColumns.get(targetId) ?? (record ? recordValue(record, "column_id") : undefined))))
        )
          fail("Projection parent belongs to another table.", 503, "table_projection_blocked");
        if (table === "table_row_pages") {
          if (!record) fail(`Historical prerequisite ${key} is unavailable.`, 503, "table_projection_blocked");
          this.validateDetailRecord(record, state);
          if (state.links.get(targetId)?.page_id === recordValue(record, "page_id")) continue;
        } else if (current) continue;
        if (!record) fail(`Historical prerequisite ${key} is unavailable.`, 503, "table_projection_blocked");
        if (
          table !== "table_select_options" &&
          table !== "table_row_pages" &&
          recordValue(record, "page_id") !== meta.pageId
        )
          fail("Prerequisite belongs to another table.", 503, "table_projection_blocked");
        if (
          table === "table_select_options" &&
          optionColumns.has(targetId) &&
          recordValue(record, "column_id") !== optionColumns.get(targetId)
        )
          fail("Historical option belongs to another property.", 503, "table_projection_blocked");
        if (table === "table_rows") {
          if (
            this.rows(
              "SELECT 1 FROM receipts WHERE json_extract(result,'$.result.rowId')=? AND json_extract(result,'$.result.publicationFailed')=1 LIMIT 1",
              targetId,
            ).length
          )
            fail("Publication denied this row.", 503, "table_projection_blocked");
          for (const field of ["created_by", "updated_by"]) {
            const user = recordValue(record, field);
            if (user && !state.users.has(String(user)))
              fail("Prerequisite user is unavailable.", 503, "table_projection_blocked");
          }
        }
        if (table === "table_row_pages") {
          links.push([
            targetId,
            String(recordValue(record, "page_id")),
            Number(recordValue(record, "created_at")),
            state.links.get(targetId)?.page_id ?? null,
          ]);
        } else
          restored.push({
            sql: `INSERT INTO ${table}(${record.columns.join(",")}) VALUES(${record.binds.map(() => "?").join(",")}) ON CONFLICT DO NOTHING`,
            binds: record.binds,
          });
      }
      if (links.length) restored.push(...this.reconcileLinks(links, meta));
      if (restored.length) {
        await this.applyOwnedProjection(
          compactProjection(restored),
          event.revision,
          false,
          Boolean(event.cancel_row_id) && event.next_step === 0,
        );
        recovered = true;
      }
    }
    if (!recovered && !cursor && !marker.recoveryRequired && remaining.length <= REPAIR_ENTITY_LIMIT)
      fail("Missing foreign-key evidence cannot be recovered.", 503, "table_projection_blocked");
    const last = selected.at(-1);
    if (last && remaining.length > selected.length) {
      this.requireActive();
      this.ctx.storage.sql.exec(
        "UPDATE events SET value=? WHERE revision=?",
        JSON.stringify({
          ...marker,
          recovery: {
            generation: meta.generation,
            revision: event.revision,
            position: event.next_step,
            table: last.split(":")[0],
            key: last,
          },
        }),
        event.revision,
      );
      await this.scheduleAlarm(1000);
      return false;
    }
    const guards: ProjectionStatement[] = [];
    const links = keys.filter((key) => key.startsWith("table_row_pages:")).map((key) => sources.get(key)!);
    for (let offset = 0; offset < links.length; offset += REPAIR_ENTITY_LIMIT) {
      const targets: LinkTarget[] = links
        .slice(offset, offset + REPAIR_ENTITY_LIMIT)
        .map((record) => [
          String(recordValue(record, "row_id")),
          String(recordValue(record, "page_id")),
          Number(recordValue(record, "created_at")),
          String(recordValue(record, "page_id")),
        ]);
      guards.push(this.linkRelationshipGuard(targets, meta));
    }
    return guards;
  }
  private clearRecovery(revision?: number) {
    this.requireActive();
    if (revision === undefined)
      this.ctx.storage.sql.exec(
        "UPDATE events SET value=json_set(json_remove(value,'$.recovery'),'$.recoveryRequired',json_object('generation',?,'revision',revision,'position',next_step)) WHERE revision>? AND (json_type(value,'$.recovery') IS NOT NULL OR json_type(value,'$.recoveryRequired') IS NOT NULL)",
        this.meta().generation,
        this.meta().projectedRevision,
      );
    else
      this.ctx.storage.sql.exec(
        "UPDATE events SET value=json_set(json_remove(value,'$.recovery'),'$.recoveryRequired',json_object('generation',?,'revision',revision,'position',next_step)) WHERE revision=?",
        this.meta().generation,
        revision,
      );
  }
  private async structuralState(table: string, ids: string[], records: Prerequisite[]) {
    const serialized = JSON.stringify(ids),
      byId = new Map<string, { page_id: string; column_id?: string }>();
    const currentSql =
      table === "table_select_options"
        ? "SELECT o.id,o.column_id,c.page_id FROM table_select_options o JOIN table_columns c ON c.id=o.column_id WHERE o.id IN (SELECT value FROM json_each(?))"
        : `SELECT id,page_id FROM ${table === "table_row_pages" ? "table_rows" : table} WHERE id IN (SELECT value FROM json_each(?))`;
    for (const row of (
      await this.env.DB.prepare(currentSql).bind(serialized).all<{ id: string; page_id: string; column_id?: string }>()
    ).results)
      byId.set(row.id, row);
    const kind =
      table === "table_rows" || table === "table_row_pages" ? "row" : table === "table_columns" ? "column" : "option";
    const claims = new Map(
      (
        await this.env.DB.prepare(
          "SELECT id,page_id FROM table_id_claims WHERE kind=? AND id IN (SELECT value FROM json_each(?))",
        )
          .bind(kind, serialized)
          .all<{ id: string; page_id: string }>()
      ).results.map((claim) => [claim.id, claim.page_id]),
    );
    const userIds = [
      ...new Set(
        records
          .flatMap((record) => [recordValue(record, "created_by"), recordValue(record, "updated_by")])
          .filter((value): value is string => typeof value === "string"),
      ),
    ];
    const users = new Set(
      userIds.length
        ? (
            await this.env.DB.prepare("SELECT id FROM user WHERE id IN (SELECT value FROM json_each(?))")
              .bind(JSON.stringify(userIds))
              .all<{ id: string }>()
          ).results.map((user) => user.id)
        : [],
    );
    const links = new Map<string, { row_id: string; page_id: string; workspace_id: string }>(),
      pages = new Map<string, string>();
    if (table === "table_row_pages") {
      const details = records.map((record) => recordValue(record, "page_id"));
      for (const link of (
        await this.env.DB.prepare(
          "SELECT link.row_id,link.page_id,p.workspace_id FROM table_row_pages link JOIN pages p ON p.id=link.page_id WHERE link.row_id IN (SELECT value FROM json_each(?)) OR link.page_id IN (SELECT value FROM json_each(?))",
        )
          .bind(serialized, JSON.stringify(details))
          .all<{ row_id: string; page_id: string; workspace_id: string }>()
      ).results)
        links.set(link.row_id, link);
      for (const page of (
        await this.env.DB.prepare("SELECT id,workspace_id FROM pages WHERE id IN (SELECT value FROM json_each(?))")
          .bind(JSON.stringify(details))
          .all<{ id: string; workspace_id: string }>()
      ).results)
        pages.set(page.id, page.workspace_id);
    }
    return { current: byId, claims, users, links, pages };
  }
  private validateDetailRecord(
    record: Prerequisite,
    state: Awaited<ReturnType<TableAuthority["structuralState"]>>,
    allowMissingRow = false,
  ) {
    const meta = this.meta(),
      rowId = String(recordValue(record, "row_id")),
      detailId = String(recordValue(record, "page_id"));
    if (
      (state.current.has(rowId) ? state.current.get(rowId)!.page_id !== meta.pageId : !allowMissingRow) ||
      (state.claims.has(rowId) && state.claims.get(rowId) !== meta.pageId) ||
      state.pages.get(detailId) !== meta.workspaceId ||
      [...state.links.values()].some(
        (link) =>
          (link.row_id === rowId && link.workspace_id !== meta.workspaceId) ||
          (link.page_id === detailId && link.row_id !== rowId),
      )
    )
      fail("Repair detail ownership is unavailable.", 503, "table_projection_blocked");
  }
  /** This bounded link transaction must never be split by generic projection batching. */
  private reconcileLinks(targets: LinkTarget[], meta: Meta): ProjectionStatement[] {
    if (targets.length > REPAIR_ENTITY_LIMIT) fail("Too many link prerequisites.", 503, "table_projection_blocked");
    const tuples = JSON.stringify(targets);
    return [
      {
        sql: "INSERT OR REPLACE INTO table_publication_guards(page_id,ok) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(?) WHERE NOT EXISTS(SELECT 1 FROM table_rows WHERE id=json_extract(value,'$[0]') AND page_id=?) OR EXISTS(SELECT 1 FROM table_id_claims WHERE kind='row' AND id=json_extract(value,'$[0]') AND page_id<>?) OR (json_extract(value,'$[1]') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pages WHERE id=json_extract(value,'$[1]') AND workspace_id=?)) OR (json_extract(value,'$[3]') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pages WHERE id=json_extract(value,'$[3]') AND workspace_id=?)) OR EXISTS(SELECT 1 FROM table_row_pages WHERE row_id=json_extract(value,'$[0]') AND page_id IS NOT json_extract(value,'$[3]')) OR EXISTS(SELECT 1 FROM table_row_pages WHERE page_id=json_extract(value,'$[1]') AND row_id<>json_extract(value,'$[0]'))) THEN 1 ELSE 0 END",
        binds: [meta.pageId, tuples, meta.pageId, meta.pageId, meta.workspaceId, meta.workspaceId],
      },
      {
        sql: "DELETE FROM table_row_pages WHERE EXISTS(SELECT 1 FROM json_each(?) WHERE row_id=json_extract(value,'$[0]') AND page_id=json_extract(value,'$[3]') AND page_id IS NOT json_extract(value,'$[1]'))",
        binds: [tuples],
      },
      ...targets
        .filter((target) => target[1] !== null)
        .map((target) => ({ sql: PROJECTION_INSERT_SQL.table_row_pages, binds: target.slice(0, 3) })),
      this.linkRelationshipGuard(targets, meta),
    ];
  }
  private linkRelationshipGuard(targets: LinkTarget[], meta: Meta): ProjectionStatement {
    return {
      sql: "INSERT OR REPLACE INTO table_publication_guards(page_id,ok) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM json_each(?) WHERE NOT EXISTS(SELECT 1 FROM table_rows WHERE id=json_extract(value,'$[0]') AND page_id=?) OR EXISTS(SELECT 1 FROM table_id_claims WHERE kind='row' AND id=json_extract(value,'$[0]') AND page_id<>?) OR (json_extract(value,'$[1]') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM table_row_pages link JOIN pages detail ON detail.id=link.page_id WHERE link.row_id=json_extract(value,'$[0]') AND detail.id=json_extract(value,'$[1]') AND detail.workspace_id=?)) OR (json_extract(value,'$[1]') IS NULL AND EXISTS(SELECT 1 FROM table_row_pages WHERE row_id=json_extract(value,'$[0]')))) THEN 1 ELSE 0 END",
      binds: [meta.pageId, JSON.stringify(targets), meta.pageId, meta.pageId, meta.workspaceId],
    };
  }
  private async project(recover = false): Promise<boolean> {
    this.requireActive();
    if (this.projecting) {
      try {
        await this.projecting;
      } catch (error) {
        if (!recover || !missingProjectionParent(error)) throw error;
      }
      return recover ? this.project(true) : true;
    }
    this.projecting = (async () => {
      while (true) {
        const meta = this.meta(),
          event = this.rows<PendingEvent>(
            "SELECT revision,operation_id,value,cancel_row_id,next_step FROM events WHERE revision>? ORDER BY revision LIMIT 1",
            meta.projectedRevision,
          )[0];
        if (!event) break;
        const artifactSteps = this.rows<{ count: number }>(
          "SELECT count(*) count FROM projection_steps WHERE revision=? AND position>=0",
          event.revision,
        )[0]!.count;
        let atomicCancellation = false;
        try {
          if (event.cancel_row_id && (artifactSteps !== 1 || event.next_step !== 0))
            fail("Cancellable publication has a non-atomic projection artifact.", 503, "table_projection_blocked");
          this.normalizeEventProjection(event);
          const steps = this.rows<{ position: number; value: string }>(
            "SELECT position,value FROM projection_steps WHERE revision=? AND position>=? ORDER BY position",
            event.revision,
            event.next_step,
          );
          if (event.cancel_row_id && (steps.length !== 1 || steps[0]!.position !== 0))
            fail("Cancellable publication normalized into a non-atomic artifact.", 503, "table_projection_blocked");
          atomicCancellation = Boolean(event.cancel_row_id) && artifactSteps === 1 && steps.length === 1;
          if (!steps.length) await this.applyProjection([], event.revision);
          for (const [index, step] of steps.entries()) {
            if (this.purged || this.deletionIntent) return false;
            const statements = JSON.parse(step.value) as ProjectionStatement[];
            const replayRecovered = async () => {
              const prerequisites = await this.recoverProjectionParents(event, statements);
              if (prerequisites === false) return false;
              try {
                await this.applyOwnedProjection(
                  [...prerequisites, ...statements],
                  event.revision,
                  index === steps.length - 1,
                  Boolean(event.cancel_row_id) && event.next_step === 0 && steps.length === 1,
                );
              } catch (retryError) {
                if (!this.purged && !this.deletionIntent) this.clearRecovery(event.revision);
                if (missingProjectionParent(retryError))
                  fail("Projection still lacks a verified prerequisite.", 503, "table_projection_blocked");
                throw retryError;
              }
              return true;
            };
            const marker = prerequisiteJson(event.value);
            if (marker.recovery !== undefined || marker.recoveryRequired !== undefined) {
              if (!(await replayRecovered())) return false;
            } else {
              try {
                await this.applyProjection(statements, event.revision, index === steps.length - 1);
              } catch (error) {
                if (!recover || !missingProjectionParent(error)) throw error;
                if (!(await replayRecovered())) return false;
              }
            }
            if (this.purged || this.deletionIntent) return false;
            this.ctx.storage.sql.exec(
              "UPDATE events SET next_step=?,value=json_remove(value,'$.recovery','$.recoveryRequired') WHERE revision=?",
              step.position + 1,
              event.revision,
            );
            event.next_step = step.position + 1;
            event.value = this.rows<{ value: string }>(
              "SELECT value FROM events WHERE revision=?",
              event.revision,
            )[0]!.value;
          }
        } catch (error) {
          if (!atomicCancellation || (error as { code?: string }).code !== "table_publication_conflict") throw error;
          const publication = await this.env.DB.prepare(
            "SELECT generation,projected_revision FROM table_authority WHERE page_id=?",
          )
            .bind(meta.pageId)
            .first<{ generation: number; projected_revision: number }>();
          this.requireActive();
          const current = this.rows<PendingEvent>(
            "SELECT revision,operation_id,value,cancel_row_id,next_step FROM events WHERE revision=?",
            event.revision,
          )[0];
          if (
            publication?.generation !== meta.generation ||
            publication.projected_revision >= event.revision ||
            this.meta().projectedRevision >= event.revision ||
            !current ||
            current.next_step !== 0 ||
            current.cancel_row_id !== event.cancel_row_id ||
            this.rows<{ count: number }>(
              "SELECT count(*) count FROM projection_steps WHERE revision=? AND position>=0",
              event.revision,
            )[0]!.count !== 1
          )
            throw error;
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
        if (this.purged || this.deletionIntent) return false;
        this.ctx.storage.transactionSync(() => {
          this.putMeta({ ...this.meta(), projectedRevision: event.revision });
          this.ctx.storage.sql.exec("DELETE FROM projection_steps WHERE revision=?", event.revision);
        });
        await broadcastWorkspaceEvent(this.env, meta.workspaceId, {
          type: "task-list-invalidated",
          pageId: meta.pageId,
          forceRefresh: true,
        });
      }
      if (this.pruneCompletedProjection() && !this.purged) await this.scheduleAlarm(1000);
      return true;
    })();
    try {
      return await this.projecting;
    } finally {
      this.projecting = null;
    }
  }
  private repairHeaders(seedBaseline: boolean): ProjectionStatement[] {
    const meta = this.meta();
    return [
      ...(!seedBaseline
        ? [
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
        sql: PROJECTION_INSERT_SQL.table_people,
        binds: [meta.pageId, person.id, person.name],
      })),
    ];
  }
  private repairRow(row: StoredRow): ProjectionStatement[] {
    const statements = this.rowProjection(row);
    for (const cell of this.rows<{ column_id: string; value: string; revision: number }>(
      "SELECT * FROM cells WHERE row_id=?",
      row.id,
    ))
      statements.push(
        this.cellProjection(row.id, cell.column_id, JSON.parse(cell.value), cell.revision, row.edited_at),
      );
    statements.push(...this.computedProjection(row.id, this.meta().revision));
    return statements;
  }
  private snapshot(): TableSnapshot {
    return {
      revision: this.meta().revision,
      columns: this.columns(),
      views: this.rows<{ value: string }>("SELECT value FROM views ORDER BY id").map(
        (view) => JSON.parse(view.value) as TableView,
      ),
      people: this.rows<{ id: string; name: string }>("SELECT * FROM people ORDER BY id"),
      rows: this.rows<StoredRow>("SELECT * FROM rows ORDER BY id").map((row) => this.rowValue(row)),
    };
  }
  private normalizeRepairState() {
    this.ctx.storage.transactionSync(() => {
      const meta = this.meta(),
        projection: ProjectionStatement[] = [];
      for (const column of this.columns()) {
        if (
          !column.options.some((option, index) => index > 0 && option.position <= column.options[index - 1]!.position)
        )
          continue;
        const next = {
          ...column,
          revision: column.revision + 1,
          options: column.options.map((option, position) => ({ ...option, position })),
        };
        this.ctx.storage.sql.exec("UPDATE properties SET value=? WHERE id=?", JSON.stringify(next), column.id);
        projection.push(...this.columnProjection(next));
      }
      const ids = new Set(this.columns().map((column) => column.id));
      for (const stored of this.rows<{ id: string; value: string }>("SELECT id,value FROM views")) {
        const view = JSON.parse(stored.value) as TableView;
        const visible = view.visibleColumnIds.filter((propertyId) => ids.has(propertyId));
        if (visible.length === view.visibleColumnIds.length) continue;
        const next = { ...view, visibleColumnIds: visible, revision: view.revision + 1 };
        this.ctx.storage.sql.exec("UPDATE views SET value=? WHERE id=?", JSON.stringify(next), stored.id);
        projection.push(this.viewProjection(next));
      }
      if (!projection.length) return;
      const revision = meta.revision + 1;
      this.putMeta({ ...meta, revision });
      this.ctx.storage.sql.exec(
        "INSERT INTO events(revision,operation_id,value) VALUES(?,?,?)",
        revision,
        `repair-normalize:${meta.generation}:${revision}`,
        JSON.stringify({ projectionFormat: 2 }),
      );
      for (const [position, statements] of projectionBatches(compactProjection(projection)).entries())
        this.ctx.storage.sql.exec(
          "INSERT INTO projection_steps VALUES(?,?,?)",
          revision,
          position,
          JSON.stringify(statements),
        );
    });
  }
  private repair(seedBaseline: true): Promise<void> {
    return this.trackRepair(() => this.repairSeed(seedBaseline));
  }
  private async repairSeed(seedBaseline: true): Promise<void> {
    try {
      if (!seedBaseline || this.rows("SELECT revision FROM events LIMIT 1").length)
        return fail("A seed baseline cannot replace committed table events.", 409, "table_seed_conflict");
      await this.project();
      const meta = this.meta();
      // D1 remains the frozen seed source until successful cutover.
      for (const batch of projectionBatches(compactProjection(this.repairHeaders(true))))
        await this.applyProjection(batch, meta.revision, false);
      for (const row of this.rows<StoredRow>("SELECT * FROM rows ORDER BY id"))
        await this.applyProjection(this.repairRow(row), meta.revision, false);
      await this.applyProjection([], meta.revision);
      this.putMeta({ ...this.meta(), projectedRevision: meta.revision });
    } catch (error) {
      if (!this.purged) await this.scheduleAlarm(1000);
      throw error;
    }
  }
  private remainingPure() {
    const meta = this.meta();
    const events = this.rows<PendingEvent>(
      "SELECT * FROM events WHERE revision>? ORDER BY revision",
      meta.projectedRevision,
    );
    if (!events.length) return null;
    for (const event of events) {
      if (event.cancel_row_id) return null;
      this.normalizeEventProjection(event);
      for (const step of this.rows<{ value: string }>(
        "SELECT value FROM projection_steps WHERE revision=? AND position>=? ORDER BY position",
        event.revision,
        event.next_step,
      )) {
        for (const statement of JSON.parse(step.value) as ProjectionStatement[]) {
          if (!pureProjection(statement, meta.pageId) && !bookkeepingProjection(statement)) return null;
          if (
            bookkeepingProjection(statement) &&
            statement.binds[statement.sql.startsWith("UPDATE") ? 2 : 0] !== meta.pageId
          )
            return null;
          for (const record of insertRecords(statement))
            if (
              ["table_columns", "table_rows", "table_views", "table_people"].includes(record.table) &&
              recordValue(record, "page_id") !== meta.pageId
            )
              return null;
        }
      }
    }
    return events[0]!.revision;
  }
  private async repairRowsStatements(rows: StoredRow[]) {
    const meta = this.meta(),
      ids = rows.map((row) => row.id),
      properties = new Map(this.columns().map((column) => [column.id, column])),
      prepared = rows.map((row) => ({ row, projection: this.rowProjection(row, meta, this.rowRevision(row.id)) }));
    const owners = await this.structuralState(
      "table_rows",
      ids,
      prepared.flatMap((item) => insertRecords(item.projection[0]!)),
    );
    const details = await this.structuralState(
      "table_row_pages",
      ids,
      prepared.flatMap((item) => item.projection.slice(1).flatMap(insertRecords)),
    );
    for (const { row, projection } of prepared) {
      if (
        (owners.current.has(row.id) && owners.current.get(row.id)!.page_id !== meta.pageId) ||
        (owners.claims.has(row.id) && owners.claims.get(row.id) !== meta.pageId)
      )
        fail("Repair row belongs to another table.", 503, "table_projection_blocked");
      for (const user of [row.created_by, row.edited_by])
        if (user && !owners.users.has(user)) fail("Prerequisite user is unavailable.", 503, "table_projection_blocked");
      if (details.links.has(row.id) && details.links.get(row.id)!.workspace_id !== meta.workspaceId)
        fail("Repair detail belongs to another workspace.", 503, "table_projection_blocked");
      if (row.detail_page_id) this.validateDetailRecord(insertRecords(projection[1]!)[0]!, details, true);
    }
    const batches = projectionBatches(
      compactProjection(
        prepared.map(({ projection }) => ({
          ...projection[0]!,
          sql: `${PROJECTION_INSERT_SQL.table_rows.replace("DO UPDATE SET ", "DO UPDATE SET created_by=excluded.created_by,created_at=excluded.created_at,")} WHERE table_rows.page_id=excluded.page_id`,
        })),
      ),
    );
    // Reconcile all links before status-cell triggers, in one guarded transaction.
    batches.push(
      compactProjection(
        this.reconcileLinks(
          rows.map((row) => [row.id, row.detail_page_id, row.created_at, details.links.get(row.id)?.page_id ?? null]),
          meta,
        ),
      ),
    );
    const cells: ProjectionStatement[] = [];
    for (const row of rows)
      for (const cell of this.rows<{ column_id: string; value: string; revision: number }>(
        "SELECT * FROM cells WHERE row_id=?",
        row.id,
      ))
        cells.push(
          this.cellProjection(
            row.id,
            cell.column_id,
            JSON.parse(cell.value),
            cell.revision,
            row.edited_at,
            properties.get(cell.column_id),
          ),
        );
    cells.push({ sql: COMPUTED_DELETE_SQL, binds: [JSON.stringify(ids), meta.pageId] });
    for (const row of rows) cells.push(...this.computedProjection(row.id, meta.revision).slice(1));
    batches.push(...projectionBatches(compactProjection(cells)));
    return batches;
  }
  private resumeRepair(ownerRetry = false) {
    return this.trackRepair(() => this.performRepair(ownerRetry));
  }
  private async performRepair(ownerRetry: boolean) {
    try {
      const initial = this.meta();
      if (ownerRetry && initial.repairIntent) {
        initial.repairIntent.mismatches = 0;
        this.putMeta(initial);
      }
      if (!initial.seeded)
        return fail("Pending table publications must complete before repair.", 503, "table_projection_pending");
      if (initial.repairIntent?.phase === "blocked") {
        if (!ownerRetry) return { pending: true as const };
        const { blocked, ...retry } = initial.repairIntent;
        if ((blocked?.resumePhase ?? "drain") === "drain") this.clearRecovery();
        this.putMeta({ ...initial, repairIntent: { ...retry, phase: blocked?.resumePhase ?? "drain" } });
      } else if (!initial.repairIntent)
        this.putMeta({ ...initial, repairIntent: { generation: initial.generation, version: 2, phase: "fence" } });
      await this.scheduleAlarm(1000);
      let intent = this.meta().repairIntent!;
      const registry = await this.env.DB.prepare("SELECT generation,state FROM table_authority WHERE page_id=?")
        .bind(initial.pageId)
        .first<{ generation: number; state: string }>();
      if (!registry || registry.generation !== intent.generation || intent.generation !== initial.generation)
        return fail("Repair generation changed.", 409, "table_generation_conflict");
      if (!["do", "repairing"].includes(registry.state))
        return fail("Table is not ready for repair.", 503, "table_seed_pending");
      const fenced = await this.env.DB.prepare(
        "UPDATE table_authority SET state='repairing' WHERE page_id=? AND generation=? AND state IN ('do','repairing')",
      )
        .bind(initial.pageId, intent.generation)
        .run();
      if (!fenced.meta.changes) return fail("Repair generation changed.", 409, "table_generation_conflict");
      const setIntent = (next: RepairIntent) => {
        intent = next;
        this.putMeta({ ...this.meta(), repairIntent: next });
      };
      if (intent.version !== 2)
        setIntent({
          generation: intent.generation,
          version: 2,
          phase: ["fence", "drain"].includes(intent.phase) ? "drain" : "headers",
          ...(intent.revision === undefined ? {} : { revision: intent.revision }),
          headerStep: 0,
        });
      if (intent.phase === "fence") setIntent({ ...intent, phase: "drain" });
      if (intent.phase === "drain") {
        try {
          await this.project(true);
        } catch (error) {
          if ((error as { code?: string }).code !== "table_projection_blocked") throw error;
          if (this.remainingPure() === null) throw error;
          this.normalizeRepairState();
          const pureFrom = this.remainingPure()!;
          setIntent({ ...intent, mode: "pure", pureFrom, phase: "bookkeeping", revision: this.meta().revision });
        }
        if (intent.phase === "drain" && this.meta().projectedRevision < this.meta().revision)
          return { pending: true as const };
        if (intent.phase === "drain") {
          this.normalizeRepairState();
          if (!(await this.project(true))) return { pending: true as const };
          if (this.meta().projectedRevision !== this.meta().revision)
            return fail("Pending table publications must complete before repair.", 503, "table_projection_pending");
          setIntent({ ...intent, phase: "headers", revision: this.meta().revision, headerStep: 0 });
        }
      }
      if (intent.revision !== this.meta().revision)
        return fail("Repair snapshot changed.", 409, "table_revision_conflict");
      if (intent.phase === "bookkeeping") {
        let visited = 0;
        for (const event of this.rows<PendingEvent>(
          "SELECT * FROM events WHERE revision>=? ORDER BY revision",
          intent.pureFrom!,
        )) {
          for (const step of this.rows<{ position: number; value: string }>(
            "SELECT position,value FROM projection_steps WHERE revision=? AND position>=? ORDER BY position",
            event.revision,
            event.next_step,
          )) {
            for (const [index, statement] of (JSON.parse(step.value) as ProjectionStatement[]).entries()) {
              const cursor = intent.bookkeeping;
              if (
                cursor &&
                (event.revision < cursor.revision ||
                  (event.revision === cursor.revision &&
                    (step.position < cursor.position ||
                      (step.position === cursor.position && index <= cursor.statement))))
              )
                continue;
              if (bookkeepingProjection(statement)) {
                await this.applyProjection([statement], intent.revision!, false);
                setIntent({
                  ...intent,
                  bookkeeping: { revision: event.revision, position: step.position, statement: index },
                });
              }
              if (++visited === REPAIR_ENTITY_LIMIT) {
                setIntent({
                  ...intent,
                  bookkeeping: { revision: event.revision, position: step.position, statement: index },
                });
                await this.scheduleAlarm(1000);
                return { pending: true as const };
              }
            }
          }
        }
        setIntent({ ...intent, phase: "headers", headerStep: 0 });
      }
      if (intent.phase === "headers") {
        const headers = this.repairHeaders(false);
        const batches: ProjectionStatement[][] = [];
        for (let offset = 0; offset < headers.length; offset += REPAIR_ENTITY_LIMIT)
          batches.push(...projectionBatches(compactProjection(headers.slice(offset, offset + REPAIR_ENTITY_LIMIT))));
        // Old cursors counted compacted batches containing an unbounded number of entities.
        if (intent.headerFormat !== 1) setIntent({ ...intent, headerStep: 0, headerFormat: 1 });
        for (let position = intent.headerStep ?? 0; position < batches.length; position++) {
          const records = batches[position]!.flatMap(insertRecords);
          for (const table of ["table_columns", "table_select_options"]) {
            const selected = records.filter((record) => record.table === table);
            for (let offset = 0; offset < selected.length; offset += REPAIR_ENTITY_LIMIT) {
              const group = selected.slice(offset, offset + REPAIR_ENTITY_LIMIT),
                state = await this.structuralState(
                  table,
                  group.map((record) => String(recordValue(record, "id"))),
                  group,
                );
              for (const record of group) {
                const owner = state.current.get(String(recordValue(record, "id"))),
                  claim = state.claims.get(String(recordValue(record, "id")));
                if (
                  (owner &&
                    (owner.page_id !== initial.pageId ||
                      (table === "table_select_options" && owner.column_id !== recordValue(record, "column_id")))) ||
                  (claim && claim !== initial.pageId)
                )
                  fail("Repair property belongs to another table.", 503, "table_projection_blocked");
              }
            }
          }
          await this.applyOwnedProjection(batches[position]!, intent.revision!, false);
          setIntent({ ...intent, headerStep: position + 1 });
          if (position + 1 < batches.length) {
            await this.scheduleAlarm(1000);
            return { pending: true as const };
          }
        }
        setIntent({ ...intent, phase: "rows" });
        await this.scheduleAlarm(1000);
        return { pending: true as const };
      }
      if (intent.phase === "rows") {
        const rows = this.rows<StoredRow>(
          "SELECT * FROM rows WHERE id>? ORDER BY id LIMIT 100",
          intent.rowCursor ?? "",
        );
        if (rows.length) {
          for (const batch of await this.repairRowsStatements(rows))
            await this.applyOwnedProjection(batch, intent.revision!, false);
          setIntent({ ...intent, rowCursor: rows.at(-1)!.id });
        }
        if (rows.length === 100 && this.rows("SELECT id FROM rows WHERE id>? LIMIT 1", intent.rowCursor!).length) {
          await this.scheduleAlarm(1000);
          return { pending: true as const };
        }
        setIntent({ ...intent, phase: "reconcile" });
      }
      if (intent.phase === "reconcile") {
        const projected = await this.env.DB.prepare(
          "SELECT id FROM table_rows WHERE page_id=? AND id>? ORDER BY id LIMIT 1000",
        )
          .bind(initial.pageId, intent.reconcileCursor ?? "")
          .all<{ id: string }>();
        const stale = projected.results.filter((row) => !this.rows("SELECT id FROM rows WHERE id=?", row.id).length);
        if (stale.length) {
          const ids = JSON.stringify(stale.map((row) => row.id));
          await this.applyOwnedProjection(
            [
              {
                sql: "INSERT OR REPLACE INTO table_publication_guards(page_id,ok) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM table_row_pages link JOIN pages detail ON detail.id=link.page_id WHERE link.row_id IN (SELECT value FROM json_each(?)) AND detail.workspace_id<>?) THEN 1 ELSE 0 END",
                binds: [initial.pageId, ids, initial.workspaceId],
              },
              {
                sql: "DELETE FROM table_rows WHERE page_id=? AND id IN (SELECT value FROM json_each(?))",
                binds: [initial.pageId, ids],
              },
            ],
            intent.revision!,
            false,
          );
        }
        if (projected.results.length) setIntent({ ...intent, reconcileCursor: projected.results.at(-1)!.id });
        if (projected.results.length === 1000) {
          await this.scheduleAlarm(1000);
          return { pending: true as const };
        }
        setIntent({ ...intent, phase: "verify" });
        await this.scheduleAlarm(1000);
        return { pending: true as const };
      }
      if (intent.phase === "verify") {
        const content = await compareTableProjectionContent(this.env, initial.pageId, this.snapshot());
        if (!content.contentMatches) {
          const { rowCursor: _row, reconcileCursor: _reconcile, ...restart } = intent;
          const mismatches = (intent.mismatches ?? 0) + 1;
          setIntent({
            ...restart,
            phase: mismatches < 2 ? "headers" : "blocked",
            headerStep: 0,
            mismatches,
            hashes: { canonicalHash: content.canonicalHash, projectionHash: content.projectionHash },
            ...(mismatches < 2
              ? {}
              : {
                  blocked: {
                    revision: intent.revision!,
                    position: 0,
                    reason: "Projection verification failed after its automatic rebuild.",
                    resumePhase: "headers" as const,
                  },
                }),
          });
          if (mismatches < 2) {
            await this.scheduleAlarm(1000);
            return { pending: true as const };
          }
          await this.ctx.storage.deleteAlarm();
          fail("Projection verification failed. The write fence remains active.", 503, "table_projection_mismatch");
        }
        setIntent({
          ...intent,
          phase: "publish",
          hashes: { canonicalHash: content.canonicalHash, projectionHash: content.projectionHash },
        });
      }
      this.requireActive();
      const published = await this.env.DB.batch([
        this.projectionGuard(),
        this.env.DB.prepare("INSERT OR REPLACE INTO table_projection_context VALUES(?,?)").bind(
          initial.pageId,
          intent.generation,
        ),
        this.env.DB.prepare(
          "UPDATE table_state SET revision=? WHERE page_id=? AND EXISTS(SELECT 1 FROM table_authority WHERE page_id=? AND generation=? AND state='repairing' AND projected_revision<=?)",
        ).bind(intent.revision!, initial.pageId, initial.pageId, intent.generation, intent.revision!),
        this.env.DB.prepare(
          "UPDATE table_authority SET projected_revision=?,state='do' WHERE page_id=? AND generation=? AND state='repairing' AND projected_revision<=?",
        ).bind(intent.revision!, initial.pageId, intent.generation, intent.revision!),
        this.env.DB.prepare("DELETE FROM table_publication_guards WHERE page_id=?").bind(initial.pageId),
        this.env.DB.prepare("DELETE FROM table_projection_context WHERE page_id=?").bind(initial.pageId),
      ]).catch((error: unknown) => this.classifyProjectionFailure(error));
      if (!published[3]!.meta.changes || !published[2]!.meta.changes)
        return fail("Repair generation changed.", 409, "table_generation_conflict");
      this.requireActive();
      this.ctx.storage.transactionSync(() => {
        const current = this.meta();
        if (current.revision !== intent.revision || current.generation !== intent.generation)
          fail("Repair snapshot changed.", 409, "table_revision_conflict");
        delete current.repairIntent;
        this.putMeta({ ...current, projectedRevision: intent.revision! });
        this.ctx.storage.sql.exec("DELETE FROM projection_steps WHERE revision<=?", intent.revision!);
      });
      return { ...(await this.verification()), ...intent.hashes!, consistent: true, projectionMatches: true };
    } catch (error) {
      if (!this.purged && !this.deletionIntent) {
        if ((error as { code?: string }).code === "table_projection_blocked") {
          const current = this.meta(),
            pending = this.rows<PendingEvent>(
              "SELECT * FROM events WHERE revision>? ORDER BY revision LIMIT 1",
              current.projectedRevision,
            )[0];
          this.putMeta({
            ...current,
            repairIntent: {
              ...current.repairIntent!,
              phase: "blocked",
              blocked: {
                revision: pending?.revision ?? current.revision,
                position: pending?.next_step ?? 0,
                reason: (error as Error).message.slice(0, 500),
                resumePhase:
                  current.repairIntent!.phase === "blocked"
                    ? (current.repairIntent!.blocked?.resumePhase ?? "drain")
                    : current.repairIntent!.phase,
              },
            },
          });
          await this.ctx.storage.deleteAlarm();
        } else if (this.meta().repairIntent?.phase !== "blocked") await this.scheduleAlarm(10_000);
      }
      throw error;
    }
  }
  private async deleteJobRow(request: Request) {
    if (request.method !== "POST") return fail("Use POST.", 405);
    const body = await request.json<{
      jobId: string;
      tableId: string;
      rowId: string;
      detailPageId: string;
      generation: number;
    }>();
    const meta = this.meta();
    const target = {
      tableId: id(body.tableId),
      rowId: id(body.rowId),
      detailPageId: id(body.detailPageId),
      generation: body.generation,
    };
    id(body.jobId);
    if (target.tableId !== meta.pageId || target.generation !== meta.generation || !meta.seeded)
      return fail("Deletion target generation changed.", 409, "table_generation_conflict");
    const userId = `deletion-job:${body.jobId}`;
    const command: TableCommand = {
      kind: "delete_row",
      operationId: `permanent-delete:${body.jobId}:${target.rowId}`,
      payload: { rowId: target.rowId },
    };
    const hash = await sha256Hex(canonicalJson(command));
    const authorize = async () => {
      const accepted = await this.env.DB.prepare(`SELECT job.workspace_id,authority.generation,authority.state
      FROM deletion_jobs job JOIN deletion_targets target ON target.job_id=job.id
      JOIN deletion_job_pages locked ON locked.job_id=job.id AND locked.page_id=?
      JOIN pages detail ON detail.id=locked.page_id AND detail.archived_at IS locked.archived_at AND detail.archive_operation_id IS locked.archive_operation_id
      JOIN pages list ON list.id=? AND list.workspace_id=job.workspace_id AND list.kind='table'
      JOIN table_authority authority ON authority.page_id=list.id
      WHERE job.id=? AND job.phase='rows' AND target.kind='table_row' AND json_extract(target.target,'$.tableId')=? AND json_extract(target.target,'$.rowId')=? AND json_extract(target.target,'$.detailPageId')=? AND json_extract(target.target,'$.generation')=? AND target.completed_at IS NULL`)
        .bind(
          target.detailPageId,
          target.tableId,
          body.jobId,
          target.tableId,
          target.rowId,
          target.detailPageId,
          target.generation,
        )
        .first<{ workspace_id: string; generation: number; state: string }>();
      if (
        !accepted ||
        accepted.workspace_id !== this.meta().workspaceId ||
        accepted.generation !== this.meta().generation
      )
        fail("Deletion target is unavailable.", 403, "table_forbidden");
      if (accepted.state === "repairing" || this.repairWork || this.meta().repairIntent) {
        await this.scheduleAlarm(1000);
        fail("Projection repair is running.", 503, "table_projection_repairing");
      }
      if (accepted.state !== "do") fail("Table is not ready.", 503, "table_seed_pending");
    };
    await authorize();
    const row = this.rows<StoredRow>("SELECT * FROM rows WHERE id=?", target.rowId)[0];
    if (row && row.detail_page_id !== target.detailPageId)
      return fail("Deletion target ownership changed.", 403, "table_forbidden");
    if (!row) {
      const receipt = this.rows<{ hash: string }>(
        "SELECT hash FROM receipts WHERE actor_id=? AND operation_id=?",
        userId,
        command.operationId,
      )[0];
      if (receipt) {
        if (receipt.hash !== hash)
          return fail("That operation ID describes a different command.", 409, "idempotency_key_reused");
      } else {
        const claim = await this.env.DB.prepare("SELECT page_id FROM table_id_claims WHERE kind='row' AND id=?")
          .bind(target.rowId)
          .first<{ page_id: string }>();
        if (claim?.page_id !== meta.pageId) return fail("Deletion target ownership changed.", 403, "table_forbidden");
      }
    }
    await this.scheduleAlarm(1000);
    await this.project();
    if (this.rows<StoredRow>("SELECT * FROM rows WHERE id=?", target.rowId).length) {
      await authorize();
      this.ctx.storage.transactionSync(() => {
        if (this.rows("SELECT id FROM rows WHERE id=?", target.rowId).length)
          this.command(
            {
              ...this.meta(),
              userId,
              deletionJob: body.jobId,
              allowDeleteDetail: true,
              taskMutation: true,
            },
            command,
            hash,
          );
      });
      try {
        await this.project();
      } catch {
        await this.scheduleAlarm(1000);
      }
    }
    const current = this.meta();
    return { ok: true, revision: current.revision, projectionPending: current.projectedRevision < current.revision };
  }
  // fallow-ignore-next-line unused-class-member -- Called by Cloudflare Durable Object runtime.
  async alarm() {
    if (this.purged || this.deletionIntent) return;
    try {
      const meta = this.meta();
      if (!meta.repairIntent && meta.seeded) {
        const registry = await this.env.DB.prepare("SELECT generation,state FROM table_authority WHERE page_id=?")
          .bind(meta.pageId)
          .first<{ generation: number; state: string }>();
        if (this.purged || this.deletionIntent) return;
        this.ctx.storage.transactionSync(() => {
          const current = this.meta();
          if (
            !current.repairIntent &&
            current.seeded &&
            registry?.state === "repairing" &&
            registry.generation === current.generation
          )
            this.putMeta({ ...current, repairIntent: { generation: current.generation, version: 2, phase: "fence" } });
        });
      }
      if (this.meta().repairIntent) await this.resumeRepair();
      else await this.project();
    } catch {
      if (!this.purged && this.meta().repairIntent?.phase !== "blocked") await this.scheduleAlarm(10_000);
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
  let chunk: ProjectionStatement[] = [];
  let bytes = 0;
  const flush = () => {
    if (!chunk.length) return;
    const first = chunk[0]!;
    const match =
      /^INSERT INTO (table_cells|table_rows|table_row_pages|table_columns|table_select_options|table_computed_cells|table_people)\(([^)]+)\) VALUES\(([^)]+)\)(.*)$/.exec(
        first.sql,
      );
    if (chunk.length === 1 || !match) result.push(...chunk);
    else
      result.push({
        sql: `INSERT INTO ${match[1]}(${match[2]}) SELECT ${first.binds.map((_, index) => `json_extract(value,'$[${index}]')`).join(",")} FROM json_each(?) WHERE 1 ${match[4]}`,
        binds: [JSON.stringify(chunk.map((item) => item.binds))],
      });
    chunk = [];
    bytes = 0;
  };
  for (const statement of statements) {
    const size = JSON.stringify(statement.binds).length;
    if (chunk.length && (chunk[0]!.sql !== statement.sql || chunk.length >= 100 || bytes + size > 500000)) flush();
    if (
      /^INSERT INTO (table_cells|table_rows|table_row_pages|table_columns|table_select_options|table_computed_cells|table_people)\([^)]+\) VALUES\([^)]+\)/.test(
        statement.sql,
      )
    ) {
      chunk.push(statement);
      bytes += size;
    } else {
      flush();
      result.push(statement);
    }
  }
  flush();
  return result;
}

function prerequisiteJson(value: string) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") fail("Invalid prerequisite JSON.", 503, "table_projection_blocked");
    return parsed;
  } catch {
    return fail("Invalid prerequisite JSON.", 503, "table_projection_blocked");
  }
}
const PROJECTION_NUMERIC_FIELDS = new Set([
  "position",
  "created_at",
  "updated_at",
  "property_revision",
  "property_generation",
  "row_revision",
  "cell_revision",
  "revision",
  "number_value",
  "boolean_value",
]);
const PROJECTION_NULLABLE_FIELDS = new Set([
  "created_by",
  "updated_by",
  "owner_id",
  "color",
  "text_value",
  "text_search_value",
  "number_value",
  "boolean_value",
  "date_value",
  "select_value",
]);
function validProjectionRecord(record: Prerequisite) {
  return record.columns.every((field, index) => {
    const value = record.binds[index];
    if (value === null) return PROJECTION_NULLABLE_FIELDS.has(field);
    if (PROJECTION_NUMERIC_FIELDS.has(field)) return typeof value === "number" && Number.isFinite(value);
    if (typeof value !== "string") return false;
    if (
      [
        "id",
        "page_id",
        "row_id",
        "column_id",
        "user_id",
        "owner_id",
        "created_by",
        "updated_by",
        "select_value",
      ].includes(field)
    )
      return TABLE_ID_PATTERN.test(value);
    return true;
  });
}
function insertRecords(statement: ProjectionStatement): Prerequisite[] {
  const match =
    /^INSERT INTO (table_columns|table_select_options|table_rows|table_row_pages|table_cells|table_computed_cells|table_views|table_people)\(([^)]+)\) (VALUES\([^)]+\)|SELECT .* FROM json_each\(\?\) WHERE 1)/.exec(
      statement.sql,
    );
  if (!match) return [];
  const columns = match[2]!.split(",");
  const template = PROJECTION_INSERT_SQL[match[1] as keyof typeof PROJECTION_INSERT_SQL];
  const compacted = template.replace(
    /VALUES\([^)]+\)/,
    `SELECT ${columns.map((_, index) => `json_extract(value,'$[${index}]')`).join(",")} FROM json_each(?) WHERE 1 `,
  );
  if (statement.sql !== template && statement.sql !== compacted) return [];
  const values = match[3]!.startsWith("VALUES") ? [statement.binds] : prerequisiteJson(String(statement.binds[0]));
  if (!Array.isArray(values) || values.some((row) => !Array.isArray(row) || row.length !== columns.length))
    return fail("Invalid persisted projection artifact.", 503, "table_projection_blocked");
  const records = values.map((binds) => ({ table: match[1]!, columns, binds }));
  if (records.some((record) => !validProjectionRecord(record)))
    return fail("Invalid persisted projection bind.", 503, "table_projection_blocked");
  return records;
}
function prerequisiteKey(record: Prerequisite) {
  return `${record.table}:${record.binds[record.columns.indexOf(record.table === "table_row_pages" ? "row_id" : "id")]}`;
}
function recordValue(record: Prerequisite, name: string) {
  return record.binds[record.columns.indexOf(name)];
}
function chunkPrerequisites(records: Prerequisite[]): string[] {
  const chunks: string[] = [];
  let group: Prerequisite[] = [],
    bytes = 16;
  const flush = () => {
    if (group.length) chunks.push(JSON.stringify({ records: group }));
    group = [];
    bytes = 16;
  };
  // Ordinary records share a chunk; only oversized entries are fragmented.
  const length = Math.floor((PROJECTION_MAX_BYTES - 256) / 6);
  for (const [entry, record] of records.entries()) {
    const serialized = JSON.stringify(record),
      size = new TextEncoder().encode(serialized).byteLength;
    if (size + 16 <= PROJECTION_MAX_BYTES) {
      if (bytes + size + 1 > PROJECTION_MAX_BYTES) flush();
      group.push(record);
      bytes += size + 1;
      continue;
    }
    flush();
    const parts = Math.ceil(serialized.length / length);
    for (let part = 0; part < parts; part++) {
      const value = JSON.stringify({ entry, part, parts, data: serialized.slice(part * length, (part + 1) * length) });
      if (new TextEncoder().encode(value).byteLength > PROJECTION_MAX_BYTES)
        return fail("Prerequisite exceeds the projection payload limit.", 422, "table_projection_limit");
      chunks.push(value);
    }
  }
  flush();
  return chunks;
}
function pureProjection(statement: ProjectionStatement, pageId: string) {
  if (insertRecords(statement).length) return true;
  const patterns: Record<string, { count: number; page?: number; json?: number }> = {
    "DELETE FROM table_columns WHERE id=? AND page_id=?": { count: 2, page: 1 },
    "DELETE FROM table_select_options WHERE id=? AND column_id=?": { count: 2 },
    "DELETE FROM table_rows WHERE id=? AND page_id=?": { count: 2, page: 1 },
    "DELETE FROM table_views WHERE page_id=? AND id=?": { count: 2, page: 0 },
    "DELETE FROM table_computed_cells WHERE row_id=?": { count: 1 },
    "DELETE FROM table_computed_cells WHERE row_id IN (SELECT value FROM json_each(?))": { count: 1, json: 0 },
    [COMPUTED_DELETE_SQL]: { count: 2, page: 1, json: 0 },
  };
  const pattern = patterns[statement.sql];
  if (
    !pattern ||
    statement.binds.length !== pattern.count ||
    (pattern.page !== undefined && statement.binds[pattern.page] !== pageId)
  )
    return false;
  return statement.binds.every((value, index) => {
    if (typeof value !== "string") return false;
    if (index !== pattern.json) return TABLE_ID_PATTERN.test(value);
    try {
      const values = JSON.parse(value);
      return (
        Array.isArray(values) && values.every((entry) => typeof entry === "string" && TABLE_ID_PATTERN.test(entry))
      );
    } catch {
      return false;
    }
  });
}
function bookkeepingProjection(statement: ProjectionStatement) {
  if (
    statement.sql ===
    "INSERT INTO page_contributors(page_id,user_id,first_edit_at,last_edit_at) VALUES(?,?,?,?) ON CONFLICT(page_id,user_id) DO UPDATE SET last_edit_at=max(last_edit_at,excluded.last_edit_at)"
  )
    return (
      statement.binds.length === 4 &&
      typeof statement.binds[0] === "string" &&
      typeof statement.binds[1] === "string" &&
      typeof statement.binds[2] === "number" &&
      Number.isFinite(statement.binds[2]) &&
      typeof statement.binds[3] === "number" &&
      Number.isFinite(statement.binds[3])
    );
  return (
    statement.sql === "UPDATE pages SET updated_by=?,updated_at=? WHERE id=?" &&
    statement.binds.length === 3 &&
    (statement.binds[0] === null || typeof statement.binds[0] === "string") &&
    typeof statement.binds[1] === "number" &&
    Number.isFinite(statement.binds[1]) &&
    typeof statement.binds[2] === "string"
  );
}
function projectionConstraint(error: unknown): "table_publication_conflict" | "missing_parent" | "ownership" | null {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const candidate = error as { message?: unknown; cause?: unknown };
    const message =
      typeof candidate.message === "string"
        ? candidate.message
            .replace(/^D1_ERROR: /, "")
            .replace(/: SQLITE_CONSTRAINT(?:_[A-Z]+)?(?: \(extended: SQLITE_CONSTRAINT_[A-Z]+\))?$/, "")
        : "";
    if (message === "CHECK constraint failed: table_publication_conflict") return "table_publication_conflict";
    if (message === "FOREIGN KEY constraint failed") return "missing_parent";
    if (
      [
        "table_cell_scope",
        "table_id_collision",
        "UNIQUE constraint failed: table_row_pages.row_id",
        "UNIQUE constraint failed: table_row_pages.page_id",
      ].includes(message)
    )
      return "ownership";
    error = candidate.cause;
  }
  return null;
}
function missingProjectionParent(error: unknown) {
  return (error as { code?: string })?.code === "table_projection_missing_parent";
}

/** Old compaction grouped unlike INSERTs across chunk boundaries. Only reorder
 * recognized INSERT segments; effects and all other statements remain barriers. */
function normalizeLegacyProjection(statements: ProjectionStatement[]): ProjectionStatement[] {
  const order = [
    "table_columns",
    "table_select_options",
    "table_rows",
    "table_cells",
    "table_computed_cells",
    "table_people",
  ];
  const result: ProjectionStatement[] = [];
  let inserts: Array<{ statement: ProjectionStatement; rank: number }> = [];
  const flush = () => {
    result.push(...inserts.sort((a, b) => a.rank - b.rank).map((item) => item.statement));
    inserts = [];
  };
  for (const statement of statements) {
    const table =
      /^INSERT INTO (table_cells|table_rows|table_columns|table_select_options|table_computed_cells|table_people)\([^)]+\) (?:VALUES\(|SELECT .* FROM json_each\(\?\) WHERE 1 )/.exec(
        statement.sql,
      )?.[1];
    if (table) inserts.push({ statement, rank: order.indexOf(table) });
    else {
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
    if (batch.length && (batch.length >= 200 || bytes + size > PROJECTION_MAX_BYTES)) {
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
