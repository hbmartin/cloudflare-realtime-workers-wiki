import { generateJitteredKeyBetween, generateNJitteredKeysBetween } from "fractional-indexing-jittered";
import { Hono } from "hono";
import { routePartykitRequest } from "partyserver";
import { createAuth, requireEditor, requireMember, requireOwner } from "./auth";
import { processArchiveDisconnectTargets, processDueArchiveDisconnects } from "./archive";
import {
  isInlineMime,
  isUnsafeMime,
  MAX_ATTACHMENT_BYTES,
  MAX_UPLOAD_BYTES,
  processDueUploadReaps,
  resolvePartSize,
  UPLOAD_SESSION_TTL_MS,
} from "./attachments";
import { processDeletionJob, processDueDeletionJobs } from "./cleanup";
import { Document } from "./document";
import type { Env, MemberContext } from "./env";
import {
  HttpError,
  assertSameOrigin,
  attachmentDisposition,
  errorPayload,
  errorResponse,
  isExpectedError,
  locationHint,
  normalizeFilename,
  now,
  sha256,
} from "./http";
import {
  TABLE_BULK_MAX_BODY_BYTES,
  TABLE_BULK_MAX_CELLS,
  TABLE_BULK_MAX_COLUMNS,
  TABLE_BULK_MAX_ROWS,
  TABLE_COLUMN_NAME_MAX,
  TABLE_MAX_ROWS,
  TABLE_PAGE_DEFAULT,
  TABLE_PAGE_MAX,
  TABLE_SELECT_LABEL_MAX,
  TABLE_SORT_MAX_OFFSET,
  TABLE_TEXT_CELL_MAX,
} from "../shared/table-limits";
import {
  columnType,
  documentRoom,
  ID_PATTERN,
  nullableId,
  object,
  PAGE_TITLE_MAX,
  pageKind,
  role,
  text,
} from "../shared/validation";
import type {
  ClientMemberContext,
  Page,
  PageKind,
  TableLeaseResponse,
  TableLeaseTiming,
  WorkspaceEvent,
} from "../shared/types";
import { compareBinaryText } from "../shared/tree-model";
import { canonicalJson, documentProjectionHash, sha256Hex, tableContentHash } from "../shared/import-integrity";
import { conditionalGetStatus, normalizeR2Range } from "./r2";
import { broadcastWorkspaceEvent, WorkspaceEvents } from "./workspace-events";

const app = new Hono<{ Bindings: Env }>();
const DELETION_TARGET_BATCH_SIZE = 50;
// Each page costs three or four statements, so this stays far inside D1's per-invocation
// query ceiling while still collapsing a tree level into one request.
const PAGE_BATCH_MAX = 50;
const TABLE_LEASE_DURATION_MS = 60_000;

type PageRow = {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  kind: PageKind;
  position: string;
  title: string;
  icon: string | null;
  revision: number;
  content_epoch: number;
  plain_text: string;
  indexed_seq: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};

type RequestedPageCreate = Pick<PageRow, "id" | "kind"> & {
  parentId: string | null;
  title: string;
};

type PageJsonRow = Omit<PageRow, "plain_text" | "indexed_seq">;
type PageCreateStateRow = PageJsonRow & { receipt_request_hash: string | null };

function pageJson(row: PageJsonRow): Page {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    parentId: row.parent_id,
    kind: row.kind,
    position: row.position,
    title: row.title,
    icon: row.icon,
    revision: row.revision,
    contentEpoch: row.content_epoch,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function pageCreateRequestHash(value: unknown) {
  return sha256Hex(canonicalJson(value));
}

async function readPageCreateReplay(
  database: D1Database,
  workspaceId: string,
  requested: RequestedPageCreate[],
  requestHash: string,
  conflictMessage: string,
) {
  const existing = await database
    .prepare(
      `SELECT p.id, p.workspace_id, p.parent_id, p.kind, p.position, p.title, p.icon,
              p.revision, p.content_epoch, p.archived_at, p.created_at, p.updated_at,
              r.request_hash receipt_request_hash
         FROM pages p
         LEFT JOIN page_create_receipts r ON r.page_id = p.id AND r.workspace_id = ?
        WHERE p.workspace_id = ? AND p.id IN (${requested.map(() => "?").join(", ")})`,
    )
    .bind(workspaceId, workspaceId, ...requested.map((page) => page.id))
    .all<PageCreateStateRow>();
  if (!existing.results.length) return null;
  if (existing.results.length !== requested.length) {
    throw new HttpError(409, "idempotency_key_reused", conflictMessage);
  }
  const byId = new Map(existing.results.map((row) => [row.id, row]));
  const rows = requested.map((page) => byId.get(page.id)!);
  const replayMatches = requested.every((page, index) => {
    const row = rows[index]!;
    if (row.receipt_request_hash !== null) return row.receipt_request_hash === requestHash;
    return (
      row.archived_at === null && row.parent_id === page.parentId && row.kind === page.kind && row.title === page.title
    );
  });
  if (!replayMatches) throw new HttpError(409, "idempotency_key_reused", conflictMessage);
  return rows.map(pageJson);
}

async function requestedPageIdsExist(database: D1Database, requested: RequestedPageCreate[]) {
  const existing = await database
    .prepare(`SELECT 1 FROM pages WHERE id IN (${requested.map(() => "?").join(", ")}) LIMIT 1`)
    .bind(...requested.map((page) => page.id))
    .first();
  return existing !== null;
}

async function batchWithFinalResult<T>(
  database: D1Database,
  statements: D1PreparedStatement[],
  finalStatement: D1PreparedStatement,
) {
  // D1 applies the caller-supplied row type to the whole batch; this helper only
  // selects the result at the position occupied by finalStatement.
  const finalResultIndex = statements.length;
  const results = await database.batch<T>([...statements, finalStatement]);
  return results[finalResultIndex];
}

function sendWorkspaceEvent(
  c: { env: Env; executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  workspaceId: string,
  event: WorkspaceEvent,
) {
  c.executionCtx.waitUntil(
    broadcastWorkspaceEvent(c.env, workspaceId, event).catch((error) => {
      console.error("Failed to broadcast workspace event", error);
    }),
  );
}

function defaultLocation(request: Request, override?: string) {
  if (locationHint(override)) return override!;
  const continent = String(request.cf?.continent ?? "");
  const map: Record<string, DurableObjectLocationHint> = {
    AF: "afr",
    AN: "sam",
    AS: "apac",
    EU: "weur",
    NA: "wnam",
    OC: "oc",
    SA: "sam",
  };
  return map[continent] ?? "wnam";
}

async function jsonBody(request: Request) {
  try {
    return object(await request.json());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "Send a valid JSON request body.");
  }
}

async function limitedJsonBody(request: Request, limit: number) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, "bulk_too_large", "The bulk table write is larger than the request limit.");
  }
  if (!request.body) throw new HttpError(400, "invalid_json", "Send a valid JSON request body.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new HttpError(413, "bulk_too_large", "The bulk table write is larger than the request limit.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return object(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_json", "Send a valid JSON request body.");
  }
}

async function authEmail(
  env: Env,
  request: Request,
  path: "/api/auth/sign-up/email" | "/api/auth/sign-in/email",
  body: { name?: string; email: string; password: string },
) {
  const url = new URL(path, env.BETTER_AUTH_URL);
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.set("origin", new URL(env.BETTER_AUTH_URL).origin);
  const response = await createAuth(env).handler(
    new Request(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok) return { response, user: null };
  const payload = await response.clone().json<{ user?: { id: string } }>();
  if (!payload.user) throw new HttpError(500, "signup_failed", "The account was created without a user record.");
  return { response, user: payload.user };
}

async function signUp(env: Env, request: Request, body: { name: string; email: string; password: string }) {
  return authEmail(env, request, "/api/auth/sign-up/email", body);
}

async function pageForMember(env: Env, member: MemberContext, pageId: string, includeArchived = false) {
  const row = await env.DB.prepare(
    `SELECT * FROM pages WHERE id = ? AND workspace_id = ? ${includeArchived ? "" : "AND archived_at IS NULL"}`,
  )
    .bind(pageId, member.workspace.id)
    .first<PageRow>();
  if (!row) throw new HttpError(404, "page_not_found", "Page not found.");
  return row;
}

type TablePageExtras = { columns: string; binds: unknown[] };

// Resolves the active (unarchived) table page a request targets, failing with
// the 404/422 every table route reports. `extra.columns` are selected alongside
// the page row so a route can fold its own existence and position lookups into
// this one query; their placeholders bind first and the page/workspace binds
// are appended here, so no route maintains a positional bind list by hand.
async function activeTablePage<T = unknown>(
  env: Env,
  member: MemberContext,
  pageId: string,
  extra: TablePageExtras = { columns: "", binds: [] },
) {
  const row = await env.DB.prepare(
    `SELECT p.*${extra.columns}
       FROM pages p
      WHERE p.id = ? AND p.workspace_id = ? AND p.archived_at IS NULL`,
  )
    .bind(...extra.binds, pageId, member.workspace.id)
    .first<PageRow & T>();
  if (!row) throw new HttpError(404, "page_not_found", "Page not found.");
  if (row.kind !== "table") throw new HttpError(422, "table_required", "This page is not a table.");
  return row;
}

function leaseGuards() {
  return `EXISTS (
    SELECT 1 FROM table_state s JOIN table_leases l ON l.page_id = s.page_id
     WHERE s.page_id = ? AND s.revision = ? AND l.token_hash = ?
       AND l.holder_session_id = ? AND l.expires_at > ?
  )`;
}

async function leaseInputs(body: Record<string, unknown>, member: MemberContext) {
  const leaseToken = text(body.leaseToken, "leaseToken", 200);
  const expectedRevision = Number(body.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new HttpError(422, "invalid_revision", "expectedRevision must be a positive integer.");
  }
  return { body, expectedRevision, tokenHash: await sha256(leaseToken), sessionId: member.session.id };
}

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

type TableRowQuery = {
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
function buildTableRowQuery(
  pageId: string,
  columns: { id: string; type: string }[],
  query: Record<string, string | undefined>,
): TableRowQuery {
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
             WHERE r.page_id = ?
               AND (? IS NULL OR r.position > ? OR (r.position = ? AND r.id > ?))
             ORDER BY r.position, r.id LIMIT ? OFFSET ?`,
      binds: [pageId, afterPosition, afterPosition, afterPosition, afterId ?? null],
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
           WHERE r.page_id = ?
           ORDER BY (CASE WHEN ${value} IS NULL THEN 1 ELSE 0 END), ${value} ${dir === "desc" ? "DESC" : "ASC"},
                    r.position, r.id
           LIMIT ? OFFSET ?`,
    binds: [sortColumn.id, pageId],
    orderSql: `page_rows.sort_null, page_rows.sort_value ${dir === "desc" ? "DESC" : "ASC"}, page_rows.position, page_rows.id`,
    limit,
    offset,
    sort: sortColumn.id,
    dir,
  };
}

function tableRowBinds(query: TableRowQuery, limit: number) {
  return [...query.binds, limit, query.offset];
}

app.onError((error, c) => errorResponse(c, error));

app.get("/api/install", async (c) => {
  const state = await c.env.DB.prepare(`SELECT 1 initialized FROM install_state WHERE id = 1`).first();
  return c.json({ initialized: Boolean(state) });
});

app.post("/api/install/bootstrap", async (c) => {
  assertSameOrigin(c.req.raw, c.env.BETTER_AUTH_URL);
  const existing = await c.env.DB.prepare(`SELECT 1 FROM install_state WHERE id = 1`).first();
  if (existing) throw new HttpError(409, "already_initialized", "This installation already has an owner.");
  const body = await jsonBody(c.req.raw);
  const token = text(body.bootstrapToken, "bootstrapToken", 500);
  if (!constantTimeEqual(await sha256(token), await sha256(c.env.BOOTSTRAP_TOKEN))) {
    throw new HttpError(403, "invalid_bootstrap_token", "The bootstrap token is invalid.");
  }

  const name = text(body.name, "name", 100);
  const email = text(body.email, "email", 320).toLowerCase();
  const password = text(body.password, "password", 200);
  const workspaceName = text(body.workspaceName, "workspaceName", 100);
  const signup = await signUp(c.env, c.req.raw, { name, email, password });
  if (!signup.user) return signup.response;

  const workspaceId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const timestamp = now();
  const hint = defaultLocation(c.req.raw, c.env.DO_LOCATION_HINT);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO workspaces (id, name, location_hint, created_at) VALUES (?, ?, ?, ?)`).bind(
      workspaceId,
      workspaceName,
      hint,
      timestamp,
    ),
    c.env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
    ).bind(workspaceId, signup.user.id, timestamp),
    c.env.DB.prepare(`INSERT INTO install_state (id, workspace_id, initialized_at) VALUES (1, ?, ?)`).bind(
      workspaceId,
      timestamp,
    ),
    c.env.DB.prepare(
      `INSERT INTO pages (id, workspace_id, parent_id, kind, position, title, created_by, created_at, updated_at)
       VALUES (?, ?, NULL, 'document', ?, 'Welcome', ?, ?, ?)`,
    ).bind(pageId, workspaceId, generateJitteredKeyBetween(null, null), signup.user.id, timestamp, timestamp),
    c.env.DB.prepare(`INSERT INTO page_search (page_id, workspace_id, title, body) VALUES (?, ?, 'Welcome', '')`).bind(
      pageId,
      workspaceId,
    ),
  ]);
  return signup.response;
});

app.post("/api/invites/accept", async (c) => {
  assertSameOrigin(c.req.raw, c.env.BETTER_AUTH_URL);
  const body = await jsonBody(c.req.raw);
  const inviteToken = text(body.token, "token", 500);
  const tokenHash = await sha256(inviteToken);
  const invite = await c.env.DB.prepare(
    `SELECT id, workspace_id, role FROM invites
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
  )
    .bind(tokenHash, now())
    .first<{ id: string; workspace_id: string; role: "editor" | "viewer" }>();
  if (!invite) throw new HttpError(404, "invite_invalid", "This invite is invalid, expired, or already used.");

  const inviteEmail = text(body.email, "email", 320).toLowerCase();
  const existingUser = await c.env.DB.prepare(`SELECT id FROM user WHERE email = ?`).bind(inviteEmail).first();
  const signup = existingUser
    ? await authEmail(c.env, c.req.raw, "/api/auth/sign-in/email", {
        email: inviteEmail,
        password: text(body.password, "password", 200),
      })
    : await signUp(c.env, c.req.raw, {
        name: text(body.name, "name", 100),
        email: inviteEmail,
        password: text(body.password, "password", 200),
      });
  if (!signup.user) return signup.response;
  const existingMembership = await c.env.DB.prepare(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
  )
    .bind(invite.workspace_id, signup.user.id)
    .first();
  if (existingMembership) return signup.response;
  const timestamp = now();
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT workspace_id, ?, role, ? FROM invites WHERE id = ? AND used_at IS NULL`,
    ).bind(signup.user.id, timestamp, invite.id),
    c.env.DB.prepare(`UPDATE invites SET used_by = ?, used_at = ? WHERE id = ? AND used_at IS NULL`).bind(
      signup.user.id,
      timestamp,
      invite.id,
    ),
  ]);
  if (!result[1]!.meta.changes) throw new HttpError(409, "invite_used", "This invite was used by another request.");
  return signup.response;
});

app.all("/api/auth/*", async (c) => {
  if (new URL(c.req.url).pathname.endsWith("/sign-up/email")) {
    throw new HttpError(403, "registration_closed", "Use the bootstrap screen or an invite to register.");
  }
  return createAuth(c.env).handler(c.req.raw);
});

app.get("/api/me", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const context: ClientMemberContext = {
    user: member.user,
    workspace: member.workspace,
    role: member.role,
  };
  return c.json(context);
});

app.get("/api/health", async (c) => {
  const database = await c.env.DB.prepare(`SELECT 1 ok`).first<{ ok: number }>();
  return c.json({ ok: database?.ok === 1, version: "0.1.0", time: new Date().toISOString() });
});

app.get("/api/members", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, wm.role, wm.created_at createdAt
       FROM workspace_members wm JOIN user u ON u.id = wm.user_id
      WHERE wm.workspace_id = ? ORDER BY u.name, u.id`,
  )
    .bind(member.workspace.id)
    .all();
  return c.json({ members: rows.results });
});

