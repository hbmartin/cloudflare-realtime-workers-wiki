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

  it("keeps the successful initial load when the post-acquisition load fails", async () => {
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
    expect(loadCount).toBe(1);

    await act(async () => {
      initialLoad.resolve({ table: tableWithValue("Initial", 1) });
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue("Initial")).toBeInTheDocument();
    expect(loadCount).toBe(2);

    await act(async () => {
      acquiredLoad.reject(new ApiClientError(503, "table_unavailable", "Table temporarily unavailable."));
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue("Initial")).toBeInTheDocument();
    expect(screen.getByText("Table temporarily unavailable.")).toBeInTheDocument();
  });

  it("does not start a second lease request while automatic acquisition is pending", async () => {
    const lease = deferred<{ leaseToken: string }>();
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
      lease.resolve({ leaseToken: "lease-token" });
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("serializes force unlock and acquisition behind one lease action", async () => {
    const unlocked = deferred<{ ok: boolean }>();
    const lease = deferred<{ leaseToken: string }>();
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
      lease.resolve({ leaseToken: "lease-token" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
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

    const button = await screen.findByRole("button", { name: "Try edit lock" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
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

    const button = await screen.findByRole("button", { name: "Try edit lock" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);

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

  it("keeps a lease through a transient renewal failure and clears the notice after retry", async () => {
    vi.useFakeTimers();
    let renewals = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") return { leaseToken: "lease-token" };
      if (path.endsWith("/lease") && init?.method === "PATCH") {
        renewals += 1;
        if (renewals === 1) throw new ApiClientError(503, "lease_unavailable", "Lease service unavailable.");
        return { expiresAt: Date.now() + 60_000 };
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
    expect(screen.getByText("Lease service unavailable.")).toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith("/api/tables/table-page/lease", expect.objectContaining({ method: "DELETE" }));

    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(screen.getByText("Editing lease active")).toBeInTheDocument();
    expect(screen.queryByText("Lease service unavailable.")).not.toBeInTheDocument();
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
    expect(screen.getByText("Another editor has this table open for editing.")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText("Another editor has this table open for editing.")).toBeInTheDocument();
    expect(screen.getByText("Table temporarily unavailable.")).toBeInTheDocument();
  });

  it("uses a force-unlock-specific fallback message", async () => {
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/lease") && init?.method === "POST") {
        throw new ApiClientError(409, "lease_conflict", "held");
      }
      if (path.endsWith("/force-unlock")) throw "offline";
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
});
