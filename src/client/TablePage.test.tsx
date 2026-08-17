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
    expect(api).toHaveBeenCalledWith("/api/tables/table-page", { signal: expect.any(AbortSignal) });
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

    expect(await screen.findByText("Editing lease active")).toBeInTheDocument();
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "First" } });
    fireEvent.blur(input);
    await waitFor(() => expect(mutations).toHaveLength(1));

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

  it("ends the lease when a renewal response cannot be read", async () => {
    vi.useFakeTimers();
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "PATCH") return {};
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
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();

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

  it("keeps a save failure visible across a successful lease renewal", async () => {
    vi.useFakeTimers();
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
      if (path.endsWith("/lease") && init?.method === "PATCH") return { leaseDurationMs: LEASE_DURATION_MS };
      if (path.includes("/cells/"))
        throw new ApiClientError(500, "table_unavailable", "Table temporarily unavailable.");
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

    advanceMonotonic(LEASE_DURATION_MS + 1);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(
      screen.getByText("The editing lease expired after renewal failures. Reloaded the authoritative table."),
    ).toBeInTheDocument();
  });

  it("expires a lease after system sleep even when the monotonic clock pauses", async () => {
    stubMonotonicClock();
    const acquiredAt = Date.now();
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
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
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();

    vi.setSystemTime(acquiredAt + LEASE_DURATION_MS + 1);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(screen.getByText("Read-only")).toBeInTheDocument();
    expect(
      screen.getByText("The editing lease expired after renewal failures. Reloaded the authoritative table."),
    ).toBeInTheDocument();
  });

  it("does not send a mutation after the local lease deadline", async () => {
    const advanceMonotonic = stubMonotonicClock();
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return leaseResult();
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

    advanceMonotonic(LEASE_DURATION_MS + 1);
    const input = screen.getByDisplayValue("Ready");
    fireEvent.change(input, { target: { value: "Stale" } });
    fireEvent.blur(input);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Read-only")).toBeInTheDocument();
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
    expect(screen.getByDisplayValue("Ready")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText("Table temporarily unavailable.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.queryByText("Table temporarily unavailable.")).not.toBeInTheDocument();
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
});