app.post("/api/invites", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const body = await jsonBody(c.req.raw);
  const inviteRole = role(body.role);
  if (inviteRole === "owner") throw new HttpError(422, "invalid_role", "Invites can grant editor or viewer access.");
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const id = crypto.randomUUID();
  const expiresAt = now() + 7 * 24 * 60 * 60_000;
  await c.env.DB.prepare(
    `INSERT INTO invites (id, workspace_id, token_hash, role, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, member.workspace.id, await sha256(token), inviteRole, expiresAt, member.user.id, now())
    .run();
  return c.json({ invite: { id, token, role: inviteRole, expiresAt } }, 201);
});

app.patch("/api/members/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const body = await jsonBody(c.req.raw);
  const nextRole = role(body.role);
  const targetId = c.req.param("id");
  if (nextRole !== "owner") {
    const target = await c.env.DB.prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
      .bind(member.workspace.id, targetId)
      .first<{ role: string }>();
    if (target?.role === "owner") await assertAnotherOwner(c.env, member.workspace.id, targetId);
  }
  const result = await c.env.DB.prepare(`UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?`)
    .bind(nextRole, member.workspace.id, targetId)
    .run();
  if (!result.meta.changes) throw new HttpError(404, "member_not_found", "Member not found.");
  return c.json({ ok: true });
});

app.delete("/api/members/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const targetId = c.req.param("id");
  const target = await c.env.DB.prepare(`SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
    .bind(member.workspace.id, targetId)
    .first<{ role: string }>();
  if (!target) throw new HttpError(404, "member_not_found", "Member not found.");
  if (target.role === "owner") await assertAnotherOwner(c.env, member.workspace.id, targetId);
  await c.env.DB.prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
    .bind(member.workspace.id, targetId)
    .run();
  return c.json({ ok: true });
});

app.get("/api/pages/tree", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const archived = c.req.query("archived") === "true";
  const rows = await c.env.DB.prepare(
    `SELECT * FROM pages WHERE workspace_id = ? AND archived_at IS ${archived ? "NOT " : ""}NULL ORDER BY position, id`,
  )
    .bind(member.workspace.id)
    .all<PageRow>();
  return c.json({ pages: rows.results.map(pageJson) });
});

app.post("/api/pages", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const body = await jsonBody(c.req.raw);
  const parentId = nullableId(body.parentId, "parentId");
  const clientProvidedId = body.id !== undefined;
  const id = clientProvidedId ? text(body.id, "id", 100) : crypto.randomUUID();
  if (!ID_PATTERN.test(id)) throw new HttpError(422, "invalid_input", "id is not a valid resource id.");
  const kind = pageKind(body.kind ?? "document");
  const title = typeof body.title === "string" ? text(body.title, "title", PAGE_TITLE_MAX) : "Untitled";
  const requestHash = await pageCreateRequestHash({ parentId, kind, title });
  const requested = [{ id, parentId, kind, title }];
  const conflictMessage = "That page id already describes a different page.";
  const initialReplay = clientProvidedId
    ? await readPageCreateReplay(c.env.DB, member.workspace.id, requested, requestHash, conflictMessage)
    : null;
  if (initialReplay) return c.json({ page: initialReplay[0]! });
  if (parentId) await pageForMember(c.env, member, parentId);
  const timestamp = now();
  let createdRow: PageRow | undefined;
  try {
    const last = await c.env.DB.prepare(
      `SELECT position FROM pages WHERE workspace_id = ? AND parent_id IS ? AND archived_at IS NULL
        ORDER BY position DESC, id DESC LIMIT 1`,
    )
      .bind(member.workspace.id, parentId)
      .first<{ position: string }>();
    const position = generateJitteredKeyBetween(last?.position ?? null, null);
    const results = await c.env.DB.batch<PageRow>([
      c.env.DB.prepare(
        `INSERT INTO pages (id, workspace_id, parent_id, kind, position, title, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      ).bind(id, member.workspace.id, parentId, kind, position, title, member.user.id, timestamp, timestamp),
      c.env.DB.prepare(`INSERT INTO page_search (page_id, workspace_id, title, body) VALUES (?, ?, ?, '')`).bind(
        id,
        member.workspace.id,
        title,
      ),
      ...(kind === "table" ? [c.env.DB.prepare(`INSERT INTO table_state (page_id) VALUES (?)`).bind(id)] : []),
      c.env.DB.prepare(
        `INSERT INTO page_create_receipts
         (workspace_id, page_id, request_hash) VALUES (?, ?, ?)`,
      ).bind(member.workspace.id, id, requestHash),
    ]);
    createdRow = results[0]?.results[0];
  } catch (error) {
    const replay = await readPageCreateReplay(c.env.DB, member.workspace.id, requested, requestHash, conflictMessage);
    if (replay) return c.json({ page: replay[0]! });
    if (await requestedPageIdsExist(c.env.DB, requested)) {
      throw new HttpError(409, "idempotency_key_reused", conflictMessage);
    }
    throw error;
  }
  const created = createdRow
    ? pageJson(createdRow)
    : (await readPageCreateReplay(c.env.DB, member.workspace.id, requested, requestHash, conflictMessage))?.[0];
  if (!created) throw new Error("The created page was not returned by its insert or its committed receipt.");
  sendWorkspaceEvent(c, member.workspace.id, { type: "pages-upserted", pages: [created] });
  return c.json({ page: created }, 201);
});

// Creates a whole tree level at once.
//
// Creating pages one at a time is correct but broadcasts `pages-upserted` per page,
// and an import of a thousand pages then makes every connected client merge its tree a
// thousand times. The event payload is already a list, so one request that inserts N
// pages in a single batch and emits one event needs no client change at all.
//
// Parents must already exist: a page cannot name another page from the same request as
// its parent. Callers walk the tree a level at a time, which also keeps sibling order
// deterministic, since positions are handed out in request order.
app.post("/api/pages/batch", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const body = await jsonBody(c.req.raw);
  const requested = Array.isArray(body.pages) ? body.pages : [];
  if (!requested.length) throw new HttpError(422, "invalid_input", "pages must list at least one page.");
  if (requested.length > PAGE_BATCH_MAX) {
    throw new HttpError(422, "batch_too_large", `A batch is limited to ${PAGE_BATCH_MAX} pages.`);
  }

  let allIdsClientProvided = true;
  const parsed = requested.map((raw, index) => {
    const entry = object(raw);
    if (entry.id === undefined) allIdsClientProvided = false;
    const requestedId = entry.id === undefined ? crypto.randomUUID() : text(entry.id, `pages[${index}].id`, 100);
    if (!ID_PATTERN.test(requestedId)) {
      throw new HttpError(422, "invalid_input", `pages[${index}].id is not a valid resource id.`);
    }
    return {
      id: requestedId,
      parentId: nullableId(entry.parentId, `pages[${index}].parentId`),
      kind: pageKind(entry.kind ?? "document"),
      title: typeof entry.title === "string" ? text(entry.title, `pages[${index}].title`, PAGE_TITLE_MAX) : "Untitled",
    };
  });
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) {
    throw new HttpError(422, "invalid_input", "A page id may appear only once in a batch.");
  }
  const requestHash = await pageCreateRequestHash(parsed);
  const conflictMessage = "Those page ids already describe different pages.";
  const initialReplay = allIdsClientProvided
    ? await readPageCreateReplay(c.env.DB, member.workspace.id, parsed, requestHash, conflictMessage)
    : null;
  if (initialReplay) return c.json({ pages: initialReplay, replayed: true });

  // Every distinct parent is checked once, which also rejects a parent in another
  // workspace or an archived one exactly as the single-page route does.
  const parentIds = [...new Set(parsed.map((page) => page.parentId))];
  for (const parentId of parentIds) {
    if (parentId) await pageForMember(c.env, member, parentId);
  }

  // Positions are generated per parent, continuing after that parent's last child, so
  // a batch appends in request order just like a sequence of single creates would.
  const positions = new Map<string, string>();
  for (const parentId of parentIds) {
    const siblings = parsed.filter((page) => page.parentId === parentId);
    const last = await c.env.DB.prepare(
      `SELECT position FROM pages WHERE workspace_id = ? AND parent_id IS ? AND archived_at IS NULL
        ORDER BY position DESC, id DESC LIMIT 1`,
    )
      .bind(member.workspace.id, parentId)
      .first<{ position: string }>();
    const keys = generateNJitteredKeysBetween(last?.position ?? null, null, siblings.length);
    siblings.forEach((page, index) => positions.set(page.id, keys[index]!));
  }

  const timestamp = now();
  const statements: D1PreparedStatement[] = [];
  const pageResultIndexes: number[] = [];
  for (const page of parsed) {
    pageResultIndexes.push(statements.length);
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO pages (id, workspace_id, parent_id, kind, position, title, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      ).bind(
        page.id,
        member.workspace.id,
        page.parentId,
        page.kind,
        positions.get(page.id),
        page.title,
        member.user.id,
        timestamp,
        timestamp,
      ),
      c.env.DB.prepare(`INSERT INTO page_search (page_id, workspace_id, title, body) VALUES (?, ?, ?, '')`).bind(
        page.id,
        member.workspace.id,
        page.title,
      ),
    );
    if (page.kind === "table") {
      statements.push(c.env.DB.prepare(`INSERT INTO table_state (page_id) VALUES (?)`).bind(page.id));
    }
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO page_create_receipts
         (workspace_id, page_id, request_hash) VALUES (?, ?, ?)`,
      ).bind(member.workspace.id, page.id, requestHash),
    );
  }
  let createdRows: Array<PageRow | undefined>;
  try {
    const results = await c.env.DB.batch<PageRow>(statements);
    createdRows = pageResultIndexes.map((index) => results[index]?.results[0]);
  } catch (error) {
    // A concurrent identical retry may have committed between the existence check
    // and this transaction. Re-read before classifying the unique conflict.
    const replay = await readPageCreateReplay(c.env.DB, member.workspace.id, parsed, requestHash, conflictMessage);
    if (replay) return c.json({ pages: replay, replayed: true });
    if (await requestedPageIdsExist(c.env.DB, parsed)) {
      throw new HttpError(409, "idempotency_key_reused", conflictMessage);
    }
    throw error;
  }
  const createdPages = createdRows.every((row) => row !== undefined)
    ? createdRows.map((row) => pageJson(row!))
    : await readPageCreateReplay(c.env.DB, member.workspace.id, parsed, requestHash, conflictMessage);
  if (!createdPages) {
    throw new Error("The created page batch was not returned completely by its inserts or committed receipts.");
  }
  sendWorkspaceEvent(c, member.workspace.id, { type: "pages-upserted", pages: createdPages });
  return c.json({ pages: createdPages, replayed: false }, 201);
});

app.get("/api/pages/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  return c.json({ page: pageJson(await pageForMember(c.env, member, c.req.param("id"), true)) });
});

