import { describe, expect, it, vi } from "vitest";
import { createReport } from "./report.mjs";

describe("createReport", () => {
  it("labels the number of pages whose content was written", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    createReport().print({ pages: 3, written: 2, databases: 0 });

    expect(log).toHaveBeenCalledWith("Imported 3 pages; wrote content for 2 pages.");
    log.mockRestore();
  });
});
