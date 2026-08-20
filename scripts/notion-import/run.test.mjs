import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tableContentHash } from "../../src/shared/import-integrity.ts";
import {
  canonicalSourceTable,
  deterministicResourceId,
  importTable,
  planTableRowBatches,
  reconcileCommitted,
  runImport,
  selectPages,
} from "./run.mjs";

async function planFor(table) {
  const canonical = canonicalSourceTable(table);
  return {
    table,
    batches: table.columns.length ? planTableRowBatches(table) : [],
    contentHash: await tableContentHash(canonical.columns, canonical.rows),
  };
}

describe("selectPages", () => {
  it("includes ancestors when a limited child sorts before its parent", () => {
    const parent = { path: "Cool 3333333333333333333333333333cccc.html", parent: null };
    const child = { path: "Cool 3333-cccc/Nested.html", parent };

    expect(selectPages([child, parent], 1)).toEqual([child, parent]);
  });
});

describe("deterministic import resources", () => {
  it("is stable within an import and namespaced across imports", () => {
    const first = deterministicResourceId("a".repeat(32), "page", "Page.html");
    expect(deterministicResourceId("a".repeat(32), "page", "Page.html")).toBe(first);
    expect(deterministicResourceId("b".repeat(32), "page", "Page.html")).not.toBe(first);
    expect(first).toMatch(/^[\da-f-]{36}$/);
  });
});

describe("runImport", () => {
  it("rejects a short page batch before recording shifted ids", async () => {
    const page = {
      path: "Page.html",
      parent: null,
      kind: "document",
      title: "Page",
      assets: [],
    };
    const root = mkdtempSync(join(tmpdir(), "notion-run-test-"));
    writeFileSync(join(root, page.path), '<html><body><div class="page-body"><p>Page</p></div></body></html>');
    const manifest = {
      state: {},
      node: vi.fn(() => null),
      record: vi.fn(),
      recordNow: vi.fn(),
      flush: vi.fn(),
    };

    await expect(
      runImport({
        index: {
          pages: [page],
          root,
          pagesByPath: new Map([[page.path, page]]),
          assetsByPath: new Map(),
          byPath: new Map([[page.path, [page]]]),
          assetIndex: new Map(),
        },
        client: { createPages: vi.fn(async () => []) },
        manifest,
        report: { issue: vi.fn(), progress: vi.fn(), inPage: vi.fn() },
        rootParentId: null,
        limit: 1,
        lingerMs: 0,
      }),
    ).rejects.toThrow(/returned 0 results for 1 pages/);
    expect(manifest.record).toHaveBeenCalledWith(
      page.path,
      expect.objectContaining({ plannedPageId: expect.any(String), expectedPage: expect.any(Object) }),
    );
  });

  it("keeps a collaborator edit made after a fresh page is created", async () => {
    const page = {
      path: "Page.html",
      parent: null,
      kind: "document",
      title: "Page",
      assets: [],
    };
    const root = mkdtempSync(join(tmpdir(), "notion-run-test-"));
    writeFileSync(join(root, page.path), '<html><body><div class="page-body"><p>Imported</p></div></body></html>');
    const state = { importId: "a".repeat(32), nodes: {} };
    const update = (path, patch) => {
      state.nodes[path] = { ...state.nodes[path], ...patch };
    };
    const manifest = {
      state,
      node: (path) => state.nodes[path] ?? null,
      record: vi.fn(update),
      recordNow: vi.fn(update),
      flush: vi.fn(),
    };
    const documentPush = vi.fn(async () => ({
      conflict: true,
      liveProjectionHash: "collaborator-document",
      updates: 0,
    }));
    const report = {
      errorCount: 0,
      error: vi.fn(),
      issue: vi.fn(),
      progress: vi.fn(),
      inPage: vi.fn(),
    };

    await expect(
      runImport({
        index: {
          pages: [page],
          root,
          pagesByPath: new Map([[page.path, page]]),
          assetsByPath: new Map(),
          byPath: new Map([[page.path, [page]]]),
          assetIndex: new Map(),
        },
        client: {
          createPages: vi.fn(async (pages) => pages.map(({ id }) => ({ id, contentEpoch: 1 }))),
        },
        manifest,
        report,
        rootParentId: null,
        limit: 1,
        lingerMs: 0,
        documentPush,
      }),
    ).resolves.toMatchObject({ written: 0, errors: 0 });
    expect(documentPush).toHaveBeenCalledWith(
      expect.objectContaining({ expectedProjectionHashes: [expect.stringMatching(/^[a-f\d]{64}$/)] }),
    );
    expect(state.nodes[page.path].content).toMatchObject({
      status: "destination-owned",
      acceptedRemoteHash: "collaborator-document",
    });
    expect(report.issue).toHaveBeenCalledWith("destination_document_kept", "Page");
  });

  it("names the database when table batch planning fails", async () => {
    const database = {
      path: "Table.html",
      csvPath: "Table.csv",
      parent: null,
      kind: "database",
      title: "Table",
      assets: [],
    };
    const root = mkdtempSync(join(tmpdir(), "notion-run-test-"));
    const headers = Array.from({ length: 2_001 }, (_, index) => `Column ${index}`);
    writeFileSync(join(root, database.csvPath), `${headers.join(",")}\n${headers.map(() => "x").join(",")}\n`);
    const manifest = {
      state: {},
      node: vi.fn(() => null),
      record: vi.fn(),
      recordNow: vi.fn(),
      flush: vi.fn(),
    };

    await expect(
      runImport({
        index: { pages: [database], root },
        client: {},
        manifest,
        report: { issue: vi.fn(), progress: vi.fn(), inPage: vi.fn() },
        rootParentId: null,
        limit: 1,
        lingerMs: 0,
      }),
    ).rejects.toThrow("Table (Table.html): Row 1 has 2001 cells");
    expect(manifest.record).not.toHaveBeenCalled();
  });
});