app.patch("/api/pages/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  const body = await jsonBody(c.req.raw);
  const revision = Number(body.revision);
  const titleValue = body.title === undefined ? page.title : text(body.title, "title", PAGE_TITLE_MAX);
  const iconValue = body.icon === undefined ? page.icon : body.icon === null ? null : text(body.icon, "icon", 20);
  const result = await c.env.DB.prepare(
    `UPDATE pages SET title = ?, icon = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND revision = ?`,
  )
    .bind(titleValue, iconValue, now(), page.id, member.workspace.id, revision)
    .run();
  if (!result.meta.changes)
    throw new HttpError(409, "stale_revision", "The page metadata changed. Reload and try again.");
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM page_search WHERE page_id = ?`).bind(page.id),
    c.env.DB.prepare(`INSERT INTO page_search (page_id, workspace_id, title, body) VALUES (?, ?, ?, ?)`).bind(
      page.id,
      member.workspace.id,
      titleValue,
      await currentPlainText(c.env, page.id),
    ),
  ]);
  const updated = pageJson(await pageForMember(c.env, member, page.id));
  sendWorkspaceEvent(c, member.workspace.id, { type: "pages-upserted", pages: [updated] });
  return c.json({ page: updated });
});

app.post("/api/pages/:id/move", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  const body = await jsonBody(c.req.raw);
  const parentId = nullableId(body.parentId, "parentId");
  if (parentId) {
    await pageForMember(c.env, member, parentId);
    const cycle = await c.env.DB.prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM pages WHERE id = ?
         UNION ALL SELECT p.id FROM pages p JOIN descendants d ON p.parent_id = d.id
       ) SELECT 1 cycle FROM descendants WHERE id = ? LIMIT 1`,
    )
      .bind(page.id, parentId)
      .first();
    if (cycle) throw new HttpError(409, "page_cycle", "A page cannot be moved beneath itself or a descendant.");
  }
  const beforeId = nullableId(body.beforeId, "beforeId");
  const afterId = nullableId(body.afterId, "afterId");
  const neighbors = await c.env.DB.prepare(
    `SELECT id, position FROM pages WHERE workspace_id = ? AND parent_id IS ? AND archived_at IS NULL`,
  )
    .bind(member.workspace.id, parentId)
    .all<{ id: string; position: string }>();
  const before = neighbors.results.find((item) => item.id === beforeId)?.position ?? null;
  const after = neighbors.results.find((item) => item.id === afterId)?.position ?? null;
  if (beforeId && !before)
    throw new HttpError(422, "invalid_neighbor", "beforeId is not a sibling in the destination.");
  if (afterId && !after) throw new HttpError(422, "invalid_neighbor", "afterId is not a sibling in the destination.");
  const lower =
    after ??
    (before
      ? null
      : (neighbors.results.sort((a, b) => compareBinaryText(a.position, b.position)).at(-1)?.position ?? null));
  const upper = before;
  if (lower && upper && lower >= upper) throw new HttpError(422, "invalid_order", "afterId must come before beforeId.");
  await c.env.DB.prepare(
    `UPDATE pages SET parent_id = ?, position = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
  )
    .bind(parentId, generateJitteredKeyBetween(lower, upper), now(), page.id)
    .run();
  const moved = pageJson(await pageForMember(c.env, member, page.id));
  sendWorkspaceEvent(c, member.workspace.id, { type: "pages-upserted", pages: [moved] });
  return c.json({ page: moved });
});

app.delete("/api/pages/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"), true);
  const requestedOperationId = c.req.header("x-notes-operation-id");
  const operationId = requestedOperationId && ID_PATTERN.test(requestedOperationId) ? requestedOperationId : undefined;
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM pages WHERE id = ? AND workspace_id = ?
         UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
       ) UPDATE pages
           SET archived_at = ?, archived_by = ?, revision = revision + 1, updated_at = ?
         WHERE id IN subtree`,
    ).bind(page.id, member.workspace.id, timestamp, member.user.id, timestamp),
    c.env.DB.prepare(`DELETE FROM page_search WHERE page_id IN (
      WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id)
      SELECT id FROM subtree
    )`).bind(page.id),
    c.env.DB.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
       )
       INSERT INTO archive_disconnect_targets
        (page_id, workspace_id, content_epoch, room, next_attempt_at, created_at, updated_at)
       SELECT id, workspace_id, content_epoch, id || '~' || content_epoch, ?, ?, ?
         FROM pages WHERE id IN subtree AND kind = 'document'
       ON CONFLICT(page_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         content_epoch = excluded.content_epoch,
         room = excluded.room,
         attempts = 0,
         next_attempt_at = excluded.next_attempt_at,
         last_error = NULL,
         updated_at = excluded.updated_at`,
    ).bind(page.id, timestamp, timestamp, timestamp),
  ]);
  const archived = await c.env.DB.prepare(
    `WITH RECURSIVE subtree(id) AS (
       SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
     ) SELECT id, kind, content_epoch FROM pages WHERE id IN subtree`,
  )
    .bind(page.id)
    .all<{ id: string; kind: PageKind; content_epoch: number }>();
  const pageIds = archived.results.map((item) => item.id);
  const documents = archived.results.filter((item) => item.kind === "document");
  sendWorkspaceEvent(c, member.workspace.id, {
    type: "pages-removed",
    pageIds,
    permanently: false,
    ...(operationId ? { operationId } : {}),
  });
  const pendingPageIds = await processArchiveDisconnectTargets(
    c.env,
    documents.map((item) => ({
      page_id: item.id,
      content_epoch: item.content_epoch,
    })),
  );
  return c.json(
    {
      ok: true,
      pageIds,
      cleanupPending: pendingPageIds.length > 0,
      pendingPageIds,
    },
    pendingPageIds.length ? 202 : 200,
  );
});

app.post("/api/pages/:id/restore", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"), true);
  const restoredSnapshotStatement = c.env.DB.prepare(
    `SELECT * FROM pages WHERE id IN (
      WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id)
      SELECT id FROM subtree
    )`,
  ).bind(page.id);
  const restored = await batchWithFinalResult<PageRow>(
    c.env.DB,
    [
      c.env.DB.prepare(
        `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM pages WHERE id = ? AND workspace_id = ?
         UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
       ) UPDATE pages
           SET archived_at = NULL, archived_by = NULL, revision = revision + 1, updated_at = ?
         WHERE id IN subtree`,
      ).bind(page.id, member.workspace.id, now()),
      c.env.DB.prepare(
        `DELETE FROM archive_disconnect_targets WHERE page_id IN (
         WITH RECURSIVE subtree(id) AS (
           SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
         ) SELECT id FROM subtree
       )`,
      ).bind(page.id),
      c.env.DB.prepare(
        `DELETE FROM page_search WHERE page_id IN (
         WITH RECURSIVE subtree(id) AS (
           SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
         ) SELECT id FROM subtree
       )`,
      ).bind(page.id),
      c.env.DB.prepare(
        `INSERT INTO page_search (page_id, workspace_id, title, body)
       SELECT id, workspace_id, title, COALESCE(plain_text, '') FROM pages WHERE id IN (
         WITH RECURSIVE subtree(id) AS (
           SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
         ) SELECT id FROM subtree
       )`,
      ).bind(page.id),
    ],
    // Read the restored snapshot in the same transaction as the update.
    restoredSnapshotStatement,
  );
  if (
    !restored ||
    !restored.results.some((item) => item.id === page.id) ||
    restored.results.some((item) => item.archived_at !== null)
  ) {
    throw new Error("The restore batch did not return its authoritative page snapshot.");
  }
  const restoredPages = restored.results.map(pageJson);
  sendWorkspaceEvent(c, member.workspace.id, {
    type: "pages-upserted",
    pages: restoredPages,
    restored: true,
  });
  return c.json({ pages: restoredPages });
});

app.post("/api/pages/:id/permanent-delete", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const page = await pageForMember(c.env, member, c.req.param("id"), true);
  if (!page.archived_at) throw new HttpError(409, "archive_first", "Archive a page before permanently deleting it.");
  const [subtree, attachments] = await Promise.all([
    c.env.DB.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
       ) SELECT * FROM pages WHERE id IN subtree`,
    )
      .bind(page.id)
      .all<PageRow>(),
    c.env.DB.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
       )
       SELECT r2_key FROM attachments WHERE page_id IN subtree
       UNION ALL
       SELECT r2_key FROM attachment_uploads
        WHERE page_id IN subtree AND state IN ('r2_complete', 'committed')`,
    )
      .bind(page.id)
      .all<{ r2_key: string }>(),
  ]);
  const jobId = crypto.randomUUID();
  const timestamp = now();
  const targets = new Map<string, { kind: "document_do" | "r2_object" | "r2_prefix"; target: string }>();
  for (const item of subtree.results) {
    if (item.kind !== "document") continue;
    targets.set(`r2_prefix:documents/${item.id}/`, { kind: "r2_prefix", target: `documents/${item.id}/` });
    for (let epoch = 1; epoch <= item.content_epoch; epoch++) {
      targets.set(`document_do:${item.id}~${epoch}`, { kind: "document_do", target: `${item.id}~${epoch}` });
    }
  }
  for (const attachment of attachments.results) {
    targets.set(`r2_object:${attachment.r2_key}`, { kind: "r2_object", target: attachment.r2_key });
  }
  const targetValues = [...targets.values()];
  try {
    await c.env.DB.prepare(
      `INSERT INTO deletion_jobs
        (id, workspace_id, root_page_id, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(jobId, member.workspace.id, page.id, Number.MAX_SAFE_INTEGER, timestamp, timestamp)
      .run();
    for (let index = 0; index < targetValues.length; index += DELETION_TARGET_BATCH_SIZE) {
      await c.env.DB.batch(
        targetValues
          .slice(index, index + DELETION_TARGET_BATCH_SIZE)
          .map((target) =>
            c.env.DB.prepare(`INSERT INTO deletion_targets (job_id, kind, target) VALUES (?, ?, ?)`).bind(
              jobId,
              target.kind,
              target.target,
            ),
          ),
      );
    }
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE deletion_jobs SET next_attempt_at = ?, updated_at = ? WHERE id = ?`).bind(
        timestamp,
        timestamp,
        jobId,
      ),
      c.env.DB.prepare(
        `DELETE FROM page_search WHERE page_id IN (
           WITH RECURSIVE subtree(id) AS (
             SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
           ) SELECT id FROM subtree
         )`,
      ).bind(page.id),
      c.env.DB.prepare(
        `DELETE FROM attachment_uploads
          WHERE state IN ('r2_complete', 'committed') AND page_id IN (
            WITH RECURSIVE subtree(id) AS (
              SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
            ) SELECT id FROM subtree
          )`,
      ).bind(page.id),
      c.env.DB.prepare(`DELETE FROM pages WHERE id = ? AND workspace_id = ?`).bind(page.id, member.workspace.id),
    ]);
    if (!results[3]?.meta.changes) throw new Error("Page metadata changed during permanent deletion.");
  } catch (error) {
    try {
      await c.env.DB.prepare(`DELETE FROM deletion_jobs WHERE id = ?`).bind(jobId).run();
    } catch (cleanupError) {
      console.error("Failed to discard staged deletion job", cleanupError);
    }
    throw error;
  }
  const pageIds = subtree.results.map((item) => item.id);
  sendWorkspaceEvent(c, member.workspace.id, { type: "pages-removed", pageIds, permanently: true });
  c.executionCtx.waitUntil(
    processDeletionJob(c.env, jobId).catch((error) => {
      console.error("Immediate deletion cleanup failed", error);
    }),
  );
  return c.json({ ok: true, pageIds, cleanupPending: true }, 202);
});

app.get("/api/search", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const query = (c.req.query("q") ?? "").trim().slice(0, 200);
  if (!query) return c.json({ results: [] });
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) ?? [];
  if (!terms.length) return c.json({ results: [] });
  const match = terms.map((word) => `"${word.replaceAll('"', '""')}"*`).join(" AND ");
  const rows = await c.env.DB.prepare(
    `SELECT p.*, snippet(page_search, 3, '<mark>', '</mark>', '…', 20) snippet
       FROM page_search JOIN pages p ON p.id = page_search.page_id
      WHERE page_search MATCH ? AND page_search.workspace_id = ? AND p.archived_at IS NULL
      ORDER BY bm25(page_search) LIMIT 30`,
  )
    .bind(match, member.workspace.id)
    .all<PageRow & { snippet: string }>();
  return c.json({ results: rows.results.map((row) => ({ page: pageJson(row), snippet: row.snippet })) });
});

app.get("/api/mentions/suggestions", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const query = (c.req.query("q") ?? "").trim().slice(0, 100);
  const escapedQuery = escapeLike(query);
  const pattern = `%${escapedQuery}%`;
  const [pages, members] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, title, icon FROM pages
        WHERE workspace_id = ? AND archived_at IS NULL AND title LIKE ? ESCAPE '\\'
        ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, title, id LIMIT 10`,
    )
      .bind(member.workspace.id, pattern, `${escapedQuery}%`)
      .all<{ id: string; title: string; icon: string | null }>(),
    c.env.DB.prepare(
      `SELECT u.id, u.name, u.email, wm.role
         FROM workspace_members wm JOIN user u ON u.id = wm.user_id
        WHERE wm.workspace_id = ? AND (u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')
        ORDER BY u.name, u.id LIMIT 10`,
    )
      .bind(member.workspace.id, pattern, pattern)
      .all<{ id: string; name: string; email: string; role: string }>(),
  ]);
  return c.json({
    suggestions: [
      ...pages.results.map((page) => ({
        entityType: "page" as const,
        entityId: page.id,
        label: page.title,
        detail: "Page",
        icon: page.icon,
      })),
      ...members.results.map((item) => ({
        entityType: "user" as const,
        entityId: item.id,
        label: item.name,
        detail: `${item.email} · ${item.role}`,
        icon: null,
      })),
    ],
  });
});

app.get("/api/pages/:id/preview", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const row = await c.env.DB.prepare(`SELECT * FROM pages WHERE id = ? AND workspace_id = ? AND archived_at IS NULL`)
    .bind(c.req.param("id"), member.workspace.id)
    .first<PageRow>();
  if (!row) throw new HttpError(404, "page_not_found", "Page not found.");
  return c.json({ preview: { page: pageJson(row), excerpt: (row.plain_text ?? "").slice(0, 280) } });
});

app.get("/api/pages/:id/verification", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const row = await c.env.DB.prepare(`SELECT * FROM pages WHERE id = ? AND workspace_id = ? AND archived_at IS NULL`)
    .bind(c.req.param("id"), member.workspace.id)
    .first<PageRow>();
  if (!row) throw new HttpError(404, "page_not_found", "Page not found.");
  const [references, mentions] = await Promise.all([
    c.env.DB.prepare(
      `SELECT target_page_id targetId FROM page_references WHERE source_page_id = ? ORDER BY target_page_id`,
    )
      .bind(row.id)
      .all<{ targetId: string }>(),
    c.env.DB.prepare(
      `SELECT target_user_id targetId FROM member_mentions WHERE source_page_id = ? ORDER BY target_user_id`,
    )
      .bind(row.id)
      .all<{ targetId: string }>(),
  ]);
  const projection = {
    plainText: row.plain_text ?? "",
    pageReferences: references.results.map(({ targetId }) => ({ targetId, excerpt: "" })),
    memberMentions: mentions.results.map(({ targetId }) => ({ targetId, excerpt: "" })),
  };
  return c.json({
    verification: {
      page: pageJson(row),
      indexedSequence: row.indexed_seq,
      projectionHash: await documentProjectionHash(projection),
      plainTextLength: projection.plainText.length,
    },
  });
});

app.get("/api/pages/:id/backlinks", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  const rows = await c.env.DB.prepare(
    `SELECT source.*, reference.excerpt
       FROM page_references reference JOIN pages source ON source.id = reference.source_page_id
      WHERE reference.target_page_id = ? AND source.workspace_id = ? AND source.archived_at IS NULL
      ORDER BY source.updated_at DESC, source.id`,
  )
    .bind(page.id, member.workspace.id)
    .all<PageRow & { excerpt: string }>();
  return c.json({ backlinks: rows.results.map((row) => ({ page: pageJson(row), excerpt: row.excerpt })) });
});

app.get("/api/mentions/unread-count", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const row = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT mention.source_page_id) count
       FROM member_mentions mention
       JOIN pages source ON source.id = mention.source_page_id AND source.archived_at IS NULL
       LEFT JOIN mention_reads reads
         ON reads.workspace_id = mention.workspace_id AND reads.user_id = mention.target_user_id
      WHERE mention.workspace_id = ? AND mention.target_user_id = ?
        AND mention.first_seen_at > COALESCE(reads.read_at, 0)`,
  )
    .bind(member.workspace.id, member.user.id)
    .first<{ count: number }>();
  return c.json({ unreadCount: row?.count ?? 0 });
});

