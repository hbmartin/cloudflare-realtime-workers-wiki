import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readExport } from "./export-tree.mjs";
import { createImportEditor } from "./blocks.mjs";
import { expectedDocumentProjectionHash, verifyImport } from "./verify.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "export");

describe("verifyImport", () => {
  it("records a per-page request failure and continues checking later pages", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const index = readExport(root);
    const table = index.pages.find((page) => page.kind === "database");
    const later = index.pages.find((page) => page.kind === "document");
    const client = {
      baseURL: "https://notes.example.test",
      listAttachments: vi.fn(async () => []),
      tableVerification: vi.fn(async () => {
        throw new Error("table unavailable");
      }),
    };
    const manifest = {
      state: {
        rootParentId: null,
        selectedPaths: [table.path, later.path],
        nodes: {
          [table.path]: { pageId: "table", kind: "database", title: table.title, table: { phase: "complete" } },
          [later.path]: { kind: "document", title: later.title },
        },
      },
      node(path) {
        return this.state.nodes[path] ?? null;
      },
    };

    await expect(verifyImport({ client, manifest, index, timeoutMs: 5_000 })).resolves.toBe(2);
    expect(client.tableVerification).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(`  ${table.title}: table unavailable`);
    expect(log).toHaveBeenCalledWith(`  ${later.title}: The page was never created.`);
    log.mockRestore();
  });

  it("polls a lagging document projection and accepts the exact canonical hash", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const index = readExport(root);
    const page = index.pages.find((candidate) => candidate.title === "Cool");
    const node = {
      pageId: "page-1",
      title: page.title,
      contentEpoch: 1,
      expectedPage: { kind: "document", title: page.title, parentId: null },
      assets: {},
    };
    const manifest = {
      state: { rootParentId: null, selectedPaths: [page.path], nodes: { [page.path]: node } },
      node(path) {
        return this.state.nodes[path] ?? null;
      },
    };
    const expectedHash = await expectedDocumentProjectionHash({
      index,
      page,
      manifest,
      included: new Set([page]),
      editor: await createImportEditor(),
      assets: new Map(),
    });
    node.content = { status: "written", projectionHash: expectedHash };
    const pageVerification = vi
      .fn()
      .mockResolvedValueOnce({
        page: { kind: "document", title: page.title, parentId: null },
        projectionHash: "0".repeat(64),
      })
      .mockResolvedValueOnce({
        page: { kind: "document", title: page.title, parentId: null },
        projectionHash: expectedHash,
      });
    const client = {
      baseURL: "https://notes.example.test",
      listAttachments: vi.fn(async () => []),
      pageVerification,
    };

    await expect(verifyImport({ client, manifest, index, timeoutMs: 100, pollIntervalMs: 1 })).resolves.toBe(0);
    expect(pageVerification).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
