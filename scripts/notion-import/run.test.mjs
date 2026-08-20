import { describe, expect, it, vi } from "vitest";
import { runImport, selectPages } from "./run.mjs";

describe("selectPages", () => {
  it("includes ancestors when a limited child sorts before its parent", () => {
    const parent = { path: "Cool 3333333333333333333333333333cccc.html", parent: null };
    const child = { path: "Cool 3333-cccc/Nested.html", parent };

    expect(selectPages([child, parent], 1)).toEqual([child, parent]);
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
    const manifest = {
      node: vi.fn(() => null),
      record: vi.fn(),
      flush: vi.fn(),
    };

    await expect(
      runImport({
        index: { pages: [page], root: "/unused" },
        client: { createPages: vi.fn(async () => []) },
        manifest,
        report: { issue: vi.fn(), progress: vi.fn(), inPage: vi.fn() },
        rootParentId: null,
        limit: 1,
        lingerMs: 0,
      }),
    ).rejects.toThrow(/returned 0 results for 1 pages/);
    expect(manifest.record).not.toHaveBeenCalled();
  });
});