app.get("/api/mentions", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const requestedAsOf = c.req.query("asOf");
  // Use the previous millisecond for a new traversal so a projection committed
  // after this read can never share the cursor and be marked read unseen.
  const asOf = requestedAsOf === undefined ? now() - 1 : Number(requestedAsOf);
  const beforeAtValue = c.req.query("beforeAt");
  const beforeId = c.req.query("beforeId");
  const beforeAt = beforeAtValue === undefined ? null : Number(beforeAtValue);
  if (!Number.isInteger(asOf) || asOf < 0 || asOf > now() + 1_000) {
    throw new HttpError(422, "invalid_mentions_cursor", "asOf must be a valid server timestamp.");
  }
  if (
    (beforeAtValue === undefined) !== (beforeId === undefined) ||
    (beforeAt !== null && (!Number.isInteger(beforeAt) || beforeAt < 0)) ||
    (beforeId !== undefined && (!beforeId || beforeId.length > 100))
  ) {
    throw new HttpError(422, "invalid_mentions_cursor", "The mention page cursor is invalid.");
  }
  const rows = await c.env.DB.prepare(
    `SELECT source.*, mention.excerpt, mention.first_seen_at,
            CASE WHEN mention.first_seen_at > COALESCE(reads.read_at, 0) THEN 1 ELSE 0 END unread
       FROM member_mentions mention
       JOIN pages source ON source.id = mention.source_page_id AND source.archived_at IS NULL
       LEFT JOIN mention_reads reads
         ON reads.workspace_id = mention.workspace_id AND reads.user_id = mention.target_user_id
      WHERE mention.workspace_id = ? AND mention.target_user_id = ? AND mention.first_seen_at <= ?
        AND (? IS NULL OR mention.first_seen_at < ?
          OR (mention.first_seen_at = ? AND source.id > ?))
      ORDER BY mention.first_seen_at DESC, source.id LIMIT 101`,
  )
    .bind(member.workspace.id, member.user.id, asOf, beforeAt, beforeAt, beforeAt, beforeId ?? null)
    .all<PageRow & { excerpt: string; first_seen_at: number; unread: number }>();
  const pageRows = rows.results.slice(0, 100);
  const last = pageRows.at(-1);
  return c.json({
    asOf,
    nextCursor:
      rows.results.length > pageRows.length && last ? { firstSeenAt: last.first_seen_at, pageId: last.id } : null,
    mentions: pageRows.map((row) => ({
      page: pageJson(row),
      excerpt: row.excerpt,
      firstSeenAt: row.first_seen_at,
      unread: Boolean(row.unread),
    })),
  });
});

app.post("/api/mentions/read", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const body = await jsonBody(c.req.raw);
  const through = Number(body.through);
  if (!Number.isInteger(through) || through < 0 || through > now() + 1_000) {
    throw new HttpError(422, "invalid_read_cursor", "through must be a valid server timestamp.");
  }
  await c.env.DB.prepare(
    `INSERT INTO mention_reads (workspace_id, user_id, read_at) VALUES (?, ?, ?)
      ON CONFLICT(workspace_id, user_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)`,
  )
    .bind(member.workspace.id, member.user.id, through)
    .run();
  const unread = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT mention.source_page_id) count
       FROM member_mentions mention
       JOIN pages source ON source.id = mention.source_page_id AND source.archived_at IS NULL
       LEFT JOIN mention_reads reads
         ON reads.workspace_id = mention.workspace_id AND reads.user_id = mention.target_user_id
      WHERE mention.workspace_id = ? AND mention.target_user_id = ?
        AND mention.first_seen_at > COALESCE(reads.read_at, 0)`,
  )
    .bind(member.workspace.id, member.user.id)
    .first<{ count: number }>();
  return c.json({ unreadCount: unread?.count ?? 0 });
});

type AttachmentRow = {
  id: string;
  workspace_id: string;
  page_id: string;
  r2_key: string;
  name: string;
  mime: string;
  size: number;
  content_sha256: string | null;
  created_by: string;
  created_at: number;
};

function attachmentJson(attachment: AttachmentRow) {
  return {
    id: attachment.id,
    pageId: attachment.page_id,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    contentSha256: attachment.content_sha256,
  };
}

function optionalSha256(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[a-f\d]{64}$/i.test(value)) {
    throw new HttpError(422, "invalid_input", `${field} must be a hexadecimal SHA-256 digest.`);
  }
  return value.toLowerCase();
}

function sameAttachment(
  attachment: AttachmentRow,
  expected: { pageId: string; name: string; mime: string; size: number; contentSha256: string | null },
) {
  return (
    attachment.page_id === expected.pageId &&
    attachment.name === expected.name &&
    attachment.mime === expected.mime &&
    attachment.size === expected.size &&
    attachment.content_sha256 === expected.contentSha256
  );
}

async function attachmentById(env: Env, workspaceId: string, id: string) {
  return env.DB.prepare(`SELECT * FROM attachments WHERE id = ? AND workspace_id = ?`)
    .bind(id, workspaceId)
    .first<AttachmentRow>();
}

app.get("/api/pages/:id/attachments", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForMember(c.env, member, c.req.param("id"), true);
  const attachments = await c.env.DB.prepare(
    `SELECT id, page_id pageId, name, mime, size, content_sha256 contentSha256,
            created_by createdBy, created_at createdAt
       FROM attachments WHERE page_id = ? AND workspace_id = ? ORDER BY created_at DESC`,
  )
    .bind(page.id, member.workspace.id)
    .all();
  return c.json({ attachments: attachments.results });
});

app.post("/api/pages/:id/attachments", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  const contentLength = Number(c.req.header("content-length") ?? 0);
  if (contentLength > MAX_UPLOAD_BYTES + 100_000)
    throw new HttpError(413, "upload_too_large", "Uploads are limited to 10 MiB.");
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(422, "file_required", "Attach one file in the file field.");
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "upload_too_large", "Uploads are limited to 10 MiB.");
  const mime = file.type || "application/octet-stream";
  if (isUnsafeMime(mime, file.name))
    throw new HttpError(415, "unsafe_file_type", "HTML, SVG, and executable web content cannot be uploaded.");
  const suppliedId = form.get("attachmentId");
  const id = suppliedId === null ? crypto.randomUUID() : text(suppliedId, "attachmentId", 100);
  if (!ID_PATTERN.test(id)) throw new HttpError(422, "invalid_input", "attachmentId is not a valid resource id.");
  const name = normalizeFilename(file.name);
  const declaredContentSha = optionalSha256(form.get("contentSha256"), "contentSha256");
  const suppliedRequestHash = optionalSha256(form.get("requestHash"), "requestHash");
  const actualContentSha = await sha256Hex(new Uint8Array(await file.arrayBuffer()));
  if (declaredContentSha && declaredContentSha !== actualContentSha) {
    throw new HttpError(422, "attachment_hash_mismatch", "The uploaded bytes do not match contentSha256.");
  }
  const contentSha256 = declaredContentSha ?? actualContentSha;
  const canonicalRequestHash = await sha256Hex(
    canonicalJson({ attachmentId: id, pageId: page.id, name, mime, size: file.size, contentSha256 }),
  );
  if (suppliedRequestHash && suppliedRequestHash !== canonicalRequestHash) {
    throw new HttpError(422, "request_hash_mismatch", "requestHash does not match the attachment metadata.");
  }
  const expected = { pageId: page.id, name, mime, size: file.size, contentSha256 };
  const existing = await attachmentById(c.env, member.workspace.id, id);
  if (existing) {
    if (!sameAttachment(existing, expected)) {
      throw new HttpError(409, "idempotency_key_reused", "That attachment id already describes another file.");
    }
    return c.json({ attachment: attachmentJson(existing), replayed: true });
  }
  const inFlight = await c.env.DB.prepare(`SELECT 1 found FROM attachment_uploads WHERE id = ?`).bind(id).first();
  if (inFlight) throw new HttpError(409, "idempotency_key_reused", "That attachment id is already an upload session.");
  const key = `assets/${member.workspace.id}/${id}/${contentSha256}`;
  await c.env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: mime },
    customMetadata: { attachmentId: id },
  });
  try {
    await c.env.DB.prepare(
      `INSERT INTO attachments
         (id, workspace_id, page_id, r2_key, name, mime, size, content_sha256, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, member.workspace.id, page.id, key, name, mime, file.size, contentSha256, member.user.id, now())
      .run();
  } catch (error) {
    const replay = await attachmentById(c.env, member.workspace.id, id);
    if (replay && sameAttachment(replay, expected)) {
      return c.json({ attachment: attachmentJson(replay), replayed: true });
    }
    // A conflicting row with the same content hash committed this same deterministic
    // key concurrently; deleting it would strand that row without its object.
    if (replay?.r2_key !== key) await c.env.BUCKET.delete(key);
    if (replay) {
      throw new HttpError(409, "idempotency_key_reused", "That attachment id already describes another file.");
    }
    throw error;
  }
  return c.json({ attachment: { id, ...expected }, replayed: false }, 201);
});

