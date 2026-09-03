import {
  applyD1Migrations,
  abortAllDurableObjects,
  createExecutionContext,
  createScheduledController,
  env,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as Y from "yjs";
import { joinBytes } from "../shared/bytes";
import { canonicalJson, documentProjectionHash, sha256Hex, tableContentHash } from "../shared/import-integrity";
import {
  PAGE_MOVE_RECEIPT_PRUNE_BATCH_SIZE,
  PAGE_MOVE_RECEIPT_PRUNE_MAX_BATCHES,
  PAGE_MOVE_RECEIPT_VERSION,
} from "../shared/page-move";
import { TABLE_BULK_MAX_ROWS } from "../shared/table-limits";
import type { Page, TableData, TableLeaseResponse, TableLeaseTiming, WorkspaceEvent } from "../shared/types";
import { processDueUploadReaps } from "./attachments";
import { processDeletionJob } from "./cleanup";
import type { Env } from "./env";
import worker from "./index";
import { broadcastWorkspaceEvent, eventForCurrentWorkspaceState, WorkspaceEvents } from "./workspace-events";

type InstalledWorkspace = {
  cookie: string;
  pageId: string;
  userId: string;
  workspaceId: string;
};

function authenticatedRequest(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", "http://example.test");
  return new Request(`http://example.test${path}`, { ...init, headers });
}

function internalWarmupRequest() {
  return new Request("https://document.internal/noop", {
    headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
  });
}

async function bootstrap(): Promise<InstalledWorkspace> {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Test Notes",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const me = await (
    await SELF.fetch(authenticatedRequest(cookie!, "/api/me"))
  ).json<{
    user: { id: string };
    workspace: { id: string };
  }>();
  const tree = await (
    await SELF.fetch(authenticatedRequest(cookie!, "/api/pages/tree"))
  ).json<{
    pages: Array<{ id: string }>;
  }>();
  return {
    cookie: cookie!,
    pageId: tree.pages[0]!.id,
    userId: me.user.id,
    workspaceId: me.workspace.id,
  };
}

