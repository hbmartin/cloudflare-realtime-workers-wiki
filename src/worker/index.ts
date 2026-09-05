import { generateJitteredKeyBetween, generateNJitteredKeysBetween } from "fractional-indexing-jittered";
import { Hono, type Context } from "hono";
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
import {
  addCommentReply,
  commentThread,
  createCommentThread,
  listCommentThreads,
  migrateLegacyComments,
  setThreadResolved,
  softDeleteComment,
  updateComment,
  type CommentPage,
} from "./comments";
import { Document } from "./document";
import type { Env, MemberContext } from "./env";
import {
  HttpError,
  assertSameOrigin,
  attachmentDisposition,
  classifyError,
  errorResponse,
  locationHint,
  normalizeFilename,
  now,
  safeHttpErrorCode,
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
import { PAGE_KINDS } from "../shared/page-kind";
import { errorLogFields, prefixedErrorLogFields, safeInstanceOf } from "../shared/error-log";
import {
  PAGE_MOVE_RECEIPT_PRUNE_BATCH_SIZE,
  PAGE_MOVE_RECEIPT_PRUNE_MAX_BATCHES,
  PAGE_MOVE_RECEIPT_RETENTION_MS,
  PAGE_MOVE_RECEIPT_VERSION,
} from "../shared/page-move";
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
  Role,
  Space,
  Tag,
  TagColor,
  TableLeaseResponse,
  TableLeaseTiming,
  WorkspaceEvent,
} from "../shared/types";
import { compareBinaryText } from "../shared/tree-model";
import { canonicalJson, documentProjectionHash, sha256Hex, tableContentHash } from "../shared/import-integrity";
import { conditionalGetStatus, normalizeR2Range } from "./r2";
import { pageJson, type PageJsonRow } from "./page-row";
import { broadcastWorkspaceEvent, WorkspaceEvents } from "./workspace-events";
import {
  consumeDeliveryMessage,
  createJob,
  expireJobArtifacts,
  jobForMember,
  jobJson,
  NotesJobWorkflow,
  recoverQueuedJobs,
  startJobExecution,
  sweepOutbox,
  type DeliveryQueueMessage,
  type JobRow,
} from "./jobs";