app.get("/api/attachments/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const attachment = await c.env.DB.prepare(
    `SELECT a.* FROM attachments a JOIN pages p ON p.id = a.page_id
      WHERE a.id = ? AND a.workspace_id = ? AND p.archived_at IS NULL`,
  )
    .bind(c.req.param("id"), member.workspace.id)
    .first<{
      r2_key: string;
      name: string;
      mime: string;
      size: number;
    }>();
  if (!attachment) throw new HttpError(404, "attachment_not_found", "Attachment not found.");
  const rangeRequested = Boolean(c.req.header("range"));
  let r2Object = await c.env.BUCKET.get(attachment.r2_key, {
    ...(rangeRequested ? { range: c.req.raw.headers } : {}),
    onlyIf: c.req.raw.headers,
  });
  if (!r2Object) throw new HttpError(404, "attachment_missing", "The attachment data is missing.");
  const headers = new Headers();
  r2Object.writeHttpMetadata(headers);
  headers.set("etag", r2Object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, max-age=0, must-revalidate");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-disposition", attachmentDisposition(attachment.name, isInlineMime(attachment.mime)));
  if (!("body" in r2Object)) {
    const status = conditionalGetStatus(c.req.raw.headers, r2Object);
    if (status !== 200) {
      return new Response(null, { status, headers });
    }
    r2Object = await c.env.BUCKET.get(attachment.r2_key, rangeRequested ? { range: c.req.raw.headers } : {});
    if (!r2Object || !("body" in r2Object)) {
      throw new HttpError(404, "attachment_missing", "The attachment data is missing.");
    }
  }
  const range = rangeRequested && r2Object.range ? normalizeR2Range(r2Object.range, r2Object.size) : null;
  if (range && range.length > 0) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${r2Object.size}`);
    headers.set("content-length", String(range.length));
    return new Response(r2Object.body, { status: 206, headers });
  }
  return new Response(r2Object.body, { status: 200, headers });
});

app.delete("/api/attachments/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const attachment = await c.env.DB.prepare(`SELECT r2_key FROM attachments WHERE id = ? AND workspace_id = ?`)
    .bind(c.req.param("id"), member.workspace.id)
    .first<{ r2_key: string }>();
  if (!attachment) throw new HttpError(404, "attachment_not_found", "Attachment not found.");
  await c.env.DB.prepare(`DELETE FROM attachments WHERE id = ?`).bind(c.req.param("id")).run();
  await c.env.BUCKET.delete(attachment.r2_key);
  return c.json({ ok: true });
});

type UploadSessionRow = {
  id: string;
  workspace_id: string;
  page_id: string;
  r2_key: string;
  r2_upload_id: string;
  name: string;
  mime: string;
  size: number;
  part_size: number;
  part_count: number;
  state: "active" | "completing" | "r2_complete" | "committed" | "reaping" | "aborting";
  request_hash: string | null;
  content_sha256: string | null;
  next_attempt_at: number;
  updated_at: number;
};

// Resolves an upload session the caller is allowed to act on. The R2 upload id is
// never handed to a client: a session is addressed by our own id so every request is
// authorised against D1 first, and R2's key layout stays server-side.
async function uploadSession(env: Env, member: MemberContext, uploadId: string) {
  const session = await env.DB.prepare(
    `SELECT u.* FROM attachment_uploads u JOIN pages p ON p.id = u.page_id
      WHERE u.id = ? AND u.workspace_id = ? AND p.archived_at IS NULL`,
  )
    .bind(uploadId, member.workspace.id)
    .first<UploadSessionRow>();
  if (!session) throw new HttpError(404, "upload_session_not_found", "That upload session no longer exists.");
  return session;
}

function uploadJson(session: UploadSessionRow) {
  return {
    id: session.id,
    pageId: session.page_id,
    name: session.name,
    mime: session.mime,
    size: session.size,
    contentSha256: session.content_sha256,
    partSize: session.part_size,
    partCount: session.part_count,
    expiresAt: session.next_attempt_at,
  };
}

function sameUpload(
  session: UploadSessionRow,
  expected: {
    pageId: string;
    name: string;
    mime: string;
    size: number;
    contentSha256: string | null;
    requestHash: string;
  },
) {
  return (
    session.page_id === expected.pageId &&
    session.name === expected.name &&
    session.mime === expected.mime &&
    session.size === expected.size &&
    session.content_sha256 === expected.contentSha256 &&
    session.request_hash === expected.requestHash
  );
}

// The size of one part, which is fixed for every part except the last. R2 rejects a
// multipart upload whose middle parts differ in size, so the server dictates this
// rather than accepting whatever the client happened to chunk to.
function expectedPartBytes(session: UploadSessionRow, partNumber: number) {
  return partNumber === session.part_count
    ? session.size - session.part_size * (session.part_count - 1)
    : session.part_size;
}

app.post("/api/pages/:id/uploads", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  const body = await jsonBody(c.req.raw);
  const name = normalizeFilename(text(body.name, "name", 400));
  const mime = body.mime === undefined ? "application/octet-stream" : text(body.mime, "mime", 200);
  const size = Number(body.size);
  if (!Number.isInteger(size) || size <= 0) {
    throw new HttpError(422, "invalid_input", "size must be a positive integer.");
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new HttpError(413, "upload_too_large", "That file is larger than the attachment limit.");
  }
  // Checked before a single byte moves, so a rejected type costs one request rather
  // than an entire multi-gigabyte upload.
  if (isUnsafeMime(mime, name)) {
    throw new HttpError(415, "unsafe_file_type", "That file type is not accepted.");
  }
  const partSize = resolvePartSize(body.partSize);
  const partCount = Math.ceil(size / partSize);
  const id = body.attachmentId === undefined ? crypto.randomUUID() : text(body.attachmentId, "attachmentId", 100);
  if (!ID_PATTERN.test(id)) throw new HttpError(422, "invalid_input", "attachmentId is not a valid resource id.");
  const contentSha256 = optionalSha256(body.contentSha256, "contentSha256");
  const canonicalRequestHash = await sha256Hex(
    canonicalJson({ attachmentId: id, pageId: page.id, name, mime, size, contentSha256 }),
  );
  const suppliedRequestHash = optionalSha256(body.requestHash, "requestHash");
  if (suppliedRequestHash && suppliedRequestHash !== canonicalRequestHash) {
    throw new HttpError(422, "request_hash_mismatch", "requestHash does not match the upload metadata.");
  }
  const requestHash = suppliedRequestHash ?? canonicalRequestHash;
  const expected = { pageId: page.id, name, mime, size, contentSha256, requestHash };
  const completed = await attachmentById(c.env, member.workspace.id, id);
  if (completed) {
    if (!sameAttachment(completed, expected)) {
      throw new HttpError(409, "idempotency_key_reused", "That attachment id already describes another file.");
    }
    return c.json({ status: "committed", attachment: attachmentJson(completed), replayed: true });
  }
  const existing = await c.env.DB.prepare(`SELECT * FROM attachment_uploads WHERE id = ? AND workspace_id = ?`)
    .bind(id, member.workspace.id)
    .first<UploadSessionRow>();
  if (existing) {
    if (!sameUpload(existing, expected) || existing.state === "reaping" || existing.state === "aborting") {
      throw new HttpError(409, "idempotency_key_reused", "That attachment id is already used by another upload.");
    }
    return c.json({ status: existing.state, upload: uploadJson(existing), replayed: true });
  }
  const key = `assets/${member.workspace.id}/${id}/${contentSha256 ?? requestHash}`;
  const upload = await c.env.BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: mime },
    customMetadata: { attachmentId: id },
  });
  const timestamp = now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO attachment_uploads
         (id, workspace_id, page_id, r2_key, r2_upload_id, name, mime, size, part_size, part_count,
          created_by, created_at, updated_at, next_attempt_at, state, request_hash, content_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
      .bind(
        id,
        member.workspace.id,
        page.id,
        key,
        upload.uploadId,
        name,
        mime,
        size,
        partSize,
        partCount,
        member.user.id,
        timestamp,
        timestamp,
        timestamp + UPLOAD_SESSION_TTL_MS,
        requestHash,
        contentSha256,
      )
      .run();
  } catch (error) {
    // Nothing records this upload yet, so abandoning it here would leak parts with no
    // row for the reaper to find them by.
    await upload.abort().catch((abortError) => {
      console.error("Failed to abort an unrecorded multipart upload", abortError);
    });
    const completedReplay = await attachmentById(c.env, member.workspace.id, id);
    if (completedReplay && sameAttachment(completedReplay, expected)) {
      return c.json({ status: "committed", attachment: attachmentJson(completedReplay), replayed: true });
    }
    const replay = await c.env.DB.prepare(`SELECT * FROM attachment_uploads WHERE id = ? AND workspace_id = ?`)
      .bind(id, member.workspace.id)
      .first<UploadSessionRow>();
    if (replay && sameUpload(replay, expected)) {
      return c.json({ status: replay.state, upload: uploadJson(replay), replayed: true });
    }
    if (replay || completedReplay) {
      throw new HttpError(409, "idempotency_key_reused", "That attachment id is already used by another upload.");
    }
    throw error;
  }
  return c.json(
    {
      status: "active",
      upload: {
        id,
        pageId: page.id,
        name,
        mime,
        size,
        contentSha256,
        partSize,
        partCount,
        expiresAt: timestamp + UPLOAD_SESSION_TTL_MS,
      },
      replayed: false,
    },
    201,
  );
});

app.get("/api/uploads/:uploadId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const completed = await attachmentById(c.env, member.workspace.id, c.req.param("uploadId"));
  if (completed) return c.json({ status: "committed", attachment: attachmentJson(completed) });
  const session = await uploadSession(c.env, member, c.req.param("uploadId"));
  const parts = await c.env.DB.prepare(
    `SELECT part_number, etag, size FROM attachment_upload_parts WHERE upload_id = ? ORDER BY part_number`,
  )
    .bind(session.id)
    .all<{ part_number: number; etag: string; size: number }>();
  return c.json({
    status: session.state,
    upload: uploadJson(session),
    // Which parts already landed, so an interrupted upload resumes instead of
    // restarting from the first byte.
    parts: parts.results.map((part) => ({ partNumber: part.part_number, etag: part.etag, size: part.size })),
  });
});

app.put("/api/uploads/:uploadId/parts/:partNumber", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  await uploadSession(c.env, member, c.req.param("uploadId"));
  const claimedAt = now();
  const session = await c.env.DB.prepare(
    `UPDATE attachment_uploads SET updated_at = ?, next_attempt_at = ?, last_error = NULL
      WHERE id = ? AND workspace_id = ? AND state = 'active'
      RETURNING *`,
  )
    .bind(claimedAt, claimedAt + UPLOAD_SESSION_TTL_MS, c.req.param("uploadId"), member.workspace.id)
    .first<UploadSessionRow>();
  if (!session) throw new HttpError(409, "upload_not_active", "That upload is no longer accepting parts.");
  const partNumber = Number(c.req.param("partNumber"));
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.part_count) {
    throw new HttpError(422, "upload_part_size", "That part number is outside this upload.");
  }
  // Read rather than streamed so the length can be checked exactly before R2 is
  // touched; one part is bounded well below the Worker's memory ceiling.
  const bytes = await c.req.arrayBuffer();
  const expected = expectedPartBytes(session, partNumber);
  if (bytes.byteLength !== expected) {
    throw new HttpError(422, "upload_part_size", `Part ${partNumber} must be exactly ${expected} bytes.`);
  }
  const upload = c.env.BUCKET.resumeMultipartUpload(session.r2_key, session.r2_upload_id);
  const part = await upload.uploadPart(partNumber, bytes);
  const timestamp = now();
  await c.env.DB.batch([
    // Re-uploading a part replaces it, so a retry after a network failure is safe.
    c.env.DB.prepare(
      `INSERT INTO attachment_upload_parts (upload_id, part_number, etag, size, uploaded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(upload_id, part_number)
         DO UPDATE SET etag = excluded.etag, size = excluded.size, uploaded_at = excluded.uploaded_at`,
    ).bind(session.id, partNumber, part.etag, bytes.byteLength, timestamp),
    // Every accepted part pushes the reaper's deadline out, so an upload that is merely
    // slow is never collected - only one nobody is still feeding.
    c.env.DB.prepare(
      `UPDATE attachment_uploads SET updated_at = ?, next_attempt_at = ? WHERE id = ? AND state = 'active'`,
    ).bind(timestamp, timestamp + UPLOAD_SESSION_TTL_MS, session.id),
  ]);
  return c.json({ part: { partNumber, etag: part.etag, size: bytes.byteLength } });
});

app.post("/api/uploads/:uploadId/complete", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const uploadId = c.req.param("uploadId");
  const completed = await attachmentById(c.env, member.workspace.id, uploadId);
  if (completed) return c.json({ status: "committed", attachment: attachmentJson(completed), replayed: true });
  let session = await uploadSession(c.env, member, uploadId);
  if (["reaping", "aborting"].includes(session.state)) {
    throw new HttpError(409, "upload_not_active", "That upload is being abandoned and cannot be completed.");
  }
  const parts = await c.env.DB.prepare(
    `SELECT part_number, etag, size FROM attachment_upload_parts WHERE upload_id = ? ORDER BY part_number`,
  )
    .bind(session.id)
    .all<{ part_number: number; etag: string; size: number }>();
  if (parts.results.length !== session.part_count) {
    throw new HttpError(409, "upload_incomplete", "Some parts of this upload have not arrived yet.");
  }
  const uploaded = parts.results.reduce((total, part) => total + part.size, 0);
  if (uploaded !== session.size) {
    throw new HttpError(422, "upload_size_mismatch", "The uploaded parts do not add up to the declared size.");
  }

  if (session.state === "active") {
    const claimedAt = now();
    const claimed = await c.env.DB.prepare(
      `UPDATE attachment_uploads
          SET state = 'completing', updated_at = ?, next_attempt_at = ?, last_error = NULL
        WHERE id = ? AND workspace_id = ? AND state = 'active'
        RETURNING *`,
    )
      .bind(claimedAt, claimedAt + UPLOAD_SESSION_TTL_MS, uploadId, member.workspace.id)
      .first<UploadSessionRow>();
    session = claimed ?? (await uploadSession(c.env, member, uploadId));
  }

  if (session.state === "completing") {
    const r2Object = await c.env.BUCKET.head(session.r2_key);
    if (r2Object && r2Object.size === session.size) {
      await c.env.DB.prepare(
        `UPDATE attachment_uploads SET state = 'r2_complete', updated_at = ?, next_attempt_at = ?
          WHERE id = ? AND state = 'completing'`,
      )
        .bind(now(), now() + UPLOAD_SESSION_TTL_MS, session.id)
        .run();
    } else {
      const upload = c.env.BUCKET.resumeMultipartUpload(session.r2_key, session.r2_upload_id);
      try {
        await upload.complete(parts.results.map((part) => ({ partNumber: part.part_number, etag: part.etag })));
      } catch (error) {
        // A concurrent/lost completion response is successful if the completed object
        // is now present. Otherwise the session stays completing for status/retry.
        const recovered = await c.env.BUCKET.head(session.r2_key).catch(() => null);
        if (!recovered || recovered.size !== session.size) {
          await c.env.DB.prepare(
            `UPDATE attachment_uploads SET last_error = ?, updated_at = ?, next_attempt_at = ?
              WHERE id = ? AND state = 'completing'`,
          )
            .bind("R2 multipart completion failed", now(), now() + UPLOAD_SESSION_TTL_MS, session.id)
            .run()
            .catch(() => undefined);
          console.error("Failed to complete a multipart upload", error);
          throw new HttpError(503, "multipart_complete_failed", "The upload could not be finalised. Retry it.");
        }
      }
      await c.env.DB.prepare(
        `UPDATE attachment_uploads SET state = 'r2_complete', updated_at = ?, next_attempt_at = ?, last_error = NULL
          WHERE id = ? AND state = 'completing'`,
      )
        .bind(now(), now() + UPLOAD_SESSION_TTL_MS, session.id)
        .run();
    }
    session = await uploadSession(c.env, member, uploadId);
  }
  if (session.state !== "r2_complete") {
    throw new HttpError(503, "upload_completion_in_progress", "The upload is still being finalised. Retry it.");
  }

  const timestamp = now();
  // If this batch fails, the completed R2 object and r2_complete row are deliberately
  // preserved. A retry only commits metadata; it never completes the upload again.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO attachments
           (id, workspace_id, page_id, r2_key, name, mime, size, content_sha256, created_by, created_at)
         SELECT id, workspace_id, page_id, r2_key, name, mime, size, content_sha256, created_by, ?
           FROM attachment_uploads WHERE id = ? AND state = 'r2_complete'`,
    ).bind(timestamp, session.id),
    c.env.DB.prepare(
      `UPDATE attachment_uploads SET state = 'committed', updated_at = ? WHERE id = ? AND state = 'r2_complete'`,
    ).bind(timestamp, session.id),
    c.env.DB.prepare(`DELETE FROM attachment_uploads WHERE id = ? AND state = 'committed'`).bind(session.id),
  ]);
  const attachment = await attachmentById(c.env, member.workspace.id, session.id);
  if (!attachment)
    throw new HttpError(503, "attachment_commit_failed", "The completed upload metadata was not committed.");
  return c.json({ status: "committed", attachment: attachmentJson(attachment), replayed: false }, 201);
});

app.delete("/api/uploads/:uploadId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const completed = await attachmentById(c.env, member.workspace.id, c.req.param("uploadId"));
  if (completed) {
    throw new HttpError(409, "upload_already_committed", "The upload is already an attachment and cannot be aborted.");
  }
  await uploadSession(c.env, member, c.req.param("uploadId"));
  const session = await c.env.DB.prepare(
    `UPDATE attachment_uploads SET state = 'aborting', updated_at = ?, next_attempt_at = ?
      WHERE id = ? AND workspace_id = ? AND state = 'active' RETURNING *`,
  )
    .bind(now(), now() + UPLOAD_SESSION_TTL_MS, c.req.param("uploadId"), member.workspace.id)
    .first<UploadSessionRow>();
  if (!session) throw new HttpError(409, "upload_not_abortable", "Only an active upload can be aborted.");
  try {
    await c.env.BUCKET.resumeMultipartUpload(session.r2_key, session.r2_upload_id).abort();
    await c.env.DB.prepare(`DELETE FROM attachment_uploads WHERE id = ? AND state = 'aborting'`).bind(session.id).run();
  } catch (error) {
    await c.env.DB.prepare(
      `UPDATE attachment_uploads SET last_error = ?, updated_at = ?, next_attempt_at = ?
        WHERE id = ? AND state = 'aborting'`,
    )
      .bind("R2 multipart abort failed", now(), now() + UPLOAD_SESSION_TTL_MS, session.id)
      .run()
      .catch(() => undefined);
    throw error;
  }
  return c.json({ ok: true });
});

app.get("/api/pages/:id/versions", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForMember(c.env, member, c.req.param("id"), true);
  if (page.kind !== "document")
    throw new HttpError(422, "document_required", "Tables do not have version history in v1.");
  const versions = await c.env.DB.prepare(
    `SELECT id, page_id pageId, epoch, sequence, title, byte_size byteSize,
            last_editor_id lastEditorId, created_at createdAt
       FROM page_versions WHERE page_id = ? ORDER BY created_at DESC`,
  )
    .bind(page.id)
    .all();
  return c.json({ versions: versions.results });
});

