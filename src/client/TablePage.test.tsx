// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ClientMemberContext } from "../shared/types";
import type { Page, TableData, TableLeaseResponse, TableLeaseTiming } from "../shared/types";
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
  limit: 500,
  sort: null,
  dir: "asc",
  hasMore: false,
  nextCursor: null,
  nextOffset: null,
  truncated: false,
  rowCount: 1,
};

const LEASE_DURATION_MS = 60_000;

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

function pagedTable(overrides: Partial<TableData> & { rows: TableData["rows"] }): TableData {
  const lastRow = overrides.rows.at(-1);
  if (!lastRow) throw new Error("pagedTable requires at least one row.");
  return {
    ...table,
    hasMore: true,
    nextCursor: { position: lastRow.position, rowId: lastRow.id },
    rowCount: Math.max(overrides.rows.length + 1, lastRow.position + 2),
    ...overrides,
  };
}

async function drainStaleRetries() {
  // Mirrors the private production retry schedule while keeping callers focused
  // on draining the behavior rather than importing scheduler implementation state.
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersByTimeAsync(50));
  await act(() => vi.advanceTimersByTimeAsync(200));
}

function tableWithTwoTextCells(revision = 1): TableData {
  return {
    ...table,
    revision,
    columns: [table.columns[0]!, { id: "notes", name: "Notes", type: "text", position: 1, options: [] }],
    rows: [{ ...table.rows[0]!, cells: { status: "Ready", notes: "Stable" } }],
  };
}

function tableWithOptions(labels: string[], revision = 1): TableData {
  return {
    ...table,
    revision,
    columns: [
      {
        id: "choice",
        name: "Choice",
        type: "select",
        position: 0,
        options: labels.map((label, position) => ({ id: `option-${position}`, label, position })),
      },
    ],
    rows: [{ ...table.rows[0]!, cells: { choice: null } }],
  };
}

function tableWithLease(): TableData {
  return {
    ...table,
    lease: { heldByMe: false, holderName: "Another editor", expiresAt: Date.now() + 60_000 },
  };
}

function leaseResult(leaseToken = "lease-token"): TableLeaseResponse {
  return { leaseToken, leaseDurationMs: LEASE_DURATION_MS };
}

// Installs fake timers that deliberately leave performance.now alone, then
// stubs it separately. This lets tests advance either lease clock without also
// firing the scheduled expiry timer. Returns the monotonic advance function.
function stubMonotonicClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const base = performance.now();
  let elapsed = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => base + elapsed);
  onTestFinished(() => now.mockRestore());
  return (milliseconds: number) => {
    elapsed += milliseconds;
  };
}

function member(role: ClientMemberContext["role"]): ClientMemberContext {
  return {
    role,
    user: { id: `${role}-user`, name: role, email: `${role}@example.test` },
    workspace: { id: "workspace", name: "Notes", locationHint: null },
  };
}

async function renderActiveEditor() {
  render(
    <TablePage
      page={page}
      member={member("editor")}
      onPageChanged={vi.fn()}
      onSelectPage={vi.fn()}
      backlinksRevision={0}
    />,
  );
  if (vi.isFakeTimers()) {
    await act(() => vi.advanceTimersByTimeAsync(0));
  } else {
    await screen.findByText("Editing lease active");
  }
  expect(screen.getByText("Editing lease active")).toBeInTheDocument();
}

