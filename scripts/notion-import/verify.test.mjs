import { describe, expect, it, vi } from "vitest";
import { verifyImport } from "./verify.mjs";

describe("verifyImport", () => {
  it("records a per-page request failure and continues checking later pages", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const client = {
      baseURL: "https://notes.example.test",
      tree: vi.fn(async () => [{ id: "table" }, { id: "document" }]),
      readTable: vi.fn(async () => {
        throw new Error("table unavailable");
      }),
      request: vi.fn(async () => ({ preview: { excerpt: "checked" } })),
    };
    const manifest = {
      state: {
        nodes: {
          table: { pageId: "table", kind: "database", title: "Table" },
          document: { pageId: "document", kind: "document", title: "Document" },
        },
      },
    };

    await expect(verifyImport({ client, manifest, index: { pages: [{}, {}] } })).resolves.toBe(1);
    expect(client.request).toHaveBeenCalledWith("/api/pages/document/preview");
    expect(log).toHaveBeenCalledWith("  Table could not be checked: table unavailable");
    log.mockRestore();
  });
});