const app = new Hono<{ Bindings: Env }>();
const DELETION_TARGET_BATCH_SIZE = 50;
// Each page costs three or four statements, so this stays far inside D1's per-invocation
// query ceiling while still collapsing a tree level into one request.
const PAGE_BATCH_MAX = 50;
const TABLE_LEASE_DURATION_MS = 60_000;
const TAG_COLORS = ["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;

type PageRow = PageJsonRow & {
  created_by: string;
  plain_text: string;
  indexed_seq: number;
  visibility?: "workspace" | "private";
  space_role?: Exclude<Role, "owner"> | null;
  effective_role?: Role;
};

type RequestedPageCreate = Pick<PageRow, "id" | "kind"> & {
  spaceId: string;
  parentId: string | null;
  title: string;
};

type PageCreateStateRow = PageJsonRow & { receipt_request_hash: string | null };
type PageMoveReceiptRow = { page_id: string; request_hash: string; response_json: string };
type PageMoveStateRow = { page_json: string };
type PageMoveAvailabilityRow = { archived_at: number | null };
type PageMoveBatchRow = PageMoveReceiptRow | PageMoveStateRow | PageMoveAvailabilityRow;

class InvalidPageMoveReceiptError extends Error {
  override name = "InvalidPageMoveReceiptError";
}

class InvalidPageMoveBatchResultError extends Error {
  override name = "InvalidPageMoveBatchResultError";
}

const PAGE_MOVE_RECEIPT_PAGE_COLUMNS = {
  id: "id",
  workspaceId: "workspace_id",
  spaceId: "space_id",
  parentId: "parent_id",
  kind: "kind",
  position: "position",
  title: "title",
  icon: "icon",
  revision: "revision",
  contentEpoch: "content_epoch",
  isTemplate: "is_template",
  archivedAt: "archived_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const satisfies { [Field in keyof Page]-?: keyof PageJsonRow };

const PAGE_MOVE_RECEIPT_PAGE_JSON_SQL = `json_object(${Object.entries(PAGE_MOVE_RECEIPT_PAGE_COLUMNS)
  .map(([field, column]) => `'${field}', ${column}`)
  .join(", ")})`;
const PAGE_MOVE_RECEIPT_INVALID_LOG_MESSAGE = "Page move receipt was invalid.";
const PAGE_MOVE_RECEIPT_UNREADABLE_LOG_MESSAGE = "Page move receipt could not be read.";
const PAGE_MOVE_BATCH_RESULT_INVALID_LOG_MESSAGE = "Page move batch result was invalid or inconsistent.";

async function pageCreateRequestHash(value: unknown) {
  return sha256Hex(canonicalJson(value));
}

async function readPageMoveReceipt(database: D1Database, workspaceId: string, operationId: string) {
  const value = await database
    .prepare(
      `SELECT page_id, request_hash, response_json FROM page_move_receipts
        WHERE workspace_id = ? AND operation_id = ?`,
    )
    .bind(workspaceId, operationId)
    .first();
  if (value === null) return null;
  const receipt = pageMoveReceiptRow(value);
  if (!receipt) throw new InvalidPageMoveReceiptError("A stored page move receipt row is malformed.");
  return receipt;
}

function pageMoveReceiptSnapshotV1(value: unknown): Page {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidPageMoveReceiptError("A stored page move receipt does not contain a valid page.");
  }
  const page = value as Record<string, unknown>;
  if (
    typeof page.id !== "string" ||
    typeof page.workspaceId !== "string" ||
    (page.spaceId !== undefined && typeof page.spaceId !== "string") ||
    (page.parentId !== null && typeof page.parentId !== "string") ||
    typeof page.kind !== "string" ||
    !PAGE_KINDS.includes(page.kind as PageKind) ||
    typeof page.position !== "string" ||
    typeof page.title !== "string" ||
    (page.icon !== null && typeof page.icon !== "string") ||
    typeof page.revision !== "number" ||
    typeof page.contentEpoch !== "number" ||
    (page.isTemplate !== undefined &&
      typeof page.isTemplate !== "boolean" &&
      page.isTemplate !== 0 &&
      page.isTemplate !== 1) ||
    (page.archivedAt !== null && typeof page.archivedAt !== "number") ||
    typeof page.createdAt !== "number" ||
    typeof page.updatedAt !== "number"
  ) {
    throw new InvalidPageMoveReceiptError("A stored page move receipt does not contain a valid page.");
  }
  // Keep this decoder pinned to receipt schema v1. If Page gains a field,
  // TypeScript forces an explicit backward-compatible default here instead of
  // silently making seven days of retained receipts unreadable.
  return {
    id: page.id,
    workspaceId: page.workspaceId,
    spaceId: typeof page.spaceId === "string" ? page.spaceId : `${page.workspaceId}-general`,
    parentId: page.parentId,
    kind: page.kind as PageKind,
    position: page.position,
    title: page.title,
    icon: page.icon,
    revision: page.revision,
    contentEpoch: page.contentEpoch,
    isTemplate: page.isTemplate === true || page.isTemplate === 1,
    archivedAt: page.archivedAt,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

function pageFromMoveState(row: PageMoveStateRow) {
  let stored: unknown;
  try {
    stored = JSON.parse(row.page_json);
  } catch (error) {
    throw new InvalidPageMoveReceiptError("The committed page state contains malformed JSON.", { cause: error });
  }
  return pageMoveReceiptSnapshotV1(stored);
}

function pageMoveReceiptRow(value: unknown): PageMoveReceiptRow | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return typeof row.page_id === "string" &&
    typeof row.request_hash === "string" &&
    typeof row.response_json === "string"
    ? { page_id: row.page_id, request_hash: row.request_hash, response_json: row.response_json }
    : null;
}

function pageMoveStateRow(value: unknown): PageMoveStateRow | null {
  if (value === null || typeof value !== "object") return null;
  const serializedPage = (value as Record<string, unknown>).page_json;
  return typeof serializedPage === "string" ? { page_json: serializedPage } : null;
}

function pageMoveAvailabilityRow(value: unknown): PageMoveAvailabilityRow | null {
  if (value === null || typeof value !== "object") return null;
  const archivedAt = (value as Record<string, unknown>).archived_at;
  return archivedAt === null || typeof archivedAt === "number" ? { archived_at: archivedAt } : null;
}

function pageFromMoveReceipt(receipt: PageMoveReceiptRow, workspaceId: string, pageId: string, requestHash?: string) {
  if (receipt.page_id !== pageId || (requestHash !== undefined && receipt.request_hash !== requestHash)) {
    throw new HttpError(409, "idempotency_key_reused", "That move operation id was already used for another move.");
  }
  let stored: unknown;
  try {
    stored = JSON.parse(receipt.response_json);
  } catch (error) {
    throw new InvalidPageMoveReceiptError("A stored page move receipt contains malformed JSON.", { cause: error });
  }
  const envelope =
    stored !== null && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : null;
  let snapshot = stored;
  if (envelope && "pageMoveReceiptVersion" in envelope) {
    if (envelope.pageMoveReceiptVersion !== PAGE_MOVE_RECEIPT_VERSION || !("page" in envelope)) {
      throw new InvalidPageMoveReceiptError("A stored page move receipt uses an unsupported snapshot version.");
    }
    snapshot = envelope.page;
  }
  const page = pageMoveReceiptSnapshotV1(snapshot);
  if (page.id !== receipt.page_id || page.workspaceId !== workspaceId) {
    throw new InvalidPageMoveReceiptError("A stored page move receipt does not match its page and workspace.");
  }
  return page;
}

async function readPageMoveReplay(
  database: D1Database,
  workspaceId: string,
  pageId: string,
  operationId: string,
  requestHash: string,
) {
  const receipt = await readPageMoveReceipt(database, workspaceId, operationId);
  if (!receipt) return null;
  return pageFromMoveReceipt(receipt, workspaceId, pageId, requestHash);
}

type PageMoveReceiptReadPhase = "preflight" | "commit" | "recovery" | "reconciliation";

type PageMoveReceiptReadContext = {
  workspaceId: string;
  pageId: string;
  operationId: string;
  receiptReadPhase: PageMoveReceiptReadPhase;
  moveError?: unknown;
  recoveredFromPageState?: boolean;
  recoveredFromReceipt?: boolean;
};

function pageMoveLogFields(context: PageMoveReceiptReadContext) {
  return {
    workspaceId: context.workspaceId,
    pageId: context.pageId,
    operationId: context.operationId,
    receiptReadPhase: context.receiptReadPhase,
    ...(context.recoveredFromPageState ? { recoveredFromPageState: true } : {}),
    ...(typeof context.recoveredFromReceipt === "boolean"
      ? { recoveredFromReceipt: context.recoveredFromReceipt }
      : {}),
    ...("moveError" in context ? prefixedErrorLogFields("moveError", context.moveError) : {}),
  };
}

function pageMoveReceiptLogFields(error: unknown, context: PageMoveReceiptReadContext) {
  return {
    ...pageMoveLogFields(context),
    ...prefixedErrorLogFields("receiptError", error),
  };
}

async function readPageMoveReceiptWithDiagnostics<T>(
  read: () => Promise<T>,
  context: PageMoveReceiptReadContext,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (safeInstanceOf(error, HttpError) && context.receiptReadPhase !== "recovery") throw error;
    const fields = pageMoveReceiptLogFields(error, context);
    if (safeInstanceOf(error, HttpError)) {
      console.error("Page move recovery found a conflicting receipt.", fields);
      throw error;
    }
    if (safeInstanceOf(error, InvalidPageMoveReceiptError)) {
      console.error(PAGE_MOVE_RECEIPT_INVALID_LOG_MESSAGE, fields);
      throw new HttpError(500, "internal_error", "Something went wrong.");
    }
    console.error(PAGE_MOVE_RECEIPT_UNREADABLE_LOG_MESSAGE, fields);
    throw new HttpError(
      503,
      "page_move_unresolved",
      "The page move result could not be determined. Retry with the same operation id.",
    );
  }
}

async function pruneExpiredPageMoveReceipts(database: D1Database, timestamp = now()) {
  const expiredBefore = timestamp - PAGE_MOVE_RECEIPT_RETENTION_MS;
  for (let batch = 0; batch < PAGE_MOVE_RECEIPT_PRUNE_MAX_BATCHES; batch += 1) {
    const result = await database
      .prepare(
        `DELETE FROM page_move_receipts
          WHERE rowid IN (
            SELECT rowid FROM page_move_receipts
             WHERE created_at < ?
             ORDER BY created_at
             LIMIT ?
          )`,
      )
      .bind(expiredBefore, PAGE_MOVE_RECEIPT_PRUNE_BATCH_SIZE)
      .run();
    if (result.meta.changes < PAGE_MOVE_RECEIPT_PRUNE_BATCH_SIZE) return;
  }
  const remaining = await database
    .prepare(`SELECT 1 FROM page_move_receipts WHERE created_at < ? LIMIT 1`)
    .bind(expiredBefore)
    .first();
  if (!remaining) return;
  console.warn("Page move receipt pruning reached its hourly catch-up limit; expired receipts may remain.", {
    batchSize: PAGE_MOVE_RECEIPT_PRUNE_BATCH_SIZE,
    maxBatches: PAGE_MOVE_RECEIPT_PRUNE_MAX_BATCHES,
  });
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
      `SELECT p.id, p.workspace_id, p.space_id, p.parent_id, p.kind, p.position, p.title, p.icon,
              p.revision, p.content_epoch, p.is_template, p.archived_at, p.created_at, p.updated_at,
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
      row.archived_at === null &&
      row.space_id === page.spaceId &&
      row.parent_id === page.parentId &&
      row.kind === page.kind &&
      row.title === page.title
    );
  });
  if (!replayMatches) throw new HttpError(409, "idempotency_key_reused", conflictMessage);
  if (rows.some((row) => row.archived_at !== null)) {
    throw new HttpError(409, "page_archived", "A page created by this request is now archived.");
  }
  return rows.map(pageJson);
}

async function requestedPageIdsExist(database: D1Database, requested: RequestedPageCreate[]) {
  const existing = await database
    .prepare(`SELECT 1 FROM pages WHERE id IN (${requested.map(() => "?").join(", ")}) LIMIT 1`)
    .bind(...requested.map((page) => page.id))
    .first();
  return existing !== null;
}

async function validatePageCreateParents(env: Env, member: MemberContext, requested: RequestedPageCreate[]) {
  const checkedSpaces = new Set<string>();
  const parentIds = [...new Set(requested.map((page) => page.parentId))];
  for (const parentId of parentIds) {
    if (!parentId) continue;
    const parent = await pageForMember(env, member, parentId);
    requirePageEditor(parent);
    for (const page of requested) {
      if (page.parentId === parentId && page.spaceId !== parent.space_id) {
        throw new HttpError(422, "cross_space_parent", "A parent page must belong to the same space.");
      }
    }
    checkedSpaces.add(parent.space_id!);
  }
  for (const spaceId of new Set(requested.map((page) => page.spaceId))) {
    if (checkedSpaces.has(spaceId)) continue;
    const space = await spaceForMember(env, member, spaceId);
    if (effectiveSpaceRole(member.role, space.visibility, space.space_role) === "viewer") {
      throw new HttpError(403, "read_only", "Your role in this space is read-only.");
    }
  }
}

async function readInitialPageCreateReplay(
  env: Env,
  member: MemberContext,
  requested: RequestedPageCreate[],
  requestHash: string,
  conflictMessage: string,
) {
  try {
    return await readPageCreateReplay(env.DB, member.workspace.id, requested, requestHash, conflictMessage);
  } catch (error) {
    // Exact replays remain valid if their original parent was archived later.
    // For a mismatched reuse, however, preserve the create API's parent error
    // precedence before returning the idempotency conflict.
    if (safeHttpErrorCode(error) === "idempotency_key_reused") {
      await validatePageCreateParents(env, member, requested);
    }
    throw error;
  }
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
    if (safeInstanceOf(error, HttpError)) throw error;
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
    if (safeInstanceOf(error, HttpError)) throw error;
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
    `SELECT p.*, s.visibility, sm.role space_role
       FROM pages p
       JOIN spaces s ON s.id = p.space_id AND s.workspace_id = p.workspace_id
       LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
      WHERE p.id = ? AND p.workspace_id = ? ${includeArchived ? "" : "AND p.archived_at IS NULL"}
        AND p.import_job_id IS NULL
        AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)`,
  )
    .bind(member.user.id, pageId, member.workspace.id, member.role)
    .first<PageRow>();
  if (!row) throw new HttpError(404, "page_not_found", "Page not found.");
  return { ...row, effective_role: effectiveSpaceRole(member.role, row.visibility!, row.space_role ?? null)! };
}

function commentPage(page: PageRow): CommentPage {
  return {
    id: page.id,
    workspace_id: page.workspace_id,
    space_id: page.space_id ?? `${page.workspace_id}-general`,
    content_epoch: page.content_epoch,
    created_by: page.created_by,
    effective_role: page.effective_role!,
  };
}

async function pageForCommentThread(env: Env, member: MemberContext, threadId: string) {
  const located = await env.DB.prepare(`SELECT page_id FROM comment_threads WHERE id = ? AND workspace_id = ?`)
    .bind(threadId, member.workspace.id)
    .first<{ page_id: string }>();
  if (!located) throw new HttpError(404, "comment_thread_not_found", "Comment thread not found.");
  return pageForMember(env, member, located.page_id);
}

async function pageForComment(env: Env, member: MemberContext, commentId: string) {
  const located = await env.DB.prepare(
    `SELECT ct.id thread_id, ct.page_id
       FROM comments c JOIN comment_threads ct ON ct.id = c.thread_id
      WHERE c.id = ? AND ct.workspace_id = ?`,
  )
    .bind(commentId, member.workspace.id)
    .first<{ thread_id: string; page_id: string }>();
  if (!located) throw new HttpError(404, "comment_not_found", "Comment not found.");
  return { threadId: located.thread_id, page: await pageForMember(env, member, located.page_id) };
}

function effectiveSpaceRole(
  workspaceRole: Role,
  visibility: "workspace" | "private",
  grant: Exclude<Role, "owner"> | null,
): Role | null {
  if (workspaceRole === "owner") return "owner";
  if (visibility === "private" && !grant) return null;
  if (workspaceRole === "viewer" || grant === "viewer") return "viewer";
  return "editor";
}

function requirePageEditor(page: PageRow) {
  if (page.effective_role === "viewer") {
    throw new HttpError(403, "read_only", "Your role in this space is read-only.");
  }
}

type SpaceRow = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string;
  icon: string | null;
  position: string;
  visibility: "workspace" | "private";
  space_role: Exclude<Role, "owner"> | null;
  created_at: number;
  updated_at: number;
};

function spaceJson(row: SpaceRow, member: MemberContext): Space {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    icon: row.icon,
    position: row.position,
    visibility: row.visibility,
    effectiveRole: effectiveSpaceRole(member.role, row.visibility, row.space_role)!,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function spaceForMember(env: Env, member: MemberContext, spaceId: string) {
  const row = await env.DB.prepare(
    `SELECT s.*, sm.role space_role FROM spaces s
      LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
     WHERE s.id = ? AND s.workspace_id = ?
       AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)`,
  )
    .bind(member.user.id, spaceId, member.workspace.id, member.role)
    .first<SpaceRow>();
  if (!row) throw new HttpError(404, "space_not_found", "Space not found.");
  return row;
}

type TagRow = {
  id: string;
  workspace_id: string;
  name: string;
  color: TagColor;
  page_count?: number;
  created_at: number;
  updated_at: number;
};

function tagJson(row: TagRow): Tag {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    color: row.color,
    pageCount: row.page_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function tagColor(value: unknown): TagColor {
  const color = value === undefined ? "gray" : text(value, "color", 20);
  if (!TAG_COLORS.includes(color as TagColor)) {
    throw new HttpError(422, "invalid_input", "color is not a supported tag color.");
  }
  return color as TagColor;
}

function refreshSearchV2Statements(database: D1Database, pageId: string) {
  return [
    database.prepare(`DELETE FROM page_search_v2 WHERE page_id = ?`).bind(pageId),
    database
      .prepare(
        `INSERT INTO page_search_v2
          (page_id, workspace_id, space_id, title, tags, body, comments, attachments)
         SELECT p.id, p.workspace_id, p.space_id, p.title,
                COALESCE((SELECT group_concat(t.name, ' ') FROM page_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.page_id = p.id), ''),
                COALESCE(p.plain_text, ''),
                COALESCE((SELECT group_concat(c.plain_text, ' ') FROM comment_threads ct JOIN comments c ON c.thread_id = ct.id WHERE ct.page_id = p.id AND c.deleted_at IS NULL), ''),
                COALESCE((SELECT group_concat(a.name, ' ') FROM attachments a WHERE a.page_id = p.id), '')
           FROM pages p WHERE p.id = ? AND p.archived_at IS NULL AND p.import_job_id IS NULL`,
      )
      .bind(pageId),
  ];
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
  edit = false,
  includeArchived = false,
) {
  const row = await env.DB.prepare(
    `SELECT p.*, s.visibility, sm.role space_role${extra.columns}
       FROM pages p
       JOIN spaces s ON s.id = p.space_id AND s.workspace_id = p.workspace_id
       LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
      WHERE p.id = ? AND p.workspace_id = ? ${includeArchived ? "" : "AND p.archived_at IS NULL"}
        AND p.import_job_id IS NULL
        AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)`,
  )
    .bind(...extra.binds, member.user.id, pageId, member.workspace.id, member.role)
    .first<PageRow & T>();
  if (!row) throw new HttpError(404, "page_not_found", "Page not found.");
  if (row.kind !== "table") throw new HttpError(422, "table_required", "This page is not a table.");
  const accessible = {
    ...row,
    effective_role: effectiveSpaceRole(member.role, row.visibility!, row.space_role ?? null)!,
  };
  if (edit) requirePageEditor(accessible);
  return accessible;
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
    c.env.DB.prepare(
      `INSERT INTO subscriptions
        (id, workspace_id, user_id, resource_type, resource_id, created_by, created_at)
       VALUES (?, ?, ?, 'page', ?, ?, ?)
       ON CONFLICT(user_id, resource_type, resource_id) DO UPDATE SET muted_at = NULL`,
    ).bind(`page:${pageId}:${signup.user.id}`, workspaceId, signup.user.id, pageId, signup.user.id, timestamp),
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

app.get("/api/spaces", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const rows = await c.env.DB.prepare(
    `SELECT s.*, sm.role space_role FROM spaces s
      LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
     WHERE s.workspace_id = ?
       AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
     ORDER BY s.position, s.id`,
  )
    .bind(member.user.id, member.workspace.id, member.role)
    .all<SpaceRow>();
  return c.json({ spaces: rows.results.map((row) => spaceJson(row, member)) });
});

app.post("/api/spaces", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const body = await jsonBody(c.req.raw);
  const name = text(body.name, "name", 100);
  const requestedSlug = typeof body.slug === "string" ? body.slug : name;
  const slug = requestedSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  if (!slug) throw new HttpError(422, "invalid_input", "Space slug must contain a letter or number.");
  const visibility = body.visibility === undefined ? "workspace" : text(body.visibility, "visibility", 20);
  if (visibility !== "workspace" && visibility !== "private") {
    throw new HttpError(422, "invalid_input", "visibility must be workspace or private.");
  }
  const last = await c.env.DB.prepare(
    `SELECT position FROM spaces WHERE workspace_id = ? ORDER BY position DESC, id DESC LIMIT 1`,
  )
    .bind(member.workspace.id)
    .first<{ position: string }>();
  const timestamp = now();
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO spaces
      (id, workspace_id, name, slug, description, icon, position, visibility, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      member.workspace.id,
      name,
      slug,
      typeof body.description === "string" ? body.description.trim().slice(0, 500) : "",
      body.icon === null || body.icon === undefined ? null : text(body.icon, "icon", 20),
      generateJitteredKeyBetween(last?.position ?? null, null),
      visibility,
      member.user.id,
      timestamp,
      timestamp,
    )
    .run();
  const space = await spaceForMember(c.env, member, id);
  sendWorkspaceEvent(c, member.workspace.id, { type: "organization-invalidated" });
  return c.json({ space: spaceJson(space, member) }, 201);
});

app.patch("/api/spaces/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const space = await spaceForMember(c.env, member, c.req.param("id"));
  const body = await jsonBody(c.req.raw);
  const name = body.name === undefined ? space.name : text(body.name, "name", 100);
  const visibility = body.visibility === undefined ? space.visibility : text(body.visibility, "visibility", 20);
  if (visibility !== "workspace" && visibility !== "private") {
    throw new HttpError(422, "invalid_input", "visibility must be workspace or private.");
  }
  const description =
    body.description === undefined
      ? space.description
      : typeof body.description === "string"
        ? body.description.trim().slice(0, 500)
        : (() => {
            throw new HttpError(422, "invalid_input", "description must be text.");
          })();
  const icon = body.icon === undefined ? space.icon : body.icon === null ? null : text(body.icon, "icon", 20);
  await c.env.DB.prepare(
    `UPDATE spaces SET name = ?, description = ?, icon = ?, visibility = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`,
  )
    .bind(name, description, icon, visibility, now(), space.id, member.workspace.id)
    .run();
  sendWorkspaceEvent(c, member.workspace.id, { type: "workspace-invalidated" });
  return c.json({ space: spaceJson(await spaceForMember(c.env, member, space.id), member) });
});

app.put("/api/spaces/:id/members/:userId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const space = await spaceForMember(c.env, member, c.req.param("id"));
  const userId = text(c.req.param("userId"), "userId", 100);
  const body = await jsonBody(c.req.raw);
  const grant = role(body.role);
  if (grant === "owner") throw new HttpError(422, "invalid_input", "Space grants may be editor or viewer.");
  const workspaceMember = await c.env.DB.prepare(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
  )
    .bind(member.workspace.id, userId)
    .first();
  if (!workspaceMember) throw new HttpError(404, "member_not_found", "Member not found.");
  await c.env.DB.prepare(
    `INSERT INTO space_members (space_id, user_id, role, created_by, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(space_id, user_id) DO UPDATE SET role = excluded.role, created_by = excluded.created_by`,
  )
    .bind(space.id, userId, grant, member.user.id, now())
    .run();
  sendWorkspaceEvent(c, member.workspace.id, { type: "workspace-invalidated" });
  return c.json({ ok: true });
});

app.delete("/api/spaces/:id/members/:userId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const space = await spaceForMember(c.env, member, c.req.param("id"));
  await c.env.DB.prepare(`DELETE FROM space_members WHERE space_id = ? AND user_id = ?`)
    .bind(space.id, c.req.param("userId"))
    .run();
  sendWorkspaceEvent(c, member.workspace.id, { type: "workspace-invalidated" });
  return c.json({ ok: true });
});

app.get("/api/favorites", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const rows = await c.env.DB.prepare(
    `SELECT p.* FROM favorites f
      JOIN pages p ON p.id = f.page_id
      JOIN spaces s ON s.id = p.space_id
      LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
     WHERE f.user_id = ? AND p.workspace_id = ? AND p.archived_at IS NULL
       AND p.is_template = 0 AND p.import_job_id IS NULL
       AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
     ORDER BY f.position, p.id`,
  )
    .bind(member.user.id, member.user.id, member.workspace.id, member.role)
    .all<PageRow>();
  return c.json({ pages: rows.results.map(pageJson) });
});

app.post("/api/favorites/:pageId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForMember(c.env, member, c.req.param("pageId"));
  const last = await c.env.DB.prepare(`SELECT position FROM favorites WHERE user_id = ? ORDER BY position DESC LIMIT 1`)
    .bind(member.user.id)
    .first<{ position: string }>();
  await c.env.DB.prepare(`INSERT OR IGNORE INTO favorites (user_id, page_id, position, created_at) VALUES (?, ?, ?, ?)`)
    .bind(member.user.id, page.id, generateJitteredKeyBetween(last?.position ?? null, null), now())
    .run();
  sendWorkspaceEvent(c, member.workspace.id, { type: "organization-invalidated" });
  return c.json({ page: pageJson(page) }, 201);
});

app.delete("/api/favorites/:pageId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  await c.env.DB.prepare(
    `DELETE FROM favorites WHERE user_id = ? AND page_id IN (
       SELECT id FROM pages WHERE id = ? AND workspace_id = ?
     )`,
  )
    .bind(member.user.id, c.req.param("pageId"), member.workspace.id)
    .run();
  sendWorkspaceEvent(c, member.workspace.id, { type: "organization-invalidated" });
  return c.json({ ok: true });
});

app.get("/api/spaces/:id/pins", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const space = await spaceForMember(c.env, member, c.req.param("id"));
  const rows = await c.env.DB.prepare(
    `SELECT p.* FROM space_pins sp JOIN pages p ON p.id = sp.page_id
      WHERE sp.space_id = ? AND p.space_id = ? AND p.archived_at IS NULL
        AND p.is_template = 0 AND p.import_job_id IS NULL
      ORDER BY sp.position, p.id`,
  )
    .bind(space.id, space.id)
    .all<PageRow>();
  return c.json({ pages: rows.results.map(pageJson) });
});

app.post("/api/spaces/:id/pins/:pageId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const space = await spaceForMember(c.env, member, c.req.param("id"));
  if (effectiveSpaceRole(member.role, space.visibility, space.space_role) === "viewer") {
    throw new HttpError(403, "read_only", "Your role in this space is read-only.");
  }
  const page = await pageForMember(c.env, member, c.req.param("pageId"));
  if (page.space_id !== space.id) throw new HttpError(422, "pin_space_mismatch", "A pin must belong to its space.");
  const last = await c.env.DB.prepare(
    `SELECT position FROM space_pins WHERE space_id = ? ORDER BY position DESC LIMIT 1`,
  )
    .bind(space.id)
    .first<{ position: string }>();
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO space_pins (space_id, page_id, position, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(space.id, page.id, generateJitteredKeyBetween(last?.position ?? null, null), member.user.id, now())
    .run();
  sendWorkspaceEvent(c, member.workspace.id, { type: "organization-invalidated" });
  return c.json({ page: pageJson(page) }, 201);
});

app.delete("/api/spaces/:id/pins/:pageId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const space = await spaceForMember(c.env, member, c.req.param("id"));
  if (effectiveSpaceRole(member.role, space.visibility, space.space_role) === "viewer") {
    throw new HttpError(403, "read_only", "Your role in this space is read-only.");
  }
  await c.env.DB.prepare(`DELETE FROM space_pins WHERE space_id = ? AND page_id = ?`)
    .bind(space.id, c.req.param("pageId"))
    .run();
  sendWorkspaceEvent(c, member.workspace.id, { type: "organization-invalidated" });
  return c.json({ ok: true });
});

app.get("/api/tags", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const rows = await c.env.DB.prepare(
    `SELECT t.*, COUNT(DISTINCT visible.id) page_count FROM tags t
      LEFT JOIN page_tags pt ON pt.tag_id = t.id
      LEFT JOIN (
        SELECT p.id FROM pages p JOIN spaces s ON s.id = p.space_id
        LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
        WHERE p.workspace_id = ? AND p.archived_at IS NULL
          AND p.import_job_id IS NULL AND p.is_template = 0
          AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
      ) visible ON visible.id = pt.page_id
     WHERE t.workspace_id = ? GROUP BY t.id ORDER BY lower(t.name), t.id`,
  )
    .bind(member.user.id, member.workspace.id, member.role, member.workspace.id)
    .all<TagRow>();
  return c.json({ tags: rows.results.map(tagJson) });
});

app.post("/api/tags", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const body = await jsonBody(c.req.raw);
  const name = text(body.name, "name", 50);
  const existing = await c.env.DB.prepare(`SELECT id FROM tags WHERE workspace_id = ? AND lower(name) = lower(?)`)
    .bind(member.workspace.id, name)
    .first();
  if (existing) throw new HttpError(409, "tag_exists", "A tag with that name already exists.");
  const id = crypto.randomUUID();
  const timestamp = now();
  await c.env.DB.prepare(
    `INSERT INTO tags (id, workspace_id, name, color, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, member.workspace.id, name, tagColor(body.color), member.user.id, timestamp, timestamp)
    .run();
  const tag = await c.env.DB.prepare(`SELECT * FROM tags WHERE id = ?`).bind(id).first<TagRow>();
  sendWorkspaceEvent(c, member.workspace.id, { type: "organization-invalidated" });
  return c.json({ tag: tagJson(tag!) }, 201);
});