describe("reconcileCommitted", () => {
  it("recovers a deterministic page whose committed response was lost", async () => {
    const page = { path: "Page.html", kind: "document", title: "Page" };
    const state = {
      nodes: {
        [page.path]: {
          plannedPageId: "page-1",
          expectedPage: { id: "page-1", kind: "document", title: "Page", parentId: null },
        },
      },
    };
    const manifest = {
      state,
      node: (path) => state.nodes[path],
      record(path, patch) {
        state.nodes[path] = { ...state.nodes[path], ...patch };
      },
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      client: {
        pageVerification: vi.fn(async () => ({
          page: { id: "page-1", kind: "document", title: "Page", parentId: null, contentEpoch: 2 },
        })),
      },
    });

    expect(state.nodes[page.path]).toMatchObject({ pageId: "page-1", contentEpoch: 2, sourcePath: page.path });
    expect(report.error).not.toHaveBeenCalled();
  });

  it("accepts destination edits independently for metadata, content, and attachments", async () => {
    const page = { path: "Page.html", kind: "document", title: "Page" };
    const state = {
      nodes: {
        [page.path]: {
          pageId: "page-1",
          expectedPage: { kind: "document", title: "Page", parentId: null },
          content: { status: "written", projectionHash: "local-document" },
          assets: {
            "asset.txt": {
              status: "uploaded",
              id: "asset-1",
              name: "asset.txt",
              mime: "text/plain",
              size: 5,
              contentSha256: "local-asset",
            },
          },
        },
      },
    };
    const manifest = {
      state,
      node(path) {
        return state.nodes[path];
      },
      record(path, patch) {
        state.nodes[path] = { ...state.nodes[path], ...patch };
      },
    };
    const report = { issue: vi.fn(), error: vi.fn() };
    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      client: {
        pageVerification: vi.fn(async () => ({
          page: { kind: "document", title: "Edited", parentId: "other-parent" },
          projectionHash: "remote-document",
        })),
        listAttachments: vi.fn(async () => [
          {
            id: "asset-1",
            name: "renamed.txt",
            mime: "text/plain",
            size: 5,
            contentSha256: "remote-asset",
          },
        ]),
      },
      documentHash: vi.fn(async () => "remote-document"),
    });

    expect(state.nodes[page.path].expectedPage).toMatchObject({
      acceptedRemoteTitle: "Edited",
      acceptedRemoteParentId: "other-parent",
    });
    expect(state.nodes[page.path].content.status).toBe("destination-owned");
    expect(state.nodes[page.path].content.acceptedRemoteHash).toBe("remote-document");
    expect(state.nodes[page.path].assets["asset.txt"].acceptedRemote.contentSha256).toBe("remote-asset");
    expect(report.error).not.toHaveBeenCalled();
  });

  it("resumes active uploads without treating their absent attachment as deleted", async () => {
    const page = { path: "Page.html", kind: "document", title: "Page" };
    const state = {
      nodes: {
        [page.path]: {
          pageId: "page-1",
          expectedPage: { kind: "document", title: "Page", parentId: null },
          assets: {
            "large.bin": {
              status: "uploading",
              id: "asset-1",
              uploadId: "asset-1",
              contentSha256: "a".repeat(64),
              size: 11 * 1024 * 1024,
              name: "large.bin",
              mime: "application/octet-stream",
            },
          },
        },
      },
    };
    const manifest = {
      state,
      node: (path) => state.nodes[path],
      record(path, patch) {
        state.nodes[path] = { ...state.nodes[path], ...patch };
      },
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      client: {
        pageVerification: vi.fn(async () => ({
          page: { kind: "document", title: "Page", parentId: null, contentEpoch: 1 },
        })),
        listAttachments: vi.fn(async () => []),
      },
    });

    expect(state.nodes[page.path].assets["large.bin"].remoteMissing).toBeUndefined();
    expect(report.error).not.toHaveBeenCalled();
  });

  it("accepts destination table edits that race a partially committed import", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "imported" } }, { cells: { "ref:c0": "remaining" } }],
    };
    const state = {
      nodes: {
        [page.path]: {
          pageId: "page-1",
          expectedPage: { kind: "table", title: "Table", parentId: null },
          table: {
            phase: "rows",
            revision: 3,
            columnOffset: 1,
            rowOffset: 1,
            columnsByRef: { c0: "column-1" },
            expectedColumns: 1,
            expectedRows: 2,
          },
        },
      },
    };
    const manifest = {
      state,
      node: (path) => state.nodes[path],
      record(path, patch) {
        state.nodes[path] = { ...state.nodes[path], ...patch };
      },
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      tablePlans: new Map([[page, await planFor(table)]]),
      client: {
        pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
        listAttachments: vi.fn(async () => []),
        tableVerification: vi.fn(async () => ({ revision: 4, contentHash: "b".repeat(64), rowCount: 1 })),
      },
    });

    expect(state.nodes[page.path].table).toMatchObject({
      phase: "complete",
      expectedRows: 2,
      acceptedRemoteHash: "b".repeat(64),
      acceptedRemoteRowCount: 1,
    });
    expect(report.issue).toHaveBeenCalledWith("destination_table_kept", "Table");
    expect(report.error).not.toHaveBeenCalled();
  });

  it("replays an interrupted column commit to recover its generated ids", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "imported" } }],
    };
    const plan = await planFor(table);
    const committedColumn = canonicalSourceTable(table, 1, 0);
    const committedColumnHash = await tableContentHash(committedColumn.columns, committedColumn.rows);
    const state = {
      importId: "a".repeat(32),
      nodes: {
        [page.path]: {
          pageId: "page-1",
          expectedPage: { kind: "table", title: "Table", parentId: null },
          table: {
            phase: "columns",
            revision: 1,
            columnOffset: 0,
            rowOffset: 0,
            columnsByRef: {},
            expectedColumns: 1,
            expectedRows: 1,
            contentHash: plan.contentHash,
          },
        },
      },
    };
    const update = (path, patch) => {
      state.nodes[path] = { ...state.nodes[path], ...patch };
    };
    const manifest = {
      state,
      node: (path) => state.nodes[path],
      record: vi.fn(update),
      recordNow: vi.fn(update),
    };
    const client = {
      pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
      tableVerification: vi.fn(async () => ({ revision: 2, contentHash: committedColumnHash, rowCount: 0 })),
      acquireTableLease: vi
        .fn()
        .mockResolvedValueOnce({ leaseToken: "reconcile-lease" })
        .mockResolvedValueOnce({ leaseToken: "import-lease" }),
      releaseTableLease: vi.fn(async () => undefined),
      bulkTableWrite: vi.fn(async (_pageId, body) => {
        if (body.columns.length) {
          return { revision: 2, columns: [{ ref: "c0", id: "column-1" }], rows: [], replayed: true };
        }
        expect(body.rows).toEqual([{ cells: { "column-1": "imported" } }]);
        return { revision: 3, columns: [], rows: [{ id: "row-1" }] };
      }),
      readTable: vi.fn(async () => ({ table: { revision: 3, columns: [{}], rowCount: 1 } })),
    };
    const report = { issue: vi.fn(), error: vi.fn(), progress: vi.fn() };

    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      tablePlans: new Map([[page, plan]]),
      client,
    });
    expect(state.nodes[page.path].table).toMatchObject({
      revision: 2,
      columnOffset: 1,
      columnsByRef: { c0: "column-1" },
    });
    expect(client.bulkTableWrite).toHaveBeenNthCalledWith(
      1,
      "page-1",
      expect.objectContaining({
        leaseToken: "reconcile-lease",
        expectedRevision: 1,
        clientRequestId: expect.stringContaining(":columns:0:"),
      }),
    );

    await expect(
      importTable({
        index: {},
        client,
        manifest,
        report,
        database: page,
        record: state.nodes[page.path],
        plan,
      }),
    ).resolves.toBe(1);
    expect(state.nodes[page.path].table).toMatchObject({
      phase: "complete",
      rowOffset: 1,
      columnsByRef: { c0: "column-1" },
    });
  });
});