app.get("/api/versions/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const version = await c.env.DB.prepare(
    `SELECT v.*, p.workspace_id FROM page_versions v JOIN pages p ON p.id = v.page_id
      WHERE v.id = ? AND p.workspace_id = ?`,
  )
    .bind(c.req.param("id"), member.workspace.id)
    .first<{
      r2_key: string;
      title: string;
      epoch: number;
      sequence: number;
    }>();
  if (!version) throw new HttpError(404, "version_not_found", "Version not found.");
  const snapshot = await c.env.BUCKET.get(version.r2_key);
  if (!snapshot) throw new HttpError(404, "version_missing", "The version snapshot is missing.");
  return new Response(snapshot.body, {
    headers: {
      "content-type": "application/vnd.yjs",
      "content-length": String(snapshot.size),
      "x-version-title": encodeURIComponent(version.title),
      "x-version-epoch": String(version.epoch),
      "x-version-sequence": String(version.sequence),
      "cache-control": "private, no-store",
    },
  });
});

app.post("/api/pages/:id/restore-version", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  if (page.kind !== "document") throw new HttpError(422, "document_required", "Only documents can be restored.");
  const body = await jsonBody(c.req.raw);
  const versionId = text(body.versionId, "versionId", 100);
  const hint = locationHint(member.workspace.locationHint ?? undefined);
  const oldRoom = `${page.id}~${page.content_epoch}`;
  const oldStub = c.env.DOCUMENT.getByName(oldRoom, hint ? { locationHint: hint } : undefined);
  const response = await oldStub.fetch(
    new Request("https://document.internal/restore-version", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-notes-internal": c.env.BETTER_AUTH_SECRET,
      },
      body: JSON.stringify({ versionId, userId: member.user.id }),
    }),
  );
  type RestoreResult = { pageId?: string; contentEpoch?: number; error?: string };
  const result: RestoreResult = await response.json<RestoreResult>().catch(() => ({}));
  if (!response.ok || !result.contentEpoch) {
    if (response.status === 404) throw new HttpError(404, "version_not_found", result.error ?? "Version not found.");
    if (response.status === 409)
      throw new HttpError(409, "stale_epoch", result.error ?? "The page epoch changed during restore.");
    throw new HttpError(503, "restore_failed", result.error ?? "The version could not be restored.");
  }
  const restored = pageJson(await pageForMember(c.env, member, page.id));
  sendWorkspaceEvent(c, member.workspace.id, { type: "pages-upserted", pages: [restored] });
  return c.json({ pageId: page.id, contentEpoch: result.contentEpoch });
});

/**
 * Runs `read` between two revision reads of table_state and retries once when a
 * concurrent writer moved the table, so no caller can assemble a torn snapshot.
 * The fence lives in exactly one place; every table read route shares it.
 */
async function stableTableSnapshot<T>(
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
function collectRowCells(results: Record<string, unknown>[]) {
  const rows = new Map<
    string,
    { id: string; position: number; cells: Record<string, string | number | boolean | null> }
  >();
  for (const item of results) {
    const rowId = String(item.row_id);
    const row = rows.get(rowId) ?? { id: rowId, position: Number(item.row_position), cells: {} };
    if (typeof item.column_id === "string") row.cells[item.column_id] = cellValue(item);
    rows.set(rowId, row);
  }
  return [...rows.values()];
}

app.get("/api/tables/:pageId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const wantsCount = c.req.query("count") === "true";
  const page = await activeTablePage(c.env, member, c.req.param("pageId"));
  const { snapshot, revision, rowCount } = await stableTableSnapshot(c.env, page.id, wantsCount, async () => {
    const [columns, options] = await Promise.all([
      c.env.DB.prepare(`SELECT * FROM table_columns WHERE page_id = ? ORDER BY position, id`)
        .bind(page.id)
        .all<{ id: string; name: string; type: string; position: number }>(),
      c.env.DB.prepare(
        `SELECT o.* FROM table_select_options o JOIN table_columns col ON col.id = o.column_id
          WHERE col.page_id = ? ORDER BY o.position, o.id`,
      )
        .bind(page.id)
        .all<{ id: string; column_id: string; label: string; position: number }>(),
    ]);
    const rowQuery = buildTableRowQuery(page.id, columns.results, c.req.query());
    // Row identity and cells are assembled by one joined statement; the fence covers
    // the remaining column/option reads.
    const rows = await c.env.DB.prepare(
      `WITH page_rows AS (${rowQuery.sql})
       SELECT page_rows.id row_id, page_rows.position row_position,
              cell.column_id, cell.text_value, cell.number_value, cell.boolean_value,
              cell.date_value, cell.select_value
         FROM page_rows LEFT JOIN table_cells cell ON cell.row_id = page_rows.id
        ORDER BY ${rowQuery.orderSql}, cell.column_id`,
    )
      .bind(...tableRowBinds(rowQuery, rowQuery.limit + 1))
      .all<Record<string, unknown>>();
    return { columns, options, rowQuery, rows };
  });
  const { columns, options, rowQuery } = snapshot;
  const allRows = collectRowCells(snapshot.rows.results);
  const pageRows = allRows.slice(0, rowQuery.limit);
  const hasMoreRows = allRows.length > pageRows.length;
  // The follow-up request must satisfy nextOffset + limit <= TABLE_SORT_MAX_OFFSET or
  // buildTableRowQuery 422s it, so a page whose successor cannot fit is the truncation
  // point - not only a page that itself reaches the cap.
  const truncated = Boolean(
    rowQuery.sort && hasMoreRows && rowQuery.offset + 2 * rowQuery.limit > TABLE_SORT_MAX_OFFSET,
  );
  const hasMore = hasMoreRows && !truncated;
  const lastRow = pageRows.at(-1);
  const lease = await c.env.DB.prepare(
    `SELECT l.expires_at, l.holder_session_id, u.name holder_name
       FROM table_leases l JOIN user u ON u.id = l.holder_user_id WHERE l.page_id = ? AND l.expires_at > ?`,
  )
    .bind(page.id, now())
    .first<{ expires_at: number; holder_session_id: string; holder_name: string }>();
  return c.json({
    table: {
      pageId: page.id,
      revision,
      columns: columns.results.map((column) => ({
        ...column,
        options: options.results
          .filter((option) => option.column_id === column.id)
          .map((option) => ({ id: option.id, label: option.label, position: option.position })),
      })),
      rows: pageRows,
      lease: {
        heldByMe: lease?.holder_session_id === member.session.id,
        holderName: lease?.holder_name ?? null,
        expiresAt: lease?.expires_at ?? null,
      },
      limit: rowQuery.limit,
      sort: rowQuery.sort,
      dir: rowQuery.dir,
      hasMore,
      nextCursor: hasMore && !rowQuery.sort && lastRow ? { position: lastRow.position, rowId: lastRow.id } : null,
      nextOffset: hasMore && rowQuery.sort ? rowQuery.offset + pageRows.length : null,
      truncated,
      rowCount,
    },
  });
});

app.get("/api/tables/:pageId/verification", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await activeTablePage(c.env, member, c.req.param("pageId"));
  const { snapshot, revision } = await stableTableSnapshot(c.env, page.id, false, async () => {
    const [columns, options, rows] = await Promise.all([
      c.env.DB.prepare(`SELECT id, name, type, position FROM table_columns WHERE page_id = ? ORDER BY position, id`)
        .bind(page.id)
        .all<{ id: string; name: string; type: string; position: number }>(),
      c.env.DB.prepare(
        `SELECT option.id, option.column_id, option.label, option.position
           FROM table_select_options option JOIN table_columns col ON col.id = option.column_id
          WHERE col.page_id = ? ORDER BY option.position, option.id`,
      )
        .bind(page.id)
        .all<{ id: string; column_id: string; label: string; position: number }>(),
      c.env.DB.prepare(
        `SELECT row.id row_id, row.position row_position, cell.column_id,
                cell.text_value, cell.number_value, cell.boolean_value, cell.date_value, cell.select_value
           FROM table_rows row LEFT JOIN table_cells cell ON cell.row_id = row.id
          WHERE row.page_id = ? ORDER BY row.position, row.id, cell.column_id`,
      )
        .bind(page.id)
        .all<Record<string, unknown>>(),
    ]);
    return { columns, options, rows };
  });
  const { columns, options } = snapshot;
  const optionLabels = new Map(options.results.map((option) => [option.id, option.label]));
  const canonicalColumns = columns.results.map((column) => ({
    name: column.name,
    type: column.type,
    options: options.results.filter((option) => option.column_id === column.id).map(({ label }) => label),
  }));
  const canonicalRows = collectRowCells(snapshot.rows.results).map(({ cells }) =>
    columns.results.map((column) => {
      const value = cells[column.id] ?? null;
      return column.type === "select" && typeof value === "string" ? (optionLabels.get(value) ?? null) : value;
    }),
  );
  return c.json({
    verification: {
      revision,
      contentHash: await tableContentHash(canonicalColumns, canonicalRows),
      rowCount: canonicalRows.length,
    },
  });
});

app.post("/api/tables/:pageId/lease", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await activeTablePage(c.env, member, c.req.param("pageId"));
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const expiresAt = now() + TABLE_LEASE_DURATION_MS;
  const result = await c.env.DB.prepare(
    `INSERT INTO table_leases (page_id, token_hash, holder_user_id, holder_session_id, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(page_id) DO UPDATE SET token_hash = excluded.token_hash,
       holder_user_id = excluded.holder_user_id, holder_session_id = excluded.holder_session_id,
       expires_at = excluded.expires_at
     WHERE table_leases.expires_at <= ? OR table_leases.holder_session_id = ?`,
  )
    .bind(page.id, await sha256(token), member.user.id, member.session.id, expiresAt, now(), member.session.id)
    .run();
  if (!result.meta.changes)
    throw new HttpError(409, "lease_conflict", "Another editor currently holds this table lease.");
  return c.json({ leaseToken: token, leaseDurationMs: TABLE_LEASE_DURATION_MS } satisfies TableLeaseResponse);
});

app.patch("/api/tables/:pageId/lease", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  // Renewal must observe archival like every other table write: otherwise a
  // client that never attempts an edit could keep a lease on an archived
  // table alive indefinitely.
  const page = await activeTablePage(c.env, member, c.req.param("pageId"));
  const body = await jsonBody(c.req.raw);
  const expiresAt = now() + TABLE_LEASE_DURATION_MS;
  const result = await c.env.DB.prepare(
    `UPDATE table_leases SET expires_at = ?
      WHERE page_id = ? AND holder_session_id = ? AND token_hash = ? AND expires_at > ?`,
  )
    .bind(expiresAt, page.id, member.session.id, await sha256(text(body.leaseToken, "leaseToken", 200)), now())
    .run();
  if (!result.meta.changes) throw new HttpError(409, "lease_lost", "The table lease has expired or been replaced.");
  return c.json({ leaseDurationMs: TABLE_LEASE_DURATION_MS } satisfies TableLeaseTiming);
});

app.delete("/api/tables/:pageId/lease", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const body = await jsonBody(c.req.raw);
  await c.env.DB.prepare(`DELETE FROM table_leases WHERE page_id = ? AND holder_session_id = ? AND token_hash = ?`)
    .bind(c.req.param("pageId"), member.session.id, await sha256(text(body.leaseToken, "leaseToken", 200)))
    .run();
  return c.json({ ok: true });
});

app.post("/api/tables/:pageId/force-unlock", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const page = await activeTablePage(c.env, member, c.req.param("pageId"));
  await c.env.DB.prepare(`DELETE FROM table_leases WHERE page_id = ?`).bind(page.id).run();
  return c.json({ ok: true });
});

app.post("/api/tables/:pageId/columns", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await activeTablePage<{ next_position: number }>(c.env, member, c.req.param("pageId"), {
    columns: `, (SELECT COALESCE(MAX(position) + 1, 0) FROM table_columns WHERE page_id = p.id) next_position`,
    binds: [],
  });
  const input = await leaseInputs(await jsonBody(c.req.raw), member);
  const id = crypto.randomUUID();
  const name = text(input.body.name, "name", 100);
  const type = columnType(input.body.type);
  const position = page.next_position;
  const result = await guardedBatch(c.env, page.id, input, (guardedAt) =>
    c.env.DB.prepare(
      `INSERT INTO table_columns (id, page_id, name, type, position)
       SELECT ?, ?, ?, ?, ? WHERE ${leaseGuards()}`,
    ).bind(
      id,
      page.id,
      name,
      type,
      position,
      page.id,
      input.expectedRevision,
      input.tokenHash,
      input.sessionId,
      guardedAt,
    ),
  );
  return c.json({ column: { id, name, type, position }, revision: result }, 201);
});

app.delete("/api/tables/:pageId/columns/:columnId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await activeTablePage<{ target_exists: number }>(c.env, member, c.req.param("pageId"), {
    columns: `, EXISTS (SELECT 1 FROM table_columns WHERE id = ? AND page_id = p.id) target_exists`,
    binds: [c.req.param("columnId")],
  });
  if (!page.target_exists) throw new HttpError(404, "column_not_found", "Column not found.");
  const input = await leaseInputs(await jsonBody(c.req.raw), member);
  const revision = await guardedBatch(c.env, c.req.param("pageId"), input, (guardedAt) =>
    c.env.DB.prepare(`DELETE FROM table_columns WHERE id = ? AND page_id = ? AND ${leaseGuards()}`).bind(
      c.req.param("columnId"),
      c.req.param("pageId"),
      c.req.param("pageId"),
      input.expectedRevision,
      input.tokenHash,
      input.sessionId,
      guardedAt,
    ),
  );
  return c.json({ revision });
});