app.patch("/api/tags/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const current = await c.env.DB.prepare(`SELECT * FROM tags WHERE id = ? AND workspace_id = ?`)
    .bind(c.req.param("id"), member.workspace.id)
    .first<TagRow>();
  if (!current) throw new HttpError(404, "tag_not_found", "Tag not found.");
  const body = await jsonBody(c.req.raw);
  const name = body.name === undefined ? current.name : text(body.name, "name", 50);
  const duplicate = await c.env.DB.prepare(
    `SELECT id FROM tags WHERE workspace_id = ? AND lower(name) = lower(?) AND id <> ?`,
  )
    .bind(member.workspace.id, name, current.id)
    .first();
  if (duplicate) throw new HttpError(409, "tag_exists", "A tag with that name already exists.");
  await c.env.DB.prepare(`UPDATE tags SET name = ?, color = ?, updated_at = ? WHERE id = ?`)
    .bind(name, body.color === undefined ? current.color : tagColor(body.color), now(), current.id)
    .run();
  await c.env.DB.prepare(
    `UPDATE page_search_v2 SET tags = COALESCE(
       (SELECT group_concat(t.name, ' ') FROM page_tags pt JOIN tags t ON t.id = pt.tag_id
         WHERE pt.page_id = page_search_v2.page_id), '')
      WHERE page_id IN (SELECT page_id FROM page_tags WHERE tag_id = ?)`,
  )
    .bind(current.id)
    .run();
  sendWorkspaceEvent(c, member.workspace.id, { type: "organization-invalidated" });
  return c.json({
    tag: tagJson((await c.env.DB.prepare(`SELECT * FROM tags WHERE id = ?`).bind(current.id).first<TagRow>())!),
  });
});

