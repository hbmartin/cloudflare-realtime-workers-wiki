// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { OfflinePage } from "./offline-catalog";
import { exportPendingOfflinePages } from "./offline-export";
import { loadOfflineCopy } from "./collaboration";

vi.mock("./collaboration", () => ({ loadOfflineCopy: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("exports readable pending copies even when another copy cannot be opened", async () => {
  const good = "account:user:workspace:page:1:2";
  const missing = "account:user:workspace:page:2:2";
  vi.mocked(loadOfflineCopy).mockImplementation(async (key) => {
    if (key === missing) throw new Error("Copy missing");
    const doc = new Y.Doc();
    doc.getXmlFragment("document-store");
    return doc;
  });
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:offline"), revokeObjectURL: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const page = {
    pageId: "page",
    title: "Draft",
    storageKeys: [good, missing],
    pendingCopyKeys: [good, missing],
  } as OfflinePage;

  await expect(exportPendingOfflinePages([page], true)).resolves.toEqual({ exported: 1, failed: 1 });
  expect(click).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith("Offline copy could not be exported", expect.any(Error));
});