describe("TablePage", () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
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
    expect(api).toHaveBeenCalledWith("/api/tables/table-page?limit=500&count=true", {
      signal: expect.any(AbortSignal),
    });
  });

  it("uses the table-load fallback when a request times out", async () => {
    vi.mocked(api).mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));

    render(
      <TablePage
        page={page}
        member={member("viewer")}
        onPageChanged={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );

    expect(await screen.findByText("Table could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("The operation timed out.")).not.toBeInTheDocument();
  });

  it("acquires an editor lease and exposes table mutations", async () => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
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
    expect(api).toHaveBeenCalledWith(
      "/api/tables/table-page/lease",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("does not enqueue an unchanged cell when it blurs", async () => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      return { table };
    });
    await renderActiveEditor();
    fireEvent.blur(screen.getByDisplayValue("Ready"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api).not.toHaveBeenCalledWith(
      "/api/tables/table-page/cells/row/status",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it.each([
    ["number", "5"],
    ["text", 5],
  ] as const)(
    "does not enqueue an unchanged %s cell whose stored value uses a different primitive type",
    async (type, value) => {
      const mismatchedTable: TableData = {
        ...table,
        columns: [{ ...table.columns[0]!, type }],
        rows: [{ ...table.rows[0]!, cells: { status: value } }],
      };
      vi.mocked(api).mockImplementation(async (path, init) => {
        if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
        return { table: mismatchedTable };
      });
      await renderActiveEditor();

      fireEvent.blur(screen.getByDisplayValue("5"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(api).not.toHaveBeenCalledWith(
        "/api/tables/table-page/cells/row/status",
        expect.objectContaining({ method: "PUT" }),
      );
    },
  );

  it("enqueues a revert to the rendered value while an earlier cell mutation is pending", async () => {
    const firstMutation = deferred<{ revision: number }>();
    const mutations: Array<Record<string, unknown>> = [];
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.includes("/cells/")) {
        mutations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return mutations.length === 1 ? firstMutation.promise : Promise.resolve({ revision: 3 });
      }
      return Promise.resolve({ table });
    });
    await renderActiveEditor();
    const input = screen.getByDisplayValue("Ready");

    fireEvent.change(input, { target: { value: "First" } });
    fireEvent.blur(input);
    await waitFor(() => expect(mutations).toHaveLength(1));
    fireEvent.change(input, { target: { value: "Ready" } });
    fireEvent.blur(input);

    firstMutation.resolve({ revision: 2 });
    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations.map((body) => body.value)).toEqual(["First", "Ready"]);
  });

  it.each([
    ["is missing", {}],
    // A duration past the setTimeout delay limit would overflow to a delay of
    // zero and expire the lease on the next tick.
    ["overflows the timer limit", { leaseDurationMs: 1e10 }],
  ])("fails closed when the lease duration %s", async (_label, timing) => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return { leaseToken: "invalid-token", ...timing };
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

    expect(await screen.findByText("The lease service returned an invalid response.")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Property" })).not.toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/tables/table-page/lease", {
      method: "DELETE",
      body: JSON.stringify({ leaseToken: "invalid-token" }),
      keepalive: true,
    });
  });

  it("waits for revision recovery before running an already queued edit", async () => {
    const firstMutation = deferred<{ revision: number }>();
    const recovery = deferred<{ table: TableData }>();
    const mutations: Array<Record<string, unknown>> = [];
    let loads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.includes("/cells/")) {
        mutations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return mutations.length === 1 ? firstMutation.promise : Promise.resolve({ revision: 8 });
      }
      loads += 1;
      return loads === 3 ? recovery.promise : Promise.resolve({ table });
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
      await Promise.resolve();
    });
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "First" } });
    fireEvent.blur(input);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mutations).toHaveLength(1);
    expect(api).toHaveBeenCalledWith(
      "/api/tables/table-page/cells/row/status",
      expect.objectContaining({ method: "PUT", signal: expect.any(AbortSignal) }),
    );

    fireEvent.change(input, { target: { value: "Second" } });
    fireEvent.blur(input);
    firstMutation.reject(new DOMException("The operation timed out.", "TimeoutError"));

    expect(await screen.findByText("The table update could not be saved.")).toBeInTheDocument();
    expect(screen.getByText("Editing paused while table reloads")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Second")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "+ Property" })).not.toBeInTheDocument();
    expect(mutations).toHaveLength(1);

    recovery.resolve({ table: tableWithValue("Ready", 7) });

    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations[1]).toMatchObject({ expectedRevision: 7, value: "Second" });
    expect(await screen.findByDisplayValue("Second")).toBeEnabled();
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
  });

  it("ignores a mutation response from an old lease before continuing queued work", async () => {
    const advanceMonotonic = stubMonotonicClock();
    const oldMutation = deferred<{ revision: number }>();
    const postAcquireLoad = deferred<{ table: TableData }>();
    const mutations: Array<Record<string, unknown>> = [];
    let leaseAttempts = 0;
    let loads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") {
        leaseAttempts += 1;
        return Promise.resolve(leaseResult(leaseAttempts === 1 ? "old-token" : "new-token"));
      }
      if (path.endsWith("/lease") && init?.method === "DELETE") return Promise.resolve({ ok: true });
      if (path.includes("/cells/")) {
        mutations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return mutations.length === 1 ? oldMutation.promise : Promise.resolve({ revision: 3 });
      }
      loads += 1;
      if (loads === 4) return postAcquireLoad.promise;
      return Promise.resolve({ table: loads >= 3 ? tableWithValue("First", 2) : table });
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
      await Promise.resolve();
    });
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "First" } });
    fireEvent.blur(input);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mutations).toHaveLength(1);
    fireEvent.change(input, { target: { value: "Second" } });
    fireEvent.blur(input);

    advanceMonotonic(LEASE_DURATION_MS + 1);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });
    const acquireButton = screen.getByRole("button", { name: "Try edit lock" });
    await act(async () => {
      fireEvent.click(acquireButton);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Editing paused while table reloads")).toBeInTheDocument();

    await act(async () => {
      oldMutation.resolve({ revision: 2 });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mutations).toHaveLength(2);
    expect(mutations[1]).toMatchObject({ expectedRevision: 2, leaseToken: "new-token", value: "Second" });
    await act(async () => {
      postAcquireLoad.resolve({ table });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByDisplayValue("Second")).toBeEnabled();
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
  });

  it("restarts automatic lease acquisition after Strict Mode replays the effect", async () => {
    const firstLease = deferred<ReturnType<typeof leaseResult>>();
    let leaseAttempts = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") {
        leaseAttempts += 1;
        return leaseAttempts === 1 ? firstLease.promise : Promise.resolve(leaseResult("current-token"));
      }
      if (path.endsWith("/lease") && init?.method === "DELETE") return Promise.resolve({ ok: true });
      return Promise.resolve({ table });
    });

    render(
      <StrictMode>
        <TablePage
          page={page}
          member={member("editor")}
          onPageChanged={vi.fn()}
          onSelectPage={vi.fn()}
          backlinksRevision={0}
        />
      </StrictMode>,
    );
    expect(leaseAttempts).toBe(1);

    firstLease.resolve(leaseResult("superseded-token"));

    await waitFor(() => expect(leaseAttempts).toBe(2));
    expect(await screen.findByText("Editing lease active")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/tables/table-page/lease", {
      method: "DELETE",
      body: JSON.stringify({ leaseToken: "superseded-token" }),
      keepalive: true,
    });
  });

  it("recovers from a lease conflict in read-only mode", async () => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") {
        throw new ApiClientError(409, "lease_conflict", "held");
      }
      return { table: tableWithLease() };
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

  it("does not let an older load clear a newer lease conflict", async () => {
    const initialLoad = deferred<{ table: TableData }>();
    let loads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") {
        return Promise.reject(new ApiClientError(409, "lease_conflict", "held"));
      }
      loads += 1;
      return loads === 1 ? initialLoad.promise : Promise.resolve({ table: tableWithLease() });
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

    await act(async () => {
      initialLoad.resolve({ table });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(loads).toBe(2));
    expect(screen.getByText("Another editor has this table open for editing.")).toBeInTheDocument();
  });

  it("keeps the successful initial load when the post-acquisition load fails", async () => {
    vi.useFakeTimers();
    const lease = deferred<ReturnType<typeof leaseResult>>();
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
      lease.resolve(leaseResult());
      await Promise.resolve();
    });
    expect(loadCount).toBe(1);

    await act(async () => {
      initialLoad.resolve({ table: tableWithValue("Initial", 1) });
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue("Initial")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Initial")).toBeDisabled();
    expect(screen.getByText("Editing paused while table reloads")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Property" })).not.toBeInTheDocument();
    expect(loadCount).toBe(2);

    await act(async () => {
      acquiredLoad.reject(new ApiClientError(503, "table_unavailable", "Table temporarily unavailable."));
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue("Initial")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Initial")).toBeDisabled();
    expect(screen.getByText("Table temporarily unavailable.")).toBeInTheDocument();
  });

  it("does not start a second lease request while automatic acquisition is pending", async () => {
    const lease = deferred<ReturnType<typeof leaseResult>>();
    let leaseAttempts = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") {
        leaseAttempts += 1;
        return lease.promise;
      }
      return Promise.resolve({ table });
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

    const button = screen.getByRole("button", { name: "Try edit lock" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(leaseAttempts).toBe(1);

    await act(async () => {
      lease.resolve(leaseResult());
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("serializes force unlock and acquisition behind one lease action", async () => {
    const unlocked = deferred<{ ok: boolean }>();
    const lease = deferred<ReturnType<typeof leaseResult>>();
    let forceAttempts = 0;
    let leaseAttempts = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") {
        leaseAttempts += 1;
        if (leaseAttempts === 1) throw new ApiClientError(409, "lease_conflict", "held");
        return lease.promise;
      }
      if (path.endsWith("/force-unlock")) {
        forceAttempts += 1;
        return unlocked.promise;
      }
      return Promise.resolve({ table });
    });
    render(
      <TablePage
        page={page}
        member={member("owner")}
        onPageChanged={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );

    const tryButton = await screen.findByRole("button", { name: "Try edit lock" });
    const forceButton = screen.getByRole("button", { name: "Force unlock" });
    await waitFor(() => expect(forceButton).toBeEnabled());
    act(() => {
      fireEvent.click(forceButton);
      fireEvent.click(tryButton);
      fireEvent.click(forceButton);
    });

    expect(forceAttempts).toBe(1);
    expect(leaseAttempts).toBe(1);
    expect(tryButton).toBeDisabled();
    expect(forceButton).toBeDisabled();

    await act(async () => {
      unlocked.resolve({ ok: true });
      await Promise.resolve();
    });
    expect(leaseAttempts).toBe(2);

    fireEvent.click(tryButton);
    fireEvent.click(forceButton);
    expect(forceAttempts).toBe(1);
    expect(leaseAttempts).toBe(2);

    await act(async () => {
      lease.resolve(leaseResult());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
  });

  it("releases a button-acquired lease that resolves after unmount", async () => {
    const lateLease = deferred<ReturnType<typeof leaseResult>>();
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

    const button = await screen.findByRole("button", { name: "Try edit lock" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    rendered.unmount();
    lateLease.resolve(leaseResult("late-token"));
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

    const button = await screen.findByRole("button", { name: "Try edit lock" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    expect(await screen.findByText("Lease service unavailable.")).toBeInTheDocument();
  });

  it("loads authoritative data immediately when lease renewal fails", async () => {
    vi.useFakeTimers();
    let loadCount = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "PATCH") {
        throw new ApiClientError(409, "lease_lost", "lost");
      }
      if (path.endsWith("/lease") && init?.method === "DELETE") return { ok: true };
      loadCount += 1;
      return { table: loadCount >= 3 ? tableWithValue("Authoritative", 3) : table };
    });
    await renderActiveEditor();

    await act(() => vi.advanceTimersByTimeAsync(20_000));

    expect(screen.getByDisplayValue("Authoritative")).toBeInTheDocument();
    expect(screen.getByText("The editing lease was lost. Reloaded the authoritative table.")).toBeInTheDocument();
  });

  it("releases the server lease after a terminal renewal failure", async () => {
    vi.useFakeTimers();
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "PATCH") {
        throw new ApiClientError(403, "role_changed", "Editing permission was removed.");
      }
      if (path.endsWith("/lease") && init?.method === "DELETE") return { ok: true };
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
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(() => vi.advanceTimersByTimeAsync(20_000));

    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/tables/table-page/lease", {
      method: "DELETE",
      body: JSON.stringify({ leaseToken: "lease-token" }),
      keepalive: true,
    });
  });

  it("keeps a lease through a renewal timeout and clears the contextual notice after retry", async () => {
    vi.useFakeTimers();
    let renewals = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "PATCH") {
        renewals += 1;
        if (renewals === 1) throw new DOMException("The operation timed out.", "TimeoutError");
        return { leaseDurationMs: LEASE_DURATION_MS };
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
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    expect(screen.getByText("The editing lease could not be renewed. Retrying.")).toBeInTheDocument();
    expect(screen.queryByText("The operation timed out. Retrying.")).not.toBeInTheDocument();
    expect(api).toHaveBeenCalledWith(
      "/api/tables/table-page/lease",
      expect.objectContaining({ method: "PATCH", signal: expect.any(AbortSignal) }),
    );
    expect(api).not.toHaveBeenCalledWith("/api/tables/table-page/lease", expect.objectContaining({ method: "DELETE" }));

    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    expect(screen.queryByText("The editing lease could not be renewed. Retrying.")).not.toBeInTheDocument();
  });

  it("does not overlap lease renewals when a request stalls", async () => {
    vi.useFakeTimers();
    const renewal = deferred<TableLeaseTiming>();
    let renewals = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.endsWith("/lease") && init?.method === "PATCH") {
        renewals += 1;
        return renewal.promise;
      }
      return Promise.resolve({ table });
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

    await act(() => vi.advanceTimersByTimeAsync(40_000));
    expect(renewals).toBe(1);

    await act(async () => {
      renewal.resolve({ leaseDurationMs: LEASE_DURATION_MS });
      await Promise.resolve();
    });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(renewals).toBe(2);
  });

  it("reschedules an expiry timer that fires before the monotonic deadline", async () => {
    const advanceMonotonic = stubMonotonicClock();
    const acquiredAt = Date.now();
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.endsWith("/lease") && init?.method === "PATCH") return new Promise(() => undefined);
      return Promise.resolve({ table });
    });
    await renderActiveEditor();

    vi.setSystemTime(acquiredAt - LEASE_DURATION_MS);
    advanceMonotonic(LEASE_DURATION_MS - 1);
    await act(() => vi.advanceTimersByTimeAsync(LEASE_DURATION_MS));
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();

    vi.setSystemTime(acquiredAt + LEASE_DURATION_MS + 1);
    advanceMonotonic(2);
    await act(() => vi.advanceTimersByTimeAsync(2));
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("ends the lease when a renewal response cannot be read", async () => {
    vi.useFakeTimers();
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "PATCH") return {};
      return { table };
    });
    await renderActiveEditor();

    await act(() => vi.advanceTimersByTimeAsync(20_000));

    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByText("The lease service returned an invalid response.")).toBeInTheDocument();
    expect(screen.queryByText("The lease service returned an invalid response. Retrying.")).not.toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/tables/table-page/lease", {
      method: "DELETE",
      body: JSON.stringify({ leaseToken: "lease-token" }),
      keepalive: true,
    });
  });

  it("reloads the authoritative revision after a mutation fails", async () => {
    const mutations: unknown[] = [];
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.includes("/cells/")) {
        mutations.push(JSON.parse(String(init?.body)));
        if (mutations.length === 1) throw new DOMException("The operation timed out.", "TimeoutError");
        return { revision: 8 };
      }
      // The server applied the timed-out write, so its revision moved on.
      return { table: mutations.length ? tableWithValue("Ready", 7) : table };
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
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "First" } });
    fireEvent.blur(input);
    expect(await screen.findByText("The table update could not be saved.")).toBeInTheDocument();

    const recoveredInput = screen.getByDisplayValue("Ready");
    fireEvent.change(recoveredInput, { target: { value: "Second" } });
    fireEvent.blur(recoveredInput);
    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations[1]).toMatchObject({ expectedRevision: 7 });
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    expect(screen.queryByText("The table update could not be saved.")).not.toBeInTheDocument();
  });

  it("resets only the affected cell after an ambiguous mutation failure", async () => {
    const mutation = deferred<{ revision: number }>();
    let loads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.includes("/cells/")) return mutation.promise;
      loads += 1;
      return Promise.resolve({ table: tableWithTwoTextCells(loads >= 3 ? 7 : 1) });
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
    const status = screen.getByDisplayValue("Ready");
    fireEvent.change(status, { target: { value: "Uncertain" } });
    fireEvent.blur(status);
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.stringContaining("/cells/"), expect.anything()));

    const notes = screen.getByDisplayValue("Stable");
    fireEvent.change(notes, { target: { value: "Unblurred draft" } });
    mutation.reject(new DOMException("The operation timed out.", "TimeoutError"));

    expect(await screen.findByDisplayValue("Ready")).toBeEnabled();
    expect(screen.getByDisplayValue("Unblurred draft")).toBeEnabled();
  });

  it("keeps the revision and unrelated drafts after a definitive mutation rejection", async () => {
    const mutation = deferred<{ revision: number }>();
    let loads = 0;
    let mutations = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.includes("/cells/")) {
        mutations += 1;
        return mutation.promise;
      }
      loads += 1;
      return Promise.resolve({ table: tableWithTwoTextCells() });
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
    const status = screen.getByDisplayValue("Ready");
    fireEvent.change(status, { target: { value: "Invalid" } });
    fireEvent.blur(status);
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.stringContaining("/cells/"), expect.anything()));
    fireEvent.change(screen.getByDisplayValue("Stable"), { target: { value: "Unblurred draft" } });

    mutation.reject(new ApiClientError(422, "invalid_cell", "This cell value is invalid."));

    expect(await screen.findByText("This cell value is invalid.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Invalid")).toBeEnabled();
    expect(screen.getByDisplayValue("Unblurred draft")).toBeEnabled();
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    expect(loads).toBe(2);

    fireEvent.focus(status);
    fireEvent.blur(status);
    await waitFor(() => expect(mutations).toBe(2));
  });

  it("reloads the table when a mutation target no longer exists", async () => {
    let loads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.includes("/cells/")) throw new ApiClientError(404, "row_not_found", "Row not found.");
      loads += 1;
      return { table: loads >= 3 ? { ...table, revision: 2, rows: [] } : table };
    });
    await renderActiveEditor();
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "Stale edit" } });
    fireEvent.blur(input);

    expect(await screen.findByText("Row not found.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByDisplayValue("Stale edit")).not.toBeInTheDocument());
    expect(loads).toBe(3);
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
  });

  it("ends editing on a role downgrade without discarding the visible draft", async () => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "DELETE") return { ok: true };
      if (path.includes("/cells/")) {
        throw new ApiClientError(403, "read_only", "Your workspace role is read-only.");
      }
      return { table };
    });
    await renderActiveEditor();
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "Unsaved draft" } });
    fireEvent.blur(input);

    expect(await screen.findByText("Your workspace role is read-only.")).toBeInTheDocument();
    expect(screen.getByText("The table update was not saved because editing access was lost.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Unsaved draft")).toBeDisabled();
    expect(api).toHaveBeenCalledWith("/api/tables/table-page/lease", {
      method: "DELETE",
      body: JSON.stringify({ leaseToken: "lease-token" }),
      keepalive: true,
    });
  });

  it("clears an earlier save error when a role downgrade ends editing", async () => {
    let mutations = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "DELETE") return { ok: true };
      if (path.includes("/cells/")) {
        mutations += 1;
        if (mutations === 1) throw new ApiClientError(422, "invalid_cell", "The first value was invalid.");
        throw new ApiClientError(403, "read_only", "Your workspace role is read-only.");
      }
      return { table };
    });
    await renderActiveEditor();
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "First" } });
    fireEvent.blur(input);
    expect(await screen.findByText("The first value was invalid.")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Second" } });
    fireEvent.blur(input);

    expect(await screen.findByText("Your workspace role is read-only.")).toBeInTheDocument();
    expect(screen.queryByText("The first value was invalid.")).not.toBeInTheDocument();
    expect(screen.getByText("The table update was not saved because editing access was lost.")).toBeInTheDocument();
  });

  it("releases the lease and stops polling when a mutation reports that the page is unavailable", async () => {
    vi.useFakeTimers();
    const onPageUnavailable = vi.fn();
    let loads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "DELETE") return { ok: true };
      if (path.includes("/cells/")) throw new ApiClientError(404, "page_not_found", "Page not found.");
      loads += 1;
      return { table };
    });
    render(
      <TablePage
        page={page}
        member={member("editor")}
        onPageChanged={vi.fn()}
        onPageUnavailable={onPageUnavailable}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "Unsaved" } });
    fireEvent.blur(input);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(onPageUnavailable).toHaveBeenCalledWith(page.id);
    expect(api).toHaveBeenCalledWith("/api/tables/table-page/lease", {
      method: "DELETE",
      body: JSON.stringify({ leaseToken: "lease-token" }),
      keepalive: true,
    });
    expect(screen.queryByRole("button", { name: "Try edit lock" })).not.toBeInTheDocument();
    expect(loads).toBe(2);

    await act(() => vi.advanceTimersByTimeAsync(25_000));
    expect(loads).toBe(2);
  });

  it("stops polling and reports the page unavailable when a reload finds it gone", async () => {
    vi.useFakeTimers();
    const onPageUnavailable = vi.fn();
    let loads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "DELETE") return { ok: true };
      if (path.includes("/cells/")) throw new DOMException("The operation timed out.", "TimeoutError");
      loads += 1;
      // The authoritative reload after the ambiguous save finds the page archived.
      if (loads >= 3) throw new ApiClientError(404, "page_not_found", "Page not found.");
      return { table };
    });
    render(
      <TablePage
        page={page}
        member={member("editor")}
        onPageChanged={vi.fn()}
        onPageUnavailable={onPageUnavailable}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "Unsaved" } });
    fireEvent.blur(input);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(onPageUnavailable).toHaveBeenCalledWith(page.id);
    expect(screen.getByText("Page not found.")).toBeInTheDocument();
    expect(screen.queryByText("The table update could not be saved.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try edit lock" })).not.toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/tables/table-page/lease", {
      method: "DELETE",
      body: JSON.stringify({ leaseToken: "lease-token" }),
      keepalive: true,
    });
    expect(loads).toBe(3);

    await act(() => vi.advanceTimersByTimeAsync(25_000));
    expect(loads).toBe(3);
    expect(api).not.toHaveBeenCalledWith("/api/tables/table-page/lease", expect.objectContaining({ method: "PATCH" }));
  });

  it("ends editing without reloading or polling when lease renewal finds the page gone", async () => {
    vi.useFakeTimers();
    const onPageUnavailable = vi.fn();
    let loads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "PATCH") {
        throw new ApiClientError(404, "page_not_found", "Page not found.");
      }
      if (path.endsWith("/lease") && init?.method === "DELETE") return { ok: true };
      loads += 1;
      return { table };
    });
    render(
      <TablePage
        page={page}
        member={member("editor")}
        onPageChanged={vi.fn()}
        onPageUnavailable={onPageUnavailable}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    const loadsBeforeRenewal = loads;

    await act(() => vi.advanceTimersByTimeAsync(20_000));

    expect(onPageUnavailable).toHaveBeenCalledWith(page.id);
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByText("Page not found.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try edit lock" })).not.toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/tables/table-page/lease", {
      method: "DELETE",
      body: JSON.stringify({ leaseToken: "lease-token" }),
      keepalive: true,
    });
    expect(loads).toBe(loadsBeforeRenewal);

    await act(() => vi.advanceTimersByTimeAsync(25_000));
    expect(loads).toBe(loadsBeforeRenewal);
  });

  it("keeps a queued draft when an earlier save reports that the page is unavailable", async () => {
    const firstSave = deferred<{ revision: number }>();
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.endsWith("/lease") && init?.method === "DELETE") return Promise.resolve({ ok: true });
      if (path.includes("/cells/")) return firstSave.promise;
      return Promise.resolve({ table: tableWithTwoTextCells() });
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
    const status = screen.getByDisplayValue("Ready");
    fireEvent.change(status, { target: { value: "First" } });
    fireEvent.blur(status);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(expect.stringContaining("/cells/row/status"), expect.anything()),
    );
    const notes = screen.getByDisplayValue("Stable");
    fireEvent.change(notes, { target: { value: "Second" } });
    fireEvent.blur(notes);

    firstSave.reject(new ApiClientError(404, "page_not_found", "Page not found."));

    expect(await screen.findByText("Page not found.")).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The queued save is dropped quietly: no lease-loss notice, both drafts stay visible.
    expect(screen.getByDisplayValue("First")).toBeDisabled();
    expect(screen.getByDisplayValue("Second")).toBeDisabled();
    expect(
      screen.queryByText("The table update was not saved because editing access was lost."),
    ).not.toBeInTheDocument();
    expect(vi.mocked(api).mock.calls.filter(([path]) => String(path).includes("/cells/"))).toHaveLength(1);
  });

  it("treats a page-not-found response that lands after the local lease expired as terminal", async () => {
    const advanceMonotonic = stubMonotonicClock();
    const onPageUnavailable = vi.fn();
    const save = deferred<{ revision: number }>();
    let loads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.endsWith("/lease") && init?.method === "DELETE") return Promise.resolve({ ok: true });
      if (path.includes("/cells/")) return save.promise;
      loads += 1;
      return Promise.resolve({ table });
    });
    render(
      <TablePage
        page={page}
        member={member("editor")}
        onPageChanged={vi.fn()}
        onPageUnavailable={onPageUnavailable}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "In flight" } });
    fireEvent.blur(input);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api).toHaveBeenCalledWith(expect.stringContaining("/cells/"), expect.anything());

    // The local lease deadline passes while the save is still in flight.
    advanceMonotonic(LEASE_DURATION_MS + 1);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("The editing lease expired. Reloaded the authoritative table.")).toBeInTheDocument();
    const loadsAfterExpiry = loads;

    save.reject(new ApiClientError(404, "page_not_found", "Page not found."));
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(onPageUnavailable).toHaveBeenCalledWith(page.id);
    expect(screen.getByText("Page not found.")).toBeInTheDocument();
    expect(
      screen.queryByText("The table update was not saved because editing access was lost."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try edit lock" })).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(25_000));
    expect(loads).toBe(loadsAfterExpiry);
  });

  it("reports a terminal message when a revision conflict repeats", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    let loads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.includes("/cells/")) {
        mutations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        throw new ApiClientError(409, "table_revision_conflict", "The table changed. Reloading before retrying.");
      }
      loads += 1;
      return { table: loads >= 4 ? tableWithValue("Server value", 3) : tableWithValue("Ready", loads >= 3 ? 2 : 1) };
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
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "Client value" } });
    fireEvent.blur(input);

    expect(
      await screen.findByText(
        "The table update was not saved because the table kept changing. Reloaded the authoritative table.",
      ),
    ).toBeInTheDocument();
    expect(mutations).toHaveLength(2);
    expect(screen.getByDisplayValue("Server value")).toBeEnabled();
    expect(screen.queryByText("The table changed. Reloading before retrying.")).not.toBeInTheDocument();
  });

  it("reports that an update was dropped when conflict recovery fails", async () => {
    let loads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.includes("/cells/")) {
        throw new ApiClientError(409, "table_revision_conflict", "The table changed. Reloading before retrying.");
      }
      loads += 1;
      if (loads === 3) throw new ApiClientError(503, "table_unavailable", "Table temporarily unavailable.");
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
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "Client value" } });
    fireEvent.blur(input);

    expect(
      await screen.findByText(
        "The table update was not saved because the authoritative table revision could not be reloaded.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Editing paused while table reloads")).toBeInTheDocument();
    expect(screen.queryByText("The table changed. Reloading before retrying.")).not.toBeInTheDocument();
  });

  it("recovers against the live sort when a sort change supersedes a failed-save reload", async () => {
    const staleRecovery = deferred<{ table: TableData }>();
    const supersededSortLoad = deferred<{ table: TableData }>();
    let plainLoads = 0;
    let sortedLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.endsWith("/lease") && init?.method === "DELETE") return Promise.resolve({ ok: true });
      if (init?.method === "PUT") return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
      if (String(path).includes("sort=status")) {
        sortedLoads += 1;
        if (sortedLoads === 1) return supersededSortLoad.promise;
        return Promise.resolve({
          table: { ...tableWithValue("Sorted authoritative", 2), sort: "status" },
        });
      }
      plainLoads += 1;
      if (plainLoads <= 2) return Promise.resolve({ table });
      return staleRecovery.promise;
    });
    await renderActiveEditor();

    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "Unsaved" } });
    fireEvent.blur(input);
    await waitFor(() => expect(plainLoads).toBe(3));
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await waitFor(() => expect(sortedLoads).toBe(1));

    await act(async () => {
      staleRecovery.resolve({ table: tableWithValue("Superseded", 2) });
      await staleRecovery.promise;
    });

    expect(await screen.findByDisplayValue("Sorted authoritative")).toBeEnabled();
    expect(sortedLoads).toBe(2);
    expect(
      screen.queryByText(
        "The table update was not saved because the authoritative table revision could not be reloaded.",
      ),
    ).not.toBeInTheDocument();

    await act(async () => {
      supersededSortLoad.resolve({ table: { ...tableWithValue("Stale sorted", 2), sort: "status" } });
      await supersededSortLoad.promise;
    });
    expect(screen.getByDisplayValue("Sorted authoritative")).toBeEnabled();
  });

  it("leaves option position assignment to the server across revision recovery", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    let loads = 0;
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("New option");
    onTestFinished(() => prompt.mockRestore());
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/options")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        mutations.push(body);
        if (mutations.length === 1) {
          throw new ApiClientError(409, "table_revision_conflict", "The table changed. Reloading before retrying.");
        }
        return { option: { id: "new-option", label: "New option", position: 2 }, revision: 3 };
      }
      loads += 1;
      return { table: loads >= 3 ? tableWithOptions(["One", "Two"], 2) : tableWithOptions(["One"]) };
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
    fireEvent.click(screen.getByRole("button", { name: "Add option to Choice" }));

    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations).toEqual([
      expect.not.objectContaining({ position: expect.anything() }),
      expect.not.objectContaining({ position: expect.anything() }),
    ]);
    expect(screen.getByRole("option", { name: "New option" })).toBeInTheDocument();
  });

  it("resyncs and retries a revision-only conflict without releasing the lease", async () => {
    const mutations: Array<Record<string, unknown>> = [];
    let loads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.includes("/cells/")) {
        mutations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (mutations.length === 1) throw new DOMException("The operation timed out.", "TimeoutError");
        if (mutations.length === 2) {
          throw new ApiClientError(409, "table_revision_conflict", "The table changed. Reloading before retrying.");
        }
        return { revision: 3 };
      }
      loads += 1;
      if (loads === 4) return { table: tableWithValue("First", 2) };
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
    const firstInput = screen.getByDisplayValue("Ready");
    fireEvent.change(firstInput, { target: { value: "First" } });
    fireEvent.blur(firstInput);
    await waitFor(() => expect(loads).toBe(3));

    const secondInput = screen.getByDisplayValue("Ready");
    fireEvent.change(secondInput, { target: { value: "Second" } });
    fireEvent.blur(secondInput);

    await waitFor(() => expect(mutations).toHaveLength(3));
    expect(mutations.map((body) => body.expectedRevision)).toEqual([1, 1, 2]);
    expect(await screen.findByDisplayValue("Second")).toBeEnabled();
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith("/api/tables/table-page/lease", expect.objectContaining({ method: "DELETE" }));
  });

  it("polls for the authoritative revision when the post-failure reload also fails", async () => {
    vi.useFakeTimers();
    const mutations: unknown[] = [];
    let reloadFailed = false;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.includes("/cells/")) {
        mutations.push(JSON.parse(String(init?.body)));
        if (mutations.length === 1) throw new DOMException("The operation timed out.", "TimeoutError");
        return { revision: 8 };
      }
      // The reload that follows the failed mutation fails too, so the revision
      // stays unknown until polling recovers it.
      if (mutations.length === 1 && !reloadFailed) {
        reloadFailed = true;
        throw new ApiClientError(503, "table_unavailable", "Table temporarily unavailable.");
      }
      return { table: mutations.length ? tableWithValue("Ready", 7) : table };
    });
    await renderActiveEditor();
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "First" } });
    fireEvent.blur(input);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Table temporarily unavailable.")).toBeInTheDocument();
    expect(screen.getByText("Editing paused while table reloads")).toBeInTheDocument();
    expect(screen.getByDisplayValue("First")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "+ Property" })).not.toBeInTheDocument();
    expect(mutations).toHaveLength(1);

    await act(() => vi.advanceTimersByTimeAsync(5_000));

    const recoveredInput = screen.getByDisplayValue("Ready");
    expect(recoveredInput).toBeEnabled();
    fireEvent.change(recoveredInput, { target: { value: "Second" } });
    fireEvent.blur(recoveredInput);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mutations).toHaveLength(2);
    expect(mutations[1]).toMatchObject({ expectedRevision: 7 });
  });

  it("recovers an unsorted appended table at its existing depth", async () => {
    vi.useFakeTimers();
    const first: TableData = {
      ...table,
      rows: [{ id: "row-1", position: 0, cells: { status: "Ready" } }],
      hasMore: true,
      nextCursor: { position: 0, rowId: "row-1" },
      rowCount: 3,
    };
    const second: TableData = {
      ...table,
      revision: 2,
      rows: [{ id: "row-2", position: 1, cells: { status: "Two" } }],
      hasMore: true,
      nextCursor: { position: 1, rowId: "row-2" },
      rowCount: null,
    };
    const recovery = deferred<{ table: TableData }>();
    let fullLoads = 0;
    let keysetLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.endsWith("/lease") && init?.method === "DELETE") return Promise.resolve({ ok: true });
      if (path.includes("/cells/")) {
        return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
      }
      if (path.includes("afterPosition=")) {
        keysetLoads += 1;
        return Promise.resolve({
          table:
            keysetLoads === 1
              ? second
              : {
                  ...second,
                  revision: 7,
                  rows: [{ id: "row-2", position: 1, cells: { status: "Authoritative two" } }],
                  hasMore: false,
                  nextCursor: null,
                },
        });
      }
      fullLoads += 1;
      if (fullLoads === 3) {
        return Promise.reject(new ApiClientError(503, "table_unavailable", "Table temporarily unavailable."));
      }
      if (fullLoads === 4) return recovery.promise;
      return Promise.resolve({ table: first });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue("Two")).toBeInTheDocument();
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "Unsaved" } });
    fireEvent.blur(input);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Editing paused while table reloads")).toBeInTheDocument();
    const loadMore = screen.getByRole("button", { name: "Load more rows" });
    expect(loadMore).toBeDisabled();
    expect(fullLoads).toBe(3);

    // A prior append must not suppress the poll that restores the unknown revision.
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(fullLoads).toBe(4);
    const callsDuringRecovery = vi.mocked(api).mock.calls.length;
    fireEvent.click(loadMore);
    expect(api).toHaveBeenCalledTimes(callsDuringRecovery);

    await act(async () => {
      recovery.resolve({
        table: {
          ...first,
          revision: 7,
          rows: [{ id: "row-1", position: 0, cells: { status: "Authoritative" } }],
        },
      });
      await recovery.promise;
    });
    expect(screen.getByDisplayValue("Authoritative")).toBeEnabled();
    expect(screen.queryByDisplayValue("Two")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Authoritative two")).toBeEnabled();
    expect(keysetLoads).toBe(2);
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more rows" })).not.toBeInTheDocument();
  });

  it("keeps a save failure visible across a successful lease renewal", async () => {
    vi.useFakeTimers();
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "PATCH") return { leaseDurationMs: LEASE_DURATION_MS };
      if (path.includes("/cells/"))
        throw new ApiClientError(500, "table_unavailable", "Table temporarily unavailable.");
      return { table };
    });
    await renderActiveEditor();
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "First" } });
    fireEvent.blur(input);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Table temporarily unavailable.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(20_000));

    expect(screen.getByText("Table temporarily unavailable.")).toBeInTheDocument();
  });

  it("keeps the mount load on screen when the lease-conflict reload fails", async () => {
    const initialLoad = deferred<{ table: TableData }>();
    let loads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") {
        return Promise.reject(new ApiClientError(409, "lease_conflict", "held"));
      }
      loads += 1;
      return loads === 1
        ? initialLoad.promise
        : Promise.reject(new ApiClientError(503, "table_unavailable", "Table temporarily unavailable."));
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
    expect(screen.getByText("Loading table…")).toBeInTheDocument();

    await act(async () => {
      initialLoad.resolve({ table });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(loads).toBe(2));
    await waitFor(() => expect(screen.getByText("Table temporarily unavailable.")).toBeInTheDocument());

    expect(screen.getByDisplayValue("Ready")).toBeInTheDocument();
    expect(screen.queryByText("Loading table…")).not.toBeInTheDocument();
    expect(screen.getByText("Another editor has this table open for editing.")).toBeInTheDocument();
  });

  it("expires a stale lease when the window regains focus", async () => {
    const advanceMonotonic = stubMonotonicClock();
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "DELETE") return { ok: true };
      return { table };
    });
    await renderActiveEditor();

    advanceMonotonic(LEASE_DURATION_MS + 1);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByText("The editing lease expired. Reloaded the authoritative table.")).toBeInTheDocument();
  });

  it("verifies a lease after a forward wall-clock adjustment instead of deleting it", async () => {
    stubMonotonicClock();
    const acquiredAt = Date.now();
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "PATCH") return { leaseDurationMs: LEASE_DURATION_MS };
      if (path.endsWith("/lease") && init?.method === "DELETE") return { ok: true };
      return { table };
    });
    await renderActiveEditor();

    vi.setSystemTime(acquiredAt + LEASE_DURATION_MS + 1);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api).toHaveBeenCalledWith(
      "/api/tables/table-page/lease",
      expect.objectContaining({ method: "PATCH", signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    const patchCalls = vi.mocked(api).mock.calls.filter(([, init]) => init?.method === "PATCH").length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(patchCalls);
    expect(api).not.toHaveBeenCalledWith("/api/tables/table-page/lease", expect.objectContaining({ method: "DELETE" }));
  });

  it("uses a renewal started after a clock change to verify the lease", async () => {
    stubMonotonicClock();
    const acquiredAt = Date.now();
    const staleRenewal = deferred<TableLeaseTiming>();
    let renewals = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.endsWith("/lease") && init?.method === "PATCH") {
        renewals += 1;
        return renewals === 1 ? staleRenewal.promise : Promise.resolve({ leaseDurationMs: LEASE_DURATION_MS });
      }
      return Promise.resolve({ table });
    });
    await renderActiveEditor();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(renewals).toBe(1);

    vi.setSystemTime(acquiredAt + 100_000);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      staleRenewal.resolve({ leaseDurationMs: LEASE_DURATION_MS });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renewals).toBe(2);
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
  });

  it("releases a possibly live lease when clock-change verification fails transiently", async () => {
    stubMonotonicClock();
    const acquiredAt = Date.now();
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "PATCH") {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }
      if (path.endsWith("/lease") && init?.method === "DELETE") return { ok: true };
      return { table };
    });
    await renderActiveEditor();

    vi.setSystemTime(acquiredAt + LEASE_DURATION_MS + 1);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/api/tables/table-page/lease", {
      method: "DELETE",
      body: JSON.stringify({ leaseToken: "lease-token" }),
      keepalive: true,
    });
  });

  it("ends a lease after system sleep when the server says it was lost", async () => {
    stubMonotonicClock();
    const acquiredAt = Date.now();
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "PATCH") {
        throw new ApiClientError(409, "lease_lost", "The table lease has expired or been replaced.");
      }
      return { table };
    });
    await renderActiveEditor();

    vi.setSystemTime(acquiredAt + LEASE_DURATION_MS + 1);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByText("The table lease has expired or been replaced.")).toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith("/api/tables/table-page/lease", expect.objectContaining({ method: "DELETE" }));
  });

  it("does not send a mutation after the local lease deadline", async () => {
    const advanceMonotonic = stubMonotonicClock();
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "DELETE") return { ok: true };
      return { table };
    });
    await renderActiveEditor();

    advanceMonotonic(LEASE_DURATION_MS + 1);
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "Stale" } });
    fireEvent.blur(input);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(screen.getByText("The table update was not saved because editing access was lost.")).toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith(
      "/api/tables/table-page/cells/row/status",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("clears a lease-conflict notice once polling observes that the lease was released", async () => {
    vi.useFakeTimers();
    let loads = 0;
    const heldTable = tableWithLease();
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") {
        throw new ApiClientError(409, "lease_conflict", "held");
      }
      loads += 1;
      return { table: loads < 3 ? heldTable : table };
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
    expect(screen.getByText("Another editor has this table open for editing.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(screen.queryByText("Another editor has this table open for editing.")).not.toBeInTheDocument();
  });

  it("shows lease status without hiding a later table load failure", async () => {
    vi.useFakeTimers();
    let loads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") {
        throw new ApiClientError(409, "lease_conflict", "held");
      }
      loads += 1;
      if (loads === 3) throw new ApiClientError(503, "table_unavailable", "Table temporarily unavailable.");
      return { table: loads < 3 ? tableWithLease() : table };
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
    expect(screen.getByText("Another editor has this table open for editing.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText("Another editor has this table open for editing.")).toBeInTheDocument();
    expect(screen.getByText("Table temporarily unavailable.")).toBeInTheDocument();
  });

  it.each([
    ["a timeout", new DOMException("The operation timed out.", "TimeoutError")],
    ["a non-Error rejection", "offline"],
  ])("uses a force-unlock-specific fallback message for %s", async (_label, failure) => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") {
        throw new ApiClientError(409, "lease_conflict", "held");
      }
      if (path.endsWith("/force-unlock")) throw failure;
      return { table };
    });
    render(
      <TablePage
        page={page}
        member={member("owner")}
        onPageChanged={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );
    const button = await screen.findByRole("button", { name: "Force unlock" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

    expect(await screen.findByText("The table could not be force-unlocked.")).toBeInTheDocument();
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
    const input = screen.getByDisplayValue("Ready");

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText("Table temporarily unavailable.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.queryByText("Table temporarily unavailable.")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Ready")).toBe(input);
  });

  it("resumes polling after a table load times out", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      window.setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    onTestFinished(() => timeout.mockRestore());
    let loads = 0;
    vi.mocked(api).mockImplementation((_path, init) => {
      loads += 1;
      if (loads > 1) return Promise.resolve({ table });
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("Table load timed out.")), { once: true });
      });
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

    await act(() => vi.advanceTimersByTimeAsync(20_000));

    expect(loads).toBeGreaterThan(1);
    expect(screen.getByDisplayValue("Ready")).toBeInTheDocument();
  });
  function renderViewer() {
    render(
      <TablePage
        page={page}
        member={member("viewer")}
        onPageChanged={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );
  }

  it("clears an active sort when its column is deleted locally", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    onTestFinished(() => confirm.mockRestore());
    const withoutStatus: TableData = {
      ...table,
      revision: 2,
      columns: [],
      rows: [{ ...table.rows[0]!, cells: {} }],
    };
    let deleted = false;
    let plainLoads = 0;
    let sortedLoads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "DELETE") return { ok: true };
      if (path.endsWith("/columns/status") && init?.method === "DELETE") {
        deleted = true;
        return { revision: 2 };
      }
      if (String(path).includes("sort=status")) {
        sortedLoads += 1;
        return { table: { ...table, sort: "status" } };
      }
      plainLoads += 1;
      return { table: deleted ? withoutStatus : table };
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await waitFor(() => expect(sortedLoads).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Delete Status" }));

    await waitFor(() => expect(plainLoads).toBe(3));
    expect(sortedLoads).toBe(1);
    expect(screen.getByText("Add a property to start this table.")).toBeInTheDocument();
  });

  it("clears a remotely invalidated sort and reloads the table unsorted", async () => {
    vi.useFakeTimers();
    const withoutStatus: TableData = {
      ...table,
      revision: 2,
      columns: [],
      rows: [{ ...table.rows[0]!, cells: {} }],
    };
    let plainLoads = 0;
    let sortedLoads = 0;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("sort=status")) {
        sortedLoads += 1;
        if (sortedLoads > 1) {
          return Promise.reject(
            new ApiClientError(422, "invalid_table_sort", "The sort column does not belong to this table."),
          );
        }
        return Promise.resolve({ table: { ...table, sort: "status" } });
      }
      plainLoads += 1;
      return Promise.resolve({ table: plainLoads > 1 ? withoutStatus : table });
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(sortedLoads).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(sortedLoads).toBe(2);
    expect(plainLoads).toBe(2);
    expect(screen.getByText("Add a property to start this table.")).toBeInTheDocument();
    expect(screen.queryByText("The sort column does not belong to this table.")).not.toBeInTheDocument();
  });

  it("appends the next keyset page instead of replacing the loaded rows", async () => {
    const first: TableData = {
      ...table,
      rows: [{ id: "row-1", position: 0, cells: { status: "One" } }],
      hasMore: true,
      nextCursor: { position: 0, rowId: "row-1" },
      rowCount: 2,
    };
    const second: TableData = {
      ...table,
      rows: [{ id: "row-2", position: 1, cells: { status: "Two" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: 2,
    };
    vi.mocked(api).mockResolvedValueOnce({ table: first }).mockResolvedValueOnce({ table: second });
    renderViewer();

    fireEvent.click(await screen.findByRole("button", { name: "Load more rows" }));

    expect(await screen.findByDisplayValue("Two")).toBeInTheDocument();
    expect(screen.getByDisplayValue("One")).toBeInTheDocument();
    expect(api).toHaveBeenLastCalledWith("/api/tables/table-page?limit=500&afterPosition=0&afterId=row-1", {
      signal: expect.any(AbortSignal),
    });
  });

  it("appends a sorted offset page while preserving its column and direction", async () => {
    const first: TableData = {
      ...table,
      sort: "status",
      rows: [{ id: "row-1", position: 0, cells: { status: "Alpha" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 700,
    };
    const second: TableData = {
      ...table,
      sort: "status",
      rows: [{ id: "row-2", position: 1, cells: { status: "Beta" } }],
      rowCount: 700,
    };
    vi.mocked(api)
      .mockResolvedValueOnce({ table })
      .mockResolvedValueOnce({ table: first })
      .mockResolvedValueOnce({ table: second });
    renderViewer();

    fireEvent.click(await screen.findByRole("button", { name: /^Status/ }));
    expect(await screen.findByDisplayValue("Alpha")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));

    expect(await screen.findByDisplayValue("Beta")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Alpha")).toBeInTheDocument();
    expect(api).toHaveBeenLastCalledWith("/api/tables/table-page?limit=500&sort=status&dir=asc&offset=500", {
      signal: expect.any(AbortSignal),
    });
  });

  it("clears an invalid sort discovered after appending a sorted page", async () => {
    const sortedFirst: TableData = {
      ...table,
      sort: "status",
      rows: [{ id: "row-alpha", position: 0, cells: { status: "Alpha" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 1_001,
    };
    const sortedSecond: TableData = {
      ...sortedFirst,
      rows: [{ id: "row-beta", position: 500, cells: { status: "Beta" } }],
      nextOffset: 1_000,
      rowCount: null,
    };
    const withoutStatus: TableData = {
      ...table,
      revision: 2,
      columns: [],
      rows: [],
      rowCount: 0,
    };
    let plainLoads = 0;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("offset=1000")) {
        return Promise.reject(
          new ApiClientError(422, "invalid_table_sort", "The sort column does not belong to this table."),
        );
      }
      if (String(path).includes("offset=500")) return Promise.resolve({ table: sortedSecond });
      if (String(path).includes("sort=status")) return Promise.resolve({ table: sortedFirst });
      plainLoads += 1;
      return Promise.resolve({ table: plainLoads > 1 ? withoutStatus : table });
    });
    renderViewer();

    fireEvent.click(await screen.findByRole("button", { name: /^Status/ }));
    expect(await screen.findByDisplayValue("Alpha")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    expect(await screen.findByDisplayValue("Beta")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));

    expect(await screen.findByText("Add a property to start this table.")).toBeInTheDocument();
    expect(plainLoads).toBe(2);
    expect(screen.queryByText("The sort column does not belong to this table.")).not.toBeInTheDocument();
  });

  it("clears an invalid sort discovered while rebuilding sorted depth", async () => {
    vi.useFakeTimers();
    const sortedFirst: TableData = {
      ...table,
      revision: 5,
      sort: "status",
      rows: [{ id: "row-alpha", position: 0, cells: { status: "Alpha" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 501,
    };
    const newerOffset: TableData = {
      ...sortedFirst,
      revision: 6,
      rows: [{ id: "row-beta", position: 500, cells: { status: "Beta" } }],
      hasMore: false,
      nextOffset: null,
      rowCount: null,
    };
    const withoutStatus: TableData = {
      ...table,
      revision: 6,
      columns: [],
      rows: [],
      rowCount: 0,
    };
    const staleUnsorted = tableWithValue("Stale unsorted", 4);
    let plainLoads = 0;
    let sortedLoads = 0;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("offset=500")) return Promise.resolve({ table: newerOffset });
      if (String(path).includes("sort=status")) {
        sortedLoads += 1;
        if (sortedLoads > 1) {
          return Promise.reject(
            new ApiClientError(422, "invalid_table_sort", "The sort column does not belong to this table."),
          );
        }
        return Promise.resolve({ table: sortedFirst });
      }
      plainLoads += 1;
      return Promise.resolve({ table: plainLoads === 1 ? table : plainLoads === 2 ? staleUnsorted : withoutStatus });
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByDisplayValue("Alpha")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await act(() => vi.advanceTimersByTimeAsync(0));

    // The unsorted replacement first sees revision 4. It must retain the
    // revision-5 floor from the failed depth rebuild and retry instead of adopting it.
    expect(plainLoads).toBe(2);
    expect(screen.queryByDisplayValue("Stale unsorted")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(50));

    expect(screen.getByText("Add a property to start this table.")).toBeInTheDocument();
    expect(sortedLoads).toBe(2);
    expect(plainLoads).toBe(3);
    expect(screen.queryByText("The sort column does not belong to this table.")).not.toBeInTheDocument();
  });

  it("keeps invalid-sort recovery in the background while a replica remains stale", async () => {
    vi.useFakeTimers();
    const current = tableWithValue("Current", 5);
    const stale = tableWithValue("Stale", 4);
    const fresh = tableWithValue("Fresh", 6);
    let plainLoads = 0;
    let sortedLoads = 0;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("sort=status")) {
        sortedLoads += 1;
        return Promise.reject(
          new ApiClientError(422, "invalid_table_sort", "The sort column does not belong to this table."),
        );
      }
      plainLoads += 1;
      if (plainLoads === 1) return Promise.resolve({ table: current });
      return Promise.resolve({ table: plainLoads <= 4 ? stale : fresh });
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await drainStaleRetries();

    expect(sortedLoads).toBe(1);
    expect(plainLoads).toBe(4);
    expect(screen.getByDisplayValue("Current")).toBeInTheDocument();
    expect(screen.queryByText("The table kept returning an older revision.")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(screen.getByDisplayValue("Fresh")).toBeInTheDocument();
    expect(plainLoads).toBe(5);
    expect(screen.queryByDisplayValue("Stale")).not.toBeInTheDocument();
  });

  it("does not duplicate an exhausted background revision recovery", async () => {
    vi.useFakeTimers();
    const current = tableWithValue("Current", 5);
    const stale = tableWithValue("Stale", 4);
    const fresh = tableWithValue("Fresh", 6);
    let plainLoads = 0;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("sort=status")) {
        return Promise.reject(
          new ApiClientError(422, "invalid_table_sort", "The sort column does not belong to this table."),
        );
      }
      plainLoads += 1;
      if (plainLoads === 1) return Promise.resolve({ table: current });
      return Promise.resolve({ table: plainLoads <= 5 ? stale : fresh });
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await drainStaleRetries();
    expect(plainLoads).toBe(4);

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    // Delayed polling probes once, rather than repeating the foreground
    // three-attempt stale-revision sequence.
    expect(plainLoads).toBe(5);
    expect(screen.getByDisplayValue("Current")).toBeInTheDocument();
    expect(screen.queryByText("The table kept returning an older revision.")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(plainLoads).toBe(5);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByDisplayValue("Fresh")).toBeInTheDocument();
    expect(plainLoads).toBe(6);
  });

  it("does not overlap repeated load-more requests", async () => {
    const first: TableData = {
      ...table,
      rows: [{ id: "row-1", position: 0, cells: { status: "One" } }],
      hasMore: true,
      nextCursor: { position: 0, rowId: "row-1" },
      rowCount: 2,
    };
    const second = deferred<{ table: TableData }>();
    vi.mocked(api)
      .mockResolvedValueOnce({ table: first })
      .mockImplementationOnce(() => second.promise);
    renderViewer();

    const loadMore = await screen.findByRole("button", { name: "Load more rows" });
    fireEvent.click(loadMore);
    fireEvent.click(loadMore);

    expect(loadMore).toBeDisabled();
    expect(api).toHaveBeenCalledTimes(2);
    await act(async () =>
      second.resolve({
        table: {
          ...table,
          rows: [{ id: "row-2", position: 1, cells: { status: "Two" } }],
          rowCount: 2,
        },
      }),
    );
    expect(await screen.findByDisplayValue("Two")).toBeInTheDocument();
  });

  it("keeps load more clickable during a background refresh and discards the stale refresh", async () => {
    vi.useFakeTimers();
    const first: TableData = {
      ...table,
      rows: [{ id: "row-1", position: 0, cells: { status: "One" } }],
      hasMore: true,
      nextCursor: { position: 0, rowId: "row-1" },
      rowCount: 2,
    };
    const refresh = deferred<{ table: TableData }>();
    vi.mocked(api)
      .mockResolvedValueOnce({ table: first })
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValueOnce({
        table: {
          ...table,
          rows: [{ id: "row-2", position: 1, cells: { status: "Two" } }],
          hasMore: false,
          nextCursor: null,
          rowCount: 2,
        },
      });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));
    const loadMore = screen.getByRole("button", { name: "Load more rows" });
    expect(loadMore).toBeEnabled();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(api).toHaveBeenCalledTimes(2);

    // The background poll neither disables the button nor swallows the click.
    expect(loadMore).toBeEnabled();
    fireEvent.click(loadMore);
    expect(api).toHaveBeenCalledTimes(3);
    await act(async () => {});
    expect(screen.getByDisplayValue("Two")).toBeInTheDocument();

    // The poll's page-one response lands after the append and must be discarded, not
    // yank the view back to the first page.
    await act(async () => {
      refresh.resolve({ table: first });
      await refresh.promise;
    });
    expect(screen.getByDisplayValue("One")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Two")).toBeInTheDocument();
  });

  it("keeps a valid revision usable when an ordinary background refresh stays stale", async () => {
    vi.useFakeTimers();
    const current: TableData = {
      ...tableWithValue("Current", 5),
      hasMore: true,
      nextCursor: { position: 0, rowId: "row" },
      rowCount: 2,
    };
    const stale = { ...current, revision: 4 };
    vi.mocked(api).mockResolvedValueOnce({ table: current }).mockResolvedValue({ table: stale });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));
    const loadMore = screen.getByRole("button", { name: "Load more rows" });

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await drainStaleRetries();

    expect(api).toHaveBeenCalledTimes(4);
    expect(loadMore).toBeEnabled();
    expect(screen.getByDisplayValue("Current")).toBeInTheDocument();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();
    expect(screen.queryByText("The table kept returning an older revision.")).not.toBeInTheDocument();
  });

  it("does not erase a load failure when a later background refresh stays stale", async () => {
    vi.useFakeTimers();
    const current = tableWithValue("Current", 5);
    const staleSorted: TableData = { ...current, revision: 4, sort: "status" };
    let sortedLoads = 0;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("sort=status")) {
        sortedLoads += 1;
        if (sortedLoads === 1) return Promise.reject(new Error("Sorted table could not be loaded."));
        return Promise.resolve({ table: staleSorted });
      }
      return Promise.resolve({ table: current });
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText("Sorted table could not be loaded.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await drainStaleRetries();

    expect(sortedLoads).toBe(4);
    expect(screen.getByText("Sorted table could not be loaded.")).toBeInTheDocument();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();
  });

  it("appends a newer remote revision across an unsorted keyset boundary", async () => {
    const first: TableData = {
      ...table,
      revision: 1,
      rows: [{ id: "row-1", position: 0, cells: { status: "Old first page" } }],
      hasMore: true,
      nextCursor: { position: 0, rowId: "row-1" },
      rowCount: 2,
    };
    const newerPage: TableData = {
      ...table,
      revision: 2,
      rows: [{ id: "row-2", position: 1, cells: { status: "Newer second page" } }],
      rowCount: null,
    };
    vi.mocked(api).mockResolvedValueOnce({ table: first }).mockResolvedValueOnce({ table: newerPage });
    renderViewer();

    fireEvent.click(await screen.findByRole("button", { name: "Load more rows" }));

    expect(await screen.findByDisplayValue("Newer second page")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Old first page")).toBeInTheDocument();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("retries an unsorted append when its response predates the keyset snapshot", async () => {
    const first = pagedTable({
      revision: 2,
      rows: [{ id: "row-1", position: 0, cells: { status: "Current first page" } }],
    });
    const staleSecond: TableData = {
      ...table,
      revision: 1,
      rows: [{ id: "row-stale", position: 1, cells: { status: "Deleted stale row" } }],
      rowCount: null,
    };
    const refreshedSecond: TableData = {
      ...first,
      rows: [{ id: "row-2", position: 1, cells: { status: "Current second page" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: null,
    };
    vi.mocked(api)
      .mockRejectedValue(new Error("Unexpected API request in stale keyset retry test."))
      .mockResolvedValueOnce({ table: first })
      .mockResolvedValueOnce({ table: staleSecond })
      .mockResolvedValueOnce({ table: refreshedSecond });
    renderViewer();

    fireEvent.click(await screen.findByRole("button", { name: "Load more rows" }));

    expect(await screen.findByDisplayValue("Current second page")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Current first page")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Deleted stale row")).not.toBeInTheDocument();
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("rebuilds unsorted depth after stale keyset retries are exhausted", async () => {
    vi.useFakeTimers();
    const first: TableData = {
      ...table,
      revision: 2,
      rows: [{ id: "row-1", position: 0, cells: { status: "Current first page" } }],
      hasMore: true,
      nextCursor: { position: 0, rowId: "row-1" },
      rowCount: 2,
    };
    const staleSecond: TableData = {
      ...first,
      revision: 1,
      rows: [{ id: "row-stale", position: 1, cells: { status: "Deleted stale row" } }],
      rowCount: null,
    };
    const rebuiltSecond: TableData = {
      ...first,
      rows: [{ id: "row-2", position: 1, cells: { status: "Rebuilt second page" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: null,
    };
    let pageOneLoads = 0;
    let appendLoads = 0;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("count=true")) {
        pageOneLoads += 1;
        return Promise.resolve({ table: first });
      }
      appendLoads += 1;
      return Promise.resolve({ table: appendLoads <= 3 ? staleSecond : rebuiltSecond });
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await drainStaleRetries();

    expect(screen.getByDisplayValue("Current first page")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Rebuilt second page")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Deleted stale row")).not.toBeInTheDocument();
    expect(pageOneLoads).toBe(2);
    expect(appendLoads).toBe(4);
    expect(screen.queryByText("The table kept returning an older revision.")).not.toBeInTheDocument();
  });

  it("keeps the current unsorted revision and automatically clears delayed refresh at page one", async () => {
    vi.useFakeTimers();
    const first = pagedTable({
      revision: 2,
      rows: [{ id: "row-1", position: 0, cells: { status: "Current first page" } }],
    });
    const staleFirst = { ...first, revision: 1 };
    const staleSecond: TableData = {
      ...first,
      revision: 1,
      rows: [{ id: "row-stale", position: 1, cells: { status: "Deleted stale row" } }],
      rowCount: null,
    };
    const freshSecond: TableData = {
      ...first,
      rows: [{ id: "row-2", position: 1, cells: { status: "Current second page" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: null,
    };
    let pageOneLoads = 0;
    let appendLoads = 0;
    let replicaFresh = false;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("count=true")) {
        pageOneLoads += 1;
        return Promise.resolve({ table: pageOneLoads === 1 || replicaFresh ? first : staleFirst });
      }
      appendLoads += 1;
      return Promise.resolve({ table: replicaFresh ? freshSecond : staleSecond });
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    const loadMore = screen.getByRole("button", { name: "Load more rows" });
    fireEvent.click(loadMore);
    await drainStaleRetries();
    await drainStaleRetries();

    expect(pageOneLoads).toBe(4);
    expect(appendLoads).toBe(3);
    expect(loadMore).toBeEnabled();
    expect(screen.getByDisplayValue("Current first page")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Deleted stale row")).not.toBeInTheDocument();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();
    expect(screen.queryByText("The table kept returning an older revision.")).not.toBeInTheDocument();

    replicaFresh = true;
    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(pageOneLoads).toBe(5);
    expect(screen.getByDisplayValue("Current first page")).toBeInTheDocument();
    expect(
      screen.queryByText("Table refresh is delayed while waiting for the latest revision."),
    ).not.toBeInTheDocument();

    fireEvent.click(loadMore);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.getByDisplayValue("Current second page")).toBeInTheDocument();
  });

  it("automatically retries a delayed stale rebuild while an editor lease is active", async () => {
    vi.useFakeTimers();
    const first = pagedTable({
      revision: 2,
      rows: [{ id: "row-1", position: 0, cells: { status: "Current editor page" } }],
    });
    const staleFirst = { ...first, revision: 1 };
    const staleSecond: TableData = {
      ...first,
      revision: 1,
      rows: [{ id: "row-stale", position: 1, cells: { status: "Stale editor row" } }],
      rowCount: null,
    };
    const freshSecond: TableData = { ...staleSecond, revision: 2 };
    let pageOneLoads = 0;
    let replicaFresh = false;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (String(path).includes("count=true")) {
        pageOneLoads += 1;
        return Promise.resolve({ table: pageOneLoads <= 2 || replicaFresh ? first : staleFirst });
      }
      return Promise.resolve({ table: replicaFresh ? freshSecond : staleSecond });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await drainStaleRetries();
    await drainStaleRetries();

    expect(pageOneLoads).toBe(5);
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more rows" })).toBeEnabled();

    replicaFresh = true;
    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(pageOneLoads).toBe(6);
    expect(screen.getByDisplayValue("Current editor page")).toBeEnabled();
    expect(
      screen.queryByText("Table refresh is delayed while waiting for the latest revision."),
    ).not.toBeInTheDocument();
  });

  it("automatically rebuilds a delayed viewer at the already displayed depth", async () => {
    vi.useFakeTimers();
    const first = pagedTable({
      revision: 2,
      rows: [{ id: "row-1", position: 0, cells: { status: "Current first page" } }],
      rowCount: 3,
    });
    const second: TableData = {
      ...first,
      rows: [{ id: "row-2", position: 1, cells: { status: "Current second page" } }],
      nextCursor: { position: 1, rowId: "row-2" },
      rowCount: null,
    };
    const staleFirst = { ...first, revision: 1 };
    const staleThird: TableData = {
      ...first,
      revision: 1,
      rows: [{ id: "row-stale", position: 2, cells: { status: "Stale third page" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: null,
    };
    const freshThird: TableData = {
      ...staleThird,
      revision: 2,
      rows: [{ id: "row-3", position: 2, cells: { status: "Current third page" } }],
    };
    let pageOneLoads = 0;
    let secondPageLoads = 0;
    let thirdPageLoads = 0;
    let pageOneFresh = false;
    let depthFresh = false;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("count=true")) {
        pageOneLoads += 1;
        return Promise.resolve({ table: pageOneLoads === 1 || pageOneFresh ? first : staleFirst });
      }
      if (String(path).includes("afterId=row-1")) {
        secondPageLoads += 1;
        return Promise.resolve({ table: secondPageLoads === 1 || depthFresh ? second : { ...second, revision: 3 } });
      }
      thirdPageLoads += 1;
      return Promise.resolve({ table: depthFresh ? freshThird : staleThird });
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByDisplayValue("Current second page")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await drainStaleRetries();
    await drainStaleRetries();

    expect(pageOneLoads).toBe(4);
    expect(secondPageLoads).toBe(1);
    expect(thirdPageLoads).toBe(3);
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();

    pageOneFresh = true;
    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(pageOneLoads).toBe(5);
    expect(secondPageLoads).toBe(2);
    // Churn after the page-one probe must not let a background recovery adopt
    // page one and discard the depth already on screen.
    expect(screen.getByDisplayValue("Current first page")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Current second page")).toBeInTheDocument();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();

    depthFresh = true;
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(pageOneLoads).toBe(6);
    expect(secondPageLoads).toBe(3);
    expect(screen.getByDisplayValue("Current third page")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Stale third page")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Table refresh is delayed while waiting for the latest revision."),
    ).not.toBeInTheDocument();
  });

  it("keeps delayed depth recovery armed across a transient poll failure", async () => {
    vi.useFakeTimers();
    const first = pagedTable({
      revision: 2,
      rows: [{ id: "row-1", position: 0, cells: { status: "Current first" } }],
    });
    const staleFirst = { ...first, revision: 1 };
    const staleSecond: TableData = {
      ...first,
      revision: 1,
      rows: [{ id: "row-stale", position: 1, cells: { status: "Stale second" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: null,
    };
    const freshSecond: TableData = {
      ...staleSecond,
      revision: 2,
      rows: [{ id: "row-2", position: 1, cells: { status: "Current second" } }],
    };
    let pageOneLoads = 0;
    let appendLoads = 0;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("count=true")) {
        pageOneLoads += 1;
        if (pageOneLoads === 1 || pageOneLoads >= 6) return Promise.resolve({ table: first });
        if (pageOneLoads === 5) return Promise.reject(new Error("Replica temporarily unavailable."));
        return Promise.resolve({ table: staleFirst });
      }
      appendLoads += 1;
      return Promise.resolve({ table: appendLoads <= 3 ? staleSecond : freshSecond });
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await drainStaleRetries();
    await drainStaleRetries();
    expect(pageOneLoads).toBe(4);
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(pageOneLoads).toBe(5);
    expect(screen.getByDisplayValue("Current first")).toBeInTheDocument();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();
    expect(screen.queryByText("Replica temporarily unavailable.")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(pageOneLoads).toBe(6);
    expect(screen.getByDisplayValue("Current second")).toBeInTheDocument();
    expect(
      screen.queryByText("Table refresh is delayed while waiting for the latest revision."),
    ).not.toBeInTheDocument();
  });

  it("keeps background depth recovery armed across persistent incomplete pagination", async () => {
    vi.useFakeTimers();
    const first = pagedTable({
      revision: 2,
      rows: [{ id: "row-1", position: 0, cells: { status: "Current first" } }],
    });
    const staleFirst = { ...first, revision: 1 };
    const malformedFirst = { ...first, nextCursor: null };
    const staleSecond: TableData = {
      ...first,
      revision: 1,
      rows: [{ id: "row-stale", position: 1, cells: { status: "Stale second" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: null,
    };
    const freshSecond: TableData = {
      ...staleSecond,
      revision: 2,
      rows: [{ id: "row-2", position: 1, cells: { status: "Current second" } }],
    };
    let pageOneLoads = 0;
    let appendLoads = 0;
    let paginationFixed = false;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("count=true")) {
        pageOneLoads += 1;
        if (pageOneLoads === 1 || paginationFixed) return Promise.resolve({ table: first });
        if (pageOneLoads >= 5) return Promise.resolve({ table: malformedFirst });
        return Promise.resolve({ table: staleFirst });
      }
      appendLoads += 1;
      return Promise.resolve({ table: appendLoads <= 3 ? staleSecond : freshSecond });
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await drainStaleRetries();
    await drainStaleRetries();
    expect(pageOneLoads).toBe(4);

    await act(() => vi.advanceTimersByTimeAsync(5_000));

    expect(pageOneLoads).toBe(5);
    expect(screen.getByDisplayValue("Current first")).toBeInTheDocument();
    expect(screen.queryByText("The table returned incomplete pagination information.")).not.toBeInTheDocument();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(pageOneLoads).toBe(6);
    expect(screen.queryByText("The table returned incomplete pagination information.")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(20_000));

    expect(pageOneLoads).toBe(7);
    expect(screen.getByDisplayValue("Current first")).toBeInTheDocument();
    expect(screen.getByText("The table returned incomplete pagination information.")).toBeInTheDocument();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();

    paginationFixed = true;
    await act(() => vi.advanceTimersByTimeAsync(40_000));

    expect(pageOneLoads).toBe(8);
    expect(screen.getByDisplayValue("Current second")).toBeInTheDocument();
    expect(screen.queryByText("The table returned incomplete pagination information.")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Table refresh is delayed while waiting for the latest revision."),
    ).not.toBeInTheDocument();
  });

  it("reports persistent delayed-recovery failures without abandoning recovery", async () => {
    vi.useFakeTimers();
    const current: TableData = {
      ...tableWithValue("Current", 2),
      hasMore: true,
      nextCursor: { position: 0, rowId: "row" },
      rowCount: 2,
    };
    const stale = { ...current, revision: 1 };
    let loads = 0;
    let replicaRecovered = false;
    vi.mocked(api).mockImplementation(() => {
      loads += 1;
      if (loads === 1 || replicaRecovered) return Promise.resolve({ table: current });
      if (loads <= 4) return Promise.resolve({ table: stale });
      return Promise.reject(new Error("Replica persistently unavailable."));
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await drainStaleRetries();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.queryByText("Replica persistently unavailable.")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(20_000));

    expect(screen.getByText("Replica persistently unavailable.")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Current")).toBeInTheDocument();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();

    replicaRecovered = true;
    await act(() => vi.advanceTimersByTimeAsync(40_000));

    expect(screen.queryByText("Replica persistently unavailable.")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Table refresh is delayed while waiting for the latest revision."),
    ).not.toBeInTheDocument();
  });

  it("rearms the ordinary refresh interval after recovery backoff", async () => {
    vi.useFakeTimers();
    const current = tableWithValue("Current", 2);
    const stale = tableWithValue("Stale", 1);
    const sorted = { ...current, sort: "status" };
    let plainLoads = 0;
    let sortedLoads = 0;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("sort=status")) {
        sortedLoads += 1;
        return Promise.resolve({ table: sorted });
      }
      plainLoads += 1;
      return Promise.resolve({ table: plainLoads === 1 ? current : stale });
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await drainStaleRetries();
    expect(plainLoads).toBe(4);
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(plainLoads).toBe(5);

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(sortedLoads).toBe(1);
    expect(
      screen.queryByText("Table refresh is delayed while waiting for the latest revision."),
    ).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(sortedLoads).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(sortedLoads).toBe(2);
  });

  it("does not dismiss delayed recovery when only an appended page reaches its floor", async () => {
    vi.useFakeTimers();
    const first: TableData = {
      ...table,
      rows: [{ id: "row-1", position: 0, cells: { status: "Older first page" } }],
      hasMore: true,
      nextCursor: { position: 0, rowId: "row-1" },
      rowCount: 3,
    };
    const second: TableData = {
      ...first,
      revision: 2,
      rows: [{ id: "row-2", position: 1, cells: { status: "Second page" } }],
      nextCursor: { position: 1, rowId: "row-2" },
      rowCount: null,
    };
    const staleThird: TableData = {
      ...first,
      rows: [{ id: "row-stale", position: 2, cells: { status: "Stale third" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: null,
    };
    const freshThird: TableData = {
      ...staleThird,
      revision: 2,
      rows: [{ id: "row-3", position: 2, cells: { status: "Fresh third" } }],
    };
    let thirdLoads = 0;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("count=true")) return Promise.resolve({ table: first });
      if (String(path).includes("afterId=row-1")) return Promise.resolve({ table: second });
      thirdLoads += 1;
      return Promise.resolve({ table: thirdLoads <= 3 ? staleThird : freshThird });
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await drainStaleRetries();
    await drainStaleRetries();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.getByDisplayValue("Fresh third")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Older first page")).toBeInTheDocument();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();
  });

  it("lets an edit supersede an in-flight background depth recovery", async () => {
    vi.useFakeTimers();
    const first = pagedTable({
      revision: 2,
      rows: [{ id: "row", position: 0, cells: { status: "Current" } }],
    });
    const staleFirst = { ...first, revision: 1 };
    const staleSecond: TableData = {
      ...first,
      revision: 1,
      rows: [{ id: "row-2", position: 1, cells: { status: "Stale" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: null,
    };
    const background = deferred<{ table: TableData }>();
    let pageOneLoads = 0;
    let saves = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") {
        saves += 1;
        return Promise.resolve({ revision: 3 });
      }
      if (String(path).includes("count=true")) {
        pageOneLoads += 1;
        if (pageOneLoads <= 2) return Promise.resolve({ table: first });
        if (pageOneLoads <= 5) return Promise.resolve({ table: staleFirst });
        return background.promise;
      }
      return Promise.resolve({ table: staleSecond });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await drainStaleRetries();
    await drainStaleRetries();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(pageOneLoads).toBe(6);

    const input = screen.getByDisplayValue("Current");
    fireEvent.change(input, { target: { value: "Saved while polling" } });
    fireEvent.blur(input);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(saves).toBe(1);

    await act(async () => {
      background.resolve({ table: first });
      await background.promise;
    });
    expect(screen.getByDisplayValue("Saved while polling")).toBeEnabled();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(pageOneLoads).toBe(7);
  });

  it("backs off and reports background rejections superseded by newly queued edits", async () => {
    vi.useFakeTimers();
    const first = pagedTable({
      revision: 2,
      rows: [{ id: "row", position: 0, cells: { status: "Current" } }],
    });
    const staleFirst = { ...first, revision: 1 };
    const staleSecond: TableData = {
      ...first,
      revision: 1,
      rows: [{ id: "row-2", position: 1, cells: { status: "Stale" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: null,
    };
    const backgrounds = [
      deferred<{ table: TableData }>(),
      deferred<{ table: TableData }>(),
      deferred<{ table: TableData }>(),
      deferred<{ table: TableData }>(),
    ];
    let pageOneLoads = 0;
    let backgroundLoads = 0;
    let mutationRevision = 2;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.endsWith("/lease") && init?.method === "PATCH") {
        return Promise.resolve({ leaseDurationMs: LEASE_DURATION_MS });
      }
      if (init?.method === "PUT") return Promise.resolve({ revision: ++mutationRevision });
      if (String(path).includes("count=true")) {
        pageOneLoads += 1;
        if (pageOneLoads <= 2) return Promise.resolve({ table: first });
        if (pageOneLoads <= 5) return Promise.resolve({ table: staleFirst });
        const background = backgrounds[backgroundLoads++];
        if (!background) throw new Error("Unexpected extra background page-one load.");
        return background.promise;
      }
      return Promise.resolve({ table: staleSecond });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await drainStaleRetries();
    await drainStaleRetries();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();

    for (const [index, background] of backgrounds.slice(0, 3).entries()) {
      const retryDelay = 5_000 * 2 ** index;
      await act(() => vi.advanceTimersByTimeAsync(retryDelay - 1));
      expect(backgroundLoads).toBe(index);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(backgroundLoads).toBe(index + 1);
      const value = `Saved while polling ${index + 1}`;
      const input = screen.getByDisplayValue(index === 0 ? "Current" : `Saved while polling ${index}`);
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
      await act(() => vi.advanceTimersByTimeAsync(0));

      await act(async () => {
        background.reject(new Error("Obsolete background failure."));
        await background.promise.catch(() => undefined);
      });

      expect(screen.getByDisplayValue(value)).toBeEnabled();
      expect(screen.queryByText("Obsolete background failure.") !== null).toBe(index === 2);
    }

    await act(() => vi.advanceTimersByTimeAsync(39_999));
    expect(backgroundLoads).toBe(3);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(backgroundLoads).toBe(4);
    const input = screen.getByDisplayValue("Saved while polling 3");
    fireEvent.change(input, { target: { value: "Saved while final poll" } });
    fireEvent.blur(input);
    await act(() => vi.advanceTimersByTimeAsync(0));

    await act(async () => {
      backgrounds[3]!.resolve({ table: first });
      await backgrounds[3]!.promise;
    });

    expect(pageOneLoads).toBe(9);
    expect(screen.getByDisplayValue("Saved while final poll")).toBeEnabled();
    expect(screen.getByText("Obsolete background failure.")).toBeInTheDocument();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();
  });

  it("wakes unknown-revision recovery after a mutation clears the last depth target", async () => {
    vi.useFakeTimers();
    const first = pagedTable({
      revision: 2,
      rows: [{ id: "row", position: 0, cells: { status: "Current" } }],
    });
    const staleFirst = { ...first, revision: 1 };
    const staleSecond: TableData = {
      ...first,
      revision: 1,
      rows: [{ id: "row-2", position: 1, cells: { status: "Stale" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: null,
    };
    const sorted: TableData = {
      ...first,
      sort: "status",
      hasMore: false,
      nextCursor: null,
      nextOffset: null,
      rowCount: 1,
    };
    const backgroundPoll = deferred<{ table: TableData }>();
    const save = deferred<{ revision: number }>();
    const failedSaveReload = deferred<{ table: TableData }>();
    let pageOneLoads = 0;
    let sortedLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") return save.promise;
      if (String(path).includes("count=true") && String(path).includes("sort=status")) {
        sortedLoads += 1;
        if (sortedLoads === 1) return Promise.resolve({ table: sorted });
        if (sortedLoads === 2) return failedSaveReload.promise;
        return Promise.resolve({
          table: {
            ...sorted,
            revision: 3,
            rows: [{ id: "row", position: 0, cells: { status: "Recovered" } }],
          },
        });
      }
      if (String(path).includes("count=true")) {
        pageOneLoads += 1;
        if (pageOneLoads <= 2) return Promise.resolve({ table: first });
        if (pageOneLoads <= 5) return Promise.resolve({ table: staleFirst });
        return backgroundPoll.promise;
      }
      return Promise.resolve({ table: staleSecond });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await drainStaleRetries();
    await drainStaleRetries();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(pageOneLoads).toBe(6);

    const input = screen.getByDisplayValue("Current");
    fireEvent.change(input, { target: { value: "Uncertain" } });
    fireEvent.blur(input);
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(sortedLoads).toBe(1);

    await act(async () => {
      save.reject(new DOMException("The operation timed out.", "TimeoutError"));
      await save.promise.catch(() => undefined);
    });
    expect(sortedLoads).toBe(2);

    await act(async () => {
      backgroundPoll.resolve({ table: first });
      await backgroundPoll.promise;
    });
    await act(async () => {
      failedSaveReload.reject(new ApiClientError(503, "table_unavailable", "Table temporarily unavailable."));
      await failedSaveReload.promise.catch(() => undefined);
    });
    expect(screen.getByText("Editing paused while table reloads")).toBeInTheDocument();
    expect(sortedLoads).toBe(2);

    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(sortedLoads).toBe(3);
    expect(screen.getByDisplayValue("Recovered")).toBeEnabled();
  });

  it("lets a foreground page-one reload retire a deeper recovery target", async () => {
    vi.useFakeTimers();
    const first = pagedTable({
      revision: 2,
      rows: [{ id: "row", position: 0, cells: { status: "Current" } }],
    });
    const staleFirst = { ...first, revision: 1 };
    const staleSecond: TableData = {
      ...first,
      revision: 1,
      rows: [{ id: "row-stale", position: 1, cells: { status: "Stale" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: null,
    };
    const freshSecond: TableData = {
      ...staleSecond,
      revision: 2,
      rows: [{ id: "row-2", position: 1, cells: { status: "Fresh second" } }],
    };
    let pageOneLoads = 0;
    let appendLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.endsWith("/lease") && init?.method === "DELETE") return Promise.resolve({ ok: true });
      if (init?.method === "PUT") {
        return Promise.reject(new ApiClientError(409, "lease_conflict", "The editing lease was lost."));
      }
      if (String(path).includes("count=true")) {
        pageOneLoads += 1;
        return Promise.resolve({ table: pageOneLoads <= 2 || pageOneLoads >= 6 ? first : staleFirst });
      }
      appendLoads += 1;
      return Promise.resolve({ table: appendLoads <= 3 ? staleSecond : freshSecond });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await drainStaleRetries();
    await drainStaleRetries();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();
    expect(appendLoads).toBe(3);

    const input = screen.getByDisplayValue("Current");
    fireEvent.change(input, { target: { value: "Rejected edit" } });
    fireEvent.blur(input);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(
      screen.queryByText("Table refresh is delayed while waiting for the latest revision."),
    ).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Fresh second")).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(appendLoads).toBe(3);
    expect(screen.queryByDisplayValue("Fresh second")).not.toBeInTheDocument();
  });

  it("keeps a newer unsorted boundary as the floor for the following append", async () => {
    const first: TableData = {
      ...table,
      rows: [{ id: "row-1", position: 0, cells: { status: "First" } }],
      hasMore: true,
      nextCursor: { position: 0, rowId: "row-1" },
      rowCount: 3,
    };
    const newerSecond: TableData = {
      ...first,
      revision: 2,
      rows: [{ id: "row-2", position: 1, cells: { status: "Second" } }],
      nextCursor: { position: 1, rowId: "row-2" },
      rowCount: null,
    };
    const staleThird: TableData = {
      ...first,
      rows: [{ id: "row-stale", position: 2, cells: { status: "Stale third" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: null,
    };
    const freshThird: TableData = {
      ...staleThird,
      revision: 2,
      rows: [{ id: "row-3", position: 2, cells: { status: "Third" } }],
    };
    vi.mocked(api)
      .mockRejectedValue(new Error("Unexpected API request after newer keyset boundary."))
      .mockResolvedValueOnce({ table: first })
      .mockResolvedValueOnce({ table: newerSecond })
      .mockResolvedValueOnce({ table: staleThird })
      .mockResolvedValueOnce({ table: freshThird });
    renderViewer();

    fireEvent.click(await screen.findByRole("button", { name: "Load more rows" }));
    expect(await screen.findByDisplayValue("Second")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));

    expect(await screen.findByDisplayValue("Third")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Stale third")).not.toBeInTheDocument();
    const pageOneLoads = vi.mocked(api).mock.calls.filter(([path]) => String(path).includes("count=true"));
    expect(pageOneLoads).toHaveLength(1);
    expect(api).toHaveBeenCalledTimes(4);
  });

  it("appends the next page when the user's own save commits while it loads", async () => {
    const first = pagedTable({
      rows: [{ id: "row-1", position: 0, cells: { status: "One" } }],
    });
    const append = deferred<{ table: TableData }>();
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.includes("afterPosition")) return append.promise;
      if (init?.method === "PUT") return Promise.resolve({ revision: 2 });
      return Promise.resolve({ table: first });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    const cell = screen.getByDisplayValue("One");
    fireEvent.change(cell, { target: { value: "One edited" } });
    fireEvent.blur(cell);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.stringContaining("/cells/row-1/status"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );

    // The save moved the table to revision 2 after the keyset page was read at
    // revision 1. Cell edits cannot move an unsorted boundary, so the older response
    // must still extend the locally edited view rather than reset it to page one.
    await act(async () => {
      append.resolve({
        table: {
          ...first,
          rows: [{ id: "row-2", position: 1, cells: { status: "Two" } }],
          hasMore: false,
          nextCursor: null,
          rowCount: null,
        },
      });
      await append.promise;
    });

    expect(screen.getByDisplayValue("One edited")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Two")).toBeInTheDocument();
    const fullLoads = vi.mocked(api).mock.calls.filter(([path]) => String(path).includes("count=true"));
    expect(fullLoads).toHaveLength(2);
  });

  it("rebuilds unsorted rows when an insertion commits during a keyset request", async () => {
    const first = pagedTable({
      rows: [{ id: "row-1", position: 0, cells: { status: "One" } }],
    });
    const staleSecond: TableData = {
      ...first,
      rows: [{ id: "row-2", position: 1, cells: { status: "Two" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: null,
    };
    const restored: TableData = {
      ...first,
      revision: 2,
      rows: [first.rows[0]!, staleSecond.rows[0]!, { id: "row-3", position: 2, cells: {} }],
      hasMore: false,
      nextCursor: null,
      rowCount: 3,
    };
    const append = deferred<{ table: TableData }>();
    let pageOneLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.endsWith("/rows") && init?.method === "POST") {
        return Promise.resolve({ revision: 2, row: restored.rows[2] });
      }
      if (path.includes("afterPosition")) return append.promise;
      pageOneLoads += 1;
      return Promise.resolve({ table: pageOneLoads <= 2 ? first : restored });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    fireEvent.click(screen.getByRole("button", { name: "+ New row" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/api/tables/table-page/rows", expect.objectContaining({ method: "POST" })),
    );
    await act(async () => {
      append.resolve({ table: staleSecond });
      await append.promise;
    });

    await waitFor(() => expect(screen.getAllByLabelText("Status")).toHaveLength(3));
    expect(screen.getAllByLabelText("Status").map((input) => (input as HTMLInputElement).value)).toEqual([
      "One",
      "Two",
      "",
    ]);
    expect(pageOneLoads).toBe(3);
  });

  it("reloads sorted page one when the user's own save crosses an offset snapshot", async () => {
    const sortedFirst: TableData = {
      ...table,
      sort: "status",
      rows: [{ id: "row-1", position: 0, cells: { status: "Alpha" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 501,
    };
    const append = deferred<{ table: TableData }>();
    const refreshed: TableData = {
      ...table,
      revision: 2,
      sort: "status",
      rows: [{ id: "row-displaced", position: 500, cells: { status: "Middle" } }],
      hasMore: false,
      nextCursor: null,
      nextOffset: null,
      rowCount: 501,
    };
    let sortedPageLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") return Promise.resolve({ revision: 2 });
      if (String(path).includes("offset=500")) return append.promise;
      if (String(path).includes("sort=status")) {
        sortedPageLoads += 1;
        return Promise.resolve({ table: sortedPageLoads === 1 ? sortedFirst : refreshed });
      }
      return Promise.resolve({ table });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    expect(await screen.findByDisplayValue("Alpha")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    const cell = screen.getByDisplayValue("Alpha");
    fireEvent.change(cell, { target: { value: "Zulu" } });
    fireEvent.blur(cell);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.stringContaining("/cells/row-1/status"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );

    await act(async () => {
      append.resolve({
        table: {
          ...sortedFirst,
          revision: 2,
          rows: [{ id: "row-1", position: 0, cells: { status: "Zulu" } }],
          hasMore: false,
          nextOffset: null,
          rowCount: null,
        },
      });
      await append.promise;
    });

    expect(await screen.findByDisplayValue("Middle")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Zulu")).not.toBeInTheDocument();
    expect(sortedPageLoads).toBe(2);
  });

  it("reloads sorted page one when an old append resolves before a concurrent save", async () => {
    const sortedFirst: TableData = {
      ...table,
      sort: "status",
      rows: [{ id: "row-1", position: 0, cells: { status: "Alpha" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 501,
    };
    const append = deferred<{ table: TableData }>();
    const save = deferred<{ revision: number }>();
    const refreshed: TableData = {
      ...table,
      revision: 2,
      sort: "status",
      rows: [{ id: "row-displaced", position: 500, cells: { status: "Middle" } }],
      hasMore: false,
      nextCursor: null,
      nextOffset: null,
      rowCount: 501,
    };
    let sortedPageLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") return save.promise;
      if (String(path).includes("offset=500")) return append.promise;
      if (String(path).includes("sort=status")) {
        sortedPageLoads += 1;
        return Promise.resolve({ table: sortedPageLoads === 1 ? sortedFirst : refreshed });
      }
      return Promise.resolve({ table });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const cell = await screen.findByDisplayValue("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    fireEvent.change(cell, { target: { value: "Zulu" } });
    fireEvent.blur(cell);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.stringContaining("/cells/row-1/status"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );

    await act(async () => {
      append.resolve({
        table: {
          ...sortedFirst,
          rows: [{ id: "row-stale", position: 500, cells: { status: "Stale append" } }],
          hasMore: false,
          nextOffset: null,
          rowCount: null,
        },
      });
      await append.promise;
    });
    expect(sortedPageLoads).toBe(1);
    expect(screen.queryByDisplayValue("Stale append")).not.toBeInTheDocument();

    await act(async () => {
      save.resolve({ revision: 2 });
      await save.promise;
    });

    expect(await screen.findByDisplayValue("Middle")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Stale append")).not.toBeInTheDocument();
    expect(sortedPageLoads).toBe(2);
  });

  it("reloads sorted page one when a save landed before the load-more click", async () => {
    // The in-flight ordering is covered above. Here the save commits first, so the
    // table's revision has already moved to 2 while `nextOffset` still describes the
    // revision 1 ordering: comparing the response against the table's own revision
    // would accept the stale offset and lose the row displaced across the boundary.
    const sortedFirst: TableData = {
      ...table,
      sort: "status",
      rows: [{ id: "row-1", position: 0, cells: { status: "Alpha" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 501,
    };
    const refreshed: TableData = {
      ...table,
      revision: 2,
      sort: "status",
      rows: [{ id: "row-displaced", position: 500, cells: { status: "Middle" } }],
      hasMore: false,
      nextCursor: null,
      nextOffset: null,
      rowCount: 501,
    };
    let sortedPageLoads = 0;
    let appendRequests = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") return Promise.resolve({ revision: 2 });
      if (String(path).includes("offset=500")) {
        appendRequests += 1;
        // Served at revision 2, where row-1 has sorted to the end of the table.
        return Promise.resolve({
          table: {
            ...sortedFirst,
            revision: 2,
            rows: [{ id: "row-1", position: 500, cells: { status: "Zulu" } }],
            hasMore: false,
            nextOffset: null,
          },
        });
      }
      if (String(path).includes("sort=status")) {
        sortedPageLoads += 1;
        return Promise.resolve({ table: sortedPageLoads === 1 ? sortedFirst : refreshed });
      }
      return Promise.resolve({ table });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const cell = await screen.findByDisplayValue("Alpha");
    fireEvent.change(cell, { target: { value: "Zulu" } });
    fireEvent.blur(cell);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.stringContaining("/cells/row-1/status"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    // The PUT being issued does not prove its continuation updated the mutation
    // revision. A committed cell update replaces this keyed uncontrolled input.
    await waitFor(() => expect(cell).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));

    expect(await screen.findByDisplayValue("Middle")).toBeInTheDocument();
    // The stale boundary is known before a request is sent, so recovery starts from
    // page one without spending a request on revision 1's offset.
    expect(appendRequests).toBe(0);
    expect(sortedPageLoads).toBe(2);
  });

  it("does not re-arm a queued restore after a newer same-sort load is adopted", async () => {
    const unsorted = tableWithTwoTextCells(2);
    const ascending: TableData = {
      ...unsorted,
      sort: "status",
      rows: [{ id: "row", position: 0, cells: { status: "Alpha", notes: "Stable" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 501,
    };
    const descending: TableData = {
      ...ascending,
      dir: "desc",
      rows: [{ id: "row", position: 0, cells: { status: "Zulu", notes: "Stable" } }],
    };
    const pendingSave = deferred<{ revision: number }>();
    let saves = 0;
    let ascendingLoads = 0;
    let offsetLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") {
        saves += 1;
        return saves === 1 ? Promise.resolve({ revision: 2 }) : pendingSave.promise;
      }
      if (String(path).includes("offset=500")) {
        offsetLoads += 1;
        return Promise.resolve({ table: { ...ascending, hasMore: false, nextOffset: null } });
      }
      if (String(path).includes("sort=status") && String(path).includes("dir=desc")) {
        return Promise.resolve({ table: descending });
      }
      if (String(path).includes("sort=status")) {
        ascendingLoads += 1;
        return Promise.resolve({ table: ascending });
      }
      return Promise.resolve({ table: unsorted });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    expect(await screen.findByDisplayValue("Alpha")).toBeInTheDocument();
    const status = screen.getByDisplayValue("Alpha");
    fireEvent.change(status, { target: { value: "Alpha edited" } });
    fireEvent.blur(status);
    await waitFor(() => expect(saves).toBe(1));

    const notes = screen.getByDisplayValue("Stable");
    fireEvent.change(notes, { target: { value: "Pending note" } });
    fireEvent.blur(notes);
    await waitFor(() => expect(saves).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await act(async () => {});
    expect(offsetLoads).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    expect(await screen.findByDisplayValue("Zulu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    expect(await screen.findByDisplayValue("Ready")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    expect(await screen.findByDisplayValue("Alpha")).toBeInTheDocument();
    expect(ascendingLoads).toBe(2);

    await act(async () => {
      pendingSave.resolve({ revision: 3 });
      await pendingSave.promise;
    });

    expect(
      screen.queryByText("Table refresh is delayed while waiting for the latest revision."),
    ).not.toBeInTheDocument();
    expect(offsetLoads).toBe(0);
  });

  it("reports an incomplete pagination boundary during depth restoration", async () => {
    const sortedFirst: TableData = {
      ...table,
      sort: "status",
      rows: [{ id: "row", position: 0, cells: { status: "Alpha" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 501,
    };
    const malformed = { ...sortedFirst, revision: 2, nextOffset: null };
    let sortedLoads = 0;
    let offsetLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") return Promise.resolve({ revision: 2 });
      if (String(path).includes("offset=500")) {
        offsetLoads += 1;
        return Promise.resolve({ table: sortedFirst });
      }
      if (String(path).includes("sort=status")) {
        sortedLoads += 1;
        return Promise.resolve({ table: sortedLoads === 1 ? sortedFirst : malformed });
      }
      return Promise.resolve({ table });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const input = await screen.findByDisplayValue("Alpha");
    fireEvent.change(input, { target: { value: "Zulu" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.stringContaining("/cells/row/status"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    await waitFor(() => expect(input).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));

    expect(await screen.findByText("The table returned incomplete pagination information.")).toBeInTheDocument();
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Alpha")).toBeEnabled();
    expect(
      screen.queryByText("Table refresh is delayed while waiting for the latest revision."),
    ).not.toBeInTheDocument();
    expect(offsetLoads).toBe(0);
  });

  it("rebuilds the viewed sorted depth after an edit before loading the next page", async () => {
    const sortedFirst: TableData = {
      ...table,
      sort: "status",
      rows: [{ id: "row-alpha", position: 0, cells: { status: "Alpha" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 1_500,
    };
    const oldSecond: TableData = {
      ...sortedFirst,
      rows: [{ id: "row-middle-old", position: 500, cells: { status: "Middle old" } }],
      nextOffset: 1_000,
      rowCount: null,
    };
    const refreshedFirst: TableData = {
      ...sortedFirst,
      revision: 2,
      rows: [{ id: "row-beta", position: 0, cells: { status: "Beta" } }],
    };
    const refreshedSecond: TableData = {
      ...oldSecond,
      revision: 2,
      rows: [{ id: "row-gamma", position: 500, cells: { status: "Gamma" } }],
    };
    const refreshedThird: TableData = {
      ...oldSecond,
      revision: 2,
      rows: [{ id: "row-omega", position: 1_000, cells: { status: "Omega" } }],
      hasMore: false,
      nextOffset: null,
    };
    let sortedFirstLoads = 0;
    let offset500Loads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") return Promise.resolve({ revision: 2 });
      if (String(path).includes("offset=1000")) return Promise.resolve({ table: refreshedThird });
      if (String(path).includes("offset=500")) {
        offset500Loads += 1;
        return Promise.resolve({ table: offset500Loads === 1 ? oldSecond : refreshedSecond });
      }
      if (String(path).includes("sort=status")) {
        sortedFirstLoads += 1;
        return Promise.resolve({ table: sortedFirstLoads === 1 ? sortedFirst : refreshedFirst });
      }
      return Promise.resolve({ table });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const alpha = await screen.findByDisplayValue("Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    expect(await screen.findByDisplayValue("Middle old")).toBeInTheDocument();

    fireEvent.change(alpha, { target: { value: "Zulu" } });
    fireEvent.blur(alpha);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.stringContaining("/cells/row-alpha/status"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));

    expect(await screen.findByDisplayValue("Beta")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Gamma")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Omega")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Middle old")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Zulu")).not.toBeInTheDocument();
    expect(sortedFirstLoads).toBe(2);
    expect(offset500Loads).toBe(2);
  });

  it("rejects a regressed first page while restoring sorted depth", async () => {
    const sortedFirst: TableData = {
      ...table,
      sort: "status",
      rows: [{ id: "row-alpha", position: 0, cells: { status: "Alpha" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 501,
    };
    const refreshedFirst: TableData = {
      ...sortedFirst,
      revision: 2,
      rows: [{ id: "row-beta", position: 0, cells: { status: "Beta" } }],
    };
    const refreshedSecond: TableData = {
      ...sortedFirst,
      revision: 2,
      rows: [{ id: "row-gamma", position: 500, cells: { status: "Gamma" } }],
      hasMore: false,
      nextOffset: null,
      rowCount: null,
    };
    let sortedFirstLoads = 0;
    let offsetLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") return Promise.resolve({ revision: 2 });
      if (String(path).includes("offset=500")) {
        offsetLoads += 1;
        return Promise.resolve({ table: refreshedSecond });
      }
      if (String(path).includes("sort=status")) {
        sortedFirstLoads += 1;
        return Promise.resolve({ table: sortedFirstLoads < 3 ? sortedFirst : refreshedFirst });
      }
      return Promise.resolve({ table });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const cell = await screen.findByDisplayValue("Alpha");
    fireEvent.change(cell, { target: { value: "Zulu" } });
    fireEvent.blur(cell);
    await waitFor(() => expect(cell).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));

    expect(await screen.findByDisplayValue("Beta")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Gamma")).toBeInTheDocument();
    expect(sortedFirstLoads).toBe(3);
    expect(offsetLoads).toBe(1);
  });

  it("keeps a sorted offset valid when an edit changes another column", async () => {
    const sortedFirst: TableData = {
      ...tableWithTwoTextCells(),
      sort: "status",
      rows: [{ id: "row-alpha", position: 0, cells: { status: "Alpha", notes: "Stable" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 501,
    };
    const second: TableData = {
      ...sortedFirst,
      rows: [{ id: "row-beta", position: 500, cells: { status: "Beta", notes: "Second" } }],
      hasMore: false,
      nextOffset: null,
      rowCount: null,
    };
    let sortedFirstLoads = 0;
    let offsetLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") return Promise.resolve({ revision: 2 });
      if (String(path).includes("offset=500")) {
        offsetLoads += 1;
        return Promise.resolve({ table: second });
      }
      if (String(path).includes("sort=status")) {
        sortedFirstLoads += 1;
        return Promise.resolve({ table: sortedFirst });
      }
      return Promise.resolve({ table: tableWithTwoTextCells() });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await screen.findByDisplayValue("Alpha");
    const notes = screen.getByDisplayValue("Stable");
    fireEvent.change(notes, { target: { value: "Updated" } });
    fireEvent.blur(notes);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.stringContaining("/cells/row-alpha/notes"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));

    expect(await screen.findByDisplayValue("Beta")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Updated")).toBeInTheDocument();
    expect(sortedFirstLoads).toBe(1);
    expect(offsetLoads).toBe(1);
  });

  it("reports a failed sorted-depth restore and keeps the revision invalidated", async () => {
    const sortedFirst: TableData = {
      ...table,
      sort: "status",
      rows: [{ id: "row-alpha", position: 0, cells: { status: "Alpha" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 501,
    };
    let sortedLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") return Promise.resolve({ revision: 2 });
      if (String(path).includes("sort=status")) {
        sortedLoads += 1;
        if (sortedLoads > 1) return Promise.reject(new Error("Sorted recovery unavailable."));
        return Promise.resolve({ table: sortedFirst });
      }
      return Promise.resolve({ table });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const cell = await screen.findByDisplayValue("Alpha");
    fireEvent.change(cell, { target: { value: "Zulu" } });
    fireEvent.blur(cell);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.stringContaining("/cells/row-alpha/status"),
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));

    expect(await screen.findByText("Sorted recovery unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more rows" })).toBeDisabled();
  });

  it("keeps exhausted sorted background recovery transparent", async () => {
    vi.useFakeTimers();
    const sortedFirst: TableData = {
      ...table,
      revision: 5,
      sort: "status",
      rows: [{ id: "row-alpha", position: 0, cells: { status: "Alpha" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 501,
    };
    const unusableOffset: TableData = {
      ...sortedFirst,
      revision: 6,
      rows: [{ id: "row-beta", position: 500, cells: { status: "Beta" } }],
      hasMore: false,
      nextOffset: null,
      rowCount: null,
    };
    const compatibleOffset = { ...unusableOffset, revision: 5 };
    const staleSorted = { ...sortedFirst, revision: 4 };
    let sortedLoads = 0;
    let replicaFresh = false;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("offset=500")) {
        return Promise.resolve({ table: replicaFresh ? compatibleOffset : unusableOffset });
      }
      if (String(path).includes("sort=status")) {
        sortedLoads += 1;
        return Promise.resolve({ table: sortedLoads === 1 || replicaFresh ? sortedFirst : staleSorted });
      }
      return Promise.resolve({ table });
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await drainStaleRetries();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();
    expect(screen.queryByText("The table kept returning an older revision.")).not.toBeInTheDocument();
    expect(sortedLoads).toBe(4);

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(sortedLoads).toBe(5);
    expect(screen.getByDisplayValue("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();
    expect(screen.queryByText("The table kept returning an older revision.")).not.toBeInTheDocument();

    replicaFresh = true;
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(sortedLoads).toBe(6);
    expect(
      screen.queryByText("Table refresh is delayed while waiting for the latest revision."),
    ).not.toBeInTheDocument();
  });

  it("keeps the displayed revision as the floor when recovery changes sort", async () => {
    vi.useFakeTimers();
    const sortedFirst: TableData = {
      ...table,
      revision: 5,
      sort: "status",
      rows: [{ id: "row-alpha", position: 0, cells: { status: "Alpha" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 501,
    };
    const newerOffset: TableData = {
      ...sortedFirst,
      revision: 6,
      rows: [{ id: "row-beta", position: 500, cells: { status: "Beta" } }],
      hasMore: false,
      nextOffset: null,
      rowCount: null,
    };
    const staleDescending: TableData = {
      ...tableWithValue("Stale descending", 4),
      sort: "status",
      dir: "desc",
    };
    const freshDescending: TableData = {
      ...tableWithValue("Fresh descending", 6),
      sort: "status",
      dir: "desc",
    };
    let ascendingLoads = 0;
    let descendingLoads = 0;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("offset=500")) return Promise.resolve({ table: newerOffset });
      if (String(path).includes("sort=status") && String(path).includes("dir=desc")) {
        descendingLoads += 1;
        if (descendingLoads === 1) {
          return Promise.reject(new ApiClientError(503, "table_unavailable", "Descending load unavailable."));
        }
        return Promise.resolve({ table: descendingLoads === 2 ? staleDescending : freshDescending });
      }
      if (String(path).includes("sort=status")) {
        ascendingLoads += 1;
        if (ascendingLoads > 1) return Promise.reject(new Error("Sorted recovery unavailable."));
        return Promise.resolve({ table: sortedFirst });
      }
      return Promise.resolve({ table: { ...table, revision: 5 } });
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Sorted recovery unavailable.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(descendingLoads).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(descendingLoads).toBe(2);
    // The stale recovery attempt survives the effect transition that marks
    // recovery pending, so its first backoff remains ten seconds.
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(descendingLoads).toBe(3);
    expect(screen.getByDisplayValue("Fresh descending")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Stale descending")).not.toBeInTheDocument();
  });

  it("keeps the revision floor during direct invalid-sort recovery", async () => {
    vi.useFakeTimers();
    const sorted: TableData = {
      ...tableWithValue("Sorted", 5),
      sort: "status",
    };
    const staleUnsorted = tableWithValue("Stale unsorted", 4);
    const freshUnsorted = tableWithValue("Fresh unsorted", 6);
    let plainLoads = 0;
    let sortedLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
      if (String(path).includes("sort=status")) {
        sortedLoads += 1;
        if (sortedLoads === 1) return Promise.resolve({ table: sorted });
        return Promise.reject(
          new ApiClientError(422, "invalid_table_sort", "The sort column does not belong to this table."),
        );
      }
      plainLoads += 1;
      if (plainLoads <= 2) return Promise.resolve({ table });
      return Promise.resolve({ table: plainLoads === 3 ? staleUnsorted : freshUnsorted });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    const input = screen.getByDisplayValue("Sorted");
    fireEvent.change(input, { target: { value: "Uncertain" } });
    fireEvent.blur(input);
    await act(() => vi.advanceTimersByTimeAsync(0));

    // Invalid-sort recovery owns the third plain load directly and carries its
    // revision-5 floor across the sort transition, rejecting revision 4.
    expect(sortedLoads).toBe(2);
    expect(plainLoads).toBe(3);
    expect(screen.queryByDisplayValue("Stale unsorted")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(screen.getByDisplayValue("Fresh unsorted")).toBeInTheDocument();
    expect(plainLoads).toBe(4);
  });

  it("clears an invalid background sort after a mutation supersedes its snapshot", async () => {
    vi.useFakeTimers();
    const sortedFirst: TableData = {
      ...tableWithTwoTextCells(5),
      sort: "status",
      rows: [{ id: "row", position: 0, cells: { status: "Alpha", notes: "Stable" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 501,
    };
    const sortedSecond: TableData = {
      ...sortedFirst,
      rows: [{ id: "row-beta", position: 500, cells: { status: "Beta", notes: "Second" } }],
      hasMore: false,
      nextOffset: null,
      rowCount: null,
    };
    const staleFirst = { ...sortedFirst, revision: 4 };
    const freshUnsorted = tableWithTwoTextCells(6);
    const background = deferred<{ table: TableData }>();
    const pendingSave = deferred<{ revision: number }>();
    let puts = 0;
    let plainLoads = 0;
    let sortedLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") {
        puts += 1;
        if (puts === 1) return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
        return puts === 2 ? pendingSave.promise : Promise.resolve({ revision: 8 });
      }
      if (String(path).includes("offset=500")) return Promise.resolve({ table: sortedSecond });
      if (String(path).includes("sort=status")) {
        sortedLoads += 1;
        if (sortedLoads <= 2) return Promise.resolve({ table: sortedFirst });
        if (sortedLoads === 3) return Promise.resolve({ table: staleFirst });
        return background.promise;
      }
      plainLoads += 1;
      return Promise.resolve({ table: plainLoads <= 2 ? tableWithTwoTextCells(5) : freshUnsorted });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await act(() => vi.advanceTimersByTimeAsync(0));

    const status = screen.getByDisplayValue("Alpha");
    fireEvent.change(status, { target: { value: "Uncertain" } });
    fireEvent.blur(status);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(sortedLoads).toBe(3);
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(sortedLoads).toBe(4);
    const notes = screen.getByDisplayValue("Stable");
    fireEvent.change(notes, { target: { value: "Pending note" } });
    fireEvent.blur(notes);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(puts).toBe(2);

    await act(async () => {
      background.reject(
        new ApiClientError(422, "invalid_table_sort", "The sort column does not belong to this table."),
      );
      await background.promise.catch(() => undefined);
    });

    expect(plainLoads).toBe(3);
    expect(screen.getByRole("button", { name: /^Status/ })).not.toHaveTextContent("↑");
    expect(screen.getByRole("button", { name: /^Status/ })).not.toHaveTextContent("↓");
    expect(screen.queryByText("The sort column does not belong to this table.")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Table refresh is delayed while waiting for the latest revision."),
    ).not.toBeInTheDocument();

    await act(async () => {
      pendingSave.resolve({ revision: 7 });
      await pendingSave.promise;
    });

    expect(screen.getByDisplayValue("Pending note")).toBeEnabled();
    const refreshedStatus = screen.getByDisplayValue("Ready");
    fireEvent.change(refreshedStatus, { target: { value: "Saved after recovery" } });
    fireEvent.blur(refreshedStatus);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(puts).toBe(3);
    const lastSave = vi.mocked(api).mock.calls.findLast(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(lastSave?.[1]?.body))).toMatchObject({ expectedRevision: 7 });
  });

  it("keeps a stale deferred depth restore in background recovery", async () => {
    vi.useFakeTimers();
    const sortedFirst: TableData = {
      ...tableWithTwoTextCells(5),
      sort: "status",
      rows: [{ id: "row-alpha", position: 0, cells: { status: "Alpha", notes: "Stable" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 501,
    };
    const sortedSecond: TableData = {
      ...sortedFirst,
      rows: [{ id: "row-beta", position: 500, cells: { status: "Beta", notes: "Second" } }],
      hasMore: false,
      nextOffset: null,
      rowCount: null,
    };
    const staleFirst = { ...sortedFirst, revision: 4 };
    let sortedLoads = 0;
    let replicaFresh = false;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
      if (String(path).includes("offset=500")) return Promise.resolve({ table: sortedSecond });
      if (String(path).includes("sort=status")) {
        sortedLoads += 1;
        return Promise.resolve({ table: sortedLoads <= 2 || replicaFresh ? sortedFirst : staleFirst });
      }
      return Promise.resolve({ table: tableWithTwoTextCells(5) });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByDisplayValue("Beta")).toBeEnabled();

    const notes = screen.getByDisplayValue("Stable");
    fireEvent.change(notes, { target: { value: "Uncertain" } });
    fireEvent.blur(notes);
    await act(() => vi.advanceTimersByTimeAsync(0));
    // The deferred rebuild starts as soon as the mutation queue drains instead
    // of waiting for the next five-second polling interval.
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(sortedLoads).toBe(3);
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();
    expect(screen.queryByText("The table kept returning an older revision.")).not.toBeInTheDocument();
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();

    replicaFresh = true;
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(sortedLoads).toBe(4);
    expect(screen.getByDisplayValue("Beta")).toBeEnabled();
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    expect(
      screen.queryByText("Table refresh is delayed while waiting for the latest revision."),
    ).not.toBeInTheDocument();
  });

  it("applies a queued cell reset when sorted-depth recovery adopts the authoritative table", async () => {
    const sortedFirst: TableData = {
      ...table,
      sort: "status",
      rows: [{ id: "row-alpha", position: 0, cells: { status: "Alpha" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 501,
    };
    const refreshedFirst: TableData = { ...sortedFirst, revision: 2 };
    const refreshedSecond: TableData = {
      ...sortedFirst,
      revision: 2,
      rows: [{ id: "row-beta", position: 500, cells: { status: "Beta" } }],
      hasMore: false,
      nextOffset: null,
      rowCount: null,
    };
    let sortedLoads = 0;
    let offsetLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.endsWith("/lease") && init?.method === "DELETE") return Promise.resolve({ ok: true });
      if (init?.method === "PUT") {
        return Promise.reject(new ApiClientError(409, "lease_conflict", "The editing lease was lost."));
      }
      if (String(path).includes("offset=500")) {
        offsetLoads += 1;
        return Promise.resolve({ table: offsetLoads === 1 ? { ...refreshedSecond, revision: 2 } : refreshedSecond });
      }
      if (String(path).includes("sort=status")) {
        sortedLoads += 1;
        if (sortedLoads === 2) return Promise.reject(new Error("Initial recovery unavailable."));
        return Promise.resolve({ table: sortedLoads === 1 ? sortedFirst : refreshedFirst });
      }
      return Promise.resolve({ table });
    });
    await renderActiveEditor();

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    const cell = await screen.findByDisplayValue("Alpha");
    fireEvent.change(cell, { target: { value: "Draft" } });
    fireEvent.blur(cell);
    expect(
      await screen.findByText("The table update was not saved because editing access was lost."),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Draft")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));

    expect(await screen.findByDisplayValue("Beta")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Alpha")).toBeDisabled();
    expect(screen.queryByDisplayValue("Draft")).not.toBeInTheDocument();
    expect(offsetLoads).toBe(2);
  });

  it("refetches a load snapshot that is older than an already merged save", async () => {
    let sortLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") return Promise.resolve({ revision: 2 });
      if (String(path).includes("sort=")) {
        sortLoads += 1;
        // The first sorted read raced the save and was computed at revision 1;
        // adopting it would revert the user's committed edit on screen.
        return Promise.resolve({
          table: sortLoads === 1 ? { ...table, sort: "status" } : tableWithValue("Ready edited", 2),
        });
      }
      return Promise.resolve({ table });
    });
    await renderActiveEditor();

    const cell = screen.getByDisplayValue("Ready");
    fireEvent.change(cell, { target: { value: "Ready edited" } });
    fireEvent.blur(cell);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(expect.stringContaining("/cells/"), expect.objectContaining({ method: "PUT" })),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await waitFor(() => expect(sortLoads).toBe(2));
    expect(screen.getByDisplayValue("Ready edited")).toBeInTheDocument();
  });

  it("bounds retries when table loads keep returning an older revision", async () => {
    let sortLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") return Promise.resolve({ revision: 2 });
      if (String(path).includes("sort=status")) {
        sortLoads += 1;
        return Promise.resolve({ table: { ...table, sort: "status" } });
      }
      return Promise.resolve({ table });
    });
    await renderActiveEditor();

    const cell = screen.getByDisplayValue("Ready");
    fireEvent.change(cell, { target: { value: "Ready edited" } });
    fireEvent.blur(cell);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(expect.stringContaining("/cells/"), expect.objectContaining({ method: "PUT" })),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));

    expect(await screen.findByText("The table kept returning an older revision.")).toBeInTheDocument();
    expect(sortLoads).toBe(3);
  });

  it("replaces a stale exhaustion error with the active recovery notice", async () => {
    vi.useFakeTimers();
    const stale = { ...table, revision: 0 };
    let tableLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (init?.method === "PUT") return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
      tableLoads += 1;
      return Promise.resolve({ table: tableLoads <= 2 ? table : stale });
    });
    await renderActiveEditor();

    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "Uncertain" } });
    fireEvent.blur(input);
    await drainStaleRetries();

    expect(screen.getByText("The table kept returning an older revision.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await drainStaleRetries();

    expect(screen.queryByText("The table kept returning an older revision.")).not.toBeInTheDocument();
    expect(screen.getByText("Table refresh is delayed while waiting for the latest revision.")).toBeInTheDocument();
  });

  it("discards a page-not-found response that a newer successful load superseded", async () => {
    vi.useFakeTimers();
    const onPageUnavailable = vi.fn();
    const sorted: TableData = {
      ...table,
      sort: "status",
      rows: [{ id: "row-1", position: 0, cells: { status: "Restored" } }],
    };
    const refresh = deferred<{ table: TableData }>();
    vi.mocked(api)
      .mockResolvedValueOnce({ table })
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValue({ table: sorted });
    render(
      <TablePage
        page={page}
        member={member("viewer")}
        onPageChanged={vi.fn()}
        onPageUnavailable={onPageUnavailable}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(api).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await act(async () => {});
    expect(screen.getByDisplayValue("Restored")).toBeInTheDocument();

    // The page was archived while the poll was in flight and restored before its
    // response landed; the sort load that superseded the poll saw it live, so the
    // stale rejection must not bury a working table under a terminal notice.
    await act(async () => {
      refresh.reject(new ApiClientError(404, "page_not_found", "Page not found."));
      await refresh.promise.catch(() => undefined);
    });

    expect(onPageUnavailable).not.toHaveBeenCalled();
    expect(screen.queryByText("Page not found.")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Restored")).toBeInTheDocument();
    // A genuinely deleted page is still noticed: polling keeps running.
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(api).toHaveBeenCalledTimes(4);
  });

  it("rechecks a refresh generation immediately before adopting its table", async () => {
    vi.useFakeTimers();
    const initial = pagedTable({
      rows: [{ id: "row-1", position: 0, cells: { status: "Initial" } }],
    });
    const obsolete = { ...initial, rows: [{ ...initial.rows[0]!, cells: { status: "Obsolete refresh" } }] };
    const appended: TableData = {
      ...initial,
      revision: 2,
      rows: [{ id: "row-2", position: 1, cells: { status: "Appended" } }],
      hasMore: false,
      nextCursor: null,
      rowCount: null,
    };
    const refresh = deferred<{ table: TableData }>();
    const append = deferred<{ table: TableData }>();
    let pageOneLoads = 0;
    vi.mocked(api).mockImplementation((path) => {
      if (String(path).includes("afterPosition")) return append.promise;
      if (String(path).includes("count=true")) {
        pageOneLoads += 1;
        if (pageOneLoads === 1) return Promise.resolve({ table: initial });
        if (pageOneLoads === 2) return refresh.promise;
        throw new Error("Unexpected extra page-one load.");
      }
      throw new Error(`Unexpected table request: ${String(path)}`);
    });
    renderViewer();
    await act(() => vi.advanceTimersByTimeAsync(0));
    const loadMore = screen.getByRole("button", { name: "Load more rows" });

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await act(async () => {
      refresh.resolve({ table: obsolete });
      await refresh.promise;
      // This starts a newer generation after the refresh's last read check but
      // before the outer load continuation can adopt that response.
      fireEvent.click(loadMore);
    });

    expect(screen.getByDisplayValue("Initial")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Obsolete refresh")).not.toBeInTheDocument();

    await act(async () => {
      append.resolve({ table: appended });
      await append.promise;
    });

    expect(screen.getByDisplayValue("Appended")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Obsolete refresh")).not.toBeInTheDocument();
  });

  it("treats page deletion discovered by pagination as terminal", async () => {
    vi.useFakeTimers();
    const onPageUnavailable = vi.fn();
    const first: TableData = {
      ...table,
      rows: [{ id: "row-1", position: 0, cells: { status: "One" } }],
      hasMore: true,
      nextCursor: { position: 0, rowId: "row-1" },
      rowCount: 2,
    };
    const refresh = deferred<{ table: TableData }>();
    vi.mocked(api)
      .mockResolvedValueOnce({ table: first })
      .mockImplementationOnce(() => refresh.promise)
      .mockRejectedValueOnce(new ApiClientError(404, "page_not_found", "Page not found."));
    render(
      <TablePage
        page={page}
        member={member("viewer")}
        onPageChanged={vi.fn()}
        onPageUnavailable={onPageUnavailable}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    const loadMore = screen.getByRole("button", { name: "Load more rows" });

    // The poll in flight will be superseded by the pagination request, so that
    // request is the one that discovers the deletion, and its rejection is
    // swallowed by the click handler rather than surfacing anywhere else.
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    fireEvent.click(loadMore);
    await act(async () => {});

    expect(onPageUnavailable).toHaveBeenCalledWith(page.id);
    expect(screen.getByText("Page not found.")).toBeInTheDocument();
    await act(async () => {
      refresh.resolve({ table: first });
      await refresh.promise;
    });
    expect(api).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("discards an appended page when the sort changes before its response arrives", async () => {
    const stalePage = deferred<{ table: TableData }>();
    const ascending: TableData = {
      ...table,
      sort: "status",
      rows: [{ id: "row-1", position: 0, cells: { status: "Ascending" } }],
      hasMore: true,
      nextCursor: null,
      nextOffset: 500,
      rowCount: 700,
    };
    const descending: TableData = {
      ...table,
      sort: "status",
      dir: "desc",
      rows: [{ id: "row-3", position: 2, cells: { status: "Descending" } }],
      rowCount: 700,
    };
    vi.mocked(api).mockImplementation((path) => {
      if (path.includes("offset=500")) return stalePage.promise;
      if (path.includes("dir=desc")) return Promise.resolve({ table: descending });
      if (path.includes("sort=status")) return Promise.resolve({ table: ascending });
      return Promise.resolve({ table });
    });
    renderViewer();

    const sort = await screen.findByRole("button", { name: /^Status/ });
    fireEvent.click(sort);
    expect(await screen.findByDisplayValue("Ascending")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.stringContaining("offset=500"), expect.anything()));
    fireEvent.click(sort);
    expect(await screen.findByDisplayValue("Descending")).toBeInTheDocument();

    await act(async () =>
      stalePage.resolve({
        table: {
          ...ascending,
          rows: [{ id: "row-2", position: 1, cells: { status: "Stale" } }],
          hasMore: false,
          nextOffset: null,
        },
      }),
    );
    expect(screen.queryByDisplayValue("Stale")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Descending")).toBeInTheDocument();
  });

  it("explains when a sorted view reaches the 5,000-row depth cap", async () => {
    const truncated: TableData = {
      ...table,
      sort: "status",
      hasMore: false,
      nextCursor: null,
      nextOffset: null,
      truncated: true,
      rowCount: 6_000,
    };
    vi.mocked(api).mockResolvedValueOnce({ table }).mockResolvedValueOnce({ table: truncated });
    renderViewer();

    fireEvent.click(await screen.findByRole("button", { name: /^Status/ }));

    expect(await screen.findByText(/Showing the first 5,000 sorted rows/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more rows" })).not.toBeInTheDocument();
  });

  it("counts every row on the server, not just the ones loaded", async () => {
    vi.mocked(api).mockResolvedValue({
      table: { ...table, hasMore: true, nextCursor: { position: 0, rowId: "row" }, rowCount: 4_000 },
    });
    renderViewer();

    expect(await screen.findByText("1 / 4000 rows")).toBeInTheDocument();
  });

  it("hides the load-more control once the last page has arrived", async () => {
    vi.mocked(api).mockResolvedValue({ table });
    renderViewer();

    expect(await screen.findByDisplayValue("Ready")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more rows" })).not.toBeInTheDocument();
  });

  it("re-reads from the server when a sort is applied rather than reordering loaded rows", async () => {
    vi.mocked(api).mockResolvedValue({ table });
    renderViewer();

    fireEvent.click(await screen.findByRole("button", { name: /^Status/ }));

    await waitFor(() =>
      expect(api).toHaveBeenLastCalledWith("/api/tables/table-page?limit=500&count=true&sort=status&dir=asc", {
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
