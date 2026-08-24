import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { documentProjectionHash, tableContentHash } from "../../src/shared/import-integrity.ts";
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

function stubManifest(nodes, importId = "a".repeat(32)) {
  const state = { importId, nodes };
  const update = (path, patch) => {
    state.nodes[path] = { ...state.nodes[path], ...patch };
  };
  return {
    state,
    node: (path) => state.nodes[path] ?? null,
    record: vi.fn(update),
    recordNow: vi.fn(update),
    flush: vi.fn(),
  };
}

function columnProgress(contentHash) {
  return {
    phase: "columns",
    revision: 1,
    columnOffset: 0,
    rowOffset: 0,
    columnsByRef: {},
    expectedColumns: 1,
    expectedRows: 1,
    contentHash,
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
  it("rejects an ambiguous-table settlement that was not already recorded", async () => {
    const database = {
      path: "Table.html",
      parent: null,
      kind: "database",
      title: "Table",
      assets: [],
    };
    const manifest = stubManifest({
      [database.path]: { pageId: "page-1", tableRecoveryAmbiguous: false },
    });

    await expect(
      runImport({
        index: { pages: [database], root: "/unused" },
        client: {},
        manifest,
        report: { issue: vi.fn(), progress: vi.fn(), inPage: vi.fn() },
        rootParentId: null,
        limit: 1,
        lingerMs: 0,
        keepAmbiguousTables: [database.path],
      }),
    ).rejects.toThrow('target "Table.html" is not recorded as table_recovery_ambiguous');
    expect(manifest.record).not.toHaveBeenCalled();
  });

  it("accepts a repeated settlement flag after the table was settled successfully", async () => {
    const database = {
      path: "Table.html",
      csvPath: "Table.csv",
      parent: null,
      kind: "database",
      title: "Table",
      assets: [],
    };
    const root = mkdtempSync(join(tmpdir(), "notion-run-test-"));
    writeFileSync(join(root, database.csvPath), "Value\nimported\n");
    const plan = await planFor({
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "imported" } }],
    });
    const manifest = stubManifest({
      [database.path]: {
        pageId: "page-1",
        contentEpoch: 1,
        expectedPage: { id: "page-1", kind: "table", title: "Table", parentId: null },
        tableRecoveryAmbiguous: false,
        table: {
          phase: "complete",
          revision: 2,
          contentHash: plan.contentHash,
          expectedColumns: 1,
          expectedRows: 1,
          columnOffset: 1,
          rowOffset: 1,
          columnsByRef: { c0: "column-1" },
          acceptedRemoteHash: "d".repeat(64),
          acceptedRemoteRowCount: 0,
          settledByOperator: true,
        },
      },
    });
    const report = {
      errorCount: 0,
      error: vi.fn(),
      issue: vi.fn(),
      progress: vi.fn(),
      inPage: vi.fn(),
    };

    await expect(
      runImport({
        index: { pages: [database], root },
        client: {
          pageVerification: vi.fn(async () => ({
            page: { id: "page-1", kind: "table", title: "Table", parentId: null, contentEpoch: 1 },
          })),
          tableVerification: vi.fn(async () => ({
            revision: 3,
            contentHash: "d".repeat(64),
            rowCount: 0,
          })),
        },
        manifest,
        report,
        rootParentId: null,
        limit: 1,
        lingerMs: 0,
        keepAmbiguousTables: [database.path],
      }),
    ).resolves.toMatchObject({ databases: 1, errors: 0 });
    expect(manifest.state.nodes[database.path].table.settledByOperator).toBe(true);
  });

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
    const manifest = stubManifest({});
    const { state } = manifest;
    const documentPush = vi.fn(async () => ({
      conflict: true,
      liveProjectionHash: "collaborator-document",
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

  it("recovers a page whose first push failed before observing the live document", async () => {
    const page = {
      path: "Page.html",
      parent: null,
      kind: "document",
      title: "Page",
      assets: [],
    };
    const root = mkdtempSync(join(tmpdir(), "notion-run-test-"));
    writeFileSync(join(root, page.path), '<html><body><div class="page-body"><p>Imported</p></div></body></html>');
    const manifest = stubManifest({});
    const { state } = manifest;
    const report = {
      errorCount: 0,
      error: vi.fn(),
      issue: vi.fn(),
      progress: vi.fn(),
      inPage: vi.fn(),
    };
    const index = {
      pages: [page],
      root,
      pagesByPath: new Map([[page.path, page]]),
      assetsByPath: new Map(),
      byPath: new Map([[page.path, [page]]]),
      assetIndex: new Map(),
    };
    const client = {
      createPages: vi.fn(async (pages) => pages.map(({ id }) => ({ id, contentEpoch: 1 }))),
      pageVerification: vi.fn(async () => ({
        page: { kind: "document", title: "Page", parentId: null, contentEpoch: 1 },
      })),
      listAttachments: vi.fn(async () => []),
    };
    const emptyHash = await documentProjectionHash({ plainText: "", pageReferences: [], memberMentions: [] });

    // Run 1: the connection times out before pushDocument's beforeWrite could observe
    // the live document, so no base was captured for this attempt. The failure record
    // must fall back to the empty document a fresh page is known to hold, or every
    // later run would misread the untouched destination as a collaborator edit.
    await runImport({
      index,
      client,
      manifest,
      report,
      rootParentId: null,
      limit: 1,
      lingerMs: 0,
      documentPush: vi.fn(async () => {
        throw new Error("Timed out waiting for the document to sync.");
      }),
    });
    expect(report.error).toHaveBeenCalledWith("content_failed", expect.stringContaining("Timed out"));
    expect(state.nodes[page.path].content).toMatchObject({
      status: "failed",
      projectionHash: expect.stringMatching(/^[a-f\d]{64}$/),
      baseRemoteHash: emptyHash,
    });

    // Run 2: the still-empty destination matches the recorded base, so the retry writes.
    const documentPush = vi.fn(async ({ expectedProjectionHashes, beforeWrite }) => {
      expect(expectedProjectionHashes).toContain(emptyHash);
      beforeWrite(emptyHash);
      return { updates: 1, byteLength: 1 };
    });
    await runImport({
      index,
      client,
      manifest,
      report,
      rootParentId: null,
      limit: 1,
      lingerMs: 0,
      documentPush,
    });
    expect(documentPush).toHaveBeenCalledTimes(1);
    expect(state.nodes[page.path].content).toMatchObject({ status: "written" });
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

  it("accepts destination metadata and attachment edits and leaves content to the write pass", async () => {
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
    });

    expect(state.nodes[page.path].expectedPage).toMatchObject({
      acceptedRemoteTitle: "Edited",
      acceptedRemoteParentId: "other-parent",
    });
    // Content is not classified here: the write pass compares the live document inside
    // pushDocument's own connection, so reconciliation must leave the record alone.
    expect(state.nodes[page.path].content).toEqual({ status: "written", projectionHash: "local-document" });
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
    expect(state.nodes[page.path].table.settledByOperator).toBeUndefined();
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
    const manifest = stubManifest({
      [page.path]: {
        pageId: "page-1",
        expectedPage: { kind: "table", title: "Table", parentId: null },
        table: columnProgress(plan.contentHash),
      },
    });
    const { state } = manifest;
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

  it("recovers a table left several batches ahead by a manifest that lost checkpoints", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "imported" } }],
    };
    const plan = await planFor(table);
    const manifest = stubManifest({
      [page.path]: {
        pageId: "page-1",
        expectedPage: { kind: "table", title: "Table", parentId: null },
        table: columnProgress(plan.contentHash),
      },
    });
    const { state } = manifest;
    // Both the column batch and the row batch committed (live matches the full source
    // at revision 3 = 1 + two batches), but neither checkpoint reached the manifest.
    const client = {
      pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
      tableVerification: vi.fn(async () => ({ revision: 3, contentHash: plan.contentHash, rowCount: 1 })),
      acquireTableLease: vi.fn(async () => ({ leaseToken: "reconcile-lease" })),
      releaseTableLease: vi.fn(async () => undefined),
      bulkTableWrite: vi.fn(async () => ({
        revision: 2,
        columns: [{ ref: "c0", id: "column-1" }],
        rows: [],
        replayed: true,
      })),
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      tablePlans: new Map([[page, plan]]),
      client,
    });

    // Only the column batch is replayed - its response is the sole source of the
    // generated ids. The row batch advances by content match alone.
    expect(client.bulkTableWrite).toHaveBeenCalledTimes(1);
    expect(client.bulkTableWrite).toHaveBeenCalledWith(
      "page-1",
      expect.objectContaining({ expectedRevision: 1, clientRequestId: expect.stringContaining(":columns:0:") }),
    );
    expect(state.nodes[page.path].table).toMatchObject({
      revision: 3,
      columnOffset: 1,
      rowOffset: 1,
      columnsByRef: { c0: "column-1" },
    });
    expect(report.issue).not.toHaveBeenCalled();
    expect(report.error).not.toHaveBeenCalled();
  });

  it("fails only the table when the recovery replay cannot take the lease", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "imported" } }],
    };
    const plan = await planFor(table);
    const committedColumn = canonicalSourceTable(table, 1, 0);
    const committedColumnHash = await tableContentHash(committedColumn.columns, committedColumn.rows);
    const manifest = stubManifest({
      [page.path]: {
        pageId: "page-1",
        expectedPage: { kind: "table", title: "Table", parentId: null },
        table: columnProgress(plan.contentHash),
      },
    });
    const { state } = manifest;
    const client = {
      pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
      tableVerification: vi.fn(async () => ({ revision: 2, contentHash: committedColumnHash, rowCount: 0 })),
      acquireTableLease: vi.fn(async () => {
        throw Object.assign(new Error("Another editor currently holds this table lease."), { status: 409 });
      }),
      releaseTableLease: vi.fn(async () => undefined),
      bulkTableWrite: vi.fn(),
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    // A held lease is transient, so the run must not abort and the table must not be
    // frozen as destination-owned: untouched offsets let the next attempt retry.
    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      tablePlans: new Map([[page, plan]]),
      client,
    });

    // Not reported here: the write pass retries this table in the same run, so its
    // failure is reported exactly once, by the pass that made the final attempt.
    expect(report.error).not.toHaveBeenCalled();
    expect(report.issue).not.toHaveBeenCalled();
    expect(client.bulkTableWrite).not.toHaveBeenCalled();
    expect(state.nodes[page.path].table).toMatchObject({ phase: "columns", columnOffset: 0, rowOffset: 0 });
    expect(state.nodes[page.path].tableError).toContain("lease");
    await expect(
      importTable({ index: {}, client, manifest, report, database: page, record: state.nodes[page.path], plan }),
    ).rejects.toThrow(/lease/);
  });

  it("keeps the destination when content matches an own batch but the revision moved past it", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "imported" } }],
    };
    const plan = await planFor(table);
    const committedColumn = canonicalSourceTable(table, 1, 0);
    const committedColumnHash = await tableContentHash(committedColumn.columns, committedColumn.rows);
    const manifest = stubManifest({
      [page.path]: {
        pageId: "page-1",
        expectedPage: { kind: "table", title: "Table", parentId: null },
        table: columnProgress(plan.contentHash),
      },
    });
    const { state } = manifest;
    // Content equals the committed column batch, but revision 4 !== 1 + one batch: a
    // destination edit was made and undone, so the table belongs to the destination.
    const client = {
      pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
      tableVerification: vi.fn(async () => ({ revision: 4, contentHash: committedColumnHash, rowCount: 0 })),
      acquireTableLease: vi.fn(),
      releaseTableLease: vi.fn(async () => undefined),
      bulkTableWrite: vi.fn(),
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      tablePlans: new Map([[page, plan]]),
      client,
    });

    expect(client.acquireTableLease).not.toHaveBeenCalled();
    expect(report.issue).toHaveBeenCalledWith("destination_table_kept", "Table");
    expect(report.error).not.toHaveBeenCalled();
    expect(state.nodes[page.path].table).toMatchObject({
      phase: "complete",
      acceptedRemoteHash: committedColumnHash,
      acceptedRemoteRowCount: 0,
    });
    expect(state.nodes[page.path].table.settledByOperator).toBeUndefined();
  });

  it("keeps the destination when an exact saved checkpoint was edited and reverted", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "remaining" } }],
    };
    const plan = await planFor(table);
    const checkpoint = canonicalSourceTable(table, 1, 0);
    const checkpointHash = await tableContentHash(checkpoint.columns, checkpoint.rows);
    const manifest = stubManifest({
      [page.path]: {
        pageId: "page-1",
        expectedPage: { kind: "table", title: "Table", parentId: null },
        table: {
          ...columnProgress(plan.contentHash),
          phase: "rows",
          revision: 2,
          columnOffset: 1,
          columnsByRef: { c0: "column-1" },
        },
      },
    });
    const { state } = manifest;
    const client = {
      pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
      // The content is exactly the saved revision-2 checkpoint, but an edit and revert
      // advanced the authoritative revision twice.
      tableVerification: vi.fn(async () => ({ revision: 4, contentHash: checkpointHash, rowCount: 0 })),
      acquireTableLease: vi.fn(),
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      tablePlans: new Map([[page, plan]]),
      client,
    });

    expect(client.acquireTableLease).not.toHaveBeenCalled();
    expect(report.issue).toHaveBeenCalledWith("destination_table_kept", "Table");
    expect(report.error).not.toHaveBeenCalled();
    expect(state.nodes[page.path].table).toMatchObject({
      phase: "complete",
      revision: 2,
      acceptedRemoteHash: checkpointHash,
      acceptedRemoteRowCount: 0,
    });
  });

  it.each(["table_revision_conflict", "idempotency_key_reused"])(
    "marks recovery ambiguous when a matched batch replay returns %s",
    async (conflictCode) => {
      const page = { path: "Q1 $Budget 'draft'.html", kind: "database", title: "Table" };
      const table = {
        columns: [{ ref: "c0", name: "Value", type: "text" }],
        rows: [{ cells: { "ref:c0": "imported" } }],
      };
      const plan = await planFor(table);
      const committedColumn = canonicalSourceTable(table, 1, 0);
      const committedColumnHash = await tableContentHash(committedColumn.columns, committedColumn.rows);
      const manifest = stubManifest({
        [page.path]: {
          pageId: "page-1",
          expectedPage: { kind: "table", title: "Table", parentId: null },
          table: columnProgress(plan.contentHash),
        },
      });
      const { state } = manifest;
      // The revision walk matches a column batch, but the server holds no receipt for
      // its request id (for example, receipts written before their request hashes were
      // recorded have been cleared), so the guarded replay is refused as a stale write.
      // The absence of that receipt cannot distinguish a legacy importer-owned commit
      // from a destination edit, so recovery must stop without blessing either origin.
      const client = {
        pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
        tableVerification: vi.fn(async () => ({ revision: 2, contentHash: committedColumnHash, rowCount: 0 })),
        acquireTableLease: vi.fn(async () => ({ leaseToken: "reconcile-lease" })),
        releaseTableLease: vi.fn(async () => undefined),
        bulkTableWrite: vi.fn(async () => {
          throw Object.assign(new Error("The table changed. Reloading before retrying the update."), {
            status: 409,
            code: conflictCode,
          });
        }),
      };
      const report = { issue: vi.fn(), error: vi.fn() };

      await reconcileCommitted({
        selected: [page],
        manifest,
        report,
        tablePlans: new Map([[page, plan]]),
        client,
      });

      expect(report.issue).not.toHaveBeenCalled();
      expect(report.error).toHaveBeenCalledWith(
        "table_recovery_ambiguous",
        expect.stringMatching(/^Table: .*no durable receipt proves who committed it/),
      );
      expect(report.error).toHaveBeenCalledWith(
        "table_recovery_ambiguous",
        expect.stringContaining(`--keep-ambiguous-table 'Q1 $Budget '"'"'draft'"'"'.html'`),
      );
      expect(state.nodes[page.path].tableError).toMatch(/no durable receipt proves who committed it/);
      expect(state.nodes[page.path].tableRecoveryAmbiguous).toBe(true);
      expect(state.nodes[page.path].table).toMatchObject({
        phase: "columns",
        revision: 1,
        columnOffset: 0,
        rowOffset: 0,
      });
      expect(state.nodes[page.path].table.acceptedRemoteHash).toBeUndefined();
    },
  );

  it("settles an ambiguous table as the destination's when the operator opts in", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "imported" } }],
    };
    const plan = await planFor(table);
    const committedColumn = canonicalSourceTable(table, 1, 0);
    const committedColumnHash = await tableContentHash(committedColumn.columns, committedColumn.rows);
    const manifest = stubManifest({
      [page.path]: {
        pageId: "page-1",
        expectedPage: { kind: "table", title: "Table", parentId: null },
        table: columnProgress(plan.contentHash),
        tableError:
          "The live table matches an unrecorded import batch, but no durable receipt proves who committed it.",
        tableRecoveryAmbiguous: true,
      },
    });
    const { state } = manifest;
    const client = {
      pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
      tableVerification: vi.fn(async () => ({ revision: 2, contentHash: committedColumnHash, rowCount: 0 })),
      acquireTableLease: vi.fn(async () => ({ leaseToken: "reconcile-lease" })),
      releaseTableLease: vi.fn(async () => undefined),
      bulkTableWrite: vi.fn(async () => {
        throw Object.assign(new Error("The table changed. Reloading before retrying the update."), {
          status: 409,
          code: "idempotency_key_reused",
        });
      }),
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    // Without this the ambiguity is terminal: every rerun re-derives it identically, the
    // write pass skips the table, and verify fails forever on a table never completed.
    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      tablePlans: new Map([[page, plan]]),
      client,
      keepAmbiguousTables: new Set([page.path]),
    });

    expect(report.error).not.toHaveBeenCalled();
    expect(report.issue).toHaveBeenCalledWith("ambiguous_table_kept", "Table");
    expect(report.issue).not.toHaveBeenCalledWith("destination_table_kept", "Table");
    expect(state.nodes[page.path].tableRecoveryAmbiguous).toBe(false);
    expect(state.nodes[page.path].table).toMatchObject({
      phase: "complete",
      acceptedRemoteHash: committedColumnHash,
      acceptedRemoteRowCount: 0,
      settledByOperator: true,
    });
  });

  it("reports the transient failure that stopped a rerun over an inherited ambiguity", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "imported" } }],
    };
    const plan = await planFor(table);
    const committedColumn = canonicalSourceTable(table, 1, 0);
    const committedColumnHash = await tableContentHash(committedColumn.columns, committedColumn.rows);
    const manifest = stubManifest({
      [page.path]: {
        pageId: "page-1",
        expectedPage: { kind: "table", title: "Table", parentId: null },
        table: columnProgress(plan.contentHash),
        tableError:
          "The live table matches an unrecorded import batch, but no durable receipt proves who committed it.",
        tableRecoveryAmbiguous: true,
      },
    });
    const { state } = manifest;
    const client = {
      pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
      tableVerification: vi.fn(async () => ({ revision: 2, contentHash: committedColumnHash, rowCount: 0 })),
      acquireTableLease: vi.fn(async () => {
        throw Object.assign(new Error("Another editor currently holds this table lease."), { status: 409 });
      }),
      releaseTableLease: vi.fn(async () => undefined),
      bulkTableWrite: vi.fn(),
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      tablePlans: new Map([[page, plan]]),
      client,
    });

    // The prior verdict stands -- nothing here disproved it -- but what stopped this
    // attempt was the lease, and that message must not be lost to the inherited flag.
    expect(state.nodes[page.path].tableRecoveryAmbiguous).toBe(true);
    expect(state.nodes[page.path].tableError).toContain("lease");
    expect(report.error).toHaveBeenCalledWith("table_recovery_ambiguous", expect.stringContaining("lease"));
    expect(report.error).not.toHaveBeenCalledWith("table_recovery_ambiguous", expect.stringContaining("null"));
  });

  it("records no recovered column ids when a later batch replay is ambiguous", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    // 51 columns is two bulk column batches, so the replay can succeed once and then
    // fail: the manifest must not keep ids for columns its offsets do not cover.
    const table = {
      columns: Array.from({ length: 51 }, (_, index) => ({ ref: `c${index}`, name: `Value ${index}`, type: "text" })),
      rows: [{ cells: { "ref:c0": "imported" } }],
    };
    const plan = await planFor(table);
    const committed = canonicalSourceTable(table, 51, 0);
    const committedHash = await tableContentHash(committed.columns, committed.rows);
    const manifest = stubManifest({
      [page.path]: {
        pageId: "page-1",
        expectedPage: { kind: "table", title: "Table", parentId: null },
        table: {
          phase: "columns",
          revision: 1,
          columnOffset: 0,
          rowOffset: 0,
          columnsByRef: {},
          expectedColumns: 51,
          expectedRows: 1,
          contentHash: plan.contentHash,
        },
      },
    });
    const { state } = manifest;
    const client = {
      pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
      tableVerification: vi.fn(async () => ({ revision: 3, contentHash: committedHash, rowCount: 0 })),
      acquireTableLease: vi.fn(async () => ({ leaseToken: "reconcile-lease" })),
      releaseTableLease: vi.fn(async () => undefined),
      bulkTableWrite: vi.fn(async (_pageId, request) => {
        if (request.expectedRevision === 1) {
          return {
            replayed: true,
            revision: 2,
            columns: request.columns.map((column) => ({ ref: column.ref, id: `column-${column.ref}` })),
          };
        }
        throw Object.assign(new Error("The table changed. Reloading before retrying the update."), {
          status: 409,
          code: "idempotency_key_reused",
        });
      }),
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      tablePlans: new Map([[page, plan]]),
      client,
    });

    expect(client.bulkTableWrite).toHaveBeenCalledTimes(2);
    expect(state.nodes[page.path].tableRecoveryAmbiguous).toBe(true);
    expect(state.nodes[page.path].table).toMatchObject({
      phase: "columns",
      revision: 1,
      columnOffset: 0,
      rowOffset: 0,
    });
    // toMatchObject treats {} as a subset of anything, so the map is compared exactly.
    expect(state.nodes[page.path].table.columnsByRef).toEqual({});
  });

  it("clears an ambiguity verdict this run cannot re-derive", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "imported" } }],
    };
    const plan = await planFor(table);
    // No recorded table progress, so nothing can be attributed and the classification
    // below is skipped entirely. A verdict left by an earlier run must not survive it:
    // the write pass skips an ambiguous table in silence, and this table needs to reach
    // importTable's guard and fail loudly instead.
    const manifest = stubManifest({
      [page.path]: {
        pageId: "page-1",
        expectedPage: { kind: "table", title: "Table", parentId: null },
        tableError:
          "The live table matches an unrecorded import batch, but no durable receipt proves who committed it.",
        tableRecoveryAmbiguous: true,
      },
    });
    const { state } = manifest;
    const client = {
      pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
      tableVerification: vi.fn(async () => ({ revision: 5, contentHash: "unrelated-destination-hash", rowCount: 7 })),
      acquireTableLease: vi.fn(),
      releaseTableLease: vi.fn(),
      bulkTableWrite: vi.fn(),
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      tablePlans: new Map([[page, plan]]),
      client,
    });

    expect(state.nodes[page.path].tableRecoveryAmbiguous).toBe(false);
    expect(state.nodes[page.path].table).toBeUndefined();
    expect(state.nodes[page.path].tableError).toBeNull();
  });

  it("preserves an ambiguity verdict when no table plan can re-derive it", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    const manifest = stubManifest({
      [page.path]: {
        pageId: "page-1",
        expectedPage: { kind: "table", title: "Table", parentId: null },
        tableRecoveryAmbiguous: true,
        tableError: "Receipt ownership is still ambiguous.",
      },
    });

    await reconcileCommitted({
      selected: [page],
      manifest,
      report: { issue: vi.fn(), error: vi.fn() },
      client: {
        pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
        tableVerification: vi.fn(async () => ({ revision: 5, contentHash: "e".repeat(64), rowCount: 2 })),
      },
    });

    expect(manifest.state.nodes[page.path]).toMatchObject({
      tableRecoveryAmbiguous: true,
      tableError: "Receipt ownership is still ambiguous.",
    });
  });

  it("classifies recovery against the table read under its lease, not the earlier probe", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "imported" } }],
    };
    const plan = await planFor(table);
    const committedColumn = canonicalSourceTable(table, 1, 0);
    const committedColumnHash = await tableContentHash(committedColumn.columns, committedColumn.rows);
    const manifest = stubManifest({
      [page.path]: {
        pageId: "page-1",
        expectedPage: { kind: "table", title: "Table", parentId: null },
        table: columnProgress(plan.contentHash),
      },
    });
    const { state } = manifest;
    // The pre-lease probe looks like an own unrecorded column batch, but an editor
    // commits before the lease is taken. The recorded classification must describe
    // the leased table - destination-owned at its actual values - not the stale probe.
    const client = {
      pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
      tableVerification: vi
        .fn()
        .mockResolvedValueOnce({ revision: 2, contentHash: committedColumnHash, rowCount: 0 })
        .mockResolvedValueOnce({ revision: 5, contentHash: "d".repeat(64), rowCount: 3 }),
      acquireTableLease: vi.fn(async () => ({ leaseToken: "reconcile-lease" })),
      releaseTableLease: vi.fn(async () => undefined),
      bulkTableWrite: vi.fn(),
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      tablePlans: new Map([[page, plan]]),
      client,
    });

    expect(client.tableVerification).toHaveBeenCalledTimes(2);
    expect(client.bulkTableWrite).not.toHaveBeenCalled();
    expect(report.issue).toHaveBeenCalledWith("destination_table_kept", "Table");
    expect(state.nodes[page.path].table).toMatchObject({
      phase: "complete",
      acceptedRemoteHash: "d".repeat(64),
      acceptedRemoteRowCount: 3,
    });
  });

  it("adopts an untouched empty table as the baseline when no progress was recorded", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "imported" } }],
    };
    const plan = await planFor(table);
    const empty = canonicalSourceTable(table, 0, 0);
    const emptyHash = await tableContentHash(empty.columns, empty.rows);
    const manifest = stubManifest({
      [page.path]: { pageId: "page-1", expectedPage: { kind: "table", title: "Table", parentId: null } },
    });
    const { state } = manifest;
    const client = {
      pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
      tableVerification: vi.fn(async () => ({ revision: 1, contentHash: emptyHash, rowCount: 0 })),
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      tablePlans: new Map([[page, plan]]),
      client,
    });

    expect(report.issue).not.toHaveBeenCalled();
    expect(report.error).not.toHaveBeenCalled();
    expect(state.nodes[page.path].table).toMatchObject({
      phase: "columns",
      revision: 1,
      columnOffset: 0,
      rowOffset: 0,
    });
  });

  it("keeps an empty table whose revision shows the destination emptied it", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "imported" } }],
    };
    const plan = await planFor(table);
    const empty = canonicalSourceTable(table, 0, 0);
    const emptyHash = await tableContentHash(empty.columns, empty.rows);
    const manifest = stubManifest({
      [page.path]: { pageId: "page-1", expectedPage: { kind: "table", title: "Table", parentId: null } },
    });
    const { state } = manifest;
    // Fresh tables start at revision 1 and an own write never leaves a table empty, so
    // an empty table at revision 3 was written to and emptied by the destination; its
    // edit-and-revert claims the facet exactly as it would with a recorded checkpoint.
    const client = {
      pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
      tableVerification: vi.fn(async () => ({ revision: 3, contentHash: emptyHash, rowCount: 0 })),
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      tablePlans: new Map([[page, plan]]),
      client,
    });

    expect(report.issue).toHaveBeenCalledWith("destination_table_kept", "Table");
    expect(state.nodes[page.path].table).toMatchObject({
      phase: "complete",
      acceptedRemoteHash: emptyHash,
      acceptedRemoteRowCount: 0,
    });
  });

  it("leaves a non-empty table with no recorded baseline for the write pass to refuse", async () => {
    const page = { path: "Table.html", kind: "database", title: "Table" };
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "imported" } }],
    };
    const plan = await planFor(table);
    const manifest = stubManifest({
      [page.path]: { pageId: "page-1", expectedPage: { kind: "table", title: "Table", parentId: null } },
    });
    const { state } = manifest;
    // With no baseline there is no revision to fence own writes against, so neither
    // resuming nor destination ownership can be proven. Recording either would guess;
    // the write pass's no-progress guard turns this into one loud operator decision.
    const client = {
      pageVerification: vi.fn(async () => ({ page: { kind: "table", title: "Table", parentId: null } })),
      tableVerification: vi.fn(async () => ({ revision: 4, contentHash: "e".repeat(64), rowCount: 2 })),
      acquireTableLease: vi.fn(async () => ({ leaseToken: "import-lease" })),
      releaseTableLease: vi.fn(async () => undefined),
      readTable: vi.fn(async () => ({ table: { revision: 4, columns: [{}], rowCount: 2 } })),
    };
    const report = { issue: vi.fn(), error: vi.fn() };

    await reconcileCommitted({
      selected: [page],
      manifest,
      report,
      tablePlans: new Map([[page, plan]]),
      client,
    });

    expect(report.issue).not.toHaveBeenCalled();
    expect(report.error).not.toHaveBeenCalled();
    expect(state.nodes[page.path].table).toBeUndefined();
    await expect(
      importTable({ index: {}, client, manifest, report, database: page, record: state.nodes[page.path], plan }),
    ).rejects.toThrow(/no table progress/);
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

  it("refuses to finalize recovered offsets after the live revision changes", async () => {
    const database = { path: "Table.html", title: "Table" };
    const table = {
      columns: [{ ref: "c0", name: "Value", type: "text" }],
      rows: [{ cells: { "ref:c0": "imported" } }],
    };
    const plan = await planFor(table);
    const manifest = stubManifest({
      [database.path]: {
        pageId: "page-1",
        table: {
          ...columnProgress(plan.contentHash),
          phase: "rows",
          revision: 3,
          columnOffset: 1,
          rowOffset: 1,
          columnsByRef: { c0: "column-1" },
        },
      },
    });
    const client = {
      acquireTableLease: vi.fn(async () => ({ leaseToken: "lease" })),
      releaseTableLease: vi.fn(async () => undefined),
      bulkTableWrite: vi.fn(),
      // A collaborator changed content after reconciliation but before this lease was
      // acquired. Counts still match, so only the revision fence exposes the race.
      readTable: vi.fn(async () => ({ table: { revision: 4, columns: [{}], rowCount: 1 } })),
    };

    await expect(
      importTable({
        index: {},
        client,
        manifest,
        report: { issue: vi.fn(), progress: vi.fn() },
        database,
        record: manifest.node(database.path),
        plan,
      }),
    ).rejects.toThrow("revision 4; expected imported revision 3");

    expect(client.bulkTableWrite).not.toHaveBeenCalled();
    expect(client.releaseTableLease).toHaveBeenCalledWith("page-1", "lease");
    expect(manifest.node(database.path).table.phase).toBe("rows");
  });
});
