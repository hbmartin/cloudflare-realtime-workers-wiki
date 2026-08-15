// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMemberContext } from "../shared/types";
import type { Page, TableData } from "../shared/types";
import { ApiClientError, api } from "./api";
import { TablePage } from "./TablePage";

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return { ...original, api: vi.fn() };
});

const page: Page = {
  id: "table-page",
  workspaceId: "workspace",
  parentId: null,
  kind: "table",
  position: "a0",
  title: "Roadmap",
  icon: null,
  revision: 1,
  contentEpoch: 1,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const table: TableData = {
  pageId: page.id,
  revision: 1,
  columns: [{ id: "status", name: "Status", type: "text", position: 0, options: [] }],
  rows: [{ id: "row", position: 0, cells: { status: "Ready" } }],
  lease: { heldByMe: false, holderName: null, expiresAt: null },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function tableWithValue(value: string, revision: number): TableData {
  return {
    ...table,
    revision,
    rows: [{ ...table.rows[0]!, cells: { status: value } }],
  };
}

function member(role: ClientMemberContext["role"]): ClientMemberContext {
  return {
    role,
    user: { id: `${role}-user`, name: role, email: `${role}@example.test` },
    workspace: { id: "workspace", name: "Notes", locationHint: null },
  };
}

describe("TablePage", () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps viewers read-only and never requests an editing lease", async () => {
    vi.mocked(api).mockResolvedValue({ table });
    render(
      <TablePage
        page={page}
        member={member("viewer")}
        onPageChanged={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );

    expect(await screen.findByDisplayValue("Ready")).toBeDisabled();
    expect(screen.getByDisplayValue("Roadmap")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "+ Property" })).not.toBeInTheDocument();
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/api/tables/table-page");
  });

  it("acquires an editor lease and exposes table mutations", async () => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return { leaseToken: "lease-token" };
      return { table };
    });
    render(
      <TablePage
        page={page}
        member={member("editor")}
        onPageChanged={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );

    expect(await screen.findByText("Editing lease active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Property" })).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/tables/table-page/lease", { method: "POST" });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("recovers from a lease conflict in read-only mode", async () => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") {
        throw new ApiClientError(409, "lease_conflict", "held");
      }
      return { table };
    });
    render(
      <TablePage
        page={page}
        member={member("editor")}
        onPageChanged={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );

    expect(await screen.findByText("Another editor has this table open for editing.")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Try edit lock" }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(4));
  });

  it("ignores a stale read-only poll after acquiring a lease", async () => {
    vi.useFakeTimers();
    const lease = deferred<{ leaseToken: string }>();
    const staleLoad = deferred<{ table: TableData }>();
    const currentLoad = deferred<{ table: TableData }>();
    let loadCount = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return lease.promise;
      loadCount += 1;
      return loadCount === 1 ? staleLoad.promise : currentLoad.promise;
    });

    render(
      <TablePage
        page={page}
        member={member("editor")}
        onPageChanged={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(loadCount).toBe(1);

    await act(async () => {
      lease.resolve({ leaseToken: "lease-token" });
      await Promise.resolve();
    });
    expect(loadCount).toBe(2);

    await act(async () => {
      currentLoad.resolve({ table: tableWithValue("Current", 2) });
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue("Current")).toBeInTheDocument();

    await act(async () => {
      staleLoad.resolve({ table: tableWithValue("Stale", 1) });
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue("Current")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Stale")).not.toBeInTheDocument();
  });
});
