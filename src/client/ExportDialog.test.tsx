// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job, Page } from "../shared/types";
import { api } from "./api";
import { ExportDialog } from "./ExportDialog";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: vi.fn(),
}));

const page: Page = {
  id: "page-1",
  workspaceId: "workspace-1",
  spaceId: "space-1",
  parentId: null,
  kind: "document",
  position: "a0",
  title: "Project brief",
  icon: null,
  revision: 1,
  contentEpoch: 1,
  isTemplate: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const job = {
  id: "job-1",
  workspaceId: page.workspaceId,
  spaceId: page.spaceId,
  type: "export",
  status: "queued",
  progress: { current: 0, total: 0, label: "" },
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

describe("ExportDialog", () => {
  it("reports disabled PDF configuration and queues a portable HTML export", async () => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/integrations/status") return { pdf: { available: false } };
      if (path === `/api/pages/${page.id}/exports` && init?.method === "POST") return { job };
      throw new Error(`Unexpected request: ${path}`);
    });
    const onQueued = vi.fn();
    render(<ExportDialog page={page} onClose={vi.fn()} onQueued={onQueued} />);

    expect(await screen.findByRole("radio", { name: /PDF/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /HTML/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start export" }));

    await waitFor(() => expect(onQueued).toHaveBeenCalledOnce());
    expect(onQueued).toHaveBeenCalledWith(job);
    expect(api).toHaveBeenCalledWith(
      `/api/pages/${page.id}/exports`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ format: "html", portable: true }) }),
    );
  });
});