app.delete("/api/tags/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const tag = await c.env.DB.prepare(`SELECT id FROM tags WHERE id = ? AND workspace_id = ?`)
    .bind(c.req.param("id"), member.workspace.id)
    .first<{ id: string }>();
  if (!tag) throw new HttpError(404, "tag_not_found", "Tag not found.");
  const pages = await c.env.DB.prepare(`SELECT page_id id FROM page_tags WHERE tag_id = ?`)
    .bind(tag.id)
    .all<{ id: string }>();
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM tags WHERE id = ?`).bind(tag.id),
    c.env.DB.prepare(
      `UPDATE page_search_v2 SET tags = COALESCE(
           (SELECT group_concat(t.name, ' ') FROM page_tags pt JOIN tags t ON t.id = pt.tag_id
             WHERE pt.page_id = page_search_v2.page_id), '')
          WHERE page_id IN (SELECT value FROM json_each(?))`,
    ).bind(JSON.stringify(pages.results.map((page) => page.id))),
  ]);
  sendWorkspaceEvent(c, member.workspace.id, { type: "organization-invalidated" });
  return c.json({ ok: true });
});

app.get("/api/pages/:id/tags", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForMember(c.env, member, c.req.param("id"), true);
  const rows = await c.env.DB.prepare(
    `SELECT t.*, 0 page_count FROM page_tags pt JOIN tags t ON t.id = pt.tag_id
      WHERE pt.page_id = ? AND t.workspace_id = ? ORDER BY lower(t.name), t.id`,
  )
    .bind(page.id, member.workspace.id)
    .all<TagRow>();
  return c.json({ tags: rows.results.map(tagJson) });
});

app.put("/api/pages/:id/tags/:tagId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  requirePageEditor(page);
  const tag = await c.env.DB.prepare(`SELECT id FROM tags WHERE id = ? AND workspace_id = ?`)
    .bind(c.req.param("tagId"), member.workspace.id)
    .first<{ id: string }>();
  if (!tag) throw new HttpError(404, "tag_not_found", "Tag not found.");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO page_tags (page_id, tag_id, created_by, created_at) VALUES (?, ?, ?, ?)`,
    ).bind(page.id, tag.id, member.user.id, now()),
    ...refreshSearchV2Statements(c.env.DB, page.id),
  ]);
  sendWorkspaceEvent(c, member.workspace.id, { type: "organization-invalidated" });
  return c.json({ ok: true });
});

app.delete("/api/pages/:id/tags/:tagId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  requirePageEditor(page);
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM page_tags WHERE page_id = ? AND tag_id = ?`).bind(page.id, c.req.param("tagId")),
    ...refreshSearchV2Statements(c.env.DB, page.id),
  ]);
  sendWorkspaceEvent(c, member.workspace.id, { type: "organization-invalidated" });
  return c.json({ ok: true });
});

app.get("/api/templates", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const requestedSpaceId = c.req.query("spaceId");
  if (requestedSpaceId) await spaceForMember(c.env, member, requestedSpaceId);
  const rows = await c.env.DB.prepare(
    `SELECT p.* FROM pages p
      JOIN spaces s ON s.id = p.space_id
      LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
     WHERE p.workspace_id = ? AND p.is_template = 1 AND p.archived_at IS NULL AND p.import_job_id IS NULL
       AND (? IS NULL OR p.space_id = ?)
       AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
     ORDER BY s.position, p.position, p.id`,
  )
    .bind(member.user.id, member.workspace.id, requestedSpaceId ?? null, requestedSpaceId ?? null, member.role)
    .all<PageRow>();
  return c.json({ templates: rows.results.map(pageJson) });
});

app.post("/api/templates", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const body = await jsonBody(c.req.raw);
  const source = await pageForMember(c.env, member, text(body.pageId, "pageId", 100));
  requirePageEditor(source);
  if (source.is_template) throw new HttpError(409, "already_template", "This page is already a template.");
  if (!source.space_id) throw new HttpError(409, "space_required", "The source page is not assigned to a space.");
  const title = body.title === undefined ? source.title : text(body.title, "title", PAGE_TITLE_MAX);
  const targetPageId = crypto.randomUUID();
  const job = await createJob(c.env, {
    member,
    type: "template_clone",
    spaceId: source.space_id,
    options: {
      sourcePageId: source.id,
      targetPageId,
      targetSpaceId: source.space_id,
      parentId: null,
      title,
      isTemplate: true,
    },
  });
  c.executionCtx.waitUntil(
    startJobExecution(c.env, job).catch((error) => {
      console.error("Failed to start template creation workflow", { jobId: job.id, error });
    }),
  );
  sendWorkspaceEvent(c, member.workspace.id, { type: "jobs-invalidated" });
  return c.json({ job: jobJson(job) }, 202);
});

app.post("/api/templates/:id/instantiate", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const template = await pageForMember(c.env, member, c.req.param("id"));
  requirePageEditor(template);
  if (!template.is_template) throw new HttpError(404, "template_not_found", "Template not found.");
  if (!template.space_id) throw new HttpError(409, "space_required", "The template is not assigned to a space.");
  const body = await jsonBody(c.req.raw);
  const parentId = nullableId(body.parentId, "parentId");
  if (parentId) {
    const parent = await pageForMember(c.env, member, parentId);
    requirePageEditor(parent);
    if (parent.is_template || parent.space_id !== template.space_id) {
      throw new HttpError(422, "template_parent_mismatch", "The destination must be a page in the template's space.");
    }
  }
  const title = body.title === undefined ? template.title : text(body.title, "title", PAGE_TITLE_MAX);
  const targetPageId = crypto.randomUUID();
  const job = await createJob(c.env, {
    member,
    type: "template_clone",
    spaceId: template.space_id,
    options: {
      sourcePageId: template.id,
      targetPageId,
      targetSpaceId: template.space_id,
      parentId,
      title,
      isTemplate: false,
    },
  });
  c.executionCtx.waitUntil(
    startJobExecution(c.env, job).catch((error) => {
      console.error("Failed to start template instantiation workflow", { jobId: job.id, error });
    }),
  );
  sendWorkspaceEvent(c, member.workspace.id, { type: "jobs-invalidated" });
  return c.json({ job: jobJson(job) }, 202);
});

app.get("/api/jobs", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const requestedLimit = Number(c.req.query("limit") ?? 50);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const rows = await c.env.DB.prepare(
    `SELECT j.* FROM jobs j
      LEFT JOIN spaces s ON s.id = j.space_id
      LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
     WHERE j.workspace_id = ? AND j.requested_by = ?
       AND (j.space_id IS NULL OR ? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
     ORDER BY j.created_at DESC, j.id DESC LIMIT ?`,
  )
    .bind(member.user.id, member.workspace.id, member.user.id, member.role, limit)
    .all<JobRow>();
  return c.json({ jobs: rows.results.map(jobJson) });
});

app.get("/api/jobs/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  return c.json({ job: jobJson(await jobForMember(c.env, member, c.req.param("id"))) });
});

app.post("/api/jobs/search-reindex", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const existing = await c.env.DB.prepare(
    `SELECT * FROM jobs WHERE workspace_id = ? AND type = 'search_reindex' AND status IN ('queued', 'running')
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(member.workspace.id)
    .first<JobRow>();
  if (existing) return c.json({ job: jobJson(existing), coalesced: true });
  const job = await createJob(c.env, { member, type: "search_reindex" });
  c.executionCtx.waitUntil(
    startJobExecution(c.env, job).catch((error) => {
      console.error("Failed to start search reindex workflow", { jobId: job.id, error });
    }),
  );
  sendWorkspaceEvent(c, member.workspace.id, { type: "jobs-invalidated" });
  return c.json({ job: jobJson(job), coalesced: false }, 202);
});

