import { describe, expect, it, vi } from "vitest";
import { createReport } from "./report.mjs";

describe("createReport", () => {
  it("labels the number of pages whose content was written", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    createReport().print({ pages: 3, written: 2, databases: 0 });

    expect(log).toHaveBeenCalledWith("Imported 3 pages; wrote content for 2 pages.");
    log.mockRestore();
  });

  it("keeps warnings separate from data errors", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const report = createReport();
    report.inPage("Example");
    report.issue("unsafe_skipped", "asset.svg");
    report.error("attachment_missing", "photo.png");
    report.print({ pages: 1, written: 0, databases: 0 });

    expect(report.errorCount).toBe(1);
    expect(log).toHaveBeenCalledWith("Warnings (content was intentionally degraded):");
    expect(log).toHaveBeenCalledWith("Data errors (the import is incomplete):");
    log.mockRestore();
  });
});