async function createPage(cookie: string, kind: "document" | "table" = "document", parentId: string | null = null) {
  const response = await SELF.fetch(
    authenticatedRequest(cookie, "/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, parentId }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json<{ page: { id: string } }>()).page;
}

async function acquireLease(cookie: string, pageId: string) {
  const response = await SELF.fetch(authenticatedRequest(cookie, `/api/tables/${pageId}/lease`, { method: "POST" }));
  expect(response.status).toBe(200);
  return response.json<TableLeaseResponse>();
}

// Seeds many rows straight into D1, batched so one call does not exceed D1's limits.
// Paging needs hundreds of rows and the row API is one lease-guarded request each.
async function seedRows(
  installed: InstalledWorkspace,
  pageId: string,
  count: number,
  cell?: { columnId: string; value: (index: number) => string | null },
) {
  const timestamp = Date.now();
  const ids: string[] = [];
  for (let start = 0; start < count; start += 50) {
    const statements: D1PreparedStatement[] = [];
    for (let index = start; index < Math.min(start + 50, count); index += 1) {
      const rowId = crypto.randomUUID();
      ids.push(rowId);
      statements.push(
        env.DB.prepare(
          `INSERT INTO table_rows (id, page_id, position, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(rowId, pageId, index, installed.userId, timestamp, timestamp),
      );
      const value = cell?.value(index);
      if (cell && value !== null && value !== undefined) {
        statements.push(
          env.DB.prepare(
            `INSERT INTO table_cells (row_id, column_id, text_value, updated_at) VALUES (?, ?, ?, ?)`,
          ).bind(rowId, cell.columnId, value, timestamp),
        );
      }
    }
    await env.DB.batch(statements);
  }
  return ids;
}

// Reads a table page, returning the parsed body either way so a test can assert on
// the error code without a second branch.
async function readTable(cookie: string, pageId: string, query = "") {
  const response = await SELF.fetch(authenticatedRequest(cookie, `/api/tables/${pageId}${query}`));
  return {
    status: response.status,
    body: await response.json<{ table: TableData; error?: { code: string } }>(),
  };
}

// Posts a bulk table write, returning the parsed body either way.
async function bulkWrite(cookie: string, pageId: string, body: Record<string, unknown>) {
  const response = await SELF.fetch(
    authenticatedRequest(cookie, `/api/tables/${pageId}/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    body: await response.json<{
      revision: number;
      replayed: boolean;
      columns: { id: string; ref: string | null; options: { id: string; label: string }[] }[];
      rows: { id: string; position: number }[];
      counts: { columns: number; options: number; rows: number; cells: number };
      error?: { code: string };
    }>(),
  };
}

function capturedWorkspaceEvents(bindings: Env, delivered: Array<{ workspaceId: string; event: WorkspaceEvent }>) {
  return {
    getByName(workspaceId: string) {
      return {
        async fetch(request: Request) {
          const event = await eventForCurrentWorkspaceState(
            bindings,
            workspaceId,
            (await request.json()) as WorkspaceEvent,
          );
          if (event) delivered.push({ workspaceId, event });
          return Response.json({ delivered: event !== null });
        },
      };
    },
  } as unknown as Env["WORKSPACE_EVENTS"];
}

function envWithCapturedWorkspaceEvents(
  bindings: Env,
  delivered: Array<{ workspaceId: string; event: WorkspaceEvent }>,
) {
  const workspaceEvents = capturedWorkspaceEvents(bindings, delivered);
  return new Proxy(bindings, {
    get(target, property, receiver) {
      if (property === "WORKSPACE_EVENTS") return workspaceEvents;
      return Reflect.get(target, property, receiver);
    },
  });
}

function envWithPageCreateBatchIntercepted(
  bindings: Env,
  delivered: Array<{ workspaceId: string; event: WorkspaceEvent }>,
  expectedPageIds: readonly string[],
  options: { hideFirstPageResult?: boolean; afterPageCreateBatch?: () => Promise<void> } = {},
) {
  const expectedIds = new Set(expectedPageIds);
  let intercepted = false;
  const database = new Proxy(bindings.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch<Record<string, unknown>>(statements);
          if (intercepted) return results;
          const pageResultIndexes = results.flatMap((result, index) =>
            result.results.some((row) => typeof row.id === "string" && expectedIds.has(row.id)) ? [index] : [],
          );
          const returnedPageIds = new Set(
            pageResultIndexes.flatMap((index) =>
              results[index]!.results.flatMap((row) =>
                typeof row.id === "string" && expectedIds.has(row.id) ? [row.id] : [],
              ),
            ),
          );
          if (expectedPageIds.some((pageId) => !returnedPageIds.has(pageId))) return results;
          intercepted = true;
          await options.afterPageCreateBatch?.();
          return options.hideFirstPageResult
            ? results.map((result, index) => (index === pageResultIndexes[0] ? { ...result, results: [] } : result))
            : results;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const eventBindings = new Proxy(bindings, {
    get(target, property, receiver) {
      if (property === "DB") return database;
      return Reflect.get(target, property, receiver);
    },
  });
  const workspaceEvents = capturedWorkspaceEvents(eventBindings, delivered);
  return {
    bindings: new Proxy(eventBindings, {
      get(target, property, receiver) {
        if (property === "WORKSPACE_EVENTS") return workspaceEvents;
        return Reflect.get(target, property, receiver);
      },
    }),
    pageCreateBatchWasIntercepted: () => intercepted,
  };
}

function envArchivingPageBeforeNextBatch(
  bindings: Env,
  pageId: string,
  options: { beforeBatch?: () => Promise<void>; failReceiptReadsAfterBatch?: boolean } = {},
) {
  let intercepted = false;
  const replayError = new Error("D1 unavailable during archive-race receipt lookup");
  const database = new Proxy(bindings.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!intercepted) {
            intercepted = true;
            await options.beforeBatch?.();
            await target
              .prepare(
                `UPDATE pages
                    SET archived_at = ?, revision = revision + 1, updated_at = ?
                  WHERE id = ?`,
              )
              .bind(Date.now(), Date.now(), pageId)
              .run();
          }
          return target.batch(statements);
        };
      }
      if (property === "prepare") {
        return (query: string) => {
          if (intercepted && options.failReceiptReadsAfterBatch && query.includes("FROM page_move_receipts")) {
            throw replayError;
          }
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    replayError,
    bindings: new Proxy(bindings, {
      get(target, property, receiver) {
        if (property === "DB") return database;
        return Reflect.get(target, property, receiver);
      },
    }),
    moveBatchWasIntercepted: () => intercepted,
  };
}

function envFailingMoveBatchAndReplay(bindings: Env) {
  const batchError = new Error("D1 move batch failed");
  const replayError = new Error("D1 move receipt lookup failed");
  let batchFailed = false;
  const database = new Proxy(bindings.DB, {
    get(target, property) {
      if (property === "batch") {
        return async () => {
          batchFailed = true;
          throw batchError;
        };
      }
      if (property === "prepare") {
        return (query: string) => {
          if (batchFailed && query.includes("FROM page_move_receipts")) throw replayError;
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    batchError,
    replayError,
    bindings: new Proxy(bindings, {
      get(target, property, receiver) {
        if (property === "DB") return database;
        return Reflect.get(target, property, receiver);
      },
    }),
  };
}

function envFailingPageMoveReceiptReads(bindings: Env) {
  const receiptError = new Error("D1 move receipt lookup failed");
  const database = new Proxy(bindings.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          if (query.includes("FROM page_move_receipts")) throw receiptError;
          return target.prepare(query);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    receiptError,
    bindings: new Proxy(bindings, {
      get(target, property, receiver) {
        if (property === "DB") return database;
        return Reflect.get(target, property, receiver);
      },
    }),
  };
}

function envRejectingNextBatchAfterCommit(
  bindings: Env,
  delivered: Array<{ workspaceId: string; event: WorkspaceEvent }>,
  afterCommit?: () => Promise<void>,
) {
  let intercepted = false;
  const database = new Proxy(bindings.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          if (!intercepted) {
            intercepted = true;
            await afterCommit?.();
            throw new Error("D1 response lost after commit");
          }
          return results;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const eventBindings = new Proxy(bindings, {
    get(target, property, receiver) {
      if (property === "DB") return database;
      return Reflect.get(target, property, receiver);
    },
  });
  const workspaceEvents = capturedWorkspaceEvents(eventBindings, delivered);
  return {
    bindings: new Proxy(eventBindings, {
      get(target, property, receiver) {
        if (property === "WORKSPACE_EVENTS") return workspaceEvents;
        return Reflect.get(target, property, receiver);
      },
    }),
    moveBatchWasIntercepted: () => intercepted,
  };
}

const MIB = 1024 * 1024;

async function initUpload(cookie: string, pageId: string, body: Record<string, unknown>) {
  const response = await SELF.fetch(
    authenticatedRequest(cookie, `/api/pages/${pageId}/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    body: await response.json<{
      upload: { id: string; partSize: number; partCount: number };
      error?: { code: string };
    }>(),
  };
}

// Parts are built as ArrayBuffers so the request body needs no view-to-buffer dance.
function filledBytes(length: number, value = 0) {
  const buffer = new ArrayBuffer(length);
  new Uint8Array(buffer).fill(value);
  return buffer;
}

async function putUploadPart(cookie: string, uploadId: string, partNumber: number, bytes: ArrayBuffer) {
  const response = await SELF.fetch(
    authenticatedRequest(cookie, `/api/uploads/${uploadId}/parts/${partNumber}`, {
      method: "PUT",
      body: bytes,
    }),
  );
  return { status: response.status, body: await response.json<{ error?: { code: string } }>() };
}

async function completeUpload(cookie: string, uploadId: string) {
  const response = await SELF.fetch(
    authenticatedRequest(cookie, `/api/uploads/${uploadId}/complete`, { method: "POST" }),
  );
  return {
    status: response.status,
    body: await response.json<{ attachment: { id: string; size: number }; error?: { code: string } }>(),
  };
}

type TableSeed = { column?: "text" | "select"; option?: string; row?: boolean };

// Seeds table structure straight into D1, bypassing the lease-guarded API, so a
// test can start from a populated table without acquiring a lease first. Ids are
// generated for every part; only the requested parts are inserted.
async function seedTable(installed: InstalledWorkspace, pageId: string, seed: TableSeed) {
  const columnId = crypto.randomUUID();
  const rowId = crypto.randomUUID();
  const optionId = crypto.randomUUID();
  const timestamp = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (seed.column) {
    statements.push(
      env.DB.prepare(`INSERT INTO table_columns (id, page_id, name, type, position) VALUES (?, ?, ?, ?, 0)`).bind(
        columnId,
        pageId,
        seed.column === "select" ? "Choice" : "Text",
        seed.column,
      ),
    );
  }
  if (seed.option) {
    statements.push(
      env.DB.prepare(`INSERT INTO table_select_options (id, column_id, label, position) VALUES (?, ?, ?, 0)`).bind(
        optionId,
        columnId,
        seed.option,
      ),
    );
  }
  if (seed.row) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO table_rows (id, page_id, position, created_by, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)`,
      ).bind(rowId, pageId, installed.userId, timestamp, timestamp),
    );
  }
  await env.DB.batch(statements);
  return { columnId, rowId, optionId };
}

type TestDocument = {
  document: Y.Doc;
  onStart(): Promise<void>;
  onAlarm(): Promise<void>;
  onSave(): Promise<void>;
  onRequest(request: Request): Promise<Response>;
  compact(forceVersion?: boolean): Promise<void>;
  restoreVersion(versionId: string, userId: string): Promise<Response>;
  finishTransition(): Promise<void>;
  scheduleAlarm(when: number): Promise<void>;
  deferAlarm(when: number): Promise<void>;
  flushPendingUpdates(): void;
  transition: "archive" | "restore" | null;
  transitionAlarmDeferred: boolean;
  transitionRetryAt: number | null;
  getConnections(): Array<{ close(code: number, reason: string): void }>;
  bindings: Cloudflare.Env;
  metadata: { retired: number; restore_pending: number; restore_attempts: number; restore_retry_at: number };
};

// The reconciliation backoff is persisted and gates onAlarm, so a test that
// drives consecutive attempts through the alarm has to stand in for the quiet
// period elapsing between them.
function elapseRestoreBackoff(document: TestDocument, state: DurableObjectState) {
  state.storage.sql.exec(`UPDATE document_meta SET restore_retry_at = 0 WHERE id = 1`);
  document.metadata.restore_retry_at = 0;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

async function clearWorkerDatabase() {
  // pool-workers 0.22 does not currently clear D1 rows when reset() is called from
  // this long shared integration file. Keep schemas/migration history and remove the
  // two application roots explicitly; their foreign-key cascades cover every child.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM install_state`),
    env.DB.prepare(`DELETE FROM page_search`),
    env.DB.prepare(`DELETE FROM workspaces`),
    env.DB.prepare(`DELETE FROM verification`),
    env.DB.prepare(`DELETE FROM user`),
  ]);
}

afterEach(async () => {
  // reset() clears persisted bindings, but it does not evict an instantiated Durable
  // Object. Evict after the test has drained so appended tests cannot retain its
  // in-memory document state or recreate rows after the next reset.
  await abortAllDurableObjects();
  await clearWorkerDatabase();
  await reset();
});

describe("Worker integration", () => {
  it("reports a healthy empty installation", async () => {
    const [health, install] = await Promise.all([
      SELF.fetch("http://example.test/api/health"),
      SELF.fetch("http://example.test/api/install"),
    ]);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, version: "0.1.0" });
    expect(await install.json()).toEqual({ initialized: false });
  });

  it("blocks the raw Better Auth registration endpoint", async () => {
    const response = await SELF.fetch("http://example.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin: "http://example.test", "content-type": "application/json" },
      body: JSON.stringify({ name: "Bypass", email: "bypass@example.test", password: "password123" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "registration_closed", message: "Use the bootstrap screen or an invite to register." },
    });
    const count = await env.DB.prepare(`SELECT COUNT(*) count FROM user`).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("uses the shared JSON envelope for missing API routes", async () => {
    const response = await SELF.fetch("http://example.test/api/not-real");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "not_found", message: "API route not found." } });
  });

  it("keeps client-facing party request errors unlogged with their own message", async () => {
    const installed = await bootstrap();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const stale = await SELF.fetch(
        authenticatedRequest(installed.cookie, `/parties/document/${installed.pageId}~999`),
      );
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({
        error: { code: "stale_epoch", message: "Reload this page to connect to its current document version." },
      });
      const wrongRoom = await SELF.fetch(authenticatedRequest(installed.cookie, "/parties/workspace-events/other"));
      expect(wrongRoom.status).toBe(404);
      expect(await wrongRoom.json()).toEqual({
        error: { code: "room_not_found", message: "Workspace event room not found." },
      });
      // A percent escape never appears in a canonical room, so a malformed one
      // fails the room pattern. It is client input that can never name a room,
      // so it answers like any other unknown room rather than as an internal
      // failure.
      const malformed = await SELF.fetch(authenticatedRequest(installed.cookie, "/parties/document/%E0%A4%A"));
      expect(malformed.status).toBe(404);
      expect(await malformed.json()).toEqual({
        error: { code: "room_not_found", message: "Document room not found." },
      });
      const malformedWorkspace = await SELF.fetch(
        authenticatedRequest(installed.cookie, "/parties/workspace-events/%E0%A4%A"),
      );
      expect(malformedWorkspace.status).toBe(404);
      expect(await malformedWorkspace.json()).toEqual({
        error: { code: "room_not_found", message: "Workspace event room not found." },
      });
      // An oversized room is rejected on its shape, not by failing a lookup.
      const oversized = await SELF.fetch(
        authenticatedRequest(installed.cookie, `/parties/document/${"p".repeat(101)}~1`),
      );
      expect(oversized.status).toBe(404);
      expect(await oversized.json()).toEqual({
        error: { code: "room_not_found", message: "Document room not found." },
      });
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("rejects room names that authorize as a page but address a different Durable Object", async () => {
    const installed = await bootstrap();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // PartyServer hashes the raw pathname segment into the Durable Object
      // name. Every epoch below coerces to the page's real epoch of 1 through
      // Number, so accepting any of them would let one page fork into rooms
      // that compact to a single R2 key and overwrite each other.
      for (const epoch of ["01", "0001", "1e0", "1.0", "1.", "+1", "0x1", " 1", "1 "]) {
        const aliased = await SELF.fetch(
          authenticatedRequest(installed.cookie, `/parties/document/${installed.pageId}~${encodeURIComponent(epoch)}`),
        );
        expect(aliased.status, `epoch ${JSON.stringify(epoch)}`).toBe(404);
        expect(await aliased.json()).toEqual({
          error: { code: "room_not_found", message: "Document room not found." },
        });
      }

      // An empty epoch is Number("") === 0, which passed the old integer check
      // on shape and was caught only by the epoch comparison behind a D1 read.
      const emptyEpoch = await SELF.fetch(
        authenticatedRequest(installed.cookie, `/parties/document/${installed.pageId}~`),
      );
      expect(emptyEpoch.status).toBe(404);

      // An encoded page id decodes to an authorized page but routes to a room
      // whose own name parses back to a different id, so it would never reach
      // the page it authorized against.
      const encodedPageId = `%${installed.pageId.charCodeAt(0).toString(16)}${installed.pageId.slice(1)}`;
      const encoded = await SELF.fetch(authenticatedRequest(installed.cookie, `/parties/document/${encodedPageId}~1`));
      expect(encoded.status).toBe(404);

      // An encoded separator leaves the routed name with no "~" at all.
      const encodedSeparator = await SELF.fetch(
        authenticatedRequest(installed.cookie, `/parties/document/${installed.pageId}%7E1`),
      );
      expect(encodedSeparator.status).toBe(404);

      // Leading zeros are unbounded under Number, and Cloudflare stops exposing
      // ctx.id.name past 1,024 bytes, which strands PartyServer's initialization
      // and turns an authenticated request into a 500 with a stack trace.
      const longEpoch = await SELF.fetch(
        authenticatedRequest(installed.cookie, `/parties/document/${installed.pageId}~${"0".repeat(2000)}1`),
      );
      expect(longEpoch.status).toBe(404);

      // An encoded workspace id would authorize but join a room nobody
      // broadcasts into, silently dropping every live update.
      const encodedWorkspace = await SELF.fetch(
        authenticatedRequest(
          installed.cookie,
          `/parties/workspace-events/%${installed.workspaceId.charCodeAt(0).toString(16)}${installed.workspaceId.slice(1)}`,
        ),
      );
      expect(encodedWorkspace.status).toBe(404);

      // None of the above is a server fault, so none of them logs.
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("logs unexpected party request failures against a bounded room and answers them generically", async () => {
    const installed = await bootstrap();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // A real dependency failure, reached only after the room shape checks, so
      // the log names a validated id rather than whatever path was supplied.
      await env.DB.exec("ALTER TABLE pages RENAME TO pages_offline");
      const response = await SELF.fetch(
        authenticatedRequest(installed.cookie, `/parties/document/${installed.pageId}~1`),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: { code: "internal_error", message: "Something went wrong." },
      });
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]![0]).toBe(`Failed to handle document party request for ${installed.pageId}~1`);
      // The same broken dependency cannot be reached by an unbounded room, so
      // no arbitrary path can ride into that log line.
      const oversized = await SELF.fetch(
        authenticatedRequest(installed.cookie, `/parties/document/${"p".repeat(101)}~1`),
      );
      expect(oversized.status).toBe(404);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it("serves all byte-range forms and conditionally revalidates private attachments", async () => {
    const installed = await bootstrap();
    const form = new FormData();
    form.set("file", new File(["0123456789"], "sample.txt", { type: "text/plain" }));
    const upload = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/attachments`, {
        method: "POST",
        body: form,
      }),
    );
    expect(upload.status).toBe(201);
    const attachmentId = (await upload.json<{ attachment: { id: string } }>()).attachment.id;
    const path = `/api/attachments/${attachmentId}`;

    const normal = await SELF.fetch(authenticatedRequest(installed.cookie, path));
    expect(normal.status).toBe(200);
    expect(await normal.text()).toBe("0123456789");
    expect(normal.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    const etag = normal.headers.get("etag");
    expect(etag).toBeTruthy();
    await env.DB.prepare(`UPDATE attachments SET size = 999 WHERE id = ?`).bind(attachmentId).run();

    for (const [range, contentRange, body] of [
      ["bytes=2-5", "bytes 2-5/10", "2345"],
      ["bytes=6-", "bytes 6-9/10", "6789"],
      ["bytes=-3", "bytes 7-9/10", "789"],
      ["bytes=-500", "bytes 0-9/10", "0123456789"],
    ] as const) {
      const response = await SELF.fetch(
        authenticatedRequest(installed.cookie, path, {
          headers: { range },
        }),
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(contentRange);
      expect(response.headers.get("content-length")).toBe(String(body.length));
      expect(await response.text()).toBe(body);
    }

    const unchanged = await SELF.fetch(
      authenticatedRequest(installed.cookie, path, {
        headers: { "if-none-match": etag! },
      }),
    );
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("etag")).toBe(etag);

    const unchangedSince = await SELF.fetch(
      authenticatedRequest(installed.cookie, path, {
        headers: { "if-modified-since": new Date(Date.now() + 60_000).toUTCString() },
      }),
    );
    expect(unchangedSince.status).toBe(304);
    expect(await unchangedSince.text()).toBe("");

    const changed = await SELF.fetch(
      authenticatedRequest(installed.cookie, path, {
        headers: { "if-none-match": '"not-this-object"' },
      }),
    );
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe("0123456789");

    const failedPrecondition = await SELF.fetch(
      authenticatedRequest(installed.cookie, path, {
        headers: { "if-match": '"not-this-object"', "if-none-match": etag! },
      }),
    );
    expect(failedPrecondition.status).toBe(412);
    expect(await failedPrecondition.text()).toBe("");
  });

  it("rejects malformed core workspace events and drops malformed advisory ids", async () => {
    const installed = await bootstrap();
    const stub = env.WORKSPACE_EVENTS.getByName(installed.workspaceId);
    const malformed = await stub.fetch(
      new Request("https://workspace-events.internal/broadcast", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-notes-internal": env.BETTER_AUTH_SECRET,
          "x-notes-workspace-id": installed.workspaceId,
        },
        body: JSON.stringify({ type: "pages-removed", permanently: false }),
      }),
    );
    expect(malformed.status).toBe(400);

    await env.DB.prepare("UPDATE pages SET archived_at = ? WHERE id = ?").bind(Date.now(), installed.pageId).run();
    const validOperation = await stub.fetch(
      new Request("https://workspace-events.internal/broadcast", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-notes-internal": env.BETTER_AUTH_SECRET,
          // The Durable Object must use its own name, not this untrusted hint.
          "x-notes-workspace-id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          type: "pages-removed",
          pageIds: [installed.pageId],
          permanently: false,
          operationId: "archive-operation",
        }),
      }),
    );
    expect(validOperation.status).toBe(200);

    await runInDurableObject(stub, async (instance) => {
      const delivered: string[] = [];
      const workspaceEvents = instance as WorkspaceEvents;
      const broadcast = vi
        .spyOn(workspaceEvents, "broadcastCustomMessage")
        .mockImplementation((message) => void delivered.push(message));
      try {
        const invalidOperation = await workspaceEvents.onRequest(
          new Request("https://workspace-events.internal/broadcast", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-notes-internal": env.BETTER_AUTH_SECRET,
              "x-notes-workspace-id": installed.workspaceId,
            },
            body: JSON.stringify({
              type: "pages-removed",
              pageIds: [installed.pageId],
              permanently: false,
              operationId: "invalid/operation",
            }),
          }),
        );

        expect(invalidOperation.status).toBe(200);
        expect(delivered.map((message) => JSON.parse(message))).toEqual([
          { type: "pages-removed", pageIds: [installed.pageId], permanently: false },
        ]);
      } finally {
        broadcast.mockRestore();
      }
    });
  });

  it("strips undeclared properties before broadcasting workspace events", async () => {
    const installed = await bootstrap();
    const stub = env.WORKSPACE_EVENTS.getByName(installed.workspaceId);
    const eventPage = {
      ...(await (await SELF.fetch(authenticatedRequest(installed.cookie, "/api/pages/tree"))).json<{ pages: Page[] }>())
        .pages[0]!,
      privateDiagnostic: "do not broadcast",
    };
    const { privateDiagnostic: _privateDiagnostic, ...expectedPage } = eventPage;

    await runInDurableObject(stub, async (instance) => {
      const delivered: string[] = [];
      const workspaceEvents = instance as WorkspaceEvents;
      const broadcast = vi
        .spyOn(workspaceEvents, "broadcastCustomMessage")
        .mockImplementation((message) => void delivered.push(message));
      const request = (body: unknown) =>
        workspaceEvents.onRequest(
          new Request("https://workspace-events.internal/broadcast", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-notes-internal": env.BETTER_AUTH_SECRET,
              "x-notes-workspace-id": installed.workspaceId,
            },
            body: JSON.stringify(body),
          }),
        );

      try {
        expect(
          (
            await request({
              type: "pages-upserted",
              pages: [eventPage],
              restored: true,
              restoredRootId: installed.pageId,
              internalTrace: "trace",
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await request({
              type: "projection-updated",
              pageId: installed.pageId,
              backlinkTargetIds: ["backlink"],
              mentionTargetUserIds: [installed.userId],
              internalTrace: "trace",
            })
          ).status,
        ).toBe(200);

        expect(delivered.map((message) => JSON.parse(message))).toEqual([
          {
            type: "pages-upserted",
            pages: [expectedPage],
            restored: true,
            restoredRootId: installed.pageId,
          },
          {
            type: "projection-updated",
            pageId: installed.pageId,
            backlinkTargetIds: ["backlink"],
            mentionTargetUserIds: [installed.userId],
          },
        ]);
      } finally {
        broadcast.mockRestore();
      }
    });
  });

  it("does not retry an ambiguous thrown workspace-event delivery", async () => {
    const workspaceId = crypto.randomUUID();
    const overloaded = Object.assign(new Error("Durable Object is overloaded."), {
      overloaded: true,
      retryable: true,
    });
    let stubs = 0;
    const workspaceEvents = {
      getByName() {
        stubs += 1;
        return { fetch: async () => Promise.reject(overloaded) };
      },
    } as unknown as Env["WORKSPACE_EVENTS"];
    const bindings = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "WORKSPACE_EVENTS") return workspaceEvents;
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(
      broadcastWorkspaceEvent(bindings, workspaceId, {
        type: "pages-removed",
        pageIds: [crypto.randomUUID()],
        permanently: false,
      }),
    ).rejects.toBe(overloaded);
    expect(stubs).toBe(1);
  });

  it("reports an accepted workspace-event delivery that was deferred to resync", async () => {
    const workspaceId = crypto.randomUUID();
    const workspaceEvents = {
      getByName() {
        return {
          fetch: async () => Response.json({ delivered: false, resyncScheduled: true }, { status: 202 }),
        };
      },
    } as unknown as Env["WORKSPACE_EVENTS"];
    const bindings = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "WORKSPACE_EVENTS") return workspaceEvents;
        return Reflect.get(target, property, receiver);
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await broadcastWorkspaceEvent(bindings, workspaceId, {
        type: "pages-removed",
        pageIds: [crypto.randomUUID()],
        permanently: false,
      });

      expect(warn).toHaveBeenCalledWith("Workspace event delivery deferred to an authoritative resync.", {
        workspaceId,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("collapses an overflowing lifecycle queue into one workspace invalidation", async () => {
    const installed = await bootstrap();
    const stub = env.WORKSPACE_EVENTS.getByName(installed.workspaceId);
    const activePage = (
      await (await SELF.fetch(authenticatedRequest(installed.cookie, "/api/pages/tree"))).json<{ pages: Page[] }>()
    ).pages[0]!;

    await runInDurableObject(stub, async (instance) => {
      const delivered: WorkspaceEvent[] = [];
      const workspaceEvents = instance as WorkspaceEvents;
      const broadcast = vi
        .spyOn(workspaceEvents, "broadcastCustomMessage")
        .mockImplementation((message) => void delivered.push(JSON.parse(message) as WorkspaceEvent));
      const close = vi.fn();
      const testEvents = workspaceEvents as unknown as {
        getConnections(): Array<{ close(code: number, reason: string): void }>;
        queuedDeliveries: number;
      };
      const originalGetConnections = testEvents.getConnections;
      testEvents.getConnections = () => [{ close }];
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const request = () =>
        workspaceEvents.onRequest(
          new Request("https://workspace-events.internal/broadcast", {
            method: "POST",
            headers: { "content-type": "application/json", "x-notes-internal": env.BETTER_AUTH_SECRET },
            body: JSON.stringify({ type: "pages-upserted", pages: [activePage] }),
          }),
        );

      try {
        testEvents.queuedDeliveries = 128;
        const overflow = await request();
        expect(overflow.status).toBe(202);
        expect(await overflow.json()).toEqual({ delivered: false, resyncScheduled: true });

        testEvents.queuedDeliveries = 0;
        expect((await request()).status).toBe(200);
        expect(delivered).toEqual([{ type: "pages-upserted", pages: [activePage] }, { type: "workspace-invalidated" }]);
        expect(warn).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledWith(1012, "Workspace refresh required.");
      } finally {
        warn.mockRestore();
        testEvents.getConnections = originalGetConnections;
        broadcast.mockRestore();
      }
    });
  });

  it("falls back to workspace invalidation when a lifecycle state check fails", async () => {
    const installed = await bootstrap();
    const stub = env.WORKSPACE_EVENTS.getByName(installed.workspaceId);
    const activePage = (
      await (await SELF.fetch(authenticatedRequest(installed.cookie, "/api/pages/tree"))).json<{ pages: Page[] }>()
    ).pages[0]!;

    await runInDurableObject(stub, async (instance) => {
      const delivered: WorkspaceEvent[] = [];
      const workspaceEvents = instance as WorkspaceEvents;
      const broadcast = vi
        .spyOn(workspaceEvents, "broadcastCustomMessage")
        .mockImplementation((message) => void delivered.push(JSON.parse(message) as WorkspaceEvent));
      const close = vi.fn();
      const failure = new Error("D1 unavailable");
      const testEvents = workspaceEvents as unknown as {
        bindings: Env;
        getConnections(): Array<{ close(code: number, reason: string): void }>;
      };
      const originalBindings = testEvents.bindings;
      const originalGetConnections = testEvents.getConnections;
      testEvents.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "DB") {
            return new Proxy(target.DB, {
              get(database, databaseProperty, databaseReceiver) {
                if (databaseProperty === "prepare") {
                  return () => {
                    throw failure;
                  };
                }
                return Reflect.get(database, databaseProperty, databaseReceiver);
              },
            });
          }
          return Reflect.get(target, property, receiver);
        },
      });
      testEvents.getConnections = () => [{ close }];
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      try {
        const response = await workspaceEvents.onRequest(
          new Request("https://workspace-events.internal/broadcast", {
            method: "POST",
            headers: { "content-type": "application/json", "x-notes-internal": env.BETTER_AUTH_SECRET },
            body: JSON.stringify({ type: "pages-upserted", pages: [activePage] }),
          }),
        );

        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ delivered: false, resyncScheduled: true });
        expect(delivered).toEqual([{ type: "workspace-invalidated" }]);
        expect(close).toHaveBeenCalledWith(1012, "Workspace refresh required.");
        expect(error).toHaveBeenCalledWith("Workspace event state check failed; scheduling workspace invalidation.", {
          workspaceId: installed.workspaceId,
          error: failure,
        });
      } finally {
        error.mockRestore();
        testEvents.getConnections = originalGetConnections;
        testEvents.bindings = originalBindings;
        broadcast.mockRestore();
      }
    });
  });

  it("filters serialized page lifecycle events against the current workspace state", async () => {
    const installed = await bootstrap();
    await createPage(installed.cookie, "document", installed.pageId);
    const stub = env.WORKSPACE_EVENTS.getByName(installed.workspaceId);
    const activePages = (
      await (await SELF.fetch(authenticatedRequest(installed.cookie, "/api/pages/tree"))).json<{ pages: Page[] }>()
    ).pages;
    const activePage = activePages.find((page) => page.id === installed.pageId)!;
    const activeChild = activePages.find((page) => page.parentId === installed.pageId)!;

    await runInDurableObject(stub, async (instance) => {
      const delivered: WorkspaceEvent[] = [];
      const workspaceEvents = instance as WorkspaceEvents;
      const broadcast = vi
        .spyOn(workspaceEvents, "broadcastCustomMessage")
        .mockImplementation((message) => void delivered.push(JSON.parse(message) as WorkspaceEvent));
      const request = (event: WorkspaceEvent) =>
        workspaceEvents.onRequest(
          new Request("https://workspace-events.internal/broadcast", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-notes-internal": env.BETTER_AUTH_SECRET,
              "x-notes-workspace-id": installed.workspaceId,
            },
            body: JSON.stringify(event),
          }),
        );

      try {
        await env.DB.prepare("UPDATE pages SET archived_at = ? WHERE id = ?").bind(Date.now(), installed.pageId).run();
        const archivedResponses = await Promise.all([
          request({ type: "pages-upserted", pages: [activePage] }),
          request({ type: "pages-removed", pageIds: [installed.pageId], permanently: false }),
        ]);
        expect(await Promise.all(archivedResponses.map((response) => response.json()))).toEqual([
          { delivered: true },
          { delivered: true },
        ]);

        await env.DB.prepare("UPDATE pages SET archived_at = NULL WHERE id = ?").bind(installed.pageId).run();
        const activeResponses = await Promise.all([
          request({ type: "pages-removed", pageIds: [installed.pageId], permanently: false }),
          request({ type: "pages-upserted", pages: [activePage] }),
        ]);
        expect(await Promise.all(activeResponses.map((response) => response.json()))).toEqual([
          { delivered: false },
          { delivered: true },
        ]);
        const premature = await request({
          type: "pages-upserted",
          pages: [{ ...activePage, revision: activePage.revision + 1 }],
        });
        expect(await premature.json()).toEqual({ delivered: true });
        await env.DB.prepare("UPDATE pages SET revision = revision + 1 WHERE id = ?").bind(installed.pageId).run();
        const supersededActivePage = { ...activePage, revision: activePage.revision + 1 };
        const superseded = await request({
          type: "pages-upserted",
          pages: [activePage, activeChild],
          restored: true,
          restoredRootId: activePage.id,
        });
        expect(await superseded.json()).toEqual({ delivered: true });
        expect(delivered).toEqual([
          { type: "workspace-invalidated" },
          { type: "pages-removed", pageIds: [installed.pageId], permanently: false },
          { type: "pages-upserted", pages: [activePage] },
          { type: "workspace-invalidated" },
          {
            type: "pages-upserted",
            pages: [supersededActivePage, activeChild],
            restored: true,
            restoredRootId: activePage.id,
          },
        ]);
      } finally {
        broadcast.mockRestore();
      }
    });
  });

  it("allows JSON uploads, rejects executable extensions, and ignores punctuation-only search terms", async () => {
    const installed = await bootstrap();
    const jsonForm = new FormData();
    jsonForm.set("file", new File(["{}"], "settings.json", { type: "application/json" }));
    expect(
      (
        await SELF.fetch(
          authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/attachments`, {
            method: "POST",
            body: jsonForm,
          }),
        )
      ).status,
    ).toBe(201);

    const scriptForm = new FormData();
    scriptForm.set("file", new File(["alert(1)"], "payload.js", { type: "application/octet-stream" }));
    expect(
      (
        await SELF.fetch(
          authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/attachments`, {
            method: "POST",
            body: scriptForm,
          }),
        )
      ).status,
    ).toBe(415);

    const renamed = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "JSON Guide", revision: 1 }),
      }),
    );
    expect(renamed.status).toBe(200);
    const search = await SELF.fetch(authenticatedRequest(installed.cookie, "/api/search?q=JSON%20!!!"));
    expect(
      (await search.json<{ results: Array<{ page: { id: string } }> }>()).results.map((item) => item.page.id),
    ).toContain(installed.pageId);
    expect((await SELF.fetch(authenticatedRequest(installed.cookie, "/api/search?q=!!!"))).status).toBe(200);

    const backslashTitle = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Back\\Slash", revision: 2 }),
      }),
    );
    expect(backslashTitle.status).toBe(200);
    const suggestions = await (
      await SELF.fetch(
        authenticatedRequest(installed.cookie, `/api/mentions/suggestions?q=${encodeURIComponent("Back\\")}`),
      )
    ).json<{ suggestions: Array<{ entityId: string }> }>();
    expect(suggestions.suggestions.map((item) => item.entityId)).toContain(installed.pageId);
  });

  it("replays a deterministic single-shot attachment and rejects changed metadata", async () => {
    const installed = await bootstrap();
    const attachmentId = crypto.randomUUID();
    const contentSha256 = await sha256Hex("same bytes");
    const upload = async (name = "stable.txt") => {
      const requestHash = await sha256Hex(
        canonicalJson({
          attachmentId,
          pageId: installed.pageId,
          name,
          mime: "text/plain",
          size: 10,
          contentSha256,
        }),
      );
      const form = new FormData();
      form.set("file", new File(["same bytes"], name, { type: "text/plain" }));
      form.set("attachmentId", attachmentId);
      form.set("contentSha256", contentSha256);
      form.set("requestHash", requestHash);
      return SELF.fetch(
        authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/attachments`, {
          method: "POST",
          body: form,
        }),
      );
    };
    const first = await upload();
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ replayed: false, attachment: { id: attachmentId, contentSha256 } });
    const replay = await upload();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, attachment: { id: attachmentId } });
    const mismatch = await upload("renamed.txt");
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json<{ error: { code: string } }>()).error.code).toBe("idempotency_key_reused");
  });

  it("accepts a redundant invite for an existing workspace member without failing the membership constraint", async () => {
    const installed = await bootstrap();
    const inviteResponse = await SELF.fetch(
      authenticatedRequest(installed.cookie, "/api/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "viewer" }),
      }),
    );
    const invite = await inviteResponse.json<{ invite: { id: string; token: string } }>();
    const accepted = await SELF.fetch("http://example.test/api/invites/accept", {
      method: "POST",
      headers: { origin: "http://example.test", "content-type": "application/json" },
      body: JSON.stringify({
        token: invite.invite.token,
        email: "owner@example.test",
        password: "password123",
      }),
    });
    expect(accepted.status).toBe(200);
    expect(
      (
        await env.DB.prepare(`SELECT COUNT(*) count FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
          .bind(installed.workspaceId, installed.userId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      (
        await env.DB.prepare(`SELECT used_at FROM invites WHERE id = ?`)
          .bind(invite.invite.id)
          .first<{ used_at: number | null }>()
      )?.used_at,
    ).toBeNull();
  });

  it("coalesces document updates and never reuses a drained sequence", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const content = document.document.getMap<number>("test-content");
      content.set("first", 1);
      content.set("second", 2);
      await document.onSave();

      const events = state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM update_events ORDER BY seq`).toArray();
      expect(events).toHaveLength(1);
      const chunks = state.storage.sql
        .exec<{ data: ArrayBuffer }>(
          `SELECT data FROM update_chunks WHERE seq = ? ORDER BY chunk_index`,
          events[0]!.seq,
        )
        .toArray();
      const replica = new Y.Doc();
      Y.applyUpdate(replica, joinBytes(chunks.map((chunk) => new Uint8Array(chunk.data))));
      expect(replica.getMap("test-content").toJSON()).toEqual({ first: 1, second: 2 });
      replica.destroy();

      await document.compact();
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM update_events`).one().count).toBe(0);

      content.set("third", 3);
      await document.onSave();
      const next = state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM update_events`).one().seq;
      expect(next).toBeGreaterThan(events[0]!.seq);
    });
  });

  it("retires newly-created room state when its page no longer exists", async () => {
    const stub = env.DOCUMENT.getByName(`${crypto.randomUUID()}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql.exec<{ retired: number }>(`SELECT retired FROM document_meta WHERE id = 1`).one().retired,
      ).toBe(1);
    });
  });

  it("validates a restore before closing collaborators", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const close = vi.fn();
      const originalGetConnections = document.getConnections;
      document.getConnections = () => [{ close }];
      try {
        const response = await document.restoreVersion(crypto.randomUUID(), installed.userId);

        expect(response.status).toBe(404);
        expect(close).not.toHaveBeenCalled();
        expect(document.transition).toBeNull();
      } finally {
        document.getConnections = originalGetConnections;
      }
    });
  });

  it("claims archive validation before awaiting D1", async () => {
    const installed = await bootstrap();
    await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), installed.pageId).run();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const originalBindings = document.bindings;
      let releaseLookup!: () => void;
      let markLookupStarted!: () => void;
      const lookupGate = new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      const lookupStarted = new Promise<void>((resolve) => {
        markLookupStarted = resolve;
      });
      const database = new Proxy(originalBindings.DB, {
        get(target, property, receiver) {
          if (property !== "prepare") return Reflect.get(target, property, receiver);
          return (query: string) => {
            const statement = target.prepare(query);
            if (!query.includes("SELECT content_epoch, archived_at FROM pages")) return statement;
            return {
              bind: (...args: unknown[]) => {
                const bound = statement.bind(...args);
                return {
                  first: async <T>() => {
                    markLookupStarted();
                    await lookupGate;
                    return bound.first<T>();
                  },
                };
              },
            };
          };
        },
      });
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "DB") return database;
          return Reflect.get(target, property, receiver);
        },
      });

      const request = () =>
        new Request("https://document.internal/archive", {
          method: "POST",
          headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
        });
      try {
        const first = document.onRequest(request());
        await lookupStarted;
        expect((await document.onRequest(request())).status).toBe(409);
        expect((await document.restoreVersion(crypto.randomUUID(), installed.userId)).status).toBe(409);
        releaseLookup();
        expect((await first).status).toBe(200);
      } finally {
        document.bindings = originalBindings;
        releaseLookup();
      }
    });
  });

  it("releases an archive transition when flushing storage fails", async () => {
    const installed = await bootstrap();
    await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), installed.pageId).run();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const originalFlush = document.flushPendingUpdates;
      document.flushPendingUpdates = () => {
        throw new Error("storage unavailable");
      };
      try {
        await expect(
          document.onRequest(
            new Request("https://document.internal/archive", {
              method: "POST",
              headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
            }),
          ),
        ).rejects.toThrow("storage unavailable");
      } finally {
        document.flushPendingUpdates = originalFlush;
      }
      const retried = await document.onRequest(
        new Request("https://document.internal/archive", {
          method: "POST",
          headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
        }),
      );
      expect(retried.status).toBe(200);
    });
  });

  it("preserves updates and alarms that arrive while compaction is awaiting storage", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const content = document.document.getMap<number>("race-content");
      content.set("before", 1);
      await document.onSave();
      const capturedSequence = state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM update_events`).one().seq;

      const compacting = document.compact();
      content.set("during", 2);
      await document.onSave();
      await compacting;

      const meta = state.storage.sql
        .exec<{ dirty: number; snapshot_seq: number }>(`SELECT dirty, snapshot_seq FROM document_meta WHERE id = 1`)
        .one();
      const remaining = state.storage.sql.exec<{ seq: number }>(`SELECT seq FROM update_events`).toArray();
      expect(meta).toEqual({ dirty: 1, snapshot_seq: capturedSequence });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.seq).toBeGreaterThan(capturedSequence);

      const firstAlarm = Date.now() + 20_000;
      await state.storage.deleteAlarm();
      await document.scheduleAlarm(firstAlarm);
      await document.scheduleAlarm(firstAlarm + 20_000);
      expect(await state.storage.getAlarm()).toBe(firstAlarm);
      await document.scheduleAlarm(firstAlarm - 10_000);
      expect(await state.storage.getAlarm()).toBe(firstAlarm - 10_000);
    });
  });

  it("serializes an archive compaction behind an in-flight alarm compaction", async () => {
    const installed = await bootstrap();
    await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), installed.pageId).run();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const content = document.document.getMap<number>("serialized-content");
      content.set("before", 1);
      await document.onSave();

      let releaseFirstPut!: () => void;
      let markFirstPutStarted!: () => void;
      const firstPutGate = new Promise<void>((resolve) => {
        releaseFirstPut = resolve;
      });
      const firstPutStarted = new Promise<void>((resolve) => {
        markFirstPutStarted = resolve;
      });
      const originalBindings = document.bindings;
      const bucket = originalBindings.BUCKET;
      let currentPuts = 0;
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property !== "BUCKET") return Reflect.get(target, property, receiver);
          return new Proxy(bucket, {
            get(bucketTarget, bucketProperty) {
              if (bucketProperty === "put")
                return async (...args: any[]) => {
                  if (String(args[0]).endsWith("/current.bin") && ++currentPuts === 1) {
                    markFirstPutStarted();
                    await firstPutGate;
                  }
                  return Reflect.apply(bucketTarget.put, bucketTarget, args);
                };
              const value = Reflect.get(bucketTarget, bucketProperty, bucketTarget);
              return typeof value === "function" ? value.bind(bucketTarget) : value;
            },
          });
        },
      });

      try {
        const firstCompaction = document.compact();
        await firstPutStarted;
        content.set("during", 2);
        await document.onSave();
        const archiving = document.onRequest(
          new Request("https://document.internal/archive", {
            method: "POST",
            headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
          }),
        );
        await Promise.resolve();
        expect(currentPuts).toBe(1);
        releaseFirstPut();
        const [, archived] = await Promise.all([firstCompaction, archiving]);
        expect(archived.status).toBe(200);
      } finally {
        document.bindings = originalBindings;
        releaseFirstPut();
      }

      const stored = await env.BUCKET.get(`documents/${installed.pageId}/epochs/1/current.bin`);
      expect(stored).toBeTruthy();
      const replica = new Y.Doc();
      Y.applyUpdate(replica, new Uint8Array(await stored!.arrayBuffer()));
      expect(replica.getMap("serialized-content").toJSON()).toEqual({ before: 1, during: 2 });
      replica.destroy();
    });
  });

  it("re-dirties and reschedules a document after failed compaction", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("failure-content").set("value", 1);
      await document.onSave();
      const originalBindings = document.bindings;
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "BUCKET")
            return {
              put: async () => {
                throw new Error("R2 unavailable");
              },
            };
          return Reflect.get(target, property, receiver);
        },
      });
      await expect(document.compact()).rejects.toThrow("R2 unavailable");
      document.bindings = originalBindings;

      expect(
        state.storage.sql.exec<{ dirty: number }>(`SELECT dirty FROM document_meta WHERE id = 1`).one().dirty,
      ).toBe(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("does not retire the current room when a restore commit fails, then retires it after a successful restore", async () => {
    const installed = await bootstrap();
    const room = `${installed.pageId}~1`;
    const stub = env.DOCUMENT.getByName(room);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const fragment = document.document.getXmlFragment("document-store");
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "Restorable content");
      paragraph.insert(0, [text]);
      fragment.insert(0, [paragraph]);
      await document.onSave();
      await document.compact(true);
    });
    const version = await env.DB.prepare(
      `SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(installed.pageId)
      .first<{ id: string }>();
    expect(version).toBeTruthy();

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const originalBindings = document.bindings;
      const failingDatabase = new Proxy(originalBindings.DB, {
        get(target, property) {
          if (property === "batch")
            return async () => {
              throw new Error("D1 unavailable");
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "DB") return failingDatabase;
          return Reflect.get(target, property, receiver);
        },
      });
      try {
        const failed = await document.restoreVersion(version!.id, installed.userId);
        expect(failed.status).toBe(503);
        expect(
          state.storage.sql.exec<{ retired: number }>(`SELECT retired FROM document_meta WHERE id = 1`).one().retired,
        ).toBe(0);
      } finally {
        document.bindings = originalBindings;
      }
    });
    expect(
      (
        await env.DB.prepare(`SELECT content_epoch FROM pages WHERE id = ?`)
          .bind(installed.pageId)
          .first<{ content_epoch: number }>()
      )?.content_epoch,
    ).toBe(1);

    const restored = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/restore-version`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ versionId: version!.id }),
      }),
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ pageId: installed.pageId, contentEpoch: 2 });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql.exec<{ retired: number }>(`SELECT retired FROM document_meta WHERE id = 1`).one().retired,
      ).toBe(1);
    });
  });

  it("keeps the new snapshot when a restore batch commits before its response fails", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("ambiguous-restore").set("value", 1);
      await document.onSave();
      await document.compact(true);
    });
    const version = await env.DB.prepare(
      `SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(installed.pageId)
      .first<{ id: string }>();
    expect(version).toBeTruthy();

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const originalBindings = document.bindings;
      const ambiguousDatabase = new Proxy(originalBindings.DB, {
        get(target, property) {
          if (property === "batch")
            return async (statements: D1PreparedStatement[]) => {
              await target.batch(statements);
              throw new Error("D1 response lost after commit");
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "DB") return ambiguousDatabase;
          return Reflect.get(target, property, receiver);
        },
      });
      try {
        const response = await document.restoreVersion(version!.id, installed.userId);
        expect(response.status).toBe(503);
        expect(
          state.storage.sql
            .exec<{ retired: number; restore_pending: number }>(
              `SELECT retired, restore_pending FROM document_meta WHERE id = 1`,
            )
            .one(),
        ).toEqual({ retired: 1, restore_pending: 0 });
      } finally {
        document.bindings = originalBindings;
      }
    });

    expect(
      (
        await env.DB.prepare(`SELECT content_epoch FROM pages WHERE id = ?`)
          .bind(installed.pageId)
          .first<{ content_epoch: number }>()
      )?.content_epoch,
    ).toBe(2);
    expect(await env.BUCKET.get(`documents/${installed.pageId}/epochs/2/current.bin`)).toBeTruthy();
    const preRestore = await env.DB.prepare(
      `SELECT r2_key FROM page_versions WHERE page_id = ? AND epoch = 1 AND id <> ?`,
    )
      .bind(installed.pageId, version!.id)
      .first<{ r2_key: string }>();
    expect(preRestore).toBeTruthy();
    expect(await env.BUCKET.get(preRestore!.r2_key)).toBeTruthy();
  });

  it("reconciles an unresolved restore from an alarm", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("unknown-restore").set("value", 1);
      await document.onSave();
      await document.compact(true);
    });
    const version = await env.DB.prepare(
      `SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(installed.pageId)
      .first<{ id: string }>();
    expect(version).toBeTruthy();

    let recovery!: { new_key: string; pre_key: string | null };
    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const originalBindings = document.bindings;
      const unavailableDatabase = new Proxy(originalBindings.DB, {
        get(target, property, receiver) {
          if (property === "batch")
            return async () => {
              throw new Error("D1 batch unavailable");
            };
          if (property !== "prepare") return Reflect.get(target, property, receiver);
          return (query: string) => {
            const statement = target.prepare(query);
            if (!query.includes("SELECT content_epoch FROM pages WHERE id = ?")) return statement;
            return {
              bind: (...args: unknown[]) => {
                statement.bind(...args);
                return {
                  first: async () => {
                    throw new Error("D1 confirmation unavailable");
                  },
                };
              },
            };
          };
        },
      });
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "DB") return unavailableDatabase;
          return Reflect.get(target, property, receiver);
        },
      });
      // Left over from an earlier pending restore: a new restore starts its
      // reconciliation backoff from scratch.
      state.storage.sql.exec(`UPDATE document_meta SET restore_attempts = 7 WHERE id = 1`);
      document.metadata.restore_attempts = 7;
      const restoreAttempts = () =>
        state.storage.sql
          .exec<{ restore_attempts: number }>(`SELECT restore_attempts FROM document_meta WHERE id = 1`)
          .one().restore_attempts;
      try {
        const response = await document.restoreVersion(version!.id, installed.userId);
        expect(response.status).toBe(503);
        expect(
          state.storage.sql
            .exec<{ retired: number; restore_pending: number }>(
              `SELECT retired, restore_pending FROM document_meta WHERE id = 1`,
            )
            .one(),
        ).toEqual({ retired: 0, restore_pending: 1 });
        expect(restoreAttempts()).toBe(1);
        recovery = state.storage.sql
          .exec<{ new_key: string; pre_key: string | null }>(
            `SELECT new_key, pre_key FROM restore_recovery WHERE id = 1`,
          )
          .one();
        // The first retry stays fast even though onSave left a later alarm
        // (compaction, +30 s) stored before the restore began.
        const retryAlarm = await state.storage.getAlarm();
        expect(retryAlarm).not.toBeNull();
        expect(retryAlarm!).toBeLessThanOrEqual(Date.now() + 5_000);
        expect(await env.BUCKET.get(recovery.new_key)).toBeTruthy();
        expect(await env.BUCKET.get(recovery.pre_key!)).toBeTruthy();
      } finally {
        document.bindings = originalBindings;
      }

      elapseRestoreBackoff(document, state);
      await document.onAlarm();
      expect(
        state.storage.sql
          .exec<{ retired: number; restore_pending: number }>(
            `SELECT retired, restore_pending FROM document_meta WHERE id = 1`,
          )
          .one(),
      ).toEqual({ retired: 0, restore_pending: 0 });
      expect(restoreAttempts()).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM restore_recovery`).one().count).toBe(
        0,
      );
    });

    expect(
      (
        await env.DB.prepare(`SELECT content_epoch FROM pages WHERE id = ?`)
          .bind(installed.pageId)
          .first<{ content_epoch: number }>()
      )?.content_epoch,
    ).toBe(1);
    expect(await env.BUCKET.get(recovery.new_key)).toBeNull();
    expect(await env.BUCKET.get(recovery.pre_key!)).toBeNull();
  });

  it("attempts a pending restore once per alarm even when initialization outruns the retry deadline", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      state.storage.sql.exec(
        `INSERT INTO restore_recovery (id, old_epoch, new_epoch, new_key, pre_key)
         VALUES (1, 1, 2, 'restore-new', NULL)`,
      );
      state.storage.sql.exec(`UPDATE document_meta SET restore_pending = 1, restore_attempts = 0 WHERE id = 1`);
      document.metadata.restore_pending = 1;
      document.metadata.restore_attempts = 0;

      const restoreAttempts = () =>
        state.storage.sql
          .exec<{ restore_attempts: number }>(`SELECT restore_attempts FROM document_meta WHERE id = 1`)
          .one().restore_attempts;

      // Reconciliation reads the authoritative epoch first, so failing that
      // read defers every attempt and leaves the count as the only record of
      // how many ran.
      const originalBindings = document.bindings;
      const unavailableDatabase = new Proxy(originalBindings.DB, {
        get(target, property, receiver) {
          if (property !== "prepare") return Reflect.get(target, property, receiver);
          return (query: string) => {
            const statement = target.prepare(query);
            if (!query.includes("SELECT content_epoch FROM pages WHERE id = ?")) return statement;
            return {
              bind: () => ({
                first: async () => {
                  throw new Error("D1 confirmation unavailable");
                },
              }),
            };
          };
        },
      });
      document.bindings = new Proxy(originalBindings, {
        get: (target, property, receiver) =>
          property === "DB" ? unavailableDatabase : Reflect.get(target, property, receiver),
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        // partyserver initializes before it delivers an alarm, so a cold wake
        // runs onStart and then onAlarm for the same delivery.
        await document.onStart();
        expect(restoreAttempts()).toBe(1);

        // super.onStart() loads the R2 snapshot and replays the update log
        // between the two, which a large document can drag past the 2.5-5 s
        // first backoff. The deadline alone can no longer distinguish that
        // from a genuinely elapsed quiet period.
        elapseRestoreBackoff(document, state);
        await document.onAlarm();
        expect(restoreAttempts()).toBe(1);

        // The next delivered alarm is a new wake, so an elapsed deadline still
        // reconciles: skipping once must not strand the room read-only.
        elapseRestoreBackoff(document, state);
        await document.onAlarm();
        expect(restoreAttempts()).toBe(2);
        expect(document.metadata.restore_pending).toBe(1);
        expect(await state.storage.getAlarm()).not.toBeNull();
      } finally {
        document.bindings = originalBindings;
        error.mockRestore();
      }
    });
  });

  it("re-arms the restore retry when the alarm it scheduled lands on the same instance", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      state.storage.sql.exec(
        `INSERT INTO restore_recovery (id, old_epoch, new_epoch, new_key, pre_key)
         VALUES (1, 1, 2, 'rearm-new', NULL)`,
      );
      state.storage.sql.exec(`UPDATE document_meta SET restore_pending = 1, restore_attempts = 0 WHERE id = 1`);
      document.metadata.restore_pending = 1;
      document.metadata.restore_attempts = 0;

      const originalBindings = document.bindings;
      const unavailableDatabase = new Proxy(originalBindings.DB, {
        get(target, property, receiver) {
          if (property !== "prepare") return Reflect.get(target, property, receiver);
          return (query: string) => {
            const statement = target.prepare(query);
            if (!query.includes("SELECT content_epoch FROM pages WHERE id = ?")) return statement;
            return {
              bind: () => ({
                first: async () => {
                  throw new Error("D1 confirmation unavailable");
                },
              }),
            };
          };
        },
      });
      document.bindings = new Proxy(originalBindings, {
        get: (target, property, receiver) =>
          property === "DB" ? unavailableDatabase : Reflect.get(target, property, receiver),
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        // A normal request starts the object, so onStart reconciles and its
        // failure arms a retry with no alarm delivery of its own to follow.
        await document.onStart();
        expect(await state.storage.getAlarm()).toBe(document.metadata.restore_retry_at);

        // That retry is delivered to the instance still holding the latch, and
        // the delivery consumes the stored alarm.
        await state.storage.deleteAlarm();
        await document.onAlarm();

        // Skipping the wake without re-arming would strand the room read-only
        // until something else cold-starts it.
        expect(await state.storage.getAlarm()).toBe(document.metadata.restore_retry_at);
        expect(document.metadata.restore_pending).toBe(1);
      } finally {
        document.bindings = originalBindings;
        error.mockRestore();
      }
    });
  });

  it("retries failed restore cleanup and then follows the authoritative epoch", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      state.storage.sql.exec(
        `INSERT INTO restore_recovery (id, old_epoch, new_epoch, new_key, pre_key)
         VALUES (1, 1, 2, 'restore-new', 'restore-pre')`,
      );
      state.storage.sql.exec(`UPDATE document_meta SET retired = 1, restore_pending = 1 WHERE id = 1`);
      document.metadata.retired = 1;
      document.metadata.restore_pending = 1;

      const originalBindings = document.bindings;
      const deleteObject = vi.fn(async () => {
        throw new Error("R2 delete unavailable");
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "BUCKET")
            return new Proxy(target.BUCKET, {
              get: (bucket, key) => (key === "delete" ? deleteObject : Reflect.get(bucket, key, bucket)),
            });
          return Reflect.get(target, property, receiver);
        },
      });
      try {
        await document.onAlarm();
      } finally {
        document.bindings = originalBindings;
        error.mockRestore();
      }

      expect(deleteObject).toHaveBeenCalledTimes(2);
      expect(
        state.storage.sql
          .exec<{ retired: number; restore_pending: number }>(
            `SELECT retired, restore_pending FROM document_meta WHERE id = 1`,
          )
          .one(),
      ).toEqual({ retired: 1, restore_pending: 1 });
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM restore_recovery`).one().count).toBe(
        1,
      );
      expect(await state.storage.getAlarm()).not.toBeNull();

      elapseRestoreBackoff(document, state);
      await document.onAlarm();
      expect(
        state.storage.sql
          .exec<{ retired: number; restore_pending: number }>(
            `SELECT retired, restore_pending FROM document_meta WHERE id = 1`,
          )
          .one(),
      ).toEqual({ retired: 0, restore_pending: 0 });
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM restore_recovery`).one().count).toBe(
        0,
      );
    });
  });

  it("backs off restore reconciliation exponentially and persists the attempt count", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      state.storage.sql.exec(
        `INSERT INTO restore_recovery (id, old_epoch, new_epoch, new_key, pre_key)
         VALUES (1, 1, 2, 'backoff-new', 'backoff-pre')`,
      );
      state.storage.sql.exec(`UPDATE document_meta SET retired = 1, restore_pending = 1 WHERE id = 1`);
      document.metadata.retired = 1;
      document.metadata.restore_pending = 1;
      const restoreAttempts = () =>
        state.storage.sql
          .exec<{ restore_attempts: number }>(`SELECT restore_attempts FROM document_meta WHERE id = 1`)
          .one().restore_attempts;

      const originalBindings = document.bindings;
      const deleteObject = vi.fn(async () => {
        throw new Error("R2 delete unavailable");
      });
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      // Pin the jitter to the ceiling so each delay is exact.
      const random = vi.spyOn(Math, "random").mockReturnValue(1);
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "BUCKET")
            return new Proxy(target.BUCKET, {
              get: (bucket, key) => (key === "delete" ? deleteObject : Reflect.get(bucket, key, bucket)),
            });
          return Reflect.get(target, property, receiver);
        },
      });
      const failingAlarmDelay = async () => {
        elapseRestoreBackoff(document, state);
        const before = Date.now();
        await document.onAlarm();
        const after = Date.now();
        const alarm = await state.storage.getAlarm();
        expect(alarm).not.toBeNull();
        return { atLeast: alarm! - after, atMost: alarm! - before };
      };
      try {
        for (const [index, ceiling] of [5_000, 10_000, 20_000].entries()) {
          const delay = await failingAlarmDelay();
          expect(delay.atLeast).toBeLessThanOrEqual(ceiling);
          expect(delay.atMost).toBeGreaterThanOrEqual(ceiling);
          expect(restoreAttempts()).toBe(index + 1);
        }
        // Far into an outage the delay holds at the cap instead of growing.
        state.storage.sql.exec(`UPDATE document_meta SET restore_attempts = 40 WHERE id = 1`);
        document.metadata.restore_attempts = 40;
        const capped = await failingAlarmDelay();
        expect(capped.atLeast).toBeLessThanOrEqual(5 * 60_000);
        expect(capped.atMost).toBeGreaterThanOrEqual(5 * 60_000);
        expect(restoreAttempts()).toBe(41);
        expect(
          state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM restore_recovery`).one().count,
        ).toBe(1);
      } finally {
        document.bindings = originalBindings;
        random.mockRestore();
        error.mockRestore();
      }

      elapseRestoreBackoff(document, state);
      await document.onAlarm();
      expect(
        state.storage.sql
          .exec<{ retired: number; restore_pending: number }>(
            `SELECT retired, restore_pending FROM document_meta WHERE id = 1`,
          )
          .one(),
      ).toEqual({ retired: 0, restore_pending: 0 });
      expect(restoreAttempts()).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM restore_recovery`).one().count).toBe(
        0,
      );
    });
  });

  it("holds the reconciliation backoff when an alarm fires inside the quiet period", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      state.storage.sql.exec(
        `INSERT INTO restore_recovery (id, old_epoch, new_epoch, new_key, pre_key)
         VALUES (1, 1, 2, 'quiet-new', 'quiet-pre')`,
      );
      const retryAt = Date.now() + 60_000;
      state.storage.sql.exec(
        `UPDATE document_meta SET retired = 1, restore_pending = 1, restore_attempts = 3, restore_retry_at = ? WHERE id = 1`,
        retryAt,
      );
      document.metadata.retired = 1;
      document.metadata.restore_pending = 1;
      document.metadata.restore_attempts = 3;
      document.metadata.restore_retry_at = retryAt;
      await state.storage.setAlarm(Date.now());

      // Nothing here is sabotaged: an ungated alarm would reconcile
      // successfully and clear restore_pending.
      await document.onAlarm();

      expect(
        state.storage.sql
          .exec<{ restore_pending: number; restore_attempts: number }>(
            `SELECT restore_pending, restore_attempts FROM document_meta WHERE id = 1`,
          )
          .one(),
      ).toEqual({ restore_pending: 1, restore_attempts: 3 });
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM restore_recovery`).one().count).toBe(
        1,
      );
      expect(await state.storage.getAlarm()).toBe(retryAt);
    });
  });

  it("does not query deleted Durable Object storage when an alarm follows a purge", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      state.storage.sql.exec(
        `INSERT INTO restore_recovery (id, old_epoch, new_epoch, new_key, pre_key)
         VALUES (1, 1, 2, 'restore-new', NULL)`,
      );
      state.storage.sql.exec(`UPDATE document_meta SET restore_pending = 1 WHERE id = 1`);
      document.metadata.restore_pending = 1;

      const purged = await document.onRequest(
        new Request("https://document.internal/purge", {
          method: "POST",
          headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
        }),
      );

      expect(purged.status).toBe(200);
      await expect(document.onAlarm()).resolves.toBeUndefined();
    });
  });

  it("deletes only the superseded epoch snapshot when restore recovery finds a later epoch", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    const newKey = `documents/${installed.pageId}/epochs/2/current.bin`;
    const preKey = `documents/${installed.pageId}/versions/pre-restore.bin`;
    await env.BUCKET.put(newKey, "new epoch");
    await env.BUCKET.put(preKey, "pre restore");
    await env.DB.prepare(`UPDATE pages SET content_epoch = 3 WHERE id = ?`).bind(installed.pageId).run();

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      state.storage.sql.exec(
        `INSERT INTO restore_recovery (id, old_epoch, new_epoch, new_key, pre_key)
         VALUES (1, 1, 2, ?, ?)`,
        newKey,
        preKey,
      );
      state.storage.sql.exec(`UPDATE document_meta SET restore_pending = 1 WHERE id = 1`);
      document.metadata.restore_pending = 1;

      await document.onAlarm();

      expect(
        state.storage.sql
          .exec<{ retired: number; restore_pending: number }>(
            `SELECT retired, restore_pending FROM document_meta WHERE id = 1`,
          )
          .one(),
      ).toEqual({ retired: 1, restore_pending: 0 });
    });

    expect(await env.BUCKET.get(newKey)).toBeNull();
    expect(await env.BUCKET.get(preKey)).toBeTruthy();
  });

  it("does not reconcile restore recovery while the restore is still committing", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("restore-alarm-race").set("value", 1);
      await document.onSave();
      await document.compact(true);
    });
    const version = await env.DB.prepare(
      `SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(installed.pageId)
      .first<{ id: string }>();
    expect(version).toBeTruthy();
    const newKey = `documents/${installed.pageId}/epochs/2/current.bin`;

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const originalBindings = document.bindings;
      const bucket = originalBindings.BUCKET;
      let releaseNewSnapshot!: () => void;
      let markNewSnapshotStored!: () => void;
      const newSnapshotGate = new Promise<void>((resolve) => {
        releaseNewSnapshot = resolve;
      });
      const newSnapshotStored = new Promise<void>((resolve) => {
        markNewSnapshotStored = resolve;
      });
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property !== "BUCKET") return Reflect.get(target, property, receiver);
          return new Proxy(bucket, {
            get(bucketTarget, bucketProperty) {
              if (bucketProperty === "put")
                return async (...args: any[]) => {
                  const result = await Reflect.apply(bucketTarget.put, bucketTarget, args);
                  if (args[0] === newKey) {
                    markNewSnapshotStored();
                    await newSnapshotGate;
                  }
                  return result;
                };
              const value = Reflect.get(bucketTarget, bucketProperty, bucketTarget);
              return typeof value === "function" ? value.bind(bucketTarget) : value;
            },
          });
        },
      });

      // Record every requested alarm time: reading storage after the restore
      // resolves races the runtime delivering the (immediately due) alarm,
      // which clears the stored value.
      const scheduled: number[] = [];
      const originalScheduleAlarm = document.scheduleAlarm.bind(document);
      document.scheduleAlarm = async (when: number) => {
        scheduled.push(when);
        await originalScheduleAlarm(when);
      };

      try {
        const restoring = document.restoreVersion(version!.id, installed.userId);
        await newSnapshotStored;
        expect(document.transition).toBe("restore");
        expect(
          state.storage.sql.exec<{ restore_pending: number }>(`SELECT restore_pending FROM document_meta`).one()
            .restore_pending,
        ).toBe(1);

        await state.storage.deleteAlarm();
        await document.onAlarm();
        expect(await env.BUCKET.get(newKey)).toBeTruthy();
        const deferredAlarm = await state.storage.getAlarm();
        expect(deferredAlarm).not.toBeNull();

        releaseNewSnapshot();
        expect((await restoring).status).toBe(200);
        expect(scheduled.at(-1)).toBeLessThan(deferredAlarm!);
      } finally {
        document.bindings = originalBindings;
        Reflect.deleteProperty(document, "scheduleAlarm");
        releaseNewSnapshot();
      }
    });

    expect(await env.BUCKET.get(newKey)).toBeTruthy();
  });

  it("keeps the reconciliation backoff when a deferred alarm resumes after a failed restore", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("restore-alarm-backoff").set("value", 1);
      await document.onSave();
      await document.compact(true);
    });
    const version = await env.DB.prepare(
      `SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(installed.pageId)
      .first<{ id: string }>();
    expect(version).toBeTruthy();
    const newKey = `documents/${installed.pageId}/epochs/2/current.bin`;

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const originalBindings = document.bindings;
      const bucket = originalBindings.BUCKET;
      let releaseNewSnapshot!: () => void;
      let markNewSnapshotStored!: () => void;
      const newSnapshotGate = new Promise<void>((resolve) => {
        releaseNewSnapshot = resolve;
      });
      const newSnapshotStored = new Promise<void>((resolve) => {
        markNewSnapshotStored = resolve;
      });
      // The commit fails and its confirmation lookup fails too, so the restore
      // ends with an unknown commit state and schedules a reconciliation retry.
      const unavailableDatabase = new Proxy(originalBindings.DB, {
        get(target, property, receiver) {
          if (property === "batch")
            return async () => {
              throw new Error("D1 batch unavailable");
            };
          if (property !== "prepare") return Reflect.get(target, property, receiver);
          return (query: string) => {
            const statement = target.prepare(query);
            if (!query.includes("SELECT content_epoch FROM pages WHERE id = ?")) return statement;
            return {
              bind: (...args: unknown[]) => {
                statement.bind(...args);
                return {
                  first: async () => {
                    throw new Error("D1 confirmation unavailable");
                  },
                };
              },
            };
          };
        },
      });
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "DB") return unavailableDatabase;
          if (property !== "BUCKET") return Reflect.get(target, property, receiver);
          return new Proxy(bucket, {
            get(bucketTarget, bucketProperty) {
              if (bucketProperty === "put")
                return async (...args: any[]) => {
                  const result = await Reflect.apply(bucketTarget.put, bucketTarget, args);
                  if (args[0] === newKey) {
                    markNewSnapshotStored();
                    await newSnapshotGate;
                  }
                  return result;
                };
              const value = Reflect.get(bucketTarget, bucketProperty, bucketTarget);
              return typeof value === "function" ? value.bind(bucketTarget) : value;
            },
          });
        },
      });
      const backoffs: number[] = [];
      const originalDeferAlarm = document.deferAlarm.bind(document);
      document.deferAlarm = async (when: number) => {
        backoffs.push(when);
        await originalDeferAlarm(when);
      };

      try {
        const restoring = document.restoreVersion(version!.id, installed.userId);
        await newSnapshotStored;
        expect(document.transition).toBe("restore");

        await state.storage.deleteAlarm();
        await document.onAlarm();
        expect(await state.storage.getAlarm()).not.toBeNull();
        // A restore that fails slowly leaves the alarm deferred by onAlarm
        // already overdue, so resuming it must move the alarm out to the
        // backoff rather than settle for the soonest pending time.
        await state.storage.setAlarm(Date.now() - 1_000);

        releaseNewSnapshot();
        expect((await restoring).status).toBe(503);
        const finishedAt = Date.now();
        expect(
          state.storage.sql.exec<{ restore_pending: number }>(`SELECT restore_pending FROM document_meta`).one()
            .restore_pending,
        ).toBe(1);
        const backoff = backoffs.at(-1);
        expect(backoff).toBeGreaterThan(finishedAt);
        expect(await state.storage.getAlarm()).toBe(backoff);
      } finally {
        document.bindings = originalBindings;
        Reflect.deleteProperty(document, "deferAlarm");
        releaseNewSnapshot();
      }
    });
  });

  it("keeps the reconciliation backoff when an earlier alarm has not fired", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());

    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      const earlierAlarm = Date.now() + 1_000;
      const retryAt = Date.now() + 10_000;
      await state.storage.setAlarm(earlierAlarm);
      document.transition = "restore";
      document.transitionAlarmDeferred = false;
      document.transitionRetryAt = retryAt;

      await document.finishTransition();

      expect(await state.storage.getAlarm()).toBe(retryAt);
      expect(document.transitionRetryAt).toBeNull();
      expect(document.transition).toBeNull();
    });
  });

  it("rejects a concurrent restore before it can share the next epoch snapshot key", async () => {
    const installed = await bootstrap();
    const room = `${installed.pageId}~1`;
    const stub = env.DOCUMENT.getByName(room);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("restore-race").set("value", 1);
      await document.onSave();
      await document.compact(true);
    });
    const version = await env.DB.prepare(
      `SELECT id, r2_key FROM page_versions WHERE page_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(installed.pageId)
      .first<{ id: string; r2_key: string }>();
    expect(version).toBeTruthy();

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const originalBindings = document.bindings;
      const bucket = originalBindings.BUCKET;
      let releaseVersionRead!: () => void;
      let markVersionReadStarted!: () => void;
      const versionReadGate = new Promise<void>((resolve) => {
        releaseVersionRead = resolve;
      });
      const versionReadStarted = new Promise<void>((resolve) => {
        markVersionReadStarted = resolve;
      });
      let versionReads = 0;
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property !== "BUCKET") return Reflect.get(target, property, receiver);
          return new Proxy(bucket, {
            get(bucketTarget, bucketProperty) {
              if (bucketProperty === "get")
                return async (...args: any[]) => {
                  if (args[0] === version!.r2_key && ++versionReads === 1) {
                    markVersionReadStarted();
                    await versionReadGate;
                  }
                  return Reflect.apply(bucketTarget.get, bucketTarget, args);
                };
              const value = Reflect.get(bucketTarget, bucketProperty, bucketTarget);
              return typeof value === "function" ? value.bind(bucketTarget) : value;
            },
          });
        },
      });

      try {
        const first = document.restoreVersion(version!.id, installed.userId);
        await versionReadStarted;
        const second = await document.restoreVersion(version!.id, installed.userId);
        expect(second.status).toBe(409);
        releaseVersionRead();
        expect((await first).status).toBe(200);
      } finally {
        document.bindings = originalBindings;
        releaseVersionRead();
      }
    });
    expect(await env.BUCKET.get(`documents/${installed.pageId}/epochs/2/current.bin`)).toBeTruthy();
  });

  it("flushes an archived document without resurrecting its search row", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const fragment = document.document.getXmlFragment("document-store");
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "Tail edit before archive");
      paragraph.insert(0, [text]);
      fragment.insert(0, [paragraph]);
      await document.onSave();
    });

    const archived = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}`, {
        method: "DELETE",
      }),
    );
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({
      ok: true,
      pageIds: [installed.pageId],
      cleanupPending: false,
      pendingPageIds: [],
    });
    expect(
      (
        await env.DB.prepare(`SELECT COUNT(*) count FROM page_search WHERE page_id = ?`)
          .bind(installed.pageId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect(
      (
        await env.DB.prepare(`SELECT plain_text FROM pages WHERE id = ?`)
          .bind(installed.pageId)
          .first<{ plain_text: string }>()
      )?.plain_text,
    ).toContain("Tail edit before archive");
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql.exec<{ dirty: number }>(`SELECT dirty FROM document_meta WHERE id = 1`).one().dirty,
      ).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) count FROM update_events`).one().count).toBe(0);
    });
    expect(
      (await env.DB.prepare(`SELECT COUNT(*) count FROM archive_disconnect_targets`).first<{ count: number }>())?.count,
    ).toBe(0);
  });

  it("returns the complete success envelope when archiving an already archived subtree", async () => {
    const installed = await bootstrap();
    const child = await createPage(installed.cookie, "document", installed.pageId);
    const archive = () =>
      SELF.fetch(
        authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}`, {
          method: "DELETE",
        }),
      );

    const first = await archive();
    expect(first.status).toBe(200);
    const firstBody = await first.json<{
      ok: boolean;
      pageIds: string[];
      cleanupPending: boolean;
      pendingPageIds: string[];
    }>();
    expect({ ...firstBody, pageIds: [...firstBody.pageIds].sort() }).toEqual({
      ok: true,
      pageIds: [installed.pageId, child.id].sort(),
      cleanupPending: false,
      pendingPageIds: [],
    });

    const repeated = await archive();
    expect(repeated.status).toBe(200);
    const repeatedBody = await repeated.json<{
      ok: boolean;
      pageIds: string[];
      cleanupPending: boolean;
      pendingPageIds: string[];
    }>();
    expect({ ...repeatedBody, pageIds: [...repeatedBody.pageIds].sort() }).toEqual({
      ok: true,
      pageIds: [installed.pageId, child.id].sort(),
      cleanupPending: false,
      pendingPageIds: [],
    });
  });

  it("copies the archive operation id into the workspace event", async () => {
    const installed = await bootstrap();
    const operationId = "archive-operation";
    const delivered: Array<{ workspaceId: string; event: WorkspaceEvent }> = [];
    const bindings = envWithCapturedWorkspaceEvents(env, delivered);
    const context = createExecutionContext();

    const archived = await worker.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}`, {
        method: "DELETE",
        headers: { "x-notes-operation-id": operationId },
      }),
      bindings,
      context,
    );
    await waitOnExecutionContext(context);

    expect(archived.status).toBe(200);
    expect(delivered).toEqual([
      {
        workspaceId: installed.workspaceId,
        event: {
          type: "pages-removed",
          pageIds: [installed.pageId],
          permanently: false,
          operationId,
        },
      },
    ]);
  });

  it("returns authoritative pages when restoring an archived subtree", async () => {
    const installed = await bootstrap();
    const child = await createPage(installed.cookie, "document", installed.pageId);
    const archiveContext = createExecutionContext();
    const archived = await worker.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}`, { method: "DELETE" }),
      env,
      archiveContext,
    );
    expect(archived.ok).toBe(true);
    await waitOnExecutionContext(archiveContext);

    const restoreContext = createExecutionContext();
    const restored = await worker.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/restore`, { method: "POST" }),
      env,
      restoreContext,
    );

    expect(restored.status).toBe(200);
    const result = await restored.json<{ pages: Array<{ id: string; archivedAt: number | null; revision: number }> }>();
    expect(result.pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: installed.pageId, archivedAt: null, revision: 3 }),
        expect.objectContaining({ id: child.id, archivedAt: null, revision: 3 }),
      ]),
    );
    const indexed = await env.DB.prepare(`SELECT page_id FROM page_search WHERE page_id IN (?, ?) ORDER BY page_id`)
      .bind(installed.pageId, child.id)
      .all<{ page_id: string }>();
    expect(indexed.results.map((item) => item.page_id)).toEqual([installed.pageId, child.id].sort());
    await waitOnExecutionContext(restoreContext);
  });

  it("keeps an archived page committed and retries a failed room disconnect", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    let originalBindings!: Cloudflare.Env;
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("archive-retry").set("value", 1);
      await document.onSave();
      originalBindings = document.bindings;
      document.bindings = new Proxy(originalBindings, {
        get(target, property, receiver) {
          if (property === "BUCKET") {
            return new Proxy(originalBindings.BUCKET, {
              get(bucket, bucketProperty, bucketReceiver) {
                if (bucketProperty === "put")
                  return async () => {
                    throw new Error("R2 unavailable");
                  };
                const value = Reflect.get(bucket, bucketProperty, bucketReceiver);
                return typeof value === "function" ? value.bind(bucket) : value;
              },
            });
          }
          return Reflect.get(target, property, receiver);
        },
      });
    });

    try {
      const archived = await SELF.fetch(
        authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}`, {
          method: "DELETE",
        }),
      );
      expect(archived.status).toBe(202);
      expect(await archived.json()).toEqual({
        ok: true,
        pageIds: [installed.pageId],
        cleanupPending: true,
        pendingPageIds: [installed.pageId],
      });
      expect(
        (
          await env.DB.prepare(`SELECT archived_at FROM pages WHERE id = ?`)
            .bind(installed.pageId)
            .first<{ archived_at: number | null }>()
        )?.archived_at,
      ).not.toBeNull();
      expect(
        await env.DB.prepare(`SELECT page_id FROM archive_disconnect_targets WHERE page_id = ?`)
          .bind(installed.pageId)
          .first(),
      ).not.toBeNull();
    } finally {
      await runInDurableObject(stub, async (instance) => {
        const document = instance as unknown as TestDocument;
        // Recover the real test bindings after the injected R2 outage.
        document.bindings = originalBindings;
      });
    }
    await env.DB.prepare(`UPDATE archive_disconnect_targets SET next_attempt_at = 0 WHERE page_id = ?`)
      .bind(installed.pageId)
      .run();
    const scheduledContext = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, scheduledContext);
    await waitOnExecutionContext(scheduledContext);
    expect(
      await env.DB.prepare(`SELECT page_id FROM archive_disconnect_targets WHERE page_id = ?`)
        .bind(installed.pageId)
        .first(),
    ).toBeNull();
  });

  it("does not mutate rows or options belonging to another table through a held lease", async () => {
    const installed = await bootstrap();
    const tableA = await createPage(installed.cookie, "table");
    const tableB = await createPage(installed.cookie, "table");
    const { columnId: columnA } = await seedTable(installed, tableA.id, { column: "text" });
    const {
      columnId: columnB,
      rowId: rowB,
      optionId: optionB,
    } = await seedTable(installed, tableB.id, { column: "select", option: "Foreign", row: true });
    const lease = await acquireLease(installed.cookie, tableA.id);
    expect(lease.leaseDurationMs).toBe(60_000);
    expect(lease).not.toHaveProperty("expiresAt");
    const renewed = await (
      await SELF.fetch(
        authenticatedRequest(installed.cookie, `/api/tables/${tableA.id}/lease`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ leaseToken: lease.leaseToken }),
        }),
      )
    ).json<TableLeaseTiming>();
    expect(renewed).toEqual({ leaseDurationMs: 60_000 });
    const mutationBody = JSON.stringify({ leaseToken: lease.leaseToken, expectedRevision: 1 });

    const deleteOption = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/tables/${tableA.id}/columns/${columnB}/options/${optionB}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: mutationBody,
      }),
    );
    expect(deleteOption.status).toBe(404);
    const putCell = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/tables/${tableA.id}/cells/${rowB}/${columnA}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseToken: lease.leaseToken, expectedRevision: 1, value: "cross-table" }),
      }),
    );
    expect(putCell.status).toBe(404);
    expect(
      await env.DB.prepare(`SELECT id FROM table_select_options WHERE id = ?`).bind(optionB).first(),
    ).not.toBeNull();
    expect((await env.DB.prepare(`SELECT COUNT(*) count FROM table_cells`).first<{ count: number }>())?.count).toBe(0);
    expect(
      (
        await env.DB.prepare(`SELECT revision FROM table_state WHERE page_id = ?`)
          .bind(tableA.id)
          .first<{ revision: number }>()
      )?.revision,
    ).toBe(1);
  });

  it("rejects cell and option mutations after a table is archived", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const { columnId, rowId, optionId } = await seedTable(installed, tablePage.id, {
      column: "select",
      option: "Open",
      row: true,
    });
    const lease = await acquireLease(installed.cookie, tablePage.id);
    await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), tablePage.id).run();
    const mutationBody = { leaseToken: lease.leaseToken, expectedRevision: 1 };

    const putCell = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/tables/${tablePage.id}/cells/${rowId}/${columnId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...mutationBody, value: optionId }),
      }),
    );
    expect(putCell.status).toBe(404);
    expect(await putCell.json()).toMatchObject({ error: { code: "page_not_found" } });

    const deleteOption = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/tables/${tablePage.id}/columns/${columnId}/options/${optionId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mutationBody),
      }),
    );
    expect(deleteOption.status).toBe(404);
    expect(await deleteOption.json()).toMatchObject({ error: { code: "page_not_found" } });
    expect(
      await env.DB.prepare(`SELECT 1 FROM table_select_options WHERE id = ?`).bind(optionId).first(),
    ).not.toBeNull();
    expect((await env.DB.prepare(`SELECT COUNT(*) count FROM table_cells`).first<{ count: number }>())?.count).toBe(0);
    expect(
      (
        await env.DB.prepare(`SELECT revision FROM table_state WHERE page_id = ?`)
          .bind(tablePage.id)
          .first<{ revision: number }>()
      )?.revision,
    ).toBe(1);
  });

  it("stops renewing and force-unlocking a lease once its table is archived", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const lease = await acquireLease(installed.cookie, tablePage.id);
    const leaseRow = () =>
      env.DB.prepare(`SELECT expires_at FROM table_leases WHERE page_id = ?`)
        .bind(tablePage.id)
        .first<{ expires_at: number }>();
    const expiresAt = (await leaseRow())?.expires_at;
    expect(expiresAt).toBeGreaterThan(0);
    await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), tablePage.id).run();
    const jsonRequest = (path: string, method: string, body: Record<string, unknown>) =>
      SELF.fetch(
        authenticatedRequest(installed.cookie, path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    const renewed = await jsonRequest(`/api/tables/${tablePage.id}/lease`, "PATCH", { leaseToken: lease.leaseToken });
    expect(renewed.status).toBe(404);
    expect(await renewed.json()).toMatchObject({ error: { code: "page_not_found" } });
    expect((await leaseRow())?.expires_at).toBe(expiresAt);

    const forceUnlock = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/tables/${tablePage.id}/force-unlock`, { method: "POST" }),
    );
    expect(forceUnlock.status).toBe(404);
    expect(await leaseRow()).not.toBeNull();

    // A missing page outranks lease-input validation on cell writes, as on
    // every other mutation route.
    const putCell = await jsonRequest(
      `/api/tables/${tablePage.id}/cells/${crypto.randomUUID()}/${crypto.randomUUID()}`,
      "PUT",
      {
        value: "unsaved",
      },
    );
    expect(putCell.status).toBe(404);
    expect(await putCell.json()).toMatchObject({ error: { code: "page_not_found" } });

    // Releasing one's own lease still works, so an archived table is not left
    // holding a lease that would block editing after a restore.
    const released = await jsonRequest(`/api/tables/${tablePage.id}/lease`, "DELETE", { leaseToken: lease.leaseToken });
    expect(released.status).toBe(200);
    expect(await leaseRow()).toBeNull();
  });

  it("assigns append positions on the server without reusing gaps", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const lease = await acquireLease(installed.cookie, tablePage.id);
    let revision = 1;
    const mutate = async <T>(path: string, method: string, body: Record<string, unknown> = {}) => {
      const response = await SELF.fetch(
        authenticatedRequest(installed.cookie, path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, leaseToken: lease.leaseToken, expectedRevision: revision }),
        }),
      );
      expect(response.status).toBeLessThan(300);
      const result = await response.json<T & { revision: number }>();
      revision = result.revision;
      return result;
    };

    const firstColumn = await mutate<{ column: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/columns`,
      "POST",
      { name: "First", type: "text" },
    );
    const selectColumn = await mutate<{ column: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/columns`,
      "POST",
      { name: "Choice", type: "select" },
    );
    await mutate(`/api/tables/${tablePage.id}/columns/${firstColumn.column.id}`, "DELETE");
    const thirdColumn = await mutate<{ column: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/columns`,
      "POST",
      { name: "Third", type: "text" },
    );
    expect([firstColumn.column.position, selectColumn.column.position, thirdColumn.column.position]).toEqual([0, 1, 2]);

    const firstOption = await mutate<{ option: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/columns/${selectColumn.column.id}/options`,
      "POST",
      { label: "First" },
    );
    const secondOption = await mutate<{ option: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/columns/${selectColumn.column.id}/options`,
      "POST",
      { label: "Second" },
    );
    await mutate(
      `/api/tables/${tablePage.id}/columns/${selectColumn.column.id}/options/${firstOption.option.id}`,
      "DELETE",
    );
    const thirdOption = await mutate<{ option: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/columns/${selectColumn.column.id}/options`,
      "POST",
      { label: "Third" },
    );
    expect([firstOption.option.position, secondOption.option.position, thirdOption.option.position]).toEqual([0, 1, 2]);

    const firstRow = await mutate<{ row: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/rows`,
      "POST",
    );
    const secondRow = await mutate<{ row: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/rows`,
      "POST",
    );
    await mutate(`/api/tables/${tablePage.id}/rows/${firstRow.row.id}`, "DELETE");
    const thirdRow = await mutate<{ row: { id: string; position: number } }>(
      `/api/tables/${tablePage.id}/rows`,
      "POST",
    );
    expect([firstRow.row.position, secondRow.row.position, thirdRow.row.position]).toEqual([0, 1, 2]);
  });

  it("does not advance the revision when a guarded mutation affects no rows", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const { rowId } = await seedTable(installed, tablePage.id, { row: true });
    const lease = await acquireLease(installed.cookie, tablePage.id);
    const triggerName = `ignore_delete_${rowId.replaceAll("-", "")}`;
    await env.DB.prepare(
      `CREATE TRIGGER ${triggerName} BEFORE DELETE ON table_rows
       WHEN OLD.id = '${rowId}' BEGIN SELECT RAISE(IGNORE); END`,
    ).run();

    try {
      const response = await SELF.fetch(
        authenticatedRequest(installed.cookie, `/api/tables/${tablePage.id}/rows/${rowId}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ leaseToken: lease.leaseToken, expectedRevision: 1 }),
        }),
      );

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "mutation_target_not_found" } });
      expect(await env.DB.prepare(`SELECT 1 FROM table_rows WHERE id = ?`).bind(rowId).first()).not.toBeNull();
      expect(
        (
          await env.DB.prepare(`SELECT revision FROM table_state WHERE page_id = ?`)
            .bind(tablePage.id)
            .first<{ revision: number }>()
        )?.revision,
      ).toBe(1);
    } finally {
      await env.DB.prepare(`DROP TRIGGER IF EXISTS ${triggerName}`).run();
    }
  });

  it("serves a table past the old 500-row ceiling instead of refusing to read it", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    await seedRows(installed, tablePage.id, 600);

    const { status, body } = await readTable(installed.cookie, tablePage.id, "?count=true");

    expect(status).toBe(200);
    expect(body.table.rows).toHaveLength(500);
    expect(body.table.rowCount).toBe(600);
    expect(body.table.hasMore).toBe(true);
    expect(body.table.nextCursor).not.toBeNull();
  });

  it("walks every row exactly once through the keyset cursor", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const seeded = await seedRows(installed, tablePage.id, 300);

    const seen: string[] = [];
    let cursor: TableData["nextCursor"] = null;
    let hasMore = true;
    for (let page = 0; page < 10 && hasMore; page += 1) {
      const query = cursor ? `?limit=120&afterPosition=${cursor.position}&afterId=${cursor.rowId}` : "?limit=120";
      const { body } = await readTable(installed.cookie, tablePage.id, query);
      seen.push(...body.table.rows.map((row) => row.id));
      cursor = body.table.nextCursor;
      hasMore = body.table.hasMore;
    }

    expect(hasMore).toBe(false);
    expect(cursor).toBeNull();
    expect(seen).toEqual(seeded);
    expect(new Set(seen).size).toBe(seeded.length);
  });

  it("omits the row count unless the caller asks for it", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    await seedRows(installed, tablePage.id, 3);

    const { body } = await readTable(installed.cookie, tablePage.id);

    expect(body.table.rowCount).toBeNull();
    expect(body.table.rows).toHaveLength(3);
    expect(body.table.hasMore).toBe(false);
  });

  it("sorts by a column and keeps empty cells last in both directions", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const { columnId } = await seedTable(installed, tablePage.id, { column: "text" });
    // Two filled cells either side of two blanks, so ordering cannot pass by accident.
    const values = ["banana", null, "apple", null];
    const seeded = await seedRows(installed, tablePage.id, 4, {
      columnId,
      value: (index) => values[index] ?? null,
    });

    const ascending = await readTable(installed.cookie, tablePage.id, `?sort=${columnId}&dir=asc`);
    expect(ascending.body.table.rows.map((row) => row.cells[columnId] ?? null)).toEqual([
      "apple",
      "banana",
      null,
      null,
    ]);
    expect(ascending.body.table.sort).toBe(columnId);

    const descending = await readTable(installed.cookie, tablePage.id, `?sort=${columnId}&dir=desc`);
    expect(descending.body.table.rows.map((row) => row.cells[columnId] ?? null)).toEqual([
      "banana",
      "apple",
      null,
      null,
    ]);
    // The blanks keep their stored order rather than flipping with the sort.
    expect(descending.body.table.rows.slice(2).map((row) => row.id)).toEqual([seeded[1], seeded[3]]);
  });

  it("marks a sorted result truncated at the 5,000-row offset ceiling", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const { columnId } = await seedTable(installed, tablePage.id, { column: "text" });
    await seedRows(installed, tablePage.id, 5_001);

    const capped = await readTable(installed.cookie, tablePage.id, `?sort=${columnId}&dir=asc&offset=4500&limit=500`);
    expect(capped.status).toBe(200);
    expect(capped.body.table.rows).toHaveLength(500);
    expect(capped.body.table.hasMore).toBe(false);
    expect(capped.body.table.nextOffset).toBeNull();
    expect(capped.body.table.truncated).toBe(true);
  });

  it("rejects an unknown sort column, a half-written cursor, and an out-of-range offset", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    await seedRows(installed, tablePage.id, 2);

    const unknownSort = await readTable(installed.cookie, tablePage.id, "?sort=not-a-column");
    expect(unknownSort.status).toBe(422);
    expect(unknownSort.body.error?.code).toBe("invalid_table_sort");

    const halfCursor = await readTable(installed.cookie, tablePage.id, "?afterPosition=1");
    expect(halfCursor.status).toBe(422);
    expect(halfCursor.body.error?.code).toBe("invalid_table_cursor");

    const deepOffset = await readTable(installed.cookie, tablePage.id, "?sort=x&offset=999999");
    expect(deepOffset.status).toBe(422);

    const oversizedLimit = await readTable(installed.cookie, tablePage.id, "?limit=5000");
    expect(oversizedLimit.status).toBe(422);
    expect(oversizedLimit.body.error?.code).toBe("invalid_table_cursor");
  });

  it("refuses a cursor on a sorted page, which pages by offset instead", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const { columnId } = await seedTable(installed, tablePage.id, { column: "text" });
    await seedRows(installed, tablePage.id, 2);

    const mixed = await readTable(
      installed.cookie,
      tablePage.id,
      `?sort=${columnId}&afterPosition=0&afterId=${crypto.randomUUID()}`,
    );

    expect(mixed.status).toBe(422);
    expect(mixed.body.error?.code).toBe("invalid_table_cursor");
  });

  it("writes columns, options, rows, and cells in a single bulk request", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const lease = await acquireLease(installed.cookie, tablePage.id);

    const written = await bulkWrite(installed.cookie, tablePage.id, {
      leaseToken: lease.leaseToken,
      expectedRevision: 1,
      columns: [
        { ref: "title", name: "Title", type: "text" },
        { ref: "status", name: "Status", type: "select", options: [{ label: "Todo" }] },
      ],
      rows: [
        { cells: { "ref:title": "First", "ref:status": { option: "Todo" } } },
        // A label never declared up front is created on demand, which is what an
        // export hands over: labels, not generated option ids.
        { cells: { "ref:title": "Second", "ref:status": { option: "Doing" } } },
      ],
    });

    expect(written.status).toBe(201);
    expect(written.body.revision).toBe(2);
    expect(written.body.counts).toEqual({ columns: 2, options: 2, rows: 2, cells: 4 });

    const { body } = await readTable(installed.cookie, tablePage.id, "?count=true");
    expect(body.table.rowCount).toBe(2);
    const status = body.table.columns.find((column) => column.name === "Status")!;
    expect(status.options.map((option) => option.label)).toEqual(["Todo", "Doing"]);
    const titleColumn = body.table.columns.find((column) => column.name === "Title")!;
    expect(body.table.rows.map((row) => row.cells[titleColumn.id])).toEqual(["First", "Second"]);
  });

  it("returns an exact canonical hash and row count for table verification", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const { columnId, rowId } = await seedTable(installed, tablePage.id, { column: "text", row: true });
    await env.DB.prepare(
      `INSERT INTO table_cells (row_id, column_id, text_value, updated_at) VALUES (?, ?, 'exact', ?)`,
    )
      .bind(rowId, columnId, Date.now())
      .run();
    const response = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/tables/${tablePage.id}/verification`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      verification: {
        revision: 1,
        contentHash: await tableContentHash([{ name: "Text", type: "text", options: [] }], [["exact"]]),
        rowCount: 1,
      },
    });
  });

  it("writes nothing at all when the expected revision is stale", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const lease = await acquireLease(installed.cookie, tablePage.id);

    const conflicted = await bulkWrite(installed.cookie, tablePage.id, {
      leaseToken: lease.leaseToken,
      expectedRevision: 99,
      columns: [{ ref: "a", name: "A", type: "text" }],
      rows: [{ cells: { "ref:a": "value" } }],
    });

    expect(conflicted.status).toBe(409);
    expect(conflicted.body.error?.code).toBe("table_revision_conflict");
    // The whole batch is one transaction, so a rejected write must leave no trace.
    const { body } = await readTable(installed.cookie, tablePage.id, "?count=true");
    expect(body.table.rowCount).toBe(0);
    expect(body.table.columns).toHaveLength(0);
    expect(body.table.revision).toBe(1);
  });

  it("rejects a bulk write whose lease has been lost", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    await acquireLease(installed.cookie, tablePage.id);

    const rejected = await bulkWrite(installed.cookie, tablePage.id, {
      leaseToken: "not-the-held-token",
      expectedRevision: 1,
      rows: [{ cells: {} }],
    });

    expect(rejected.status).toBe(409);
    expect(rejected.body.error?.code).toBe("table_lease_lost");
  });

  it("refuses an empty bulk write rather than advancing the revision for nothing", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const lease = await acquireLease(installed.cookie, tablePage.id);

    const empty = await bulkWrite(installed.cookie, tablePage.id, {
      leaseToken: lease.leaseToken,
      expectedRevision: 1,
      columns: [],
      rows: [],
    });

    expect(empty.status).toBe(422);
    expect(empty.body.error?.code).toBe("empty_bulk_write");
  });

  it("rejects an unknown column reference and an oversized batch", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const lease = await acquireLease(installed.cookie, tablePage.id);

    const unknown = await bulkWrite(installed.cookie, tablePage.id, {
      leaseToken: lease.leaseToken,
      expectedRevision: 1,
      rows: [{ cells: { "ref:nope": "value" } }],
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error?.code).toBe("invalid_bulk_reference");

    const oversized = await bulkWrite(installed.cookie, tablePage.id, {
      leaseToken: lease.leaseToken,
      expectedRevision: 1,
      rows: Array.from({ length: TABLE_BULK_MAX_ROWS + 1 }, () => ({ cells: {} })),
    });
    expect(oversized.status).toBe(422);
    expect(oversized.body.error?.code).toBe("bulk_too_large");
  });

  it("replays a repeated bulk write instead of appending the rows twice", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const lease = await acquireLease(installed.cookie, tablePage.id);
    const request = {
      leaseToken: lease.leaseToken,
      expectedRevision: 1,
      clientRequestId: "import-0007",
      columns: [{ ref: "a", name: "A", type: "text" }],
      rows: [{ cells: { "ref:a": "only once" } }],
    };

    const first = await bulkWrite(installed.cookie, tablePage.id, request);
    const second = await bulkWrite(installed.cookie, tablePage.id, request);

    expect(first.status).toBe(201);
    expect(first.body.replayed).toBe(false);
    expect(second.body.replayed).toBe(true);
    expect(second.body.revision).toBe(first.body.revision);
    expect(second.body.rows.map((row) => row.id)).toEqual(first.body.rows.map((row) => row.id));

    const { body } = await readTable(installed.cookie, tablePage.id, "?count=true");
    expect(body.table.rowCount).toBe(1);
  });

  it("binds durable bulk receipts to the canonical columns and rows", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const lease = await acquireLease(installed.cookie, tablePage.id);
    const first = await bulkWrite(installed.cookie, tablePage.id, {
      leaseToken: lease.leaseToken,
      expectedRevision: 1,
      clientRequestId: "import/table/rows/0",
      rows: [{ cells: {} }],
    });
    expect(first.status).toBe(201);

    const reused = await bulkWrite(installed.cookie, tablePage.id, {
      leaseToken: lease.leaseToken,
      expectedRevision: 1,
      clientRequestId: "import/table/rows/0",
      rows: [{ cells: {} }, { cells: {} }],
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error?.code).toBe("idempotency_key_reused");
  });

  it("converges concurrent identical bulk retries on one committed receipt", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const lease = await acquireLease(installed.cookie, tablePage.id);
    const request = {
      leaseToken: lease.leaseToken,
      expectedRevision: 1,
      clientRequestId: "import/table/concurrent/0",
      rows: [{ cells: {} }],
    };
    const [left, right] = await Promise.all([
      bulkWrite(installed.cookie, tablePage.id, request),
      bulkWrite(installed.cookie, tablePage.id, request),
    ]);
    expect([left.status, right.status].sort((first, second) => first - second)).toEqual([200, 201]);
    expect([left.body.replayed, right.body.replayed].sort((first, second) => Number(first) - Number(second))).toEqual([
      false,
      true,
    ]);
    expect(left.body.rows).toEqual(right.body.rows);
    expect((await readTable(installed.cookie, tablePage.id, "?count=true")).body.table.rowCount).toBe(1);
  });

  it("enforces the bulk byte ceiling without a Content-Length header", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const request = authenticatedRequest(installed.cookie, `/api/tables/${tablePage.id}/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
    });
    expect(request.headers.has("content-length")).toBe(false);
    const response = await SELF.fetch(request);
    expect(response.status).toBe(413);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe("bulk_too_large");
  });

  it("extends its own editing lease so a long import cannot outlive it", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const lease = await acquireLease(installed.cookie, tablePage.id);
    // Wind the lease close to expiry; a real import spends far longer than 60s.
    const nearlyExpired = Date.now() + 5_000;
    await env.DB.prepare(`UPDATE table_leases SET expires_at = ? WHERE page_id = ?`)
      .bind(nearlyExpired, tablePage.id)
      .run();

    const written = await bulkWrite(installed.cookie, tablePage.id, {
      leaseToken: lease.leaseToken,
      expectedRevision: 1,
      rows: [{ cells: {} }],
    });

    expect(written.status).toBe(201);
    const renewed = await env.DB.prepare(`SELECT expires_at FROM table_leases WHERE page_id = ?`)
      .bind(tablePage.id)
      .first<{ expires_at: number }>();
    expect(renewed!.expires_at).toBeGreaterThan(nearlyExpired);
  });

  it("uploads a file in parts and serves the reassembled object", async () => {
    const installed = await bootstrap();
    // Two parts, because a single-part upload never exercises R2's equal-size rule.
    const size = 5 * MIB + 1_024;
    const started = await initUpload(installed.cookie, installed.pageId, {
      name: "recording.mp4",
      mime: "video/mp4",
      size,
      partSize: 5 * MIB,
    });
    expect(started.status).toBe(201);
    expect(started.body.upload.partCount).toBe(2);

    const first = filledBytes(5 * MIB, 7);
    const second = filledBytes(1_024, 9);
    expect((await putUploadPart(installed.cookie, started.body.upload.id, 1, first)).status).toBe(200);
    expect((await putUploadPart(installed.cookie, started.body.upload.id, 2, second)).status).toBe(200);

    const completed = await completeUpload(installed.cookie, started.body.upload.id);
    expect(completed.status).toBe(201);
    expect(completed.body.attachment.size).toBe(size);

    const download = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/attachments/${completed.body.attachment.id}`),
    );
    expect(download.status).toBe(200);
    const downloaded = new Uint8Array(await download.arrayBuffer());
    expect(downloaded.byteLength).toBe(size);
    expect(downloaded[0]).toBe(7);
    expect(downloaded.at(-1)).toBe(9);

    // Video has to serve inline, or the editor's media block offers a download.
    expect(download.headers.get("content-disposition")).toMatch(/^inline/);

    const ranged = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/attachments/${completed.body.attachment.id}`, {
        headers: { range: `bytes=${5 * MIB}-${5 * MIB + 3}` },
      }),
    );
    expect(ranged.status).toBe(206);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(new Uint8Array([9, 9, 9, 9]));

    // The finished session is gone, so the reaper has nothing left to collect.
    expect(await env.DB.prepare(`SELECT COUNT(*) count FROM attachment_uploads`).first<{ count: number }>()).toEqual({
      count: 0,
    });

    const replay = await completeUpload(installed.cookie, started.body.upload.id);
    expect(replay.status).toBe(200);
    expect(replay.body.attachment.id).toBe(completed.body.attachment.id);
    const status = await SELF.fetch(authenticatedRequest(installed.cookie, `/api/uploads/${started.body.upload.id}`));
    expect(await status.json()).toMatchObject({ status: "committed", attachment: { id: started.body.upload.id } });
  });

  it("preserves r2_complete when D1 attachment finalization fails, then commits on retry", async () => {
    const installed = await bootstrap();
    const started = await initUpload(installed.cookie, installed.pageId, {
      attachmentId: crypto.randomUUID(),
      name: "recoverable.bin",
      mime: "application/octet-stream",
      size: 1_024,
    });
    expect((await putUploadPart(installed.cookie, started.body.upload.id, 1, filledBytes(1_024))).status).toBe(200);

    await env.DB.prepare(
      `CREATE TRIGGER fail_attachment_commit BEFORE INSERT ON attachments
       BEGIN SELECT RAISE(ABORT, 'forced attachment commit failure'); END`,
    ).run();
    try {
      const failed = await completeUpload(installed.cookie, started.body.upload.id);
      expect(failed.status).toBe(500);
      expect(
        await env.DB.prepare(`SELECT state FROM attachment_uploads WHERE id = ?`).bind(started.body.upload.id).first(),
      ).toEqual({ state: "r2_complete" });
    } finally {
      await env.DB.prepare(`DROP TRIGGER fail_attachment_commit`).run();
    }

    const retried = await completeUpload(installed.cookie, started.body.upload.id);
    expect(retried.status).toBe(201);
    expect(retried.body.attachment.id).toBe(started.body.upload.id);
    expect(
      await env.DB.prepare(`SELECT 1 FROM attachment_uploads WHERE id = ?`).bind(started.body.upload.id).first(),
    ).toBeNull();
  });

  it("atomically fences a part upload racing the reaper", async () => {
    const installed = await bootstrap();
    const started = await initUpload(installed.cookie, installed.pageId, {
      name: "part-race.bin",
      mime: "application/octet-stream",
      size: 1_024,
    });
    await env.DB.prepare(`UPDATE attachment_uploads SET next_attempt_at = 1 WHERE id = ?`)
      .bind(started.body.upload.id)
      .run();

    const [part] = await Promise.all([
      putUploadPart(installed.cookie, started.body.upload.id, 1, filledBytes(1_024)),
      processDueUploadReaps(env),
    ]);
    const session = await env.DB.prepare(`SELECT state FROM attachment_uploads WHERE id = ?`)
      .bind(started.body.upload.id)
      .first<{ state: string }>();
    const partCount = await env.DB.prepare(`SELECT COUNT(*) count FROM attachment_upload_parts WHERE upload_id = ?`)
      .bind(started.body.upload.id)
      .first();
    expect([
      { status: 200, session: { state: "active" }, partCount: { count: 1 } },
      { status: 404, session: null, partCount: { count: 0 } },
      { status: 409, session: null, partCount: { count: 0 } },
    ]).toContainEqual({ status: part.status, session, partCount });
  });

  it("atomically resolves completion racing the reaper", async () => {
    const installed = await bootstrap();
    const started = await initUpload(installed.cookie, installed.pageId, {
      name: "completion-race.bin",
      mime: "application/octet-stream",
      size: 1_024,
    });
    expect((await putUploadPart(installed.cookie, started.body.upload.id, 1, filledBytes(1_024))).status).toBe(200);
    await env.DB.prepare(`UPDATE attachment_uploads SET next_attempt_at = 1 WHERE id = ?`)
      .bind(started.body.upload.id)
      .run();

    const [completion] = await Promise.all([
      completeUpload(installed.cookie, started.body.upload.id),
      processDueUploadReaps(env),
    ]);
    const attachment = await env.DB.prepare(`SELECT id FROM attachments WHERE id = ?`)
      .bind(started.body.upload.id)
      .first();
    const session = await env.DB.prepare(`SELECT state FROM attachment_uploads WHERE id = ?`)
      .bind(started.body.upload.id)
      .first();
    expect([
      { status: 201, attachment: { id: started.body.upload.id }, session: null },
      { status: 404, attachment: null, session: null },
      { status: 409, attachment: null, session: null },
    ]).toContainEqual({ status: completion.status, attachment, session });
  });

  it("rejects a mistyped part and a part number outside the upload", async () => {
    const installed = await bootstrap();
    const started = await initUpload(installed.cookie, installed.pageId, {
      name: "notes.bin",
      mime: "application/octet-stream",
      size: 2_048,
    });
    expect(started.body.upload.partCount).toBe(1);

    const wrongSize = await putUploadPart(installed.cookie, started.body.upload.id, 1, filledBytes(64));
    expect(wrongSize.status).toBe(422);
    expect(wrongSize.body.error?.code).toBe("upload_part_size");

    const outOfRange = await putUploadPart(installed.cookie, started.body.upload.id, 5, filledBytes(2_048));
    expect(outOfRange.status).toBe(422);
    expect(outOfRange.body.error?.code).toBe("upload_part_size");
  });

  it("refuses to complete an upload that is missing a part", async () => {
    const installed = await bootstrap();
    const started = await initUpload(installed.cookie, installed.pageId, {
      name: "big.bin",
      mime: "application/octet-stream",
      size: 5 * MIB + 16,
      partSize: 5 * MIB,
    });
    await putUploadPart(installed.cookie, started.body.upload.id, 1, filledBytes(5 * MIB));

    const completed = await completeUpload(installed.cookie, started.body.upload.id);

    expect(completed.status).toBe(409);
    expect(completed.body.error?.code).toBe("upload_incomplete");
  });

  it("rejects a denylisted file type before any bytes are uploaded", async () => {
    const installed = await bootstrap();

    const started = await initUpload(installed.cookie, installed.pageId, {
      name: "payload.svg",
      mime: "image/svg+xml",
      size: 1_024,
    });

    expect(started.status).toBe(415);
    expect(started.body.error?.code).toBe("unsafe_file_type");
    expect(await env.DB.prepare(`SELECT COUNT(*) count FROM attachment_uploads`).first<{ count: number }>()).toEqual({
      count: 0,
    });
  });

  it("abandons an aborted upload and stops accepting parts for it", async () => {
    const installed = await bootstrap();
    const started = await initUpload(installed.cookie, installed.pageId, {
      name: "cancelled.bin",
      mime: "application/octet-stream",
      size: 1_024,
    });

    const aborted = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/uploads/${started.body.upload.id}`, { method: "DELETE" }),
    );
    expect(aborted.status).toBe(200);

    const orphaned = await putUploadPart(installed.cookie, started.body.upload.id, 1, filledBytes(1_024));
    expect(orphaned.status).toBe(404);
    expect(orphaned.body.error?.code).toBe("upload_session_not_found");
  });

  it("reaps an upload session nobody finished", async () => {
    const installed = await bootstrap();
    const started = await initUpload(installed.cookie, installed.pageId, {
      name: "abandoned.bin",
      mime: "application/octet-stream",
      size: 1_024,
    });
    // Wind the session past its deadline rather than waiting out the 24 hour TTL.
    await env.DB.prepare(`UPDATE attachment_uploads SET next_attempt_at = 1 WHERE id = ?`)
      .bind(started.body.upload.id)
      .run();

    const context = createExecutionContext();
    await worker.scheduled!(createScheduledController(), env, context);
    await waitOnExecutionContext(context);

    expect(await env.DB.prepare(`SELECT COUNT(*) count FROM attachment_uploads`).first<{ count: number }>()).toEqual({
      count: 0,
    });
  });

  it("honors and safely replays a client-generated page id", async () => {
    const installed = await bootstrap();
    const id = crypto.randomUUID();
    const post = (body: unknown) =>
      SELF.fetch(
        authenticatedRequest(installed.cookie, "/api/pages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const requested = { id, parentId: installed.pageId, kind: "document", title: "Stable page" };

    const created = await post(requested);
    expect(created.status).toBe(201);
    const createdBody = await created.json<{ page: Page }>();
    expect(createdBody).toMatchObject({ page: requested });

    const replayed = await post(requested);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ page: requested });

    await env.DB.prepare(`UPDATE pages SET title = 'Renamed', parent_id = NULL, archived_at = ? WHERE id = ?`)
      .bind(Date.now(), id)
      .run();
    const replayedAfterMutation = await post(requested);
    expect(replayedAfterMutation.status).toBe(409);
    expect((await replayedAfterMutation.json<{ error: { code: string } }>()).error.code).toBe("page_archived");

    const mismatched = await post({ ...requested, title: "Different" });
    expect(mismatched.status).toBe(409);
    expect((await mismatched.json<{ error: { code: string } }>()).error.code).toBe("idempotency_key_reused");

    const invalid = await post({ ...requested, id: "not/a/page/id" });
    expect(invalid.status).toBe(422);
  });

  it("records, reads, and idempotently replays an exact page move", async () => {
    const installed = await bootstrap();
    const sibling = await createPage(installed.cookie);
    const operationId = crypto.randomUUID();
    const moveBody: { parentId: string | null; beforeId: string | null; afterId: string | null } = {
      parentId: null,
      beforeId: null,
      afterId: null,
    };
    const move = (requestedOperationId: string | null, body = moveBody) =>
      SELF.fetch(
        authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/move`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(requestedOperationId === null ? {} : { "x-notes-operation-id": requestedOperationId }),
          },
          body: JSON.stringify(body),
        }),
      );

    const first = await move(operationId);
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ page: Page; operationId: string; replayed: boolean }>();
    expect(firstBody).toMatchObject({ operationId, replayed: false, page: { id: installed.pageId, revision: 2 } });

    const receipt = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/moves/${operationId}`),
    );
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toEqual({ operationId, page: firstBody.page });

    const laterMove = await move(crypto.randomUUID(), { parentId: null, beforeId: sibling.id, afterId: null });
    expect(laterMove.status).toBe(200);
    expect((await laterMove.json<{ page: Page }>()).page.revision).toBe(3);

    const replay = await move(operationId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...firstBody, replayed: true });
    expect(
      await env.DB.prepare(`SELECT revision FROM pages WHERE id = ?`)
        .bind(installed.pageId)
        .first<{ revision: number }>(),
    ).toEqual({ revision: 3 });

    const reused = await move(operationId, { parentId: null, beforeId: sibling.id, afterId: null });
    expect(reused.status).toBe(409);
    expect((await reused.json<{ error: { code: string } }>()).error.code).toBe("idempotency_key_reused");

    const legacyMove = await move(null);
    expect(legacyMove.status).toBe(200);
    expect(await legacyMove.json()).toMatchObject({
      operationId: expect.any(String),
      replayed: false,
      page: { id: installed.pageId, revision: 4 },
    });

    const emptyOperationIdMove = await move("");
    expect(emptyOperationIdMove.status).toBe(200);
    expect(await emptyOperationIdMove.json()).toMatchObject({
      operationId: expect.any(String),
      replayed: false,
      page: { id: installed.pageId, revision: 5 },
    });

    const whitespaceOperationIdMove = await move("   ");
    expect(whitespaceOperationIdMove.status).toBe(200);
    expect(await whitespaceOperationIdMove.json()).toMatchObject({
      operationId: expect.any(String),
      replayed: false,
      page: { id: installed.pageId, revision: 6 },
    });
  });

  it("does not move or receipt a page archived immediately before the move batch", async () => {
    const installed = await bootstrap();
    const operationId = crypto.randomUUID();
    const intercepted = envArchivingPageBeforeNextBatch(env, installed.pageId);
    const context = createExecutionContext();
    const response = await worker.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-notes-operation-id": operationId },
        body: JSON.stringify({ parentId: null, beforeId: null, afterId: null }),
      }),
      intercepted.bindings,
      context,
    );
    const body = await response.json<{ error: { code: string } }>();
    await waitOnExecutionContext(context);

    expect(intercepted.moveBatchWasIntercepted()).toBe(true);
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("page_archived");
    expect(
      await env.DB.prepare(`SELECT revision, archived_at FROM pages WHERE id = ?`)
        .bind(installed.pageId)
        .first<{ revision: number; archived_at: number | null }>(),
    ).toMatchObject({ revision: 2, archived_at: expect.any(Number) });
    expect(
      await env.DB.prepare(`SELECT COUNT(*) count FROM page_move_receipts WHERE operation_id = ?`)
        .bind(operationId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("reports an ambiguous archive race when its move receipt cannot be read", async () => {
    const installed = await bootstrap();
    const operationId = crypto.randomUUID();
    const intercepted = envArchivingPageBeforeNextBatch(env, installed.pageId, {
      failReceiptReadsAfterBatch: true,
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => logged.mockRestore());
    const context = createExecutionContext();
    const response = await worker.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-notes-operation-id": operationId },
        body: JSON.stringify({ parentId: null, beforeId: null, afterId: null }),
      }),
      intercepted.bindings,
      context,
    );
    const body = await response.json<{ error: { code: string } }>();
    await waitOnExecutionContext(context);

    expect(intercepted.moveBatchWasIntercepted()).toBe(true);
    expect(response.status).toBe(503);
    expect(body.error.code).toBe("page_move_unresolved");
    expect(logged).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith("The page move failed and its committed receipt could not be read.", {
      workspaceId: installed.workspaceId,
      pageId: installed.pageId,
      operationId,
      moveErrorName: "Error",
      moveErrorMessage: "The page was archived before it could be moved.",
      moveErrorStack: expect.any(String),
      moveErrorType: "object",
      moveErrorStatus: 409,
      moveErrorCode: "page_archived",
      receiptErrorName: intercepted.replayError.name,
      receiptErrorMessage: intercepted.replayError.message,
      receiptErrorStack: expect.any(String),
      receiptErrorType: "object",
    });
  });

  it("replays a concurrent committed move when the page is archived before the duplicate batch", async () => {
    const installed = await bootstrap();
    const operationId = crypto.randomUUID();
    const body = { parentId: null, beforeId: null, afterId: null };
    let committedPage: Page | null = null;
    const intercepted = envArchivingPageBeforeNextBatch(env, installed.pageId, {
      beforeBatch: async () => {
        const committed = await SELF.fetch(
          authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/move`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-notes-operation-id": operationId },
            body: JSON.stringify(body),
          }),
        );
        expect(committed.status).toBe(200);
        committedPage = (await committed.json<{ page: Page }>()).page;
      },
    });
    const context = createExecutionContext();
    const response = await worker.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-notes-operation-id": operationId },
        body: JSON.stringify(body),
      }),
      intercepted.bindings,
      context,
    );
    const responseBody = await response.json<{ page: Page; replayed: boolean }>();
    await waitOnExecutionContext(context);

    expect(intercepted.moveBatchWasIntercepted()).toBe(true);
    expect(response.status).toBe(200);
    expect(responseBody).toEqual({ page: committedPage, operationId, replayed: true });
  });

  it("returns an unresolved result and logs both move failures", async () => {
    const installed = await bootstrap();
    const failed = envFailingMoveBatchAndReplay(env);
    const operationId = crypto.randomUUID();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => logged.mockRestore());
    const context = createExecutionContext();
    const response = await worker.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-notes-operation-id": operationId },
        body: JSON.stringify({ parentId: null, beforeId: null, afterId: null }),
      }),
      failed.bindings,
      context,
    );
    const body = await response.json<{ error: { code: string } }>();
    await waitOnExecutionContext(context);

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("page_move_unresolved");
    expect(logged).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith("The page move failed and its committed receipt could not be read.", {
      workspaceId: installed.workspaceId,
      pageId: installed.pageId,
      operationId,
      moveErrorName: failed.batchError.name,
      moveErrorMessage: failed.batchError.message,
      moveErrorStack: expect.any(String),
      moveErrorType: "object",
      receiptErrorName: failed.replayError.name,
      receiptErrorMessage: failed.replayError.message,
      receiptErrorStack: expect.any(String),
      receiptErrorType: "object",
    });
  });

  it("returns the same unresolved result when an idempotent replay receipt cannot be read", async () => {
    const installed = await bootstrap();
    const operationId = crypto.randomUUID();
    const request = () =>
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-notes-operation-id": operationId },
        body: JSON.stringify({ parentId: null, beforeId: null, afterId: null }),
      });
    expect((await SELF.fetch(request())).status).toBe(200);
    const failed = envFailingPageMoveReceiptReads(env);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => logged.mockRestore());
    const context = createExecutionContext();

    const response = await worker.fetch(request(), failed.bindings, context);
    const body = await response.json<{ error: { code: string } }>();
    await waitOnExecutionContext(context);

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("page_move_unresolved");
    expect(logged).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith("The page move failed and its committed receipt could not be read.", {
      workspaceId: installed.workspaceId,
      pageId: installed.pageId,
      operationId,
      receiptErrorName: failed.receiptError.name,
      receiptErrorMessage: failed.receiptError.message,
      receiptErrorStack: expect.any(String),
      receiptErrorType: "object",
    });
  });

  it("broadcasts a move recovered after the batch commits but its response is lost", async () => {
    const installed = await bootstrap();
    const operationId = crypto.randomUUID();
    const delivered: Array<{ workspaceId: string; event: WorkspaceEvent }> = [];
    const intercepted = envRejectingNextBatchAfterCommit(env, delivered);
    const context = createExecutionContext();
    const response = await worker.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-notes-operation-id": operationId },
        body: JSON.stringify({ parentId: null, beforeId: null, afterId: null }),
      }),
      intercepted.bindings,
      context,
    );
    const body = await response.json<{ page: Page; replayed: boolean }>();
    await waitOnExecutionContext(context);

    expect(intercepted.moveBatchWasIntercepted()).toBe(true);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ replayed: true, page: { id: installed.pageId, revision: 2 } });
    expect(delivered).toEqual([
      {
        workspaceId: installed.workspaceId,
        event: { type: "pages-upserted", pages: [body.page] },
      },
    ]);
  });

  it("logs both failures when a committed move receipt is invalid", async () => {
    const installed = await bootstrap();
    const operationId = crypto.randomUUID();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => logged.mockRestore());
    const intercepted = envRejectingNextBatchAfterCommit(env, [], async () => {
      await env.DB.prepare(`UPDATE page_move_receipts SET response_json = ? WHERE operation_id = ?`)
        .bind("{", operationId)
        .run();
    });
    const context = createExecutionContext();
    const response = await worker.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-notes-operation-id": operationId },
        body: JSON.stringify({ parentId: null, beforeId: null, afterId: null }),
      }),
      intercepted.bindings,
      context,
    );
    await waitOnExecutionContext(context);

    expect(response.status).toBe(500);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe("internal_error");
    expect(logged).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith("The page move failed and its committed receipt was invalid.", {
      workspaceId: installed.workspaceId,
      pageId: installed.pageId,
      operationId,
      moveErrorName: "Error",
      moveErrorMessage: "D1 response lost after commit",
      moveErrorStack: expect.any(String),
      moveErrorType: "object",
      receiptErrorName: "InvalidPageMoveReceiptError",
      receiptErrorMessage: "A stored page move receipt contains malformed JSON.",
      receiptErrorStack: expect.any(String),
      receiptErrorType: "object",
      receiptErrorCauseName: "SyntaxError",
      receiptErrorCauseMessage: expect.any(String),
      receiptErrorCauseStack: expect.any(String),
      receiptErrorCauseType: "object",
    });
  });

  it("logs an invalid receipt lookup once with reconciliation identifiers", async () => {
    const installed = await bootstrap();
    const operationId = crypto.randomUUID();
    const moved = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-notes-operation-id": operationId },
        body: JSON.stringify({ parentId: null, beforeId: null, afterId: null }),
      }),
    );
    expect(moved.status).toBe(200);
    await env.DB.prepare(`UPDATE page_move_receipts SET response_json = ? WHERE operation_id = ?`)
      .bind("{", operationId)
      .run();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => logged.mockRestore());

    const response = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/moves/${operationId}`),
    );

    expect(response.status).toBe(500);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe("internal_error");
    expect(logged).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith("The page move failed and its committed receipt was invalid.", {
      workspaceId: installed.workspaceId,
      pageId: installed.pageId,
      operationId,
      receiptErrorName: "InvalidPageMoveReceiptError",
      receiptErrorMessage: "A stored page move receipt contains malformed JSON.",
      receiptErrorStack: expect.any(String),
      receiptErrorType: "object",
      receiptErrorCauseName: "SyntaxError",
      receiptErrorCauseMessage: expect.any(String),
      receiptErrorCauseStack: expect.any(String),
      receiptErrorCauseType: "object",
    });
  });

  it("returns an unresolved result when the reconciliation receipt cannot be read", async () => {
    const installed = await bootstrap();
    const operationId = crypto.randomUUID();
    const failed = envFailingPageMoveReceiptReads(env);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => logged.mockRestore());
    const context = createExecutionContext();

    const response = await worker.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/moves/${operationId}`),
      failed.bindings,
      context,
    );
    const body = await response.json<{ error: { code: string } }>();
    await waitOnExecutionContext(context);

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("page_move_unresolved");
    expect(logged).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith("The page move failed and its committed receipt could not be read.", {
      workspaceId: installed.workspaceId,
      pageId: installed.pageId,
      operationId,
      receiptErrorName: failed.receiptError.name,
      receiptErrorMessage: failed.receiptError.message,
      receiptErrorStack: expect.any(String),
      receiptErrorType: "object",
    });
  });

  it("accepts legacy page move snapshots and rejects unsupported, malformed, or mismatched snapshots", async () => {
    const installed = await bootstrap();
    const operationId = crypto.randomUUID();
    const moved = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-notes-operation-id": operationId },
        body: JSON.stringify({ parentId: null, beforeId: null, afterId: null }),
      }),
    );
    expect(moved.status).toBe(200);
    const movedPage = (await moved.json<{ page: Page }>()).page;
    const receipt = async (snapshot: unknown) => {
      await env.DB.prepare(`UPDATE page_move_receipts SET response_json = ? WHERE operation_id = ?`)
        .bind(JSON.stringify(snapshot), operationId)
        .run();
      return SELF.fetch(authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/moves/${operationId}`));
    };

    expect((await receipt(movedPage)).status).toBe(200);
    expect((await receipt({ pageMoveReceiptVersion: PAGE_MOVE_RECEIPT_VERSION + 1, page: movedPage })).status).toBe(
      500,
    );
    expect((await receipt({ pageMoveReceiptVersion: PAGE_MOVE_RECEIPT_VERSION, page: movedPage })).status).toBe(200);
    expect((await receipt({ pageMoveReceiptVersion: PAGE_MOVE_RECEIPT_VERSION, page: { id: 123 } })).status).toBe(500);
    expect(
      (
        await receipt({
          pageMoveReceiptVersion: PAGE_MOVE_RECEIPT_VERSION,
          page: { ...movedPage, id: crypto.randomUUID() },
        })
      ).status,
    ).toBe(500);
    expect(
      (
        await receipt({
          pageMoveReceiptVersion: PAGE_MOVE_RECEIPT_VERSION,
          page: { ...movedPage, workspaceId: crypto.randomUUID() },
        })
      ).status,
    ).toBe(500);
  });

  it("bounds receipt-pruning catch-up and warns only while expired receipts remain", async () => {
    const installed = await bootstrap();
    const move = async (operationId: string) => {
      const response = await SELF.fetch(
        authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/move`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-notes-operation-id": operationId },
          body: JSON.stringify({ parentId: null, beforeId: null, afterId: null }),
        }),
      );
      expect(response.status).toBe(200);
    };
    const currentOperationId = crypto.randomUUID();
    await move(currentOperationId);
    const insertExpired = (prefix: string, count: number) =>
      env.DB.prepare(
        `INSERT INTO page_move_receipts
           (workspace_id, operation_id, page_id, request_hash, response_json, created_at)
         SELECT ?, value, ?, 'expired-request', '{}', 0 FROM json_each(?)`,
      )
        .bind(
          installed.workspaceId,
          installed.pageId,
          JSON.stringify(Array.from({ length: count }, (_, index) => `${prefix}-${index}`)),
        )
        .run();
    const countExpired = () =>
      env.DB.prepare(`SELECT COUNT(*) count FROM page_move_receipts WHERE created_at = 0`).first<{ count: number }>();
    const runPrune = async () => {
      const context = createExecutionContext();
      await worker.scheduled(createScheduledController(), env, context);
      await waitOnExecutionContext(context);
    };
    const warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    onTestFinished(() => warned.mockRestore());

    const pruneCapacity = PAGE_MOVE_RECEIPT_PRUNE_BATCH_SIZE * PAGE_MOVE_RECEIPT_PRUNE_MAX_BATCHES;

    await insertExpired("exact-capacity", pruneCapacity);
    await runPrune();
    expect(await countExpired()).toEqual({ count: 0 });
    expect(warned).not.toHaveBeenCalled();

    await insertExpired("over-capacity", pruneCapacity + 1);
    await runPrune();
    expect(await countExpired()).toEqual({ count: 1 });
    expect(warned).toHaveBeenCalledOnce();
    expect(warned).toHaveBeenCalledWith(
      "Page move receipt pruning reached its hourly catch-up limit; expired receipts may remain.",
      {
        batchSize: PAGE_MOVE_RECEIPT_PRUNE_BATCH_SIZE,
        maxBatches: PAGE_MOVE_RECEIPT_PRUNE_MAX_BATCHES,
      },
    );

    await runPrune();
    expect(await countExpired()).toEqual({ count: 0 });
    expect(warned).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(`SELECT COUNT(*) count FROM page_move_receipts WHERE operation_id = ?`)
        .bind(currentOperationId)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it("does not expose a move receipt under another page or operation id", async () => {
    const installed = await bootstrap();
    const sibling = await createPage(installed.cookie);
    const operationId = crypto.randomUUID();
    const moved = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-notes-operation-id": operationId },
        body: JSON.stringify({ parentId: null, beforeId: null, afterId: null }),
      }),
    );
    expect(moved.status).toBe(200);

    const wrongPage = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${sibling.id}/moves/${operationId}`),
    );
    expect(wrongPage.status).toBe(404);
    expect((await wrongPage.json<{ error: { code: string } }>()).error.code).toBe("move_not_found");

    const wrongOperation = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/moves/${crypto.randomUUID()}`),
    );
    expect(wrongOperation.status).toBe(404);
    expect((await wrongOperation.json<{ error: { code: string } }>()).error.code).toBe("move_not_found");
  });

  it("preserves legacy page-create replays when no receipt was backfilled", async () => {
    const installed = await bootstrap();
    const id = crypto.randomUUID();
    const requested = { id, parentId: installed.pageId, kind: "document", title: "Legacy page" };
    const post = () =>
      SELF.fetch(
        authenticatedRequest(installed.cookie, "/api/pages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requested),
        }),
      );

    const created = await post();
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    await env.DB.prepare(`DELETE FROM page_create_receipts WHERE workspace_id = ? AND page_id = ?`)
      .bind(installed.workspaceId, id)
      .run();

    const replayed = await post();
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toEqual(createdBody);
  });

  it("rejects a cross-workspace receipt and classifies a foreign page id as reuse", async () => {
    const installed = await bootstrap();
    const id = crypto.randomUUID();
    const foreignWorkspaceId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES (?, 'Foreign workspace', ?)`).bind(
        foreignWorkspaceId,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO pages (id, workspace_id, kind, position, title, created_by, created_at, updated_at)
         VALUES (?, ?, 'document', 'a0', 'Foreign page', ?, ?, ?)`,
      ).bind(id, foreignWorkspaceId, installed.userId, timestamp, timestamp),
    ]);

    const response = await SELF.fetch(
      authenticatedRequest(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, parentId: null, kind: "document", title: "Local page" }),
      }),
    );

    expect(response.status).toBe(409);
    expect((await response.json<{ error: { code: string } }>()).error.code).toBe("idempotency_key_reused");

    const requestHash = await sha256Hex(canonicalJson({ parentId: null, kind: "document", title: "Foreign page" }));
    await expect(
      env.DB.prepare(`INSERT INTO page_create_receipts (workspace_id, page_id, request_hash) VALUES (?, ?, ?)`)
        .bind(installed.workspaceId, id, requestHash)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);

    const matchingForeignPage = await SELF.fetch(
      authenticatedRequest(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, parentId: null, kind: "document", title: "Foreign page" }),
      }),
    );
    expect(matchingForeignPage.status).toBe(409);
    expect((await matchingForeignPage.json<{ error: { code: string } }>()).error.code).toBe("idempotency_key_reused");
  });

  it("rejects a cross-workspace batch receipt and classifies the foreign page id as reuse", async () => {
    const installed = await bootstrap();
    const id = crypto.randomUUID();
    const foreignWorkspaceId = crypto.randomUUID();
    const timestamp = Date.now();
    const pages = [{ id, parentId: null, kind: "document", title: "Foreign batch page" }];
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES (?, 'Foreign workspace', ?)`).bind(
        foreignWorkspaceId,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO pages (id, workspace_id, kind, position, title, created_by, created_at, updated_at)
         VALUES (?, ?, 'document', 'a0', 'Foreign batch page', ?, ?, ?)`,
      ).bind(id, foreignWorkspaceId, installed.userId, timestamp, timestamp),
    ]);
    await expect(
      env.DB.prepare(`INSERT INTO page_create_receipts (workspace_id, page_id, request_hash) VALUES (?, ?, ?)`)
        .bind(installed.workspaceId, id, await sha256Hex(canonicalJson(pages)))
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);

    const response = await SELF.fetch(
      authenticatedRequest(installed.cookie, "/api/pages/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pages }),
      }),
    );
    const body = await response.json<{ error?: { code: string }; pages?: Page[] }>();
    expect(response.status).toBe(409);
    expect(body).toEqual({ error: expect.objectContaining({ code: "idempotency_key_reused" }) });
  });

  it("replays an exact create but preserves missing-parent precedence for mismatched reuse", async () => {
    const installed = await bootstrap();
    const id = crypto.randomUUID();
    const requested = { id, parentId: installed.pageId, kind: "document", title: "Child" };
    const create = await SELF.fetch(
      authenticatedRequest(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requested),
      }),
    );
    expect(create.status).toBe(201);
    await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), installed.pageId).run();

    const replay = await SELF.fetch(
      authenticatedRequest(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requested),
      }),
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ page: requested });

    const invalidParent = await SELF.fetch(
      authenticatedRequest(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, parentId: crypto.randomUUID(), kind: "document", title: "Child" }),
      }),
    );

    expect(invalidParent.status).toBe(404);
    expect((await invalidParent.json<{ error: { code: string } }>()).error.code).toBe("page_not_found");
  });

  it("keeps single-page create replays silent and rejects an archived replay", async () => {
    const installed = await bootstrap();
    const delivered: Array<{ workspaceId: string; event: WorkspaceEvent }> = [];
    const bindings = envWithCapturedWorkspaceEvents(env, delivered);
    const requested = { id: crypto.randomUUID(), parentId: null, kind: "document", title: "Replay page" };
    const request = () =>
      authenticatedRequest(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requested),
      });

    const createContext = createExecutionContext();
    expect((await worker.fetch(request(), bindings, createContext)).status).toBe(201);
    await waitOnExecutionContext(createContext);
    delivered.length = 0;

    const replayContext = createExecutionContext();
    const replay = await worker.fetch(request(), bindings, replayContext);
    const replayBody = await replay.json<{ page: Page }>();
    await waitOnExecutionContext(replayContext);
    expect(replay.status).toBe(200);
    expect(replayBody).toMatchObject({ page: requested });
    expect(delivered).toEqual([]);

    await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), requested.id).run();
    delivered.length = 0;
    const archivedReplayContext = createExecutionContext();
    const archivedReplay = await worker.fetch(request(), bindings, archivedReplayContext);
    const archivedReplayBody = await archivedReplay.json<{ error: { code: string } }>();
    await waitOnExecutionContext(archivedReplayContext);
    expect(archivedReplay.status).toBe(409);
    expect(archivedReplayBody.error.code).toBe("page_archived");
    expect(delivered).toEqual([]);
  });

  it("keeps page-batch replays silent and rejects a partly archived replay", async () => {
    const installed = await bootstrap();
    const delivered: Array<{ workspaceId: string; event: WorkspaceEvent }> = [];
    const bindings = envWithCapturedWorkspaceEvents(env, delivered);
    const pages = [
      { id: crypto.randomUUID(), parentId: null, kind: "document", title: "Replay A" },
      { id: crypto.randomUUID(), parentId: null, kind: "document", title: "Replay B" },
    ];
    const request = () =>
      authenticatedRequest(installed.cookie, "/api/pages/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pages }),
      });

    const createContext = createExecutionContext();
    expect((await worker.fetch(request(), bindings, createContext)).status).toBe(201);
    await waitOnExecutionContext(createContext);
    delivered.length = 0;

    const replayContext = createExecutionContext();
    const replay = await worker.fetch(request(), bindings, replayContext);
    const replayBody = await replay.json<{ pages: Page[]; replayed: boolean }>();
    await waitOnExecutionContext(replayContext);
    expect(replay.status).toBe(200);
    expect(replayBody.replayed).toBe(true);
    expect(replayBody).toMatchObject({ pages });
    expect(delivered).toEqual([]);

    await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), pages[0]!.id).run();
    const archivedReplayContext = createExecutionContext();
    const archivedReplay = await worker.fetch(request(), bindings, archivedReplayContext);
    const archivedReplayBody = await archivedReplay.json<{ error: { code: string } }>();
    await waitOnExecutionContext(archivedReplayContext);
    expect(archivedReplay.status).toBe(409);
    expect(archivedReplayBody.error.code).toBe("page_archived");
    expect(delivered).toEqual([]);
  });

  it("broadcasts a committed page create when its insert result is unexpectedly empty", async () => {
    const installed = await bootstrap();
    const delivered: Array<{ workspaceId: string; event: WorkspaceEvent }> = [];
    const requested = { id: crypto.randomUUID(), parentId: null, kind: "document", title: "Recovered page" };
    const hidden = envWithPageCreateBatchIntercepted(env, delivered, [requested.id], {
      hideFirstPageResult: true,
    });
    const context = createExecutionContext();

    await hidden.bindings.DB.batch([hidden.bindings.DB.prepare(`SELECT 1 marker`)]);
    expect(hidden.pageCreateBatchWasIntercepted()).toBe(false);

    const response = await worker.fetch(
      authenticatedRequest(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requested),
      }),
      hidden.bindings,
      context,
    );
    const body = await response.json<{ page: Page }>();
    await waitOnExecutionContext(context);

    expect(hidden.pageCreateBatchWasIntercepted()).toBe(true);
    expect(response.status).toBe(201);
    expect(body).toMatchObject({ page: requested });
    expect(delivered).toEqual([
      {
        workspaceId: installed.workspaceId,
        event: { type: "pages-upserted", pages: [body.page] },
      },
    ]);
  });

  it("broadcasts a committed page batch when an insert result is unexpectedly empty", async () => {
    const installed = await bootstrap();
    const delivered: Array<{ workspaceId: string; event: WorkspaceEvent }> = [];
    const pages = [
      { id: crypto.randomUUID(), parentId: null, kind: "document", title: "Recovered A" },
      { id: crypto.randomUUID(), parentId: null, kind: "table", title: "Recovered B" },
    ];
    const hidden = envWithPageCreateBatchIntercepted(
      env,
      delivered,
      pages.map((page) => page.id),
      { hideFirstPageResult: true },
    );
    const context = createExecutionContext();

    const response = await worker.fetch(
      authenticatedRequest(installed.cookie, "/api/pages/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pages }),
      }),
      hidden.bindings,
      context,
    );
    const body = await response.json<{ pages: Page[]; replayed: boolean }>();
    await waitOnExecutionContext(context);

    expect(hidden.pageCreateBatchWasIntercepted()).toBe(true);
    expect(response.status).toBe(201);
    expect(body).toMatchObject({ pages, replayed: false });
    expect(delivered).toEqual([
      {
        workspaceId: installed.workspaceId,
        event: { type: "pages-upserted", pages: body.pages },
      },
    ]);
  });

  it("drops a stale single-create upsert when the page is archived after insert", async () => {
    const installed = await bootstrap();
    const delivered: Array<{ workspaceId: string; event: WorkspaceEvent }> = [];
    const requested = { id: crypto.randomUUID(), parentId: null, kind: "document", title: "Stale snapshot" };
    const intercepted = envWithPageCreateBatchIntercepted(env, delivered, [requested.id], {
      afterPageCreateBatch: async () => {
        await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), requested.id).run();
      },
    });
    const context = createExecutionContext();

    const response = await worker.fetch(
      authenticatedRequest(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requested),
      }),
      intercepted.bindings,
      context,
    );
    const body = await response.json<{ page: Page }>();
    await waitOnExecutionContext(context);

    expect(intercepted.pageCreateBatchWasIntercepted()).toBe(true);
    expect(response.status).toBe(201);
    expect(body.page.archivedAt).toBeNull();
    expect(delivered).toEqual([
      {
        workspaceId: installed.workspaceId,
        event: { type: "workspace-invalidated" },
      },
    ]);
  });

  it("removes an archived page from a stale batch-create upsert", async () => {
    const installed = await bootstrap();
    const delivered: Array<{ workspaceId: string; event: WorkspaceEvent }> = [];
    const pages = [
      { id: crypto.randomUUID(), parentId: null, kind: "document", title: "Stale snapshot" },
      { id: crypto.randomUUID(), parentId: null, kind: "document", title: "Active snapshot" },
    ];
    const intercepted = envWithPageCreateBatchIntercepted(
      env,
      delivered,
      pages.map((page) => page.id),
      {
        afterPageCreateBatch: async () => {
          await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), pages[0]!.id).run();
        },
      },
    );
    const context = createExecutionContext();

    const response = await worker.fetch(
      authenticatedRequest(installed.cookie, "/api/pages/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pages }),
      }),
      intercepted.bindings,
      context,
    );
    const body = await response.json<{ pages: Page[]; replayed: boolean }>();
    await waitOnExecutionContext(context);

    expect(intercepted.pageCreateBatchWasIntercepted()).toBe(true);
    expect(response.status).toBe(201);
    expect(body.pages.every((page) => page.archivedAt === null)).toBe(true);
    expect(delivered).toEqual([
      {
        workspaceId: installed.workspaceId,
        event: { type: "workspace-invalidated" },
      },
    ]);
  });

  it("does not broadcast a committed page archived before single-create recovery", async () => {
    const installed = await bootstrap();
    const delivered: Array<{ workspaceId: string; event: WorkspaceEvent }> = [];
    const requested = { id: crypto.randomUUID(), parentId: null, kind: "document", title: "Archived recovery" };
    const hidden = envWithPageCreateBatchIntercepted(env, delivered, [requested.id], {
      hideFirstPageResult: true,
      afterPageCreateBatch: async () => {
        await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), requested.id).run();
      },
    });
    const context = createExecutionContext();

    const response = await worker.fetch(
      authenticatedRequest(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requested),
      }),
      hidden.bindings,
      context,
    );
    const body = await response.json<{ error: { code: string } }>();
    await waitOnExecutionContext(context);

    expect(hidden.pageCreateBatchWasIntercepted()).toBe(true);
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("page_archived");
    expect(delivered).toEqual([]);
  });

  it("does not broadcast a committed page archived before batch-create recovery", async () => {
    const installed = await bootstrap();
    const delivered: Array<{ workspaceId: string; event: WorkspaceEvent }> = [];
    const pages = [
      { id: crypto.randomUUID(), parentId: null, kind: "document", title: "Archived recovery" },
      { id: crypto.randomUUID(), parentId: null, kind: "document", title: "Active recovery" },
    ];
    const hidden = envWithPageCreateBatchIntercepted(
      env,
      delivered,
      pages.map((page) => page.id),
      {
        hideFirstPageResult: true,
        afterPageCreateBatch: async () => {
          await env.DB.prepare(`UPDATE pages SET archived_at = ? WHERE id = ?`).bind(Date.now(), pages[0]!.id).run();
        },
      },
    );
    const context = createExecutionContext();

    const response = await worker.fetch(
      authenticatedRequest(installed.cookie, "/api/pages/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pages }),
      }),
      hidden.bindings,
      context,
    );
    const body = await response.json<{ error: { code: string } }>();
    await waitOnExecutionContext(context);

    expect(hidden.pageCreateBatchWasIntercepted()).toBe(true);
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("page_archived");
    expect(delivered).toEqual([]);
  });

  it("cascades a page-create receipt on permanent deletion and permits a new create", async () => {
    const installed = await bootstrap();
    const id = crypto.randomUUID();
    const requested = { id, parentId: null, kind: "document", title: "Reusable page" };
    const post = () =>
      SELF.fetch(
        authenticatedRequest(installed.cookie, "/api/pages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requested),
        }),
      );
    expect((await post()).status).toBe(201);
    expect(
      await env.DB.prepare(`SELECT request_hash FROM page_create_receipts WHERE page_id = ?`).bind(id).first(),
    ).not.toBeNull();
    expect(
      (await SELF.fetch(authenticatedRequest(installed.cookie, `/api/pages/${id}`, { method: "DELETE" }))).status,
    ).toBe(200);
    const context = createExecutionContext();
    const deleted = await worker.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${id}/permanent-delete`, { method: "POST" }),
      env,
      context,
    );
    expect(deleted.status).toBe(202);
    expect(
      await env.DB.prepare(`SELECT request_hash FROM page_create_receipts WHERE page_id = ?`).bind(id).first(),
    ).toBeNull();
    await waitOnExecutionContext(context);

    const recreateContext = createExecutionContext();
    const recreated = await worker.fetch(
      authenticatedRequest(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requested),
      }),
      env,
      recreateContext,
    );
    expect(recreated.status).toBe(201);
    await waitOnExecutionContext(recreateContext);
  });

  it("creates a whole tree level in one request, in the order asked for", async () => {
    const installed = await bootstrap();

    const response = await SELF.fetch(
      authenticatedRequest(installed.cookie, "/api/pages/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pages: [
            { parentId: null, kind: "document", title: "Alpha" },
            { parentId: installed.pageId, kind: "document", title: "Beta" },
            { parentId: installed.pageId, kind: "table", title: "Gamma" },
            { parentId: null, kind: "document", title: "Delta" },
          ],
        }),
      }),
    );

    expect(response.status).toBe(201);
    const { pages } = await response.json<{ pages: { id: string; title: string; parentId: string | null }[] }>();
    expect(pages).toHaveLength(4);
    // Children of one parent keep request order, which is what makes an import's
    // sibling ordering reproducible.
    const children = pages.filter((page) => page.parentId === installed.pageId).map((page) => page.title);
    expect(children).toEqual(["Beta", "Gamma"]);

    // Request order, not position order: positions are generated per parent, so a batch
    // spanning two parents has no global ordering and a caller pairing input to output
    // by index would silently attach content to the wrong pages.
    expect(pages.map((page) => page.title)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);

    // A table page gets its table_state row exactly as the single-page route gives it.
    const table = pages.find((page) => page.title === "Gamma")!;
    expect(await env.DB.prepare(`SELECT page_id FROM table_state WHERE page_id = ?`).bind(table.id).first()).toEqual({
      page_id: table.id,
    });
    // Search rows are seeded for every page, so a batch import is findable immediately.
    const indexed = await env.DB.prepare(`SELECT COUNT(*) count FROM page_search`).first<{ count: number }>();
    expect(indexed!.count).toBe(5);
  });

  it("replays a deterministic page batch and rejects partial or mismatched reuse", async () => {
    const installed = await bootstrap();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    const pages = [
      { id: firstId, parentId: installed.pageId, kind: "document", title: "Stable A" },
      { id: secondId, parentId: installed.pageId, kind: "table", title: "Stable B" },
    ];
    const post = (entries: unknown[]) =>
      SELF.fetch(
        authenticatedRequest(installed.cookie, "/api/pages/batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pages: entries }),
        }),
      );
    const created = await post(pages);
    expect(created.status).toBe(201);
    const createdBody = await created.json<{ pages: Page[]; replayed: boolean }>();
    expect(createdBody).toMatchObject({ replayed: false });
    await env.DB.prepare(`DELETE FROM page_create_receipts WHERE workspace_id = ? AND page_id = ?`)
      .bind(installed.workspaceId, secondId)
      .run();
    const mixedReceiptReplay = await post(pages);
    expect(mixedReceiptReplay.status).toBe(200);
    expect(await mixedReceiptReplay.json()).toEqual({ replayed: true, pages: createdBody.pages });

    await env.DB.prepare(`UPDATE pages SET title = 'Renamed', parent_id = NULL, archived_at = ? WHERE id = ?`)
      .bind(Date.now(), firstId)
      .run();
    const replayed = await post(pages);
    expect(replayed.status).toBe(409);
    expect((await replayed.json<{ error: { code: string } }>()).error.code).toBe("page_archived");

    const mismatch = await post([{ ...pages[0], title: "Different" }, pages[1]]);
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json<{ error: { code: string } }>()).error.code).toBe("idempotency_key_reused");
    const missingParent = await post([{ ...pages[0], parentId: crypto.randomUUID() }, pages[1]]);
    expect(missingParent.status).toBe(404);
    expect((await missingParent.json<{ error: { code: string } }>()).error.code).toBe("page_not_found");
    const partial = await post([pages[0], { ...pages[1], id: crypto.randomUUID() }]);
    expect(partial.status).toBe(409);
  });

  it("returns the indexed sequence and exact canonical document projection hash", async () => {
    const installed = await bootstrap();
    const target = await createPage(installed.cookie);
    await env.DB.batch([
      env.DB.prepare(`UPDATE pages SET plain_text = 'Canonical text', indexed_seq = 7 WHERE id = ?`).bind(
        installed.pageId,
      ),
      env.DB.prepare(
        `INSERT INTO page_references (source_page_id, target_page_id, excerpt, projection_seq)
         VALUES (?, ?, '', 7)`,
      ).bind(installed.pageId, target.id),
      env.DB.prepare(
        `INSERT INTO member_mentions
           (workspace_id, source_page_id, target_user_id, excerpt, first_seen_at, projection_seq)
         VALUES (?, ?, ?, '', ?, 7)`,
      ).bind(installed.workspaceId, installed.pageId, installed.userId, Date.now()),
    ]);
    const response = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/verification`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      verification: {
        indexedSequence: 7,
        plainTextLength: 14,
        projectionHash: await documentProjectionHash({
          plainText: "Canonical text",
          pageReferences: [{ targetId: target.id, excerpt: "" }],
          memberMentions: [{ targetId: installed.userId, excerpt: "" }],
        }),
      },
    });
  });

  it("rejects a batch that is empty, oversized, or names a missing parent", async () => {
    const installed = await bootstrap();
    async function batch(body: unknown) {
      const response = await SELF.fetch(
        authenticatedRequest(installed.cookie, "/api/pages/batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, body: await response.json<{ error?: { code: string } }>() };
    }

    expect((await batch({ pages: [] })).status).toBe(422);

    const oversized = await batch({ pages: Array.from({ length: 51 }, () => ({ parentId: null })) });
    expect(oversized.status).toBe(422);
    expect(oversized.body.error?.code).toBe("batch_too_large");

    const orphan = await batch({ pages: [{ parentId: crypto.randomUUID() }] });
    expect(orphan.status).toBe(404);
    // Nothing is created when the parent check fails.
    expect(await env.DB.prepare(`SELECT COUNT(*) count FROM pages`).first<{ count: number }>()).toEqual({ count: 1 });
  });

  it("distinguishes a stale table revision from a lost editing lease", async () => {
    const installed = await bootstrap();
    const tablePage = await createPage(installed.cookie, "table");
    const { columnId, rowId } = await seedTable(installed, tablePage.id, { column: "text", row: true });
    const lease = await acquireLease(installed.cookie, tablePage.id);
    await env.DB.prepare(`UPDATE table_state SET revision = 2 WHERE page_id = ?`).bind(tablePage.id).run();
    const cellPath = `/api/tables/${tablePage.id}/cells/${rowId}/${columnId}`;

    const staleRevision = await SELF.fetch(
      authenticatedRequest(installed.cookie, cellPath, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseToken: lease.leaseToken, expectedRevision: 1, value: "stale" }),
      }),
    );

    expect(staleRevision.status).toBe(409);
    expect(await staleRevision.json()).toMatchObject({ error: { code: "table_revision_conflict" } });

    const retried = await SELF.fetch(
      authenticatedRequest(installed.cookie, cellPath, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseToken: lease.leaseToken, expectedRevision: 2, value: "saved" }),
      }),
    );
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ revision: 3 });

    const lostLease = await SELF.fetch(
      authenticatedRequest(installed.cookie, cellPath, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseToken: "wrong-token", expectedRevision: 3, value: "lost" }),
      }),
    );
    expect(lostLease.status).toBe(409);
    expect(await lostLease.json()).toMatchObject({ error: { code: "table_lease_lost" } });
  });

  it("paginates mention traversal before advancing the read watermark", async () => {
    const installed = await bootstrap();
    const extraPageIds = Array.from({ length: 100 }, () => crypto.randomUUID());
    const timestamp = Date.now() - 10_000;
    for (let offset = 0; offset < extraPageIds.length; offset += 50) {
      await env.DB.batch(
        extraPageIds.slice(offset, offset + 50).map((pageId, index) =>
          env.DB.prepare(
            `INSERT INTO pages
          (id, workspace_id, kind, position, title, created_by, created_at, updated_at)
         VALUES (?, ?, 'document', ?, ?, ?, ?, ?)`,
          ).bind(
            pageId,
            installed.workspaceId,
            `mention-${offset + index}`,
            `Mention page ${offset + index}`,
            installed.userId,
            timestamp,
            timestamp,
          ),
        ),
      );
    }
    const sourcePageIds = [installed.pageId, ...extraPageIds];
    for (let offset = 0; offset < sourcePageIds.length; offset += 50) {
      await env.DB.batch(
        sourcePageIds.slice(offset, offset + 50).map((pageId, index) =>
          env.DB.prepare(
            `INSERT INTO member_mentions
          (workspace_id, source_page_id, target_user_id, excerpt, first_seen_at, projection_seq)
         VALUES (?, ?, ?, 'Mention', ?, 1)`,
          ).bind(installed.workspaceId, pageId, installed.userId, timestamp + offset + index),
        ),
      );
    }

    const first = await (
      await SELF.fetch(authenticatedRequest(installed.cookie, "/api/mentions"))
    ).json<{
      asOf: number;
      mentions: Array<{ page: { id: string } }>;
      nextCursor: { firstSeenAt: number; pageId: string } | null;
    }>();
    expect(first.mentions).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    expect(
      await env.DB.prepare(`SELECT read_at FROM mention_reads WHERE workspace_id = ? AND user_id = ?`)
        .bind(installed.workspaceId, installed.userId)
        .first(),
    ).toBeNull();

    const query = new URLSearchParams({
      asOf: String(first.asOf),
      beforeAt: String(first.nextCursor!.firstSeenAt),
      beforeId: first.nextCursor!.pageId,
    });
    const second = await (
      await SELF.fetch(authenticatedRequest(installed.cookie, `/api/mentions?${query}`))
    ).json<{
      mentions: Array<{ page: { id: string } }>;
      nextCursor: { firstSeenAt: number; pageId: string } | null;
    }>();
    expect(second.mentions).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.mentions, ...second.mentions].map((item) => item.page.id)).size).toBe(101);

    const read = await SELF.fetch(
      authenticatedRequest(installed.cookie, "/api/mentions/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ through: first.asOf }),
      }),
    );
    expect(await read.json()).toEqual({ unreadCount: 0 });
  });

  it("materializes only same-workspace references and applies mention read cursors", async () => {
    const installed = await bootstrap();
    const target = await createPage(installed.cookie);
    const foreignWorkspace = crypto.randomUUID();
    const foreignUser = crypto.randomUUID();
    const foreignPage = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Foreign', 'foreign@example.test', 1, ?, ?)`,
      ).bind(foreignUser, timestamp, timestamp),
      env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES (?, 'Foreign workspace', ?)`).bind(
        foreignWorkspace,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
      ).bind(foreignWorkspace, foreignUser, timestamp),
      env.DB.prepare(
        `INSERT INTO pages (id, workspace_id, kind, position, title, created_by, created_at, updated_at)
         VALUES (?, ?, 'document', 'a0', 'Foreign page', ?, ?, ?)`,
      ).bind(foreignPage, foreignWorkspace, foreignUser, timestamp, timestamp),
    ]);

    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const fragment = document.document.getXmlFragment("document-store");
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "Discuss ");
      paragraph.insert(0, [text]);
      for (const [entityType, entityId, label] of [
        ["page", target.id, "Target"],
        ["page", foreignPage, "Foreign page"],
        ["user", installed.userId, "Owner"],
        ["user", foreignUser, "Foreign"],
        ["page", target.id, "Target"],
      ] as const) {
        const mention = new Y.XmlElement("mention");
        mention.setAttribute("entityType", entityType);
        mention.setAttribute("entityId", entityId);
        mention.setAttribute("label", label);
        paragraph.insert(paragraph.length, [mention]);
      }
      fragment.insert(0, [paragraph]);
      await document.onSave();
      await document.compact();
    });

    const pageTargets = await env.DB.prepare(`SELECT target_page_id FROM page_references WHERE source_page_id = ?`)
      .bind(installed.pageId)
      .all<{ target_page_id: string }>();
    expect(pageTargets.results).toEqual([{ target_page_id: target.id }]);
    const userTargets = await env.DB.prepare(
      `SELECT target_user_id, first_seen_at FROM member_mentions WHERE source_page_id = ?`,
    )
      .bind(installed.pageId)
      .all<{ target_user_id: string; first_seen_at: number }>();
    expect(userTargets.results.map((row) => row.target_user_id)).toEqual([installed.userId]);
    const firstSeen = userTargets.results[0]!.first_seen_at;

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("unrelated").set("change", 1);
      await document.onSave();
      await document.compact();
    });
    expect(
      (
        await env.DB.prepare(
          `SELECT first_seen_at FROM member_mentions WHERE source_page_id = ? AND target_user_id = ?`,
        )
          .bind(installed.pageId, installed.userId)
          .first<{ first_seen_at: number }>()
      )?.first_seen_at,
    ).toBe(firstSeen);

    await env.DB.prepare(`UPDATE member_mentions SET first_seen_at = ? WHERE source_page_id = ?`)
      .bind(Date.now() - 1_000, installed.pageId)
      .run();
    const unread = await SELF.fetch(authenticatedRequest(installed.cookie, "/api/mentions/unread-count"));
    expect(await unread.json()).toEqual({ unreadCount: 1 });
    const inbox = await (
      await SELF.fetch(authenticatedRequest(installed.cookie, "/api/mentions"))
    ).json<{
      asOf: number;
      mentions: Array<{ page: { id: string }; unread: boolean }>;
    }>();
    expect(inbox.mentions).toMatchObject([{ page: { id: installed.pageId }, unread: true }]);
    const laterSource = await createPage(installed.cookie);
    await env.DB.prepare(
      `INSERT INTO member_mentions
        (workspace_id, source_page_id, target_user_id, excerpt, first_seen_at, projection_seq)
       VALUES (?, ?, ?, 'Later mention', ?, 1)`,
    )
      .bind(installed.workspaceId, laterSource.id, installed.userId, inbox.asOf + 1)
      .run();
    const read = await SELF.fetch(
      authenticatedRequest(installed.cookie, "/api/mentions/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ through: inbox.asOf }),
      }),
    );
    expect(await read.json()).toEqual({ unreadCount: 1 });
    expect(
      await (await SELF.fetch(authenticatedRequest(installed.cookie, "/api/mentions/unread-count"))).json(),
    ).toEqual({ unreadCount: 1 });

    const backlinks = await (
      await SELF.fetch(authenticatedRequest(installed.cookie, `/api/pages/${target.id}/backlinks`))
    ).json<{ backlinks: Array<{ page: { id: string } }> }>();
    expect(backlinks.backlinks.map((item) => item.page.id)).toEqual([installed.pageId]);
    expect((await SELF.fetch(authenticatedRequest(installed.cookie, `/api/pages/${foreignPage}/preview`))).status).toBe(
      404,
    );

    await runInDurableObject(stub, async (instance) => {
      const document = instance as unknown as TestDocument;
      const fragment = document.document.getXmlFragment("document-store");
      fragment.delete(0, fragment.length);
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "References removed");
      paragraph.insert(0, [text]);
      fragment.insert(0, [paragraph]);
      await document.onSave();
      await document.compact();
    });
    expect(
      (
        await env.DB.prepare(`SELECT COUNT(*) count FROM page_references WHERE source_page_id = ?`)
          .bind(installed.pageId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });

  it("queues subtree deletion, purges every document epoch, and retries unfinished targets on cron", async () => {
    const installed = await bootstrap();
    const child = await createPage(installed.cookie, "document", installed.pageId);
    await env.DB.prepare(`UPDATE pages SET content_epoch = 3 WHERE id = ?`).bind(installed.pageId).run();
    await env.DB.prepare(`UPDATE pages SET content_epoch = 2 WHERE id = ?`).bind(child.id).run();

    const rooms = [
      `${installed.pageId}~1`,
      `${installed.pageId}~2`,
      `${installed.pageId}~3`,
      `${child.id}~1`,
      `${child.id}~2`,
    ];
    const emptySnapshot = Y.encodeStateAsUpdate(new Y.Doc());
    for (const room of rooms) {
      const stub = env.DOCUMENT.getByName(room);
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put("sentinel", room);
      });
    }
    for (const pageId of [installed.pageId, child.id]) {
      await env.BUCKET.put(`documents/${pageId}/epochs/1/current.bin`, emptySnapshot);
      await env.BUCKET.put(`documents/${pageId}/versions/old.bin`, emptySnapshot);
    }
    const attachmentKeys = Array.from({ length: 55 }, (_, index) => `assets/${installed.workspaceId}/batch-${index}`);
    await Promise.all(attachmentKeys.map((key) => env.BUCKET.put(key, "attachment")));
    await env.DB.batch(
      attachmentKeys.map((key, index) =>
        env.DB.prepare(
          `INSERT INTO attachments
        (id, workspace_id, page_id, r2_key, name, mime, size, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'text/plain', 10, ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          installed.workspaceId,
          installed.pageId,
          key,
          `batch-${index}.txt`,
          installed.userId,
          Date.now(),
        ),
      ),
    );

    const archived = await SELF.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}`, {
        method: "DELETE",
      }),
    );
    expect(archived.status).toBe(200);
    const archiveResult = await archived.json<{ pageIds: string[] }>();
    expect(archiveResult.pageIds).toHaveLength(2);
    expect(archiveResult.pageIds).toEqual(expect.arrayContaining([installed.pageId, child.id]));
    const context = createExecutionContext();
    const deleted = await worker.fetch(
      authenticatedRequest(installed.cookie, `/api/pages/${installed.pageId}/permanent-delete`, { method: "POST" }),
      env,
      context,
    );
    expect(deleted.status).toBe(202);
    expect(await deleted.json()).toEqual({
      ok: true,
      pageIds: expect.arrayContaining([installed.pageId, child.id]),
      cleanupPending: true,
    });
    await waitOnExecutionContext(context);

    expect((await env.DB.prepare(`SELECT COUNT(*) count FROM pages`).first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare(`SELECT COUNT(*) count FROM page_search`).first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare(`SELECT COUNT(*) count FROM deletion_jobs`).first<{ count: number }>())?.count).toBe(
      0,
    );
    for (const pageId of [installed.pageId, child.id]) {
      expect((await env.BUCKET.list({ prefix: `documents/${pageId}/` })).objects).toHaveLength(0);
    }
    expect(await Promise.all(attachmentKeys.map((key) => env.BUCKET.get(key)))).toEqual(attachmentKeys.map(() => null));
    for (const room of rooms) {
      const stateAfterPurge = await runInDurableObject(env.DOCUMENT.getByName(room), async (_instance, state) => ({
        sentinel: await state.storage.get("sentinel"),
        alarm: await state.storage.getAlarm(),
      }));
      expect(stateAfterPurge.sentinel).toBeUndefined();
      expect(stateAfterPurge.alarm).toBeNull();
    }

    const retryJob = crypto.randomUUID();
    const retryPrefix = "documents/retry-me/";
    const retryTime = Date.now();
    await env.BUCKET.put(`${retryPrefix}current.bin`, "retry");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO deletion_jobs (id, workspace_id, root_page_id, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, 'deleted-root', ?, ?, ?)`,
      ).bind(retryJob, installed.workspaceId, retryTime - 1, retryTime, retryTime),
      env.DB.prepare(
        `INSERT INTO deletion_targets (job_id, kind, target, completed_at)
         VALUES (?, 'r2_object', 'already-complete', ?)`,
      ).bind(retryJob, retryTime),
      env.DB.prepare(`INSERT INTO deletion_targets (job_id, kind, target) VALUES (?, 'r2_prefix', ?)`).bind(
        retryJob,
        retryPrefix,
      ),
    ]);
    const scheduledContext = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, scheduledContext);
    await waitOnExecutionContext(scheduledContext);
    expect(await env.BUCKET.get(`${retryPrefix}current.bin`)).toBeNull();
    expect(await env.DB.prepare(`SELECT id FROM deletion_jobs WHERE id = ?`).bind(retryJob).first()).toBeNull();
  });

  it("claims a due deletion job only once across concurrent processors", async () => {
    const installed = await bootstrap();
    const jobId = crypto.randomUUID();
    const target = `assets/${installed.workspaceId}/claim-once`;
    const timestamp = Date.now();
    await env.BUCKET.put(target, "delete me");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO deletion_jobs (id, workspace_id, root_page_id, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, 'claim-root', ?, ?, ?)`,
      ).bind(jobId, installed.workspaceId, timestamp, timestamp, timestamp),
      env.DB.prepare(`INSERT INTO deletion_targets (job_id, kind, target) VALUES (?, 'r2_object', ?)`).bind(
        jobId,
        target,
      ),
    ]);
    await Promise.all([processDeletionJob(env, jobId), processDeletionJob(env, jobId)]);
    expect(await env.BUCKET.get(target)).toBeNull();
    expect(await env.DB.prepare(`SELECT id FROM deletion_jobs WHERE id = ?`).bind(jobId).first()).toBeNull();
  });

  it("reconciles a pending restore once when a real alarm wakes a restarted room", async () => {
    const installed = await bootstrap();
    const room = `${installed.pageId}~1`;
    const stub = env.DOCUMENT.getByName(room);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      state.storage.sql.exec(
        `INSERT INTO restore_recovery (id, old_epoch, new_epoch, new_key, pre_key)
         VALUES (1, 1, 2, 'cold-wake-new', 'cold-wake-pre')`,
      );
      state.storage.sql.exec(
        `UPDATE document_meta SET retired = 1, restore_pending = 1, restore_attempts = 0, restore_retry_at = 0 WHERE id = 1`,
      );
      document.metadata.retired = 1;
      document.metadata.restore_pending = 1;
      document.metadata.restore_attempts = 0;
      document.metadata.restore_retry_at = 0;
      // Far out, so the runtime cannot deliver it before the restart;
      // runDurableObjectAlarm runs whatever is stored regardless of when it is due.
      await state.storage.setAlarm(Date.now() + 60 * 60_000);
    });

    // The instance-level proxies the other backoff tests use die with the
    // instance, so break the dependency itself: it has to still be failing when
    // a fresh instance reads it.
    await env.DB.exec("ALTER TABLE pages RENAME TO pages_offline");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await abortAllDurableObjects();
    const restarted = env.DOCUMENT.getByName(room);
    try {
      // partyserver initializes before it delivers an alarm, so this one wake
      // runs onStart and then onAlarm. Only onStart may contact the dependency.
      expect(await runDurableObjectAlarm(restarted)).toBe(true);
      expect(
        error.mock.calls.filter(([message]) => message === "Failed to reconcile pending document restore"),
      ).toHaveLength(1);
    } finally {
      error.mockRestore();
      await env.DB.exec("ALTER TABLE pages_offline RENAME TO pages");
    }

    await runInDurableObject(restarted, async (_instance, state) => {
      const meta = state.storage.sql
        .exec<{ restore_pending: number; restore_attempts: number; restore_retry_at: number }>(
          `SELECT restore_pending, restore_attempts, restore_retry_at FROM document_meta WHERE id = 1`,
        )
        .one();
      expect(meta.restore_pending).toBe(1);
      expect(meta.restore_attempts).toBe(1);
      expect(meta.restore_retry_at).toBeGreaterThan(Date.now());
      // The delivery consumed the stored alarm, so the skipped second attempt
      // still has to leave the backoff armed.
      expect(await state.storage.getAlarm()).toBe(meta.restore_retry_at);
    });
  });

  // abortAllDurableObjects simulates a crash rather than a graceful eviction and
  // intentionally invalidates the test isolate, so keep these destructive restart
  // scenarios last in the file.
  it("recovers a pending update log when an instance restarts after dirty was cleared", async () => {
    const installed = await bootstrap();
    const room = `${installed.pageId}~1`;
    const stub = env.DOCUMENT.getByName(room);
    await stub.fetch(internalWarmupRequest());
    await runInDurableObject(stub, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      document.document.getMap("restart-content").set("value", 1);
      await document.onSave();
      state.storage.sql.exec(`UPDATE document_meta SET dirty = 0 WHERE id = 1`);
      // The reconciliation backoff has to survive eviction: a fresh instance
      // must resume from the persisted attempt count, not the fast first retry.
      state.storage.sql.exec(`UPDATE document_meta SET restore_attempts = 3 WHERE id = 1`);
      await state.storage.deleteAlarm();
    });

    await abortAllDurableObjects();
    const restarted = env.DOCUMENT.getByName(room);
    await restarted.fetch(internalWarmupRequest());
    await runInDurableObject(restarted, async (instance, state) => {
      const document = instance as unknown as TestDocument;
      expect(
        state.storage.sql.exec<{ dirty: number }>(`SELECT dirty FROM document_meta WHERE id = 1`).one().dirty,
      ).toBe(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect(document.metadata.restore_attempts).toBe(3);
    });
  });
});