app.post("/api/jobs/:id/cancel", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const job = await jobForMember(c.env, member, c.req.param("id"));
  if (["succeeded", "failed", "canceled"].includes(job.status)) {
    throw new HttpError(409, "job_not_cancelable", "This job is no longer running.");
  }
  await c.env.DB.prepare(
    `UPDATE jobs SET status = 'canceled', progress_label = 'Canceled', updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running', 'awaiting_confirmation', 'canceling')`,
  )
    .bind(now(), job.id)
    .run();
  if (job.workflow_instance_id) {
    c.executionCtx.waitUntil(
      c.env.NOTES_WORKFLOW.get(job.workflow_instance_id)
        .then((instance) => instance.terminate())
        .catch((error) => console.error("Failed to terminate canceled workflow", { jobId: job.id, error })),
    );
  }
  sendWorkspaceEvent(c, member.workspace.id, { type: "jobs-invalidated" });
  return c.json({ job: jobJson(await jobForMember(c.env, member, job.id)) });
});

app.post("/api/jobs/:id/retry", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const job = await jobForMember(c.env, member, c.req.param("id"));
  if (job.status !== "failed" && job.status !== "canceled") {
    throw new HttpError(409, "job_not_retryable", "Only failed or canceled jobs can be retried.");
  }
  const instanceId = crypto.randomUUID();
  await c.env.DB.prepare(
    `UPDATE jobs SET status = 'queued', workflow_instance_id = ?, progress_current = 0, progress_label = 'Queued',
       error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(instanceId, now(), job.id)
    .run();
  const retried = await jobForMember(c.env, member, job.id);
  c.executionCtx.waitUntil(
    startJobExecution(c.env, retried).catch((error) => {
      console.error("Failed to restart job workflow", { jobId: job.id, error });
    }),
  );
  sendWorkspaceEvent(c, member.workspace.id, { type: "jobs-invalidated" });
  return c.json({ job: jobJson(retried) }, 202);
});

app.get("/api/jobs/:id/download", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const job = await jobForMember(c.env, member, c.req.param("id"));
  if (job.status !== "succeeded" || !job.output_key) {
    throw new HttpError(409, "job_download_unavailable", "This job does not have a downloadable result.");
  }
  if (job.expires_at && job.expires_at <= now()) {
    throw new HttpError(404, "job_artifact_expired", "This download has expired.");
  }
  const artifact = await c.env.BUCKET.get(job.output_key);
  if (!artifact) throw new HttpError(404, "job_artifact_missing", "This download is no longer available.");
  const headers = new Headers();
  artifact.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=0, must-revalidate");
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-disposition",
    attachmentDisposition(artifact.customMetadata?.filename ?? `notes-${job.type}`, false),
  );
  return new Response(artifact.body, { headers });
});

app.get("/api/pages/tree", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const archived = c.req.query("archived") === "true";
  const rows = await c.env.DB.prepare(
    `SELECT p.* FROM pages p
      JOIN spaces s ON s.id = p.space_id
      LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
     WHERE p.workspace_id = ? AND p.archived_at IS ${archived ? "NOT " : ""}NULL
       AND p.is_template = 0 AND p.import_job_id IS NULL
       AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
     ORDER BY p.position, p.id`,
  )
    .bind(member.user.id, member.workspace.id, member.role)
    .all<PageRow>();
  return c.json({ pages: rows.results.map(pageJson) });
});

app.post("/api/pages", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const body = await jsonBody(c.req.raw);
  const parentId = nullableId(body.parentId, "parentId");
  const requestedSpaceId = nullableId(body.spaceId, "spaceId");
  const clientProvidedId = body.id !== undefined;
  // An exact idempotent replay remains readable after its original parent was
  // archived. New creates are still rejected by validatePageCreateParents.
  const parent = parentId ? await pageForMember(c.env, member, parentId, clientProvidedId) : null;
  if (parent) requirePageEditor(parent);
  const spaceId = requestedSpaceId ?? parent?.space_id ?? `${member.workspace.id}-general`;
  if (parent && parent.space_id !== spaceId) {
    throw new HttpError(422, "cross_space_parent", "A parent page must belong to the same space.");
  }
  const id = clientProvidedId ? text(body.id, "id", 100) : crypto.randomUUID();
  if (!ID_PATTERN.test(id)) throw new HttpError(422, "invalid_input", "id is not a valid resource id.");
  const kind = pageKind(body.kind ?? "document");
  const title = typeof body.title === "string" ? text(body.title, "title", PAGE_TITLE_MAX) : "Untitled";
  const requestHash = await pageCreateRequestHash({ spaceId, parentId, kind, title });
  const requested = [{ id, spaceId, parentId, kind, title }];
  const conflictMessage = "That page id already describes a different page.";
  const initialReplay = clientProvidedId
    ? await readInitialPageCreateReplay(c.env, member, requested, requestHash, conflictMessage)
    : null;
  if (initialReplay) return c.json({ page: initialReplay[0]! });
  await validatePageCreateParents(c.env, member, requested);
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
        `INSERT INTO pages (id, workspace_id, space_id, parent_id, kind, position, title, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      ).bind(id, member.workspace.id, spaceId, parentId, kind, position, title, member.user.id, timestamp, timestamp),
      c.env.DB.prepare(`INSERT INTO page_search (page_id, workspace_id, title, body) VALUES (?, ?, ?, '')`).bind(
        id,
        member.workspace.id,
        title,
      ),
      c.env.DB.prepare(
        `INSERT INTO subscriptions
          (id, workspace_id, user_id, resource_type, resource_id, created_by, created_at)
         VALUES (?, ?, ?, 'page', ?, ?, ?)
         ON CONFLICT(user_id, resource_type, resource_id) DO UPDATE SET muted_at = NULL`,
      ).bind(`page:${id}:${member.user.id}`, member.workspace.id, member.user.id, id, member.user.id, timestamp),
      ...(kind === "table" ? [c.env.DB.prepare(`INSERT INTO table_state (page_id) VALUES (?)`).bind(id)] : []),
      c.env.DB.prepare(
        `INSERT INTO page_create_receipts
         (workspace_id, page_id, request_hash) VALUES (?, ?, ?)`,
      ).bind(member.workspace.id, id, requestHash),
    ]);
    createdRow = results[0]?.results[0];
  } catch (error) {
    // A failed batch response may be ambiguous after commit. The generated id is
    // known inside this invocation, so its receipt can still recover the result.
    const replay = await readPageCreateReplay(c.env.DB, member.workspace.id, requested, requestHash, conflictMessage);
    if (replay) return c.json({ page: replay[0]! });
    if (clientProvidedId && (await requestedPageIdsExist(c.env.DB, requested))) {
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

  const entries = requested.map((raw) => object(raw));
  const allIdsClientProvided = entries.every((entry) => entry.id !== undefined);
  const parsed = entries.map((entry, index) => {
    const requestedId = entry.id === undefined ? crypto.randomUUID() : text(entry.id, `pages[${index}].id`, 100);
    if (!ID_PATTERN.test(requestedId)) {
      throw new HttpError(422, "invalid_input", `pages[${index}].id is not a valid resource id.`);
    }
    return {
      id: requestedId,
      spaceId: nullableId(entry.spaceId, `pages[${index}].spaceId`) ?? `${member.workspace.id}-general`,
      parentId: nullableId(entry.parentId, `pages[${index}].parentId`),
      kind: pageKind(entry.kind ?? "document"),
      title: typeof entry.title === "string" ? text(entry.title, `pages[${index}].title`, PAGE_TITLE_MAX) : "Untitled",
    };
  });
  for (const [index, page] of parsed.entries()) {
    if (!page.parentId || entries[index]!.spaceId !== undefined) continue;
    const parent = await pageForMember(c.env, member, page.parentId);
    page.spaceId = parent.space_id!;
  }
  const clientProvidedPages = parsed.filter((_page, index) => entries[index]!.id !== undefined);
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) {
    throw new HttpError(422, "invalid_input", "A page id may appear only once in a batch.");
  }
  const requestHash = await pageCreateRequestHash(parsed);
  const conflictMessage = "Those page ids already describe different pages.";
  const initialReplay = allIdsClientProvided
    ? await readInitialPageCreateReplay(c.env, member, parsed, requestHash, conflictMessage)
    : null;
  if (initialReplay) return c.json({ pages: initialReplay, replayed: true });

  // Every distinct parent is checked once, which also rejects a parent in another
  // workspace or an archived one exactly as the single-page route does.
  await validatePageCreateParents(c.env, member, parsed);
  const parentIds = [...new Set(parsed.map((page) => page.parentId))];

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
        `INSERT INTO pages (id, workspace_id, space_id, parent_id, kind, position, title, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      ).bind(
        page.id,
        member.workspace.id,
        page.spaceId,
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
      c.env.DB.prepare(
        `INSERT INTO subscriptions
          (id, workspace_id, user_id, resource_type, resource_id, created_by, created_at)
         VALUES (?, ?, ?, 'page', ?, ?, ?)
         ON CONFLICT(user_id, resource_type, resource_id) DO UPDATE SET muted_at = NULL`,
      ).bind(
        `page:${page.id}:${member.user.id}`,
        member.workspace.id,
        member.user.id,
        page.id,
        member.user.id,
        timestamp,
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
    // A concurrent identical retry or an ambiguously committed batch can be
    // recovered from receipts, including ids generated inside this invocation.
    const replay = await readPageCreateReplay(c.env.DB, member.workspace.id, parsed, requestHash, conflictMessage);
    if (replay) return c.json({ pages: replay, replayed: true });
    if (clientProvidedPages.length && (await requestedPageIdsExist(c.env.DB, clientProvidedPages))) {
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

app.get("/api/pages/:id/comments", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  const scopedPage = commentPage(page);
  await migrateLegacyComments(c.env, scopedPage);
  return c.json({ threads: await listCommentThreads(c.env, member, scopedPage) });
});

app.post("/api/pages/:id/comments", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  const scopedPage = commentPage(page);
  await migrateLegacyComments(c.env, scopedPage);
  const body = await jsonBody(c.req.raw);
  const initialComment = object(body.initialComment);
  const thread = await createCommentThread(c.env, member, scopedPage, initialComment.body);
  sendWorkspaceEvent(c, member.workspace.id, { type: "comments-invalidated", pageId: page.id });
  return c.json({ thread }, 201);
});

app.post("/api/comment-threads/:id/anchor", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForCommentThread(c.env, member, c.req.param("id"));
  const scopedPage = commentPage(page);
  const body = await jsonBody(c.req.raw);
  const selection = object(body.selection);
  const yjs = selection.yjs;
  if (!yjs || typeof yjs !== "object" || Array.isArray(yjs)) {
    return c.json({ thread: await commentThread(c.env, member, scopedPage, c.req.param("id")), anchored: false });
  }
  const anchorJson = JSON.stringify(yjs);
  if (new TextEncoder().encode(anchorJson).byteLength > 16 * 1024) {
    throw new HttpError(422, "invalid_comment_anchor", "The comment selection is invalid.");
  }
  let anchored = false;
  if (page.kind === "document") {
    const response = await c.env.DOCUMENT.getByName(`${page.id}~${page.content_epoch}`).fetch(
      new Request("https://document.internal/comment-anchor", {
        method: "POST",
        headers: { "content-type": "application/json", "x-notes-internal": c.env.BETTER_AUTH_SECRET },
        body: JSON.stringify({
          operation: "add",
          threadId: c.req.param("id"),
          userId: member.user.id,
          selection: yjs,
        }),
      }),
    );
    if (response.ok) anchored = Boolean((await response.json<{ anchored?: boolean }>()).anchored);
  }
  await c.env.DB.prepare(`UPDATE comment_threads SET anchor_json = ?, updated_at = ? WHERE id = ? AND page_id = ?`)
    .bind(anchored ? anchorJson : null, Date.now(), c.req.param("id"), page.id)
    .run();
  sendWorkspaceEvent(c, member.workspace.id, { type: "comments-invalidated", pageId: page.id });
  return c.json({ thread: await commentThread(c.env, member, scopedPage, c.req.param("id")), anchored });
});

async function createReplyResponse(c: Context<{ Bindings: Env }>, threadId: string, body: Record<string, unknown>) {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForCommentThread(c.env, member, threadId);
  const comment = object(body.comment);
  const thread = await addCommentReply(c.env, member, commentPage(page), threadId, comment.body, body.parentId);
  sendWorkspaceEvent(c, member.workspace.id, { type: "comments-invalidated", pageId: page.id });
  return c.json({ thread }, 201);
}

app.post("/api/comment-threads/:id/replies", async (c) =>
  createReplyResponse(c, c.req.param("id"), await jsonBody(c.req.raw)),
);

app.post("/api/comment-threads/:id/comments", async (c) =>
  createReplyResponse(c, c.req.param("id"), await jsonBody(c.req.raw)),
);

app.put("/api/comment-threads/:id/comments/:commentId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForCommentThread(c.env, member, c.req.param("id"));
  const body = await jsonBody(c.req.raw);
  const comment = object(body.comment);
  const thread = await updateComment(
    c.env,
    member,
    commentPage(page),
    c.req.param("id"),
    c.req.param("commentId"),
    comment.body,
  );
  sendWorkspaceEvent(c, member.workspace.id, { type: "comments-invalidated", pageId: page.id });
  return c.json({ thread });
});

app.patch("/api/comments/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const located = await pageForComment(c.env, member, c.req.param("id"));
  const body = await jsonBody(c.req.raw);
  const thread = await updateComment(
    c.env,
    member,
    commentPage(located.page),
    located.threadId,
    c.req.param("id"),
    body.body,
  );
  sendWorkspaceEvent(c, member.workspace.id, { type: "comments-invalidated", pageId: located.page.id });
  return c.json({ thread });
});

async function deleteCommentResponse(c: Context<{ Bindings: Env }>, threadId: string, commentId: string) {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForCommentThread(c.env, member, threadId);
  const thread = await softDeleteComment(c.env, member, commentPage(page), threadId, commentId);
  sendWorkspaceEvent(c, member.workspace.id, { type: "comments-invalidated", pageId: page.id });
  return c.json({ thread });
}

app.delete("/api/comment-threads/:id/comments/:commentId", async (c) =>
  deleteCommentResponse(c, c.req.param("id"), c.req.param("commentId")),
);

app.delete("/api/comments/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const located = await pageForComment(c.env, member, c.req.param("id"));
  const thread = await softDeleteComment(c.env, member, commentPage(located.page), located.threadId, c.req.param("id"));
  sendWorkspaceEvent(c, member.workspace.id, { type: "comments-invalidated", pageId: located.page.id });
  return c.json({ thread });
});

async function resolutionResponse(c: Context<{ Bindings: Env }>, threadId: string, resolved: boolean) {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForCommentThread(c.env, member, threadId);
  const thread = await setThreadResolved(c.env, member, commentPage(page), threadId, resolved);
  sendWorkspaceEvent(c, member.workspace.id, { type: "comments-invalidated", pageId: page.id });
  return c.json({ thread });
}

app.post("/api/comment-threads/:id/resolve", async (c) => resolutionResponse(c, c.req.param("id"), true));
app.post("/api/comment-threads/:id/reopen", async (c) => resolutionResponse(c, c.req.param("id"), false));
app.post("/api/comment-threads/:id/unresolve", async (c) => resolutionResponse(c, c.req.param("id"), false));

app.get("/api/pages/:id/content", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  if (page.kind !== "document") {
    throw new HttpError(422, "document_required", "Structured content is available for document pages.");
  }
  const room = `${page.id}~${page.content_epoch}`;
  const projectionLocation = locationHint(member.workspace.locationHint ?? undefined);
  const response = await c.env.DOCUMENT.getByName(
    room,
    projectionLocation ? { locationHint: projectionLocation } : undefined,
  ).fetch(
    new Request("https://document.internal/content", {
      headers: { "x-notes-internal": c.env.BETTER_AUTH_SECRET },
    }),
  );
  if (!response.ok) throw new HttpError(503, "content_unavailable", "Document content is temporarily unavailable.");
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
  });
  const etag = response.headers.get("etag");
  if (etag) headers.set("etag", etag);
  return new Response(response.body, { status: response.status, headers });
});

app.patch("/api/pages/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  requirePageEditor(page);
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
  const body = await jsonBody(c.req.raw);
  const requestedOperationId = c.req.header("x-notes-operation-id");
  // Older browser bundles did not send an operation id. Preserve their move
  // behavior while new clients retain an id they can use for reconciliation.
  const operationId = requestedOperationId?.trim()
    ? text(requestedOperationId, "operationId", 100)
    : crypto.randomUUID();
  if (!ID_PATTERN.test(operationId)) {
    throw new HttpError(422, "invalid_input", "operationId is not a valid resource id.");
  }
  const pageId = c.req.param("id");
  const parentId = nullableId(body.parentId, "parentId");
  const beforeId = nullableId(body.beforeId, "beforeId");
  const afterId = nullableId(body.afterId, "afterId");
  const requestHash = await sha256Hex(canonicalJson({ pageId, parentId, beforeId, afterId }));
  const authorizedPage = await pageForMember(c.env, member, pageId, true);
  requirePageEditor(authorizedPage);
  const receiptContext = {
    workspaceId: member.workspace.id,
    pageId,
    operationId,
    receiptReadPhase: "preflight" as const,
  };
  const replay = await readPageMoveReceiptWithDiagnostics(
    () => readPageMoveReplay(c.env.DB, member.workspace.id, pageId, operationId, requestHash),
    receiptContext,
  );
  if (replay) return c.json({ page: replay, operationId, replayed: true });

  const page = await pageForMember(c.env, member, pageId);
  requirePageEditor(page);
  if (parentId) {
    const parent = await pageForMember(c.env, member, parentId);
    requirePageEditor(parent);
    if (parent.space_id !== page.space_id) {
      throw new HttpError(422, "cross_space_parent", "Move the subtree to that space before changing its parent.");
    }
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
  const neighbors = await c.env.DB.prepare(
    `SELECT id, position FROM pages WHERE workspace_id = ? AND space_id = ? AND parent_id IS ? AND archived_at IS NULL`,
  )
    .bind(member.workspace.id, page.space_id, parentId)
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
  const position = generateJitteredKeyBetween(lower, upper);
  const timestamp = now();
  try {
    const moveResultIndex = 0;
    const receiptResultIndex = 2;
    const pageStateResultIndex = 3;
    const statements = [
      c.env.DB.prepare(
        `UPDATE pages SET parent_id = ?, position = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND archived_at IS NULL`,
      ).bind(parentId, position, timestamp, page.id, member.workspace.id),
      c.env.DB.prepare(
        `INSERT INTO page_move_receipts
           (workspace_id, operation_id, page_id, request_hash, response_json, created_at)
         SELECT workspace_id, ?, id, ?,
           json_object(
             'pageMoveReceiptVersion', ${PAGE_MOVE_RECEIPT_VERSION},
             'page', ${PAGE_MOVE_RECEIPT_PAGE_JSON_SQL}
           ), ?
         FROM pages WHERE id = ? AND workspace_id = ? AND archived_at IS NULL`,
      ).bind(operationId, requestHash, timestamp, page.id, member.workspace.id),
      c.env.DB.prepare(
        `SELECT page_id, request_hash, response_json FROM page_move_receipts
          WHERE workspace_id = ? AND operation_id = ?`,
      ).bind(member.workspace.id, operationId),
      c.env.DB.prepare(
        `SELECT archived_at,
                CASE WHEN archived_at IS NULL THEN ${PAGE_MOVE_RECEIPT_PAGE_JSON_SQL} ELSE NULL END AS page_json
           FROM pages WHERE id = ? AND workspace_id = ?`,
      ).bind(page.id, member.workspace.id),
    ];
    const results = await c.env.DB.batch<PageMoveBatchRow>(statements);
    if (results.length !== statements.length) {
      throw new InvalidPageMoveBatchResultError("The page move batch returned an unexpected number of results.");
    }
    const moveChanges = results[moveResultIndex]?.meta?.changes;
    if (moveChanges !== 0 && moveChanges !== 1) {
      throw new InvalidPageMoveBatchResultError("The page move batch returned malformed move metadata.");
    }
    if (moveChanges === 0) {
      const pageStateResult = results[pageStateResultIndex];
      if (!pageStateResult || !Array.isArray(pageStateResult.results)) {
        throw new InvalidPageMoveBatchResultError("The page move batch did not return its page-state result.");
      }
      const unavailableValue = pageStateResult.results[0];
      const unavailable = pageMoveAvailabilityRow(unavailableValue);
      if (unavailableValue !== undefined && !unavailable) {
        throw new InvalidPageMoveBatchResultError(
          "The unavailable page state returned by the move batch was malformed.",
        );
      }
      if (unavailable && unavailable.archived_at !== null) {
        throw new HttpError(409, "page_archived", "The page was archived before it could be moved.");
      }
      if (unavailable) throw new InvalidPageMoveBatchResultError("An active page move unexpectedly changed no rows.");
      throw new HttpError(404, "page_not_found", "Page not found.");
    }
    const commitReceiptContext = { ...receiptContext, receiptReadPhase: "commit" as const };
    let moved: Page;
    try {
      const receipt = pageMoveReceiptRow(results[receiptResultIndex]?.results[0]);
      if (!receipt) throw new InvalidPageMoveReceiptError("The committed page move receipt row was malformed.");
      moved = pageFromMoveReceipt(receipt, member.workspace.id, pageId, requestHash);
    } catch (receiptError) {
      if (!safeInstanceOf(receiptError, InvalidPageMoveReceiptError)) {
        console.error(
          "Committed page move receipt result was inconsistent.",
          pageMoveReceiptLogFields(receiptError, commitReceiptContext),
        );
        throw new Error("The committed page move receipt result was inconsistent.", { cause: receiptError });
      }
      const unusablePageState = (pageStateError: unknown, cause = pageStateError) => {
        console.error(PAGE_MOVE_RECEIPT_INVALID_LOG_MESSAGE, {
          ...pageMoveReceiptLogFields(receiptError, commitReceiptContext),
          ...prefixedErrorLogFields("pageStateError", pageStateError),
        });
        return new Error("The committed page move receipt and fallback state were unusable.", { cause });
      };
      const committedPageRow = pageMoveStateRow(results[pageStateResultIndex]?.results[0]);
      if (!committedPageRow) {
        const pageStateError = new Error("The moved page state was not returned by its committed batch.");
        throw unusablePageState(pageStateError, receiptError);
      }
      try {
        moved = pageFromMoveState(committedPageRow);
      } catch (pageStateError) {
        throw unusablePageState(pageStateError);
      }
      console.error(
        PAGE_MOVE_RECEIPT_INVALID_LOG_MESSAGE,
        pageMoveReceiptLogFields(receiptError, {
          ...commitReceiptContext,
          recoveredFromPageState: true,
        }),
      );
    }
    sendWorkspaceEvent(c, member.workspace.id, { type: "pages-upserted", pages: [moved] });
    return c.json({ page: moved, operationId, replayed: false });
  } catch (error) {
    const httpErrorCode = safeHttpErrorCode(error);
    if (httpErrorCode !== null && httpErrorCode !== "page_archived") throw error;
    const recoveryContext = { ...receiptContext, receiptReadPhase: "recovery" as const, moveError: error };
    const invalidBatchResult = safeInstanceOf(error, InvalidPageMoveBatchResultError);
    let committed: Page | null = null;
    try {
      committed = await readPageMoveReceiptWithDiagnostics(
        () => readPageMoveReplay(c.env.DB, member.workspace.id, pageId, operationId, requestHash),
        recoveryContext,
      );
    } finally {
      if (invalidBatchResult) {
        console.error(
          PAGE_MOVE_BATCH_RESULT_INVALID_LOG_MESSAGE,
          pageMoveLogFields({ ...recoveryContext, recoveredFromReceipt: committed !== null }),
        );
      }
    }
    if (committed) {
      sendWorkspaceEvent(c, member.workspace.id, { type: "pages-upserted", pages: [committed] });
      return c.json({ page: committed, operationId, replayed: true });
    }
    throw error;
  }
});

app.get("/api/pages/:id/moves/:operationId", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const pageId = c.req.param("id");
  await pageForMember(c.env, member, pageId, true);
  const operationId = c.req.param("operationId");
  if (!ID_PATTERN.test(operationId)) throw new HttpError(404, "move_not_found", "Move receipt not found.");
  const page = await readPageMoveReceiptWithDiagnostics(
    async () => {
      const receipt = await readPageMoveReceipt(c.env.DB, member.workspace.id, operationId);
      return !receipt || receipt.page_id !== pageId ? null : pageFromMoveReceipt(receipt, member.workspace.id, pageId);
    },
    { workspaceId: member.workspace.id, pageId, operationId, receiptReadPhase: "reconciliation" },
  );
  if (!page) {
    throw new HttpError(404, "move_not_found", "Move receipt not found.");
  }
  return c.json({ page, operationId });
});

app.post("/api/pages/:id/move-space", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"));
  requirePageEditor(page);
  const body = await jsonBody(c.req.raw);
  const spaceId = text(body.spaceId, "spaceId", 120);
  const parentId = nullableId(body.parentId, "parentId");
  const targetSpace = await spaceForMember(c.env, member, spaceId);
  if (effectiveSpaceRole(member.role, targetSpace.visibility, targetSpace.space_role) === "viewer") {
    throw new HttpError(403, "read_only", "Your role in the destination space is read-only.");
  }
  if (parentId) {
    const parent = await pageForMember(c.env, member, parentId);
    requirePageEditor(parent);
    if (parent.space_id !== spaceId) {
      throw new HttpError(422, "cross_space_parent", "The destination parent is in another space.");
    }
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
  const last = await c.env.DB.prepare(
    `SELECT position FROM pages WHERE space_id = ? AND parent_id IS ? AND archived_at IS NULL
      ORDER BY position DESC, id DESC LIMIT 1`,
  )
    .bind(spaceId, parentId)
    .first<{ position: string }>();
  const position = generateJitteredKeyBetween(last?.position ?? null, null);
  const timestamp = now();
  const subtreeSql = `WITH RECURSIVE subtree(id) AS (
    SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
  ) SELECT id FROM subtree`;
  const results = await c.env.DB.batch<PageRow>([
    c.env.DB.prepare(
      `UPDATE pages SET
         space_id = ?,
         parent_id = CASE WHEN id = ? THEN ? ELSE parent_id END,
         position = CASE WHEN id = ? THEN ? ELSE position END,
         revision = revision + 1,
         updated_at = ?
       WHERE workspace_id = ? AND id IN (${subtreeSql})`,
    ).bind(spaceId, page.id, parentId, page.id, position, timestamp, member.workspace.id, page.id),
    c.env.DB.prepare(`UPDATE page_search_v2 SET space_id = ? WHERE page_id IN (${subtreeSql})`).bind(spaceId, page.id),
    c.env.DB.prepare(`SELECT * FROM pages WHERE id IN (${subtreeSql}) ORDER BY position, id`).bind(page.id),
  ]);
  const moved = results[2]?.results.map(pageJson) ?? [];
  sendWorkspaceEvent(c, member.workspace.id, { type: "workspace-invalidated" });
  return c.json({ pages: moved });
});

app.delete("/api/pages/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireEditor(member);
  const page = await pageForMember(c.env, member, c.req.param("id"), true);
  requirePageEditor(page);
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
  requirePageEditor(page);
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
    restoredRootId: page.id,
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
       JOIN spaces s ON s.id = p.space_id
       LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
      WHERE page_search MATCH ? AND page_search.workspace_id = ? AND p.archived_at IS NULL
        AND p.import_job_id IS NULL AND p.is_template = 0
        AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
      ORDER BY bm25(page_search) LIMIT 30`,
  )
    .bind(member.user.id, match, member.workspace.id, member.role)
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
      `SELECT p.id, p.title, p.icon FROM pages p
        JOIN spaces s ON s.id = p.space_id
        LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
        WHERE p.workspace_id = ? AND p.archived_at IS NULL AND p.title LIKE ? ESCAPE '\\'
          AND p.import_job_id IS NULL AND p.is_template = 0
          AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
        ORDER BY CASE WHEN p.title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, p.title, p.id LIMIT 10`,
    )
      .bind(member.user.id, member.workspace.id, pattern, member.role, `${escapedQuery}%`)
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
  const row = await pageForMember(c.env, member, c.req.param("id"));
  return c.json({ preview: { page: pageJson(row), excerpt: (row.plain_text ?? "").slice(0, 280) } });
});

