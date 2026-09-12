// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job, Space } from "../shared/types";
import { ActivitiesTray } from "./ActivitiesTray";

const runningJob: Job = {
  id: "job-1",
  workspaceId: "workspace-1",
  spaceId: null,
  type: "search_reindex",
  status: "running",
  progress: { current: 2, total: 4, label: "Reindexing pages" },
  warnings: [],
  result: null,
  error: null,
  hasDownload: false,
  cleanupPending: false,
  expiresAt: null,
  createdAt: Date.UTC(2026, 8, 5),
  updatedAt: Date.UTC(2026, 8, 5),
};

const workspaceSpace: Space = {
  id: "space-1",
  workspaceId: "workspace-1",
  name: "Workspace",
  slug: "workspace",
  description: "",
  icon: null,
  position: "a0",
  visibility: "workspace",
  effectiveRole: "editor",
  createdAt: Date.UTC(2026, 8, 5),
  updatedAt: Date.UTC(2026, 8, 5),
};

afterEach(cleanup);

describe("ActivitiesTray", () => {
  it("renders progress and exposes the valid action for a running job", () => {
    const cancel = vi.fn();
    render(
      <ActivitiesTray
        jobs={[runningJob]}
        loading={false}
        error=""
        pendingJobId={null}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onCancel={cancel}
        onCleanup={vi.fn()}
        onRetry={vi.fn()}
        onConfirm={vi.fn()}
        onOpenResult={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Activities" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Search reindex progress" })).toHaveValue(50);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledWith(runningJob);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it.each(["failed", "canceling"] as const)(
    "renders %s cleanup as active and lets the user retry cleanup",
    (status) => {
      const pendingCleanup: Job = {
        ...runningJob,
        status,
        progress: { current: 1, total: 4, label: "Failure cleanup pending" },
        error: { code: "job_failed", message: "Export failed" },
        cleanupPending: true,
      };
      const retryCleanup = vi.fn();
      render(
        <ActivitiesTray
          jobs={[pendingCleanup]}
          loading={false}
          error=""
          pendingJobId={null}
          onClose={vi.fn()}
          onRefresh={vi.fn()}
          onCancel={vi.fn()}
          onCleanup={retryCleanup}
          onRetry={vi.fn()}
          onConfirm={vi.fn()}
          onOpenResult={vi.fn()}
        />,
      );

      expect(screen.getByText("Export failed")).toBeInTheDocument();
      expect(screen.getByRole("progressbar", { name: "Search reindex progress" })).toHaveValue(25);
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry cancel" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Retry cleanup" }));
      expect(retryCleanup).toHaveBeenCalledWith(pendingCleanup);
    },
  );

  it("closes on Escape and restores the previously focused control", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const close = vi.fn();
    const view = render(
      <ActivitiesTray
        jobs={[]}
        loading={false}
        error=""
        pendingJobId={null}
        onClose={close}
        onRefresh={vi.fn()}
        onCancel={vi.fn()}
        onCleanup={vi.fn()}
        onRetry={vi.fn()}
        onConfirm={vi.fn()}
        onOpenResult={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Close activities" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });

  it("shows an import preview and requires explicit confirmation", () => {
    const confirm = vi.fn();
    const importJob: Job = {
      ...runningJob,
      id: "import-1",
      spaceId: "space-1",
      type: "import",
      status: "awaiting_confirmation",
      progress: { current: 2, total: 7, label: "Ready to import" },
      result: {
        preview: {
          format: "notion_zip",
          filename: "workspace.zip",
          pages: 8,
          tables: 2,
          assets: 5,
          roots: 3,
          nested: 5,
          maxDepth: 2,
          resolvedLinks: 4,
          unresolvedLinks: 1,
          unresolvedParents: 0,
          groups: [{ key: "Workspace", name: "Workspace", pages: 8, roots: 3, suggestedVisibility: "workspace" }],
          warnings: [],
        },
      },
    };
    render(
      <ActivitiesTray
        jobs={[importJob]}
        spaces={[workspaceSpace]}
        loading={false}
        error=""
        pendingJobId={null}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onCancel={vi.fn()}
        onCleanup={vi.fn()}
        onRetry={vi.fn()}
        onConfirm={confirm}
        onOpenResult={vi.fn()}
      />,
    );
    expect(screen.getByText("Pages").parentElement).toHaveTextContent("8");
    expect(screen.getByText("Tables").parentElement).toHaveTextContent("2");
    expect(screen.getByText("Assets").parentElement).toHaveTextContent("5");
    fireEvent.click(screen.getByRole("button", { name: "Confirm import" }));
    expect(confirm).toHaveBeenCalledWith(importJob, { Workspace: "space-1" });
  });

  it("requires an explicit destination for an unmatched private import group", () => {
    const confirm = vi.fn();
    const importJob: Job = {
      ...runningJob,
      id: "private-import",
      spaceId: workspaceSpace.id,
      type: "import",
      status: "awaiting_confirmation",
      result: {
        preview: {
          format: "notion_zip",
          filename: "workspace.zip",
          pages: 2,
          tables: 0,
          assets: 0,
          groups: [
            {
              key: "Private & Shared",
              name: "Private & Shared",
              pages: 2,
              roots: 1,
              suggestedVisibility: "private",
            },
          ],
          warnings: [],
        },
      },
    };
    render(
      <ActivitiesTray
        jobs={[importJob]}
        spaces={[workspaceSpace]}
        loading={false}
        error=""
        pendingJobId={null}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onCancel={vi.fn()}
        onCleanup={vi.fn()}
        onRetry={vi.fn()}
        onConfirm={confirm}
        onOpenResult={vi.fn()}
      />,
    );

    const mapping = screen.getByRole("combobox", { name: "Destination space for Private & Shared" });
    expect(mapping).toHaveValue("");
    expect(screen.getByRole("button", { name: "Confirm import" })).toBeDisabled();
    fireEvent.change(mapping, { target: { value: workspaceSpace.id } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm import" }));
    expect(confirm).toHaveBeenCalledWith(importJob, { "Private & Shared": workspaceSpace.id });
  });

  it("preselects an exact private-space match", () => {
    const privateSpace: Space = {
      ...workspaceSpace,
      id: "space-private",
      name: "Private & Shared",
      slug: "private-shared",
      visibility: "private",
    };
    const importJob: Job = {
      ...runningJob,
      id: "matched-private-import",
      spaceId: workspaceSpace.id,
      type: "import",
      status: "awaiting_confirmation",
      result: {
        preview: {
          format: "notion_zip",
          filename: "workspace.zip",
          pages: 1,
          tables: 0,
          assets: 0,
          groups: [
            {
              key: "Private & Shared",
              name: "Private & Shared",
              pages: 1,
              roots: 1,
              suggestedVisibility: "private",
            },
          ],
          warnings: [],
        },
      },
    };
    render(
      <ActivitiesTray
        jobs={[importJob]}
        spaces={[workspaceSpace, privateSpace]}
        loading={false}
        error=""
        pendingJobId={null}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onCancel={vi.fn()}
        onCleanup={vi.fn()}
        onRetry={vi.fn()}
        onConfirm={vi.fn()}
        onOpenResult={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Destination space for Private & Shared" })).toHaveValue(
      privateSpace.id,
    );
    expect(screen.getByRole("option", { name: "Workspace (Workspace)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Private & Shared (Private)" })).toBeInTheDocument();
  });
});
