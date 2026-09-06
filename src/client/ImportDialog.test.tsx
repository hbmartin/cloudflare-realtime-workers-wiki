// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job, Space } from "../shared/types";
import { api } from "./api";
import { ImportDialog } from "./ImportDialog";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: vi.fn(),
}));

const space = {
  id: "space-1",
  workspaceId: "workspace-1",
  name: "General",
  slug: "general",
  description: "",
  icon: null,
  position: "a0",
  visibility: "workspace",
  effectiveRole: "editor",
  createdAt: 1,
  updatedAt: 1,
} satisfies Space;

const job = {
  id: "job-1",
  workspaceId: space.workspaceId,
  spaceId: space.id,
  type: "import",
  status: "queued",
  progress: { current: 0, total: 0, label: "Queued" },
  warnings: [],
  result: null,
  error: null,
  hasDownload: false,
  expiresAt: null,
  createdAt: 1,
  updatedAt: 1,
} satisfies Job;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ImportDialog", () => {
  it("uploads one supported file into the selected space", async () => {
    vi.mocked(api).mockResolvedValue({ job });
    const onQueued = vi.fn();
    render(<ImportDialog spaces={[space]} initialSpaceId={space.id} onClose={vi.fn()} onQueued={onQueued} />);
    const file = new File(["# Imported"], "notes.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText(/^File/), { target: { files: [file] } });
    fireEvent.submit(screen.getByRole("button", { name: "Upload and inspect" }).closest("form")!);
    await waitFor(() => expect(onQueued).toHaveBeenCalledWith(job));
    const request = vi.mocked(api).mock.calls[0]!;
    expect(request[0]).toBe("/api/import-uploads");
    expect(request[1]?.method).toBe("POST");
    const form = request[1]?.body as FormData;
    expect(form.get("spaceId")).toBe(space.id);
    expect(form.get("file")).toBe(file);
  });
});
