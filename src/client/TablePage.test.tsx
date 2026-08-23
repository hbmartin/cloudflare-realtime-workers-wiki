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

  it("keeps appended pages from blocking revision recovery and disables pagination while it runs", async () => {
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
      rows: [{ id: "row-2", position: 1, cells: { status: "Two" } }],
      hasMore: true,
      nextCursor: { position: 1, rowId: "row-2" },
      rowCount: null,
    };
    const recovery = deferred<{ table: TableData }>();
    let fullLoads = 0;
    vi.mocked(api).mockImplementation((path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return Promise.resolve(leaseResult());
      if (path.endsWith("/lease") && init?.method === "DELETE") return Promise.resolve({ ok: true });
      if (path.includes("/cells/")) {
        return Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
      }
      if (path.includes("afterPosition=")) return Promise.resolve({ table: second });
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
      recovery.resolve({ table: tableWithValue("Authoritative", 7) });
      await recovery.promise;
    });
    expect(screen.getByDisplayValue("Authoritative")).toBeEnabled();
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
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

  it("reloads page one instead of appending rows from a different table revision", async () => {
    const first: TableData = {
      ...table,
      revision: 1,
      rows: [{ id: "row-1", position: 0, cells: { status: "Old first page" } }],
      hasMore: true,
      nextCursor: { position: 0, rowId: "row-1" },
      rowCount: 2,
    };
    const mismatchedPage: TableData = {
      ...table,
      revision: 2,
      rows: [{ id: "row-2", position: 1, cells: { status: "Incompatible second page" } }],
      rowCount: null,
    };
    const refreshed: TableData = {
      ...table,
      revision: 2,
      rows: [{ id: "row-new", position: 0, cells: { status: "Consistent first page" } }],
      rowCount: 1,
    };
    vi.mocked(api)
      .mockResolvedValueOnce({ table: first })
      .mockResolvedValueOnce({ table: mismatchedPage })
      .mockResolvedValueOnce({ table: refreshed });
    renderViewer();

    fireEvent.click(await screen.findByRole("button", { name: "Load more rows" }));

    expect(await screen.findByDisplayValue("Consistent first page")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Old first page")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Incompatible second page")).not.toBeInTheDocument();
    expect(api).toHaveBeenNthCalledWith(3, "/api/tables/table-page?limit=500&count=true", {
      signal: expect.any(AbortSignal),
    });
  });

  it("appends the next page when the user's own save commits while it loads", async () => {
    const first: TableData = {
      ...table,
      rows: [{ id: "row-1", position: 0, cells: { status: "One" } }],
      hasMore: true,
      nextCursor: { position: 0, rowId: "row-1" },
      rowCount: 2,
    };
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

    // The save moved the table to revision 2 before the append's response landed.
    // The appended page was read at revision 2, the same snapshot the merged save
    // left on screen, so it must extend the view rather than reset it to page one.
    await act(async () => {
      append.resolve({
        table: {
          ...first,
          revision: 2,
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

    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));

    expect(await screen.findByDisplayValue("Middle")).toBeInTheDocument();
    expect(appendRequests).toBe(1);
    expect(sortedPageLoads).toBe(2);
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
