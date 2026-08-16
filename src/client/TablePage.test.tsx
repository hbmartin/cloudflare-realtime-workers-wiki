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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, reject, resolve };
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
    expect(api).toHaveBeenCalledTimes(3);
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
    await waitFor(() => expect(api).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "Try edit lock" }));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(5));
  });

  it("loads immediately while a lease is pending and ignores the stale initial response", async () => {
    vi.useFakeTimers();
    const lease = deferred<{ leaseToken: string }>();
    const initialLoad = deferred<{ table: TableData }>();
    const acquiredLoad = deferred<{ table: TableData }>();
    let loadCount = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return lease.promise;
      loadCount += 1;
      return loadCount === 1 ? initialLoad.promise : acquiredLoad.promise;
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

    expect(loadCount).toBe(1);

    await act(async () => {
      lease.resolve({ leaseToken: "lease-token" });
      await Promise.resolve();
    });
    expect(loadCount).toBe(2);

    await act(async () => {
      acquiredLoad.resolve({ table: tableWithValue("Current", 2) });
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue("Current")).toBeInTheDocument();

    await act(async () => {
      initialLoad.resolve({ table: tableWithValue("Stale", 1) });
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue("Current")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Stale")).not.toBeInTheDocument();
  });

  it("releases a button-acquired lease that resolves after unmount", async () => {
    const lateLease = deferred<{ leaseToken: string }>();
    let leaseAttempts = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") {
        leaseAttempts += 1;
        if (leaseAttempts === 1) throw new ApiClientError(409, "lease_conflict", "held");
        return lateLease.promise;
      }
      if (path.endsWith("/lease") && init?.method === "DELETE") return Promise.resolve({ ok: true });
      return Promise.resolve({ table });
    });
    const rendered = render(
      <TablePage
        page={page}
        member={member("editor")}
        onPageChanged={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Try edit lock" }));
    rendered.unmount();
    lateLease.resolve({ leaseToken: "late-token" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api).toHaveBeenCalledWith("/api/tables/table-page/lease", {
      method: "DELETE",
      body: JSON.stringify({ leaseToken: "late-token" }),
      keepalive: true,
    });
  });

  it("reports non-conflict failures from the edit-lock button", async () => {
    let leaseAttempts = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") {
        leaseAttempts += 1;
        if (leaseAttempts === 1) throw new ApiClientError(409, "lease_conflict", "held");
        throw new ApiClientError(503, "lease_unavailable", "Lease service unavailable.");
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

    fireEvent.click(await screen.findByRole("button", { name: "Try edit lock" }));

    expect(await screen.findByText("Lease service unavailable.")).toBeInTheDocument();
  });

  it("loads authoritative data immediately when lease renewal fails", async () => {
    vi.useFakeTimers();
    let loadCount = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return { leaseToken: "lease-token" };
      if (path.endsWith("/lease") && init?.method === "PATCH") {
        throw new ApiClientError(409, "lease_lost", "lost");
      }
      if (path.endsWith("/lease") && init?.method === "DELETE") return { ok: true };
      loadCount += 1;
      return { table: loadCount >= 3 ? tableWithValue("Authoritative", 3) : table };
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
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(20_000));

    expect(screen.getByDisplayValue("Authoritative")).toBeInTheDocument();
    expect(screen.getByText("The editing lease was lost. Reloaded the authoritative table.")).toBeInTheDocument();
  });

  it("clears a transient polling error after the next successful load", async () => {
    vi.useFakeTimers();
    let loadCount = 0;
    vi.mocked(api).mockImplementation(async () => {
      loadCount += 1;
      if (loadCount === 2) throw new ApiClientError(503, "table_unavailable", "Table temporarily unavailable.");
      return { table };
    });
    render(
      <TablePage
        page={page}
        member={member("viewer")}
        onPageChanged={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue("Ready")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText("Table temporarily unavailable.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.queryByText("Table temporarily unavailable.")).not.toBeInTheDocument();
  });
});