app.post("/api/tables/:pageId/columns/:columnId/options", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await activeTablePage<{ column_type: string | null; next_position: number }>(
    c.env,
    member,
    c.req.param("pageId"),
    {
      columns: `, (SELECT type FROM table_columns WHERE id = ? AND page_id = p.id) column_type,
          (SELECT COALESCE(MAX(position) + 1, 0) FROM table_select_options WHERE column_id = ?) next_position`,
      binds: [c.req.param("columnId"), c.req.param("columnId")],
    },
  );
  if (page.column_type === null) throw new HttpError(404, "column_not_found", "Column not found.");
  if (page.column_type !== "select")
    throw new HttpError(422, "select_required", "This column is not a select property.");
  const input = await leaseInputs(await jsonBody(c.req.raw), member);
  const id = crypto.randomUUID();
  const label = text(input.body.label, "label", 100);
  const position = page.next_position;
  const revision = await guardedBatch(c.env, c.req.param("pageId"), input, (guardedAt) =>
    c.env.DB.prepare(
      `INSERT INTO table_select_options (id, column_id, label, position)
       SELECT ?, ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM table_columns WHERE id = ? AND page_id = ? AND type = 'select'
       ) AND ${leaseGuards()}`,
    ).bind(
      id,
      c.req.param("columnId"),
      label,
      position,
      c.req.param("columnId"),
      c.req.param("pageId"),
      c.req.param("pageId"),
      input.expectedRevision,
      input.tokenHash,
      input.sessionId,
      guardedAt,
    ),
  );
  return c.json({ option: { id, label, position }, revision }, 201);
});

app.delete("/api/tables/:pageId/columns/:columnId/options/:optionId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await activeTablePage<{ target_exists: number }>(c.env, member, c.req.param("pageId"), {
    columns: `, EXISTS (
        SELECT 1 FROM table_select_options option
        JOIN table_columns column ON column.id = option.column_id
        WHERE option.id = ? AND option.column_id = ? AND column.page_id = p.id
      ) target_exists`,
    binds: [c.req.param("optionId"), c.req.param("columnId")],
  });
  if (!page.target_exists) throw new HttpError(404, "option_not_found", "Option not found.");
  const input = await leaseInputs(await jsonBody(c.req.raw), member);
  const revision = await guardedBatch(c.env, c.req.param("pageId"), input, (guardedAt) =>
    c.env.DB.prepare(`DELETE FROM table_select_options WHERE id = ? AND column_id = ? AND ${leaseGuards()}`).bind(
      c.req.param("optionId"),
      c.req.param("columnId"),
      c.req.param("pageId"),
      input.expectedRevision,
      input.tokenHash,
      input.sessionId,
      guardedAt,
    ),
  );
  return c.json({ revision });
});

app.post("/api/tables/:pageId/bulk", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const pageId = c.req.param("pageId");
  const body = await limitedJsonBody(c.req.raw, TABLE_BULK_MAX_BODY_BYTES);
  const page = await activeTablePage<{
    row_count: number;
    next_row_position: number;
    next_column_position: number;
  }>(c.env, member, pageId, {
    columns: `, (SELECT COUNT(*) FROM table_rows WHERE page_id = p.id) row_count,
        (SELECT COALESCE(MAX(position) + 1, 0) FROM table_rows WHERE page_id = p.id) next_row_position,
        (SELECT COALESCE(MAX(position) + 1, 0) FROM table_columns WHERE page_id = p.id) next_column_position`,
    binds: [],
  });
  const input = await leaseInputs(body, member);
  const clientRequestId =
    body.clientRequestId === undefined ? null : text(body.clientRequestId, "clientRequestId", 200);
  const columnInput = Array.isArray(body.columns) ? body.columns : [];
  const rowInput = Array.isArray(body.rows) ? body.rows : [];
  const requestHash = await sha256Hex(canonicalJson({ columns: columnInput, rows: rowInput }));

  // A timed-out request is replayed with the same id rather than appended twice.
  if (clientRequestId) {
    const receipt = await c.env.DB.prepare(
      `SELECT request_hash, response_json FROM table_bulk_writes WHERE page_id = ? AND client_request_id = ?`,
    )
      .bind(pageId, clientRequestId)
      .first<{ request_hash: string; response_json: string }>();
    if (receipt) {
      if (receipt.request_hash !== requestHash) {
        throw new HttpError(409, "idempotency_key_reused", "That bulk request id was already used for other data.");
      }
      return c.json({ ...JSON.parse(receipt.response_json), replayed: true });
    }
  }

  // An empty request would advance the revision while changing nothing, which would
  // invalidate every other editor's expectedRevision for no reason.
  if (!columnInput.length && !rowInput.length) {
    throw new HttpError(422, "empty_bulk_write", "A bulk write must add at least one column or row.");
  }
  if (columnInput.length > TABLE_BULK_MAX_COLUMNS || rowInput.length > TABLE_BULK_MAX_ROWS) {
    throw new HttpError(422, "bulk_too_large", "This bulk write exceeds the per-request column or row limit.");
  }
  if (page.row_count + rowInput.length > TABLE_MAX_ROWS) {
    throw new HttpError(422, "table_row_limit", `Tables are limited to ${TABLE_MAX_ROWS} rows.`);
  }

  const [existingColumns, existingOptions] = await Promise.all([
    c.env.DB.prepare(`SELECT id, type FROM table_columns WHERE page_id = ?`)
      .bind(pageId)
      .all<{ id: string; type: string }>(),
    c.env.DB.prepare(
      `SELECT o.id, o.column_id, o.label, o.position FROM table_select_options o
         JOIN table_columns col ON col.id = o.column_id WHERE col.page_id = ?`,
    )
      .bind(pageId)
      .all<{ id: string; column_id: string; label: string; position: number }>(),
  ]);

  // Columns are addressable by their real id and, for ones created in this same
  // request, by the caller's `ref:` token - otherwise an importer would need a round
  // trip just to learn the generated ids before it could send any rows.
  const columnsByKey = new Map<string, { id: string; type: string }>();
  for (const column of existingColumns.results) columnsByKey.set(column.id, column);
  const optionIdsByLabel = new Map<string, Map<string, string>>();
  const optionIds = new Set<string>();
  const nextOptionPosition = new Map<string, number>();
  for (const option of existingOptions.results) {
    const byLabel = optionIdsByLabel.get(option.column_id) ?? new Map<string, string>();
    byLabel.set(option.label, option.id);
    optionIdsByLabel.set(option.column_id, byLabel);
    optionIds.add(option.id);
    nextOptionPosition.set(
      option.column_id,
      Math.max(nextOptionPosition.get(option.column_id) ?? 0, option.position + 1),
    );
  }

  const newColumns: { id: string; ref: string | null; name: string; type: string; position: number }[] = [];
  const newOptions: { id: string; columnId: string; label: string; position: number }[] = [];

  function declareOption(columnId: string, label: string) {
    const byLabel = optionIdsByLabel.get(columnId) ?? new Map<string, string>();
    const existing = byLabel.get(label);
    if (existing) return existing;
    const id = crypto.randomUUID();
    const position = nextOptionPosition.get(columnId) ?? 0;
    byLabel.set(label, id);
    optionIdsByLabel.set(columnId, byLabel);
    nextOptionPosition.set(columnId, position + 1);
    optionIds.add(id);
    newOptions.push({ id, columnId, label, position });
    return id;
  }

  columnInput.forEach((raw, index) => {
    const entry = object(raw);
    const id = crypto.randomUUID();
    const type = columnType(entry.type);
    const name = text(entry.name, `columns[${index}].name`, TABLE_COLUMN_NAME_MAX);
    const ref = entry.ref === undefined ? null : text(entry.ref, `columns[${index}].ref`, 64);
    if (ref && columnsByKey.has(`ref:${ref}`)) {
      throw new HttpError(422, "invalid_bulk_reference", `The column ref ${ref} is used twice.`);
    }
    newColumns.push({ id, ref, name, type, position: page.next_column_position + index });
    columnsByKey.set(id, { id, type });
    if (ref) columnsByKey.set(`ref:${ref}`, { id, type });
    const options = Array.isArray(entry.options) ? entry.options : [];
    for (const option of options) {
      declareOption(id, text(object(option).label, `columns[${index}].options[].label`, TABLE_SELECT_LABEL_MAX));
    }
  });

  const newRows: { id: string; position: number }[] = [];
  const newCells: {
    r: string;
    c: string;
    t: string | null;
    n: number | null;
    b: number | null;
    d: string | null;
    s: string | null;
  }[] = [];

  rowInput.forEach((raw, index) => {
    const entry = object(raw);
    const rowId = crypto.randomUUID();
    newRows.push({ id: rowId, position: page.next_row_position + index });
    const cells = entry.cells === undefined ? {} : object(entry.cells);
    for (const [key, value] of Object.entries(cells)) {
      const column = columnsByKey.get(key);
      if (!column) {
        throw new HttpError(422, "invalid_bulk_reference", `Unknown column ${key}.`, {
          rowIndex: index,
          columnKey: key,
        });
      }
      // Notion and every other export hands over option labels, not ids, so a select
      // cell may name its option and have it created on demand. A bare string stays
      // an option id, matching the per-cell route exactly.
      let resolved: unknown = value;
      if (column.type === "select" && value && typeof value === "object" && "option" in value) {
        resolved = declareOption(
          column.id,
          text((value as { option: unknown }).option, "option", TABLE_SELECT_LABEL_MAX),
        );
      }
      const [textValue, numberValue, booleanValue, dateValue, selectValue] = typedCell(column.type, resolved);
      if (selectValue !== null && !optionIds.has(selectValue)) {
        throw new HttpError(422, "invalid_cell", "That select option does not belong to this column.", {
          rowIndex: index,
          columnKey: key,
        });
      }
      // An absent cell already reads as null, so writing empties would be pure cost.
      if (
        textValue === null &&
        numberValue === null &&
        booleanValue === null &&
        dateValue === null &&
        selectValue === null
      ) {
        continue;
      }
      newCells.push({
        r: rowId,
        c: column.id,
        t: textValue,
        n: numberValue,
        b: booleanValue,
        d: dateValue,
        s: selectValue,
      });
    }
  });

  if (newCells.length > TABLE_BULK_MAX_CELLS) {
    throw new HttpError(422, "bulk_too_large", "This bulk write exceeds the per-request cell limit.");
  }

  const response = {
    columns: newColumns.map((column) => ({
      id: column.id,
      ref: column.ref,
      name: column.name,
      type: column.type,
      position: column.position,
      options: newOptions
        .filter((option) => option.columnId === column.id)
        .map((option) => ({ id: option.id, label: option.label, position: option.position })),
    })),
    rows: newRows,
    counts: {
      columns: newColumns.length,
      options: newOptions.length,
      rows: newRows.length,
      cells: newCells.length,
    },
  };

  let revision: number;
  try {
    revision = await guardedBatch(
      c.env,
      pageId,
      input,
      (guardedAt) => {
        const guardBinds = [pageId, input.expectedRevision, input.tokenHash, input.sessionId, guardedAt];
        const statements: D1PreparedStatement[] = [];
        // Every insert expands one JSON parameter with json_each rather than binding a
        // placeholder per value, which at these batch sizes would blow past D1's limit of
        // 100 bound parameters per query. `json_each().key` is the array index, so
        // positions are assigned deterministically regardless of iteration order.
        if (newColumns.length) {
          statements.push(
            c.env.DB.prepare(
              `INSERT INTO table_columns (id, page_id, name, type, position)
             SELECT json_extract(item.value, '$.id'), ?, json_extract(item.value, '$.name'),
                    json_extract(item.value, '$.type'), json_extract(item.value, '$.position')
               FROM json_each(?) item WHERE ${leaseGuards()}`,
            ).bind(pageId, JSON.stringify(newColumns), ...guardBinds),
          );
        }
        if (newOptions.length) {
          statements.push(
            c.env.DB.prepare(
              `INSERT INTO table_select_options (id, column_id, label, position)
             SELECT json_extract(item.value, '$.id'), json_extract(item.value, '$.columnId'),
                    json_extract(item.value, '$.label'), json_extract(item.value, '$.position')
               FROM json_each(?) item WHERE ${leaseGuards()}`,
            ).bind(JSON.stringify(newOptions), ...guardBinds),
          );
        }
        if (newRows.length) {
          statements.push(
            c.env.DB.prepare(
              `INSERT INTO table_rows (id, page_id, position, created_by, created_at, updated_at)
             SELECT json_extract(item.value, '$.id'), ?, json_extract(item.value, '$.position'), ?, ?, ?
               FROM json_each(?) item WHERE ${leaseGuards()}`,
            ).bind(pageId, member.user.id, guardedAt, guardedAt, JSON.stringify(newRows), ...guardBinds),
          );
        }
        if (newCells.length) {
          statements.push(
            c.env.DB.prepare(
              `INSERT INTO table_cells
               (row_id, column_id, text_value, number_value, boolean_value, date_value, select_value, updated_at)
             SELECT json_extract(item.value, '$.r'), json_extract(item.value, '$.c'),
                    json_extract(item.value, '$.t'), json_extract(item.value, '$.n'),
                    json_extract(item.value, '$.b'), json_extract(item.value, '$.d'),
                    json_extract(item.value, '$.s'), ?
               FROM json_each(?) item WHERE ${leaseGuards()}`,
            ).bind(guardedAt, JSON.stringify(newCells), ...guardBinds),
          );
        }
        if (clientRequestId) {
          statements.push(
            c.env.DB.prepare(
              `INSERT INTO table_bulk_writes
               (page_id, client_request_id, revision, request_hash, response_json, created_at)
             SELECT ?, ?, ?, ?, ?, ? WHERE ${leaseGuards()}`,
            ).bind(
              pageId,
              clientRequestId,
              input.expectedRevision + 1,
              requestHash,
              JSON.stringify({ revision: input.expectedRevision + 1, ...response }),
              guardedAt,
              ...guardBinds,
            ),
          );
        }
        // An import runs far longer than the 60-second lease, and asking the caller to
        // run a renewal timer alongside its writes is how tables end up half-written.
        // The guard means this can only extend a lease that is already live.
        statements.push(
          c.env.DB.prepare(
            `UPDATE table_leases SET expires_at = ?
            WHERE page_id = ? AND token_hash = ? AND holder_session_id = ? AND expires_at > ?`,
          ).bind(guardedAt + TABLE_LEASE_DURATION_MS, pageId, input.tokenHash, input.sessionId, guardedAt),
        );
        return statements;
      },
      { requireChanges: false },
    );
  } catch (error) {
    // The original request may have committed while an identical retry was already
    // running. A receipt is authoritative even when the losing attempt observed a
    // stale revision or collided on the receipt's unique key.
    if (clientRequestId) {
      const receipt = await c.env.DB.prepare(
        `SELECT request_hash, response_json FROM table_bulk_writes WHERE page_id = ? AND client_request_id = ?`,
      )
        .bind(pageId, clientRequestId)
        .first<{ request_hash: string; response_json: string }>();
      if (receipt) {
        if (receipt.request_hash !== requestHash) {
          throw new HttpError(409, "idempotency_key_reused", "That bulk request id was already used for other data.");
        }
        return c.json({ ...JSON.parse(receipt.response_json), replayed: true });
      }
    }
    throw error;
  }

  return c.json({ revision, replayed: false, ...response }, 201);
});