describe("table batching", () => {
  it("records a valid empty table as exactly complete without a bulk mutation", async () => {
    const database = { path: "Empty.html", title: "Empty" };
    const state = { importId: "a".repeat(32), nodes: { [database.path]: { pageId: "page-1" } } };
    const manifest = {
      state,
      record(path, patch) {
        state.nodes[path] = { ...state.nodes[path], ...patch };
      },
    };
    const client = { acquireTableLease: vi.fn(), bulkTableWrite: vi.fn() };

    await expect(
      importTable({
        index: {},
        client,
        manifest,
        report: { issue: vi.fn(), progress: vi.fn() },
        database,
        record: state.nodes[database.path],
        plan: await planFor({ columns: [], rows: [] }),
      }),
    ).resolves.toBe(0);
    expect(state.nodes[database.path].table).toMatchObject({
      phase: "complete",
      expectedColumns: 0,
      expectedRows: 0,
      rowOffset: 0,
      contentHash: expect.stringMatching(/^[a-f\d]{64}$/),
    });
    expect(client.acquireTableLease).not.toHaveBeenCalled();
    expect(client.bulkTableWrite).not.toHaveBeenCalled();
  });

  it("persists the server column map and every row offset across phased batches", async () => {
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: Array.from({ length: 201 }, (_, index) => ({ cells: { "ref:c0": `row ${index}` } })),
    };
    expect(planTableRowBatches(table)).toEqual([
      { start: 0, end: 200 },
      { start: 200, end: 201 },
    ]);
    const database = { path: "Table.html", title: "Table" };
    const state = { importId: "a".repeat(32), nodes: { [database.path]: { pageId: "page-1" } } };
    const update = (path, patch) => {
      state.nodes[path] = { ...state.nodes[path], ...patch };
    };
    const manifest = {
      state,
      node(path) {
        return state.nodes[path];
      },
      record: vi.fn(update),
      recordNow: vi.fn(update),
    };
    let bulk = 0;
    const client = {
      acquireTableLease: vi.fn(async () => ({ leaseToken: "lease" })),
      releaseTableLease: vi.fn(async () => undefined),
      readTable: vi
        .fn()
        .mockResolvedValueOnce({ table: { revision: 1, columns: [], rowCount: 0 } })
        .mockResolvedValueOnce({ table: { revision: 4, columns: [{}], rowCount: 201 } }),
      bulkTableWrite: vi.fn(async (_pageId, body) => {
        bulk += 1;
        if (body.columns.length) {
          return { revision: 2, columns: [{ ref: "c0", id: "column-1" }], rows: [] };
        }
        return {
          revision: bulk + 1,
          columns: [],
          rows: Array.from({ length: body.rows.length }, (_, index) => ({ id: `row-${bulk}-${index}` })),
        };
      }),
    };
    await expect(
      importTable({
        index: {},
        client,
        manifest,
        report: { issue: vi.fn(), progress: vi.fn() },
        database,
        record: state.nodes[database.path],
        plan: await planFor(table),
      }),
    ).resolves.toBe(201);
    expect(client.bulkTableWrite).toHaveBeenCalledTimes(3);
    expect(client.bulkTableWrite.mock.calls.map(([, body]) => body.clientRequestId)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(":columns:0:"),
        expect.stringContaining(":rows:0:"),
        expect.stringContaining(":rows:200:"),
      ]),
    );
    expect(client.bulkTableWrite.mock.calls.every(([, body]) => body.clientRequestId.includes("Table.html"))).toBe(
      true,
    );
    expect(
      manifest.recordNow.mock.calls
        .map(([, patch]) => patch.table?.revision)
        .filter((revision) => revision !== undefined),
    ).toEqual([1, 2, 3, 4]);
    expect(state.nodes[database.path].table).toMatchObject({
      phase: "complete",
      columnOffset: 1,
      rowOffset: 201,
      columnsByRef: { c0: "column-1" },
      expectedRows: 201,
      contentHash: expect.stringMatching(/^[a-f\d]{64}$/),
    });
  });
});
