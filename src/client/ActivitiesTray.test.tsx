// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../shared/types";
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
          duplicateTitles: 0,
          unresolvedParents: 0,
          blockingIssues: [],
          groups: [{ key: "Workspace", name: "Workspace", pages: 8, roots: 3, suggestedVisibility: "workspace" }],
          warnings: [],
        },
      },
    };
    render(
      <ActivitiesTray
        jobs={[importJob]}
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
});