app.post("/api/tables/:pageId/rows", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await activeTablePage<{ row_count: number; next_position: number }>(
    c.env,
    member,
    c.req.param("pageId"),
    {
      columns: `, (SELECT COUNT(*) FROM table_rows WHERE page_id = p.id) row_count,
          (SELECT COALESCE(MAX(position) + 1, 0) FROM table_rows WHERE page_id = p.id) next_position`,
      binds: [],
    },
  );
  const input = await leaseInputs(await jsonBody(c.req.raw), member);
  if (page.row_count >= TABLE_MAX_ROWS) {
    throw new HttpError(422, "table_row_limit", `Tables are limited to ${TABLE_MAX_ROWS} rows.`);
  }
  const id = crypto.randomUUID();
  const position = page.next_position;
  const revision = await guardedBatch(c.env, c.req.param("pageId"), input, (guardedAt) =>
    c.env.DB.prepare(
      `INSERT INTO table_rows (id, page_id, position, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE ${leaseGuards()}`,
    ).bind(
      id,
      c.req.param("pageId"),
      position,
      member.user.id,
      guardedAt,
      guardedAt,
      c.req.param("pageId"),
      input.expectedRevision,
      input.tokenHash,
      input.sessionId,
      guardedAt,
    ),
  );
  return c.json({ row: { id, position, cells: {} }, revision }, 201);
});

app.delete("/api/tables/:pageId/rows/:rowId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await activeTablePage<{ target_exists: number }>(c.env, member, c.req.param("pageId"), {
    columns: `, EXISTS (SELECT 1 FROM table_rows WHERE id = ? AND page_id = p.id) target_exists`,
    binds: [c.req.param("rowId")],
  });
  if (!page.target_exists) throw new HttpError(404, "row_not_found", "Row not found.");
  const input = await leaseInputs(await jsonBody(c.req.raw), member);
  const revision = await guardedBatch(c.env, c.req.param("pageId"), input, (guardedAt) =>
    c.env.DB.prepare(`DELETE FROM table_rows WHERE id = ? AND page_id = ? AND ${leaseGuards()}`).bind(
      c.req.param("rowId"),
      c.req.param("pageId"),
      c.req.param("pageId"),
      input.expectedRevision,
      input.tokenHash,
      input.sessionId,
      guardedAt,
    ),
  );
  return c.json({ revision });
});

app.put("/api/tables/:pageId/cells/:rowId/:columnId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  // The body is read first only because the option lookup below needs the
  // submitted value; lease validation still follows the page and target
  // checks so this route reports 404s in the same order as the others.
  const body = await jsonBody(c.req.raw);
  const pageId = c.req.param("pageId");
  const selectOptionId = typeof body.value === "string" ? body.value : null;
  const page = await activeTablePage<{ column_type: string | null; row_exists: number; select_option_exists: number }>(
    c.env,
    member,
    pageId,
    {
      columns: `, (SELECT type FROM table_columns WHERE id = ? AND page_id = p.id) column_type,
          EXISTS (SELECT 1 FROM table_rows WHERE id = ? AND page_id = p.id) row_exists,
          EXISTS (SELECT 1 FROM table_select_options WHERE id = ? AND column_id = ?) select_option_exists`,
      binds: [c.req.param("columnId"), c.req.param("rowId"), selectOptionId, c.req.param("columnId")],
    },
  );
  if (page.column_type === null) throw new HttpError(404, "column_not_found", "Column not found.");
  if (!page.row_exists) throw new HttpError(404, "row_not_found", "Row not found.");
  if (page.column_type === "select" && body.value !== null && body.value !== "" && !page.select_option_exists) {
    throw new HttpError(422, "invalid_cell", "The selected option does not belong to this column.");
  }
  const input = await leaseInputs(body, member);
  const values = typedCell(page.column_type, body.value);
  const revision = await guardedBatch(c.env, pageId, input, (guardedAt) =>
    c.env.DB.prepare(
      `INSERT INTO table_cells
       (row_id, column_id, text_value, number_value, boolean_value, date_value, select_value, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${leaseGuards()}
       ON CONFLICT(row_id, column_id) DO UPDATE SET
         text_value = excluded.text_value, number_value = excluded.number_value,
         boolean_value = excluded.boolean_value, date_value = excluded.date_value,
         select_value = excluded.select_value, updated_at = excluded.updated_at`,
    ).bind(
      c.req.param("rowId"),
      c.req.param("columnId"),
      ...values,
      guardedAt,
      pageId,
      input.expectedRevision,
      input.tokenHash,
      input.sessionId,
      guardedAt,
    ),
  );
  return c.json({ revision });
});

app.notFound(async (c) => {
  if (new URL(c.req.url).pathname.startsWith("/api/")) {
    return c.json({ error: { code: "not_found", message: "API route not found." } }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

async function assertAnotherOwner(env: Env, workspaceId: string, excludedId: string) {
  const other = await env.DB.prepare(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND role = 'owner' AND user_id <> ? LIMIT 1`,
  )
    .bind(workspaceId, excludedId)
    .first();
  if (!other)
    throw new HttpError(409, "final_owner", "Promote another owner before removing or demoting the final owner.");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

async function currentPlainText(env: Env, pageId: string) {
  return (
    (await env.DB.prepare(`SELECT plain_text FROM pages WHERE id = ?`).bind(pageId).first<{ plain_text: string }>())
      ?.plain_text ?? ""
  );
}

function escapeLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function cellValue(cell: Record<string, unknown>) {
  if (cell.text_value !== null && cell.text_value !== undefined) return String(cell.text_value);
  if (cell.number_value !== null && cell.number_value !== undefined) return Number(cell.number_value);
  if (cell.boolean_value !== null && cell.boolean_value !== undefined) return Boolean(cell.boolean_value);
  if (cell.date_value !== null && cell.date_value !== undefined) return String(cell.date_value);
  if (cell.select_value !== null && cell.select_value !== undefined) return String(cell.select_value);
  return null;
}

function typedCell(
  type: string,
  value: unknown,
): [string | null, number | null, number | null, string | null, string | null] {
  if (value === null || value === "") return [null, null, null, null, null];
  if (type === "text") return [text(value, "value", TABLE_TEXT_CELL_MAX), null, null, null, null];
  if (type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new HttpError(422, "invalid_cell", "This cell requires a finite number.");
    return [null, number, null, null, null];
  }
  if (type === "checkbox") {
    if (typeof value !== "boolean") throw new HttpError(422, "invalid_cell", "This cell requires true or false.");
    return [null, null, value ? 1 : 0, null, null];
  }
  if (type === "date") {
    const date = text(value, "value", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      throw new HttpError(422, "invalid_cell", "This cell requires a YYYY-MM-DD date.");
    }
    return [null, null, null, date, null];
  }
  if (type === "select") return [null, null, null, null, text(value, "value", 100)];
  throw new HttpError(422, "invalid_cell", "Unknown column type.");
}

// `requireChanges` is the single-statement contract every per-cell route relies on and
// must stay the default. The bulk route is the one caller that turns it off, because
// changes() reports only the statement immediately before the bump: with several
// statements it would read whichever one happened to land last and silently refuse to
// advance the revision on a request that did write rows.
//
// Dropping it is safe there, and only there, because every bulk statement inserts
// freshly generated ids that cannot match zero rows, and each carries the same
// leaseGuards() predicate as the bump inside one D1 batch, which is one transaction.
// So the inserts apply exactly when the guard holds, which is exactly when the bump
// applies. Adding an update or delete to that route would reintroduce a statement that
// can legitimately match nothing, and this reasoning would have to be redone.
async function guardedBatch(
  env: Env,
  pageId: string,
  input: { expectedRevision: number; tokenHash: string; sessionId: string },
  prepareMutation: (guardedAt: number) => D1PreparedStatement | D1PreparedStatement[],
  options: { requireChanges?: boolean } = {},
) {
  const requireChanges = options.requireChanges ?? true;
  const guardedAt = now();
  const prepared = prepareMutation(guardedAt);
  const mutations = Array.isArray(prepared) ? prepared : [prepared];
  const results = await env.DB.batch([
    ...mutations,
    // changes() is the row count of the statement immediately before this one
    // in the batch, so the revision only advances when the mutation applied and
    // a mutation can never commit without advancing the revision.
    env.DB.prepare(
      `UPDATE table_state SET revision = revision + 1
        WHERE page_id = ? AND revision = ?${requireChanges ? " AND changes() > 0" : ""} AND ${leaseGuards()}`,
    ).bind(pageId, input.expectedRevision, pageId, input.expectedRevision, input.tokenHash, input.sessionId, guardedAt),
    // Read the state inside the same batch so a failure is classified against
    // what the guards actually saw, not against a later change.
    env.DB.prepare(
      `SELECT s.revision,
         EXISTS (
           SELECT 1 FROM table_leases l
            WHERE l.page_id = s.page_id AND l.token_hash = ?
              AND l.holder_session_id = ? AND l.expires_at > ?
         ) lease_valid
         FROM table_state s WHERE s.page_id = ?`,
    ).bind(input.tokenHash, input.sessionId, guardedAt, pageId),
  ]);
  const revisionUpdated = Boolean(results[mutations.length]?.meta.changes);
  // Without changes() there is nothing to distinguish "the write missed" from "the
  // guard failed", and for insert-only statements the two coincide.
  const mutationApplied = requireChanges ? Boolean(results[mutations.length - 1]?.meta.changes) : revisionUpdated;
  if (mutationApplied && revisionUpdated) return input.expectedRevision + 1;

  const state = results[mutations.length + 1]?.results[0] as { revision: number; lease_valid: number } | undefined;
  if (!state?.lease_valid) {
    throw new HttpError(409, "table_lease_lost", "The editing lease was lost. Reloaded the authoritative table.");
  }
  if (state.revision !== input.expectedRevision) {
    throw new HttpError(409, "table_revision_conflict", "The table changed. Reloading before retrying the update.");
  }
  if (!mutationApplied) {
    throw new HttpError(404, "mutation_target_not_found", "The table item being changed no longer exists.");
  }
  // The mutation applied but the revision update, which checks the same lease
  // and revision plus changes() > 0, did not. Nothing in the batch can produce
  // this; keep it distinguishable rather than misreport it as a conflict.
  // Logged explicitly because errorResponse only logs unexpected errors, and an
  // HttpError describing a violated invariant is the one exception worth seeing.
  // The lease token and session id are omitted: they authenticate the caller.
  console.error("Table revision could not be advanced", {
    pageId,
    expectedRevision: input.expectedRevision,
    revision: state.revision,
    leaseValid: Boolean(state.lease_valid),
  });
  throw new HttpError(500, "table_revision_failed", "The table revision could not be advanced.");
}

async function handlePartyRequest(request: Request, env: Env) {
  const url = new URL(request.url);
  const documentPrefix = "/parties/document/";
  const workspacePrefix = "/parties/workspace-events/";
  const isDocument = url.pathname.startsWith(documentPrefix);
  const isWorkspace = url.pathname.startsWith(workspacePrefix);
  if (!isDocument && !isWorkspace) return null;
  const roomNotFound = () =>
    new HttpError(404, "room_not_found", isDocument ? "Document room not found." : "Workspace event room not found.");
  // Declared outside the try so a failure log can name the room. It only stays
  // null when the failure preceded validation, and every value it can hold has
  // been bounded by then, so nothing unvalidated reaches the log.
  let room: string | null = null;
  try {
    assertSameOrigin(request, env.BETTER_AUTH_URL);
    const member = await requireMember(request, env);
    // The raw segment, deliberately not decoded: this is the exact text
    // PartyServer hashes into the Durable Object name, so authorizing anything
    // else lets one page fork into rooms that share an R2 key. Percent escapes
    // fail the patterns below, which is also how a malformed one answers 404
    // rather than surfacing a URIError as a server fault.
    const candidate = url.pathname.slice((isDocument ? documentPrefix : workspacePrefix).length);
    if (isDocument) {
      const ids = documentRoom(candidate);
      if (!ids) throw roomNotFound();
      room = candidate;
      const page = await pageForMember(env, member, ids.pageId);
      if (page.kind !== "document" || page.content_epoch !== ids.epoch) {
        throw new HttpError(409, "stale_epoch", "Reload this page to connect to its current document version.");
      }
    } else {
      if (!ID_PATTERN.test(candidate) || candidate !== member.workspace.id) throw roomNotFound();
      room = candidate;
    }
    const expiresAt = Math.min(member.session.expiresAt.getTime(), now() + 5 * 60_000);
    const placement = locationHint(member.workspace.locationHint ?? undefined);
    // Awaited so a rejection from the room fetch is enveloped and logged
    // below instead of escaping this handler as an unlogged runtime 500.
    return await routePartykitRequest(request, env, {
      ...(placement ? { locationHint: placement } : {}),
      onBeforeConnect(incoming) {
        const headers = new Headers(incoming.headers);
        for (const name of ["x-notes-user-id", "x-notes-role", "x-notes-expires-at", "x-notes-internal"])
          headers.delete(name);
        headers.set("x-notes-user-id", member.user.id);
        headers.set("x-notes-role", member.role);
        headers.set("x-notes-expires-at", String(expiresAt));
        return new Request(incoming, { headers });
      },
    });
  } catch (error) {
    // Mirrors errorResponse: expected errors carry client-facing messages, and
    // anything else is logged here (there is no Hono context yet) and answered
    // generically. The room is an opaque id, safe to log where the cookie is not.
    if (!isExpectedError(error)) {
      const party = isDocument ? "document" : "workspace-events";
      console.error(`Failed to handle ${party} party request for ${room ?? "an undecoded room"}`, error);
    }
    const { status, body } = errorPayload(error);
    return Response.json(body, { status });
  }
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    const party = await handlePartyRequest(request, env);
    if (party) return party;
    return app.fetch(request, env, context);
  },
  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext) {
    context.waitUntil(
      processDueArchiveDisconnects(env).catch((error) => {
        console.error("Scheduled archive disconnect failed", error);
      }),
    );
    context.waitUntil(
      processDueDeletionJobs(env).catch((error) => {
        console.error("Scheduled deletion cleanup failed", error);
      }),
    );
    context.waitUntil(
      processDueUploadReaps(env).catch((error) => {
        console.error("Scheduled upload reap failed", error);
      }),
    );
  },
};

export { Document, WorkspaceEvents };