app.get("/api/pages/:id/verification", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const row = await pageForMember(c.env, member, c.req.param("id"));
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
       JOIN spaces s ON s.id = source.space_id
       LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
      WHERE reference.target_page_id = ? AND source.workspace_id = ? AND source.archived_at IS NULL
        AND source.import_job_id IS NULL AND source.is_template = 0
        AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
      ORDER BY source.updated_at DESC, source.id`,
  )
    .bind(member.user.id, page.id, member.workspace.id, member.role)
    .all<PageRow & { excerpt: string }>();
  return c.json({ backlinks: rows.results.map((row) => ({ page: pageJson(row), excerpt: row.excerpt })) });
});

app.get("/api/mentions/unread-count", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  const row = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT mention.source_page_id) count
       FROM member_mentions mention
      JOIN pages source ON source.id = mention.source_page_id AND source.archived_at IS NULL
       JOIN spaces s ON s.id = source.space_id
       LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
       LEFT JOIN mention_reads reads
         ON reads.workspace_id = mention.workspace_id AND reads.user_id = mention.target_user_id
      WHERE mention.workspace_id = ? AND mention.target_user_id = ?
        AND source.import_job_id IS NULL AND source.is_template = 0
        AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
        AND mention.first_seen_at > COALESCE(reads.read_at, 0)`,
  )
    .bind(member.user.id, member.workspace.id, member.user.id, member.role)
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
       JOIN spaces s ON s.id = source.space_id
       LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
       LEFT JOIN mention_reads reads
         ON reads.workspace_id = mention.workspace_id AND reads.user_id = mention.target_user_id
      WHERE mention.workspace_id = ? AND mention.target_user_id = ? AND mention.first_seen_at <= ?
        AND source.import_job_id IS NULL AND source.is_template = 0
        AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
        AND (? IS NULL OR mention.first_seen_at < ?
          OR (mention.first_seen_at = ? AND source.id > ?))
      ORDER BY mention.first_seen_at DESC, source.id LIMIT 101`,
  )
    .bind(
      member.user.id,
      member.workspace.id,
      member.user.id,
      asOf,
      member.role,
      beforeAt,
      beforeAt,
      beforeAt,
      beforeId ?? null,
    )
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
       JOIN spaces s ON s.id = source.space_id
       LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
       LEFT JOIN mention_reads reads
         ON reads.workspace_id = mention.workspace_id AND reads.user_id = mention.target_user_id
      WHERE mention.workspace_id = ? AND mention.target_user_id = ?
        AND source.import_job_id IS NULL AND source.is_template = 0
        AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
        AND mention.first_seen_at > COALESCE(reads.read_at, 0)`,
  )
    .bind(member.user.id, member.workspace.id, member.user.id, member.role)
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
  requirePageEditor(page);
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
      page_id: string;
      r2_key: string;
      name: string;
      mime: string;
      size: number;
    }>();
  if (!attachment) throw new HttpError(404, "attachment_not_found", "Attachment not found.");
  await pageForMember(c.env, member, attachment.page_id);
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
  const attachment = await c.env.DB.prepare(`SELECT page_id, r2_key FROM attachments WHERE id = ? AND workspace_id = ?`)
    .bind(c.req.param("id"), member.workspace.id)
    .first<{ page_id: string; r2_key: string }>();
  if (!attachment) throw new HttpError(404, "attachment_not_found", "Attachment not found.");
  const page = await pageForMember(c.env, member, attachment.page_id);
  requirePageEditor(page);
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
async function uploadSession(env: Env, member: MemberContext, uploadId: string, edit = false) {
  const session = await env.DB.prepare(
    `SELECT u.* FROM attachment_uploads u JOIN pages p ON p.id = u.page_id
      WHERE u.id = ? AND u.workspace_id = ? AND p.archived_at IS NULL`,
  )
    .bind(uploadId, member.workspace.id)
    .first<UploadSessionRow>();
  if (!session) throw new HttpError(404, "upload_session_not_found", "That upload session no longer exists.");
  const page = await pageForMember(env, member, session.page_id);
  if (edit) requirePageEditor(page);
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
  requirePageEditor(page);
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
  if (completed) {
    await pageForMember(c.env, member, completed.page_id);
    return c.json({ status: "committed", attachment: attachmentJson(completed) });
  }
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
  await uploadSession(c.env, member, c.req.param("uploadId"), true);
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
  if (completed) {
    const page = await pageForMember(c.env, member, completed.page_id);
    requirePageEditor(page);
    return c.json({ status: "committed", attachment: attachmentJson(completed), replayed: true });
  }
  let session = await uploadSession(c.env, member, uploadId, true);
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
    session = claimed ?? (await uploadSession(c.env, member, uploadId, true));
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
    session = await uploadSession(c.env, member, uploadId, true);
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
    const page = await pageForMember(c.env, member, completed.page_id);
    requirePageEditor(page);
    throw new HttpError(409, "upload_already_committed", "The upload is already an attachment and cannot be aborted.");
  }
  await uploadSession(c.env, member, c.req.param("uploadId"), true);
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
      page_id: string;
      r2_key: string;
      title: string;
      epoch: number;
      sequence: number;
    }>();
  if (!version) throw new HttpError(404, "version_not_found", "Version not found.");
  await pageForMember(c.env, member, version.page_id, true);
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
  const page = await activeTablePage(c.env, member, c.req.param("pageId"), undefined, true);
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
  const page = await activeTablePage(c.env, member, c.req.param("pageId"), undefined, true);
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
  await activeTablePage(c.env, member, c.req.param("pageId"), undefined, false, true);
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
  const page = await activeTablePage<{ next_position: number }>(
    c.env,
    member,
    c.req.param("pageId"),
    {
      columns: `, (SELECT COALESCE(MAX(position) + 1, 0) FROM table_columns WHERE page_id = p.id) next_position`,
      binds: [],
    },
    true,
  );
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
  const page = await activeTablePage<{ target_exists: number }>(
    c.env,
    member,
    c.req.param("pageId"),
    {
      columns: `, EXISTS (SELECT 1 FROM table_columns WHERE id = ? AND page_id = p.id) target_exists`,
      binds: [c.req.param("columnId")],
    },
    true,
  );
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
    true,
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
  const page = await activeTablePage<{ target_exists: number }>(
    c.env,
    member,
    c.req.param("pageId"),
    {
      columns: `, EXISTS (
        SELECT 1 FROM table_select_options option
        JOIN table_columns column ON column.id = option.column_id
        WHERE option.id = ? AND option.column_id = ? AND column.page_id = p.id
      ) target_exists`,
      binds: [c.req.param("optionId"), c.req.param("columnId")],
    },
    true,
  );
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
  }>(
    c.env,
    member,
    pageId,
    {
      columns: `, (SELECT COUNT(*) FROM table_rows WHERE page_id = p.id) row_count,
        (SELECT COALESCE(MAX(position) + 1, 0) FROM table_rows WHERE page_id = p.id) next_row_position,
        (SELECT COALESCE(MAX(position) + 1, 0) FROM table_columns WHERE page_id = p.id) next_column_position`,
      binds: [],
    },
    true,
  );
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
    true,
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
  const page = await activeTablePage<{ target_exists: number }>(
    c.env,
    member,
    c.req.param("pageId"),
    {
      columns: `, EXISTS (SELECT 1 FROM table_rows WHERE id = ? AND page_id = p.id) target_exists`,
      binds: [c.req.param("rowId")],
    },
    true,
  );
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
    true,
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
  let connectionRole: Role | null = null;
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
      connectionRole = page.effective_role ?? member.role;
    } else {
      if (!ID_PATTERN.test(candidate) || candidate !== member.workspace.id) throw roomNotFound();
      room = candidate;
      connectionRole = member.role;
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
        headers.set("x-notes-role", connectionRole ?? member.role);
        headers.set("x-notes-expires-at", String(expiresAt));
        return new Request(incoming, { headers });
      },
    });
  } catch (error) {
    // Mirrors errorResponse: expected errors carry client-facing messages, and
    // anything else is logged here (there is no Hono context yet) and answered
    // generically. The room is an opaque id, safe to log where the cookie is not.
    const { expected, status, body } = classifyError(error);
    if (!expected) {
      const party = isDocument ? "document" : "workspace-events";
      console.error(`Failed to handle ${party} party request for ${room ?? "an undecoded room"}`, {
        party,
        room: room ?? null,
        ...errorLogFields(error),
      });
    }
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
    context.waitUntil(
      pruneExpiredPageMoveReceipts(env.DB).catch((error) => {
        console.error("Failed to prune page move receipts", error);
      }),
    );
    context.waitUntil(
      recoverQueuedJobs(env).catch((error) => {
        console.error("Queued job recovery failed", error);
      }),
    );
    context.waitUntil(
      sweepOutbox(env).catch((error) => {
        console.error("Outbox sweep failed", error);
      }),
    );
    context.waitUntil(
      expireJobArtifacts(env).catch((error) => {
        console.error("Job artifact expiry failed", error);
      }),
    );
  },
  async queue(batch: MessageBatch<DeliveryQueueMessage>, env: Env) {
    await Promise.all(
      batch.messages.map(async (message) => {
        try {
          await consumeDeliveryMessage(env, message);
        } catch (error) {
          console.error("Delivery queue message failed", { messageId: message.id, attempts: message.attempts, error });
          message.retry({ delaySeconds: Math.min(300, 2 ** Math.min(message.attempts, 8)) });
        }
      }),
    );
  },
};

export { Document, NotesJobWorkflow, WorkspaceEvents };
