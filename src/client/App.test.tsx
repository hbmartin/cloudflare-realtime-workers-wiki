// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ClientMemberContext, Page, WorkspaceEvent } from "../shared/types";
import type { EditorPageProps } from "./EditorPage";
import { ApiClientError, api, EmptyApiResponseError, InvalidApiResponseError, UnreadableApiResponseError } from "./api";
import { App } from "./App";
import { PAGE_NAVIGATE_EVENT } from "./mentions";

const mocks = vi.hoisted(() => ({
  createWorkspaceEvents: vi.fn((_workspaceId: string, _onEvent: unknown, _onReconnect: () => void) => ({
    destroy: vi.fn(),
    provider: {},
  })),
  editorAction: vi.fn(),
  invalidatePagePreview: vi.fn(),
  signInEmail: vi.fn(),
  signOut: vi.fn(),
  waitForReconciliationRetry: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return {
    ...original,
    api: vi.fn(),
    authClient: {
      signIn: { email: mocks.signInEmail },
      signOut: mocks.signOut,
    },
  };
});

vi.mock("./collaboration", () => ({ createWorkspaceEvents: mocks.createWorkspaceEvents }));
vi.mock("./mentions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mentions")>()),
  invalidatePagePreview: mocks.invalidatePagePreview,
}));
vi.mock("./retry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./retry")>()),
  waitForReconciliationRetry: mocks.waitForReconciliationRetry,
}));

vi.mock("./EditorPage", () => ({
  EditorPage: (props: EditorPageProps) => (
    <button onClick={() => mocks.editorAction(props)}>Simulate document access denial</button>
  ),
}));

vi.mock("./TablePage", () => ({ TablePage: () => null }));

const member: ClientMemberContext = {
  role: "editor",
  user: { id: "user", name: "Editor", email: "editor@example.test" },
  workspace: { id: "workspace", name: "Notes", locationHint: null },
};

const page: Page = {
  id: "page",
  workspaceId: member.workspace.id,
  parentId: null,
  kind: "document",
  position: "a0",
  title: "Roadmap",
  icon: null,
  revision: 1,
  contentEpoch: 1,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
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

function reconnectWorkspace() {
  const reconnect = mocks.createWorkspaceEvents.mock.calls.at(-1)?.[2];
  if (!reconnect) throw new Error("Workspace reconnect handler was not registered.");
  reconnect();
}

function dispatchWorkspaceEvent(event: WorkspaceEvent) {
  const onEvent = mocks.createWorkspaceEvents.mock.calls.at(-1)?.[1] as
    | ((workspaceEvent: WorkspaceEvent) => void)
    | undefined;
  if (!onEvent) throw new Error("Workspace event handler was not registered.");
  onEvent(event);
}

function mockWorkspaceApi(treeReloadFailure?: ApiClientError, archiveFailure?: ApiClientError) {
  let treeLoads = 0;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === "/api/install") return { initialized: true };
    if (path === "/api/me") return member;
    if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
    if (path === "/api/pages/tree?archived=true") return { pages: [] };
    if (path === "/api/pages/tree") {
      treeLoads += 1;
      if (treeLoads === 1) return { pages: [page] };
      if (treeReloadFailure) throw treeReloadFailure;
      return { pages: [] };
    }
    if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
      if (archiveFailure) throw archiveFailure;
      return { ok: true, pageIds: [page.id] };
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
}

describe("App error handling", () => {
  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      clear: () => stored.clear(),
      getItem: (key: string) => stored.get(key) ?? null,
      key: (index: number) => [...stored.keys()][index] ?? null,
      get length() {
        return stored.size;
      },
      removeItem: (key: string) => stored.delete(key),
      setItem: (key: string, value: string) => stored.set(key, value),
    } satisfies Storage);
    history.replaceState(null, "", "/");
    vi.mocked(api).mockReset();
    mocks.createWorkspaceEvents.mockClear();
    mocks.editorAction.mockReset();
    mocks.invalidatePagePreview.mockReset();
    mocks.signInEmail.mockReset();
    mocks.signOut.mockReset();
    mocks.waitForReconciliationRetry.mockReset();
    mocks.waitForReconciliationRetry.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("recovers a failed initial page-tree load from the pending workspace", async () => {
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) throw new ApiClientError(503, "tree_unavailable", "Tree unavailable.");
        return { pages: [page] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByText("Tree unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Workspace unavailable" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create a root page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh the page tree" }));

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    expect(treeLoads).toBe(2);
    expect(screen.queryByText("Tree unavailable.")).not.toBeInTheDocument();
  });

  it("uses the sign-in fallback for an empty Better Auth message", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") throw new ApiClientError(401, "unauthorized", "Unauthorized.");
      throw new Error(`Unexpected API request: ${path}`);
    });
    mocks.signInEmail.mockResolvedValue({ error: { message: "" } });
    render(<App />);

    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "editor@example.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Sign in failed.")).toBeInTheDocument();
  });

  it("preserves an access-denied message when the page-tree refresh also fails", async () => {
    mockWorkspaceApi(new ApiClientError(503, "tree_unavailable", "Tree refresh unavailable."));
    mocks.editorAction.mockImplementation((props: EditorPageProps) => {
      props.onAccessDenied(page.id, new ApiClientError(403, "forbidden", "Access revoked."));
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Simulate document access denial" }));

    expect(await screen.findByText("Access revoked. Tree refresh unavailable.")).toBeInTheDocument();
  });

  it("preserves an access-denied message when the page-tree refresh succeeds", async () => {
    mockWorkspaceApi();
    mocks.editorAction.mockImplementation((props: EditorPageProps) => {
      props.onAccessDenied(page.id, new ApiClientError(403, "forbidden", "Access revoked."));
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Simulate document access denial" }));

    expect(await screen.findByText("Access revoked.")).toBeInTheDocument();
  });

  it("clears an access-denied message on the next explicit navigation", async () => {
    mockWorkspaceApi();
    mocks.editorAction.mockImplementation((props: EditorPageProps) => {
      props.onAccessDenied(page.id, new ApiClientError(403, "forbidden", "Access revoked."));
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Simulate document access denial" }));
    expect(await screen.findByText("Access revoked.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Search/ }));

    expect(screen.queryByText("Access revoked.")).not.toBeInTheDocument();
  });

  it("does not let a reconnect refresh overwrite an access-denied message", async () => {
    const reload = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        return reload.promise;
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    mocks.editorAction.mockImplementation((props: EditorPageProps) => {
      props.onAccessDenied(page.id, new ApiClientError(403, "forbidden", "Access revoked."));
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Simulate document access denial" }));
    reconnectWorkspace();
    await act(async () => {
      reload.reject(new ApiClientError(503, "tree_unavailable", "Tree refresh unavailable."));
      await reload.promise.catch(() => undefined);
    });

    expect(screen.getByText("Access revoked. Tree refresh unavailable.")).toBeInTheDocument();
    expect(screen.getAllByText(/Tree refresh unavailable\./)).toHaveLength(1);
  });

  it("preserves concurrent primary errors that share a page-tree refresh", async () => {
    mockWorkspaceApi(new ApiClientError(503, "tree_unavailable", "Tree refresh unavailable."));
    mocks.editorAction.mockImplementation((props: EditorPageProps) => {
      props.onAccessDenied(page.id, new ApiClientError(403, "forbidden", "First access revoked."));
      props.onAccessDenied(page.id, new ApiClientError(403, "forbidden", "Second access revoked."));
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Simulate document access denial" }));

    expect(
      await screen.findByText("First access revoked. Second access revoked. Tree refresh unavailable."),
    ).toBeInTheDocument();
  });

  it("suppresses duplicate messages that differ only by trailing punctuation", async () => {
    mockWorkspaceApi(new ApiClientError(503, "tree_unavailable", "Access revoked . !"));
    mocks.editorAction.mockImplementation((props: EditorPageProps) => {
      props.onAccessDenied(page.id, new ApiClientError(403, "forbidden", "Access revoked."));
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Simulate document access denial" }));

    expect(await screen.findByText("Access revoked.")).toBeInTheDocument();
    expect(screen.queryByText("Access revoked. Access revoked.")).not.toBeInTheDocument();
  });

  it("keeps an unavailable page hidden through one stale reconciliation, then recovers", async () => {
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: [page] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    mocks.editorAction.mockImplementation((props: EditorPageProps) => props.onPageUnavailable?.(page.id));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Simulate document access denial" }));

    await waitFor(() => expect(treeLoads).toBe(2));
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(page.id);

    reconnectWorkspace();

    await waitFor(() => expect(treeLoads).toBe(3));
    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
  });

  it("starts a fresh unavailable-page reconciliation after an older load settles", async () => {
    const staleTree = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        return treeLoads === 2 ? staleTree.promise : { pages: [] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    mocks.editorAction.mockImplementation((props: EditorPageProps) => props.onPageUnavailable?.(page.id));
    render(<App />);

    await screen.findByRole("button", { name: "Archive Roadmap" });
    reconnectWorkspace();
    await waitFor(() => expect(treeLoads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Simulate document access denial" }));
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();

    await act(async () => {
      staleTree.resolve({ pages: [page] });
      await staleTree.promise;
    });

    await waitFor(() => expect(treeLoads).toBe(3));
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
  });

  it("retains an unavailable-page tombstone across a failed load and one stale retry", async () => {
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 2) throw new ApiClientError(503, "tree_unavailable", "Tree unavailable.");
        return { pages: [page] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    mocks.editorAction.mockImplementation((props: EditorPageProps) => props.onPageUnavailable?.(page.id));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Simulate document access denial" }));
    expect(await screen.findByText("Tree unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();

    reconnectWorkspace();
    await waitFor(() => expect(treeLoads).toBe(3));
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();

    reconnectWorkspace();
    await waitFor(() => expect(treeLoads).toBe(4));
    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
  });

  it("sends the archive operation id to the server", async () => {
    const operationId = "00000000-0000-4000-8000-000000000001";
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
    onTestFinished(() => randomUUID.mockRestore());
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    mockWorkspaceApi();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(`/api/pages/${page.id}`, {
        method: "DELETE",
        headers: { "x-notes-operation-id": operationId },
      }),
    );
  });

  it("reports an archive error when operation id generation fails", async () => {
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("Random UUID unavailable.");
    });
    onTestFinished(() => randomUUID.mockRestore());
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    mockWorkspaceApi();
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    expect(await screen.findByText("The page could not be archived.")).toBeInTheDocument();
    expect(api).not.toHaveBeenCalledWith(`/api/pages/${page.id}`, expect.objectContaining({ method: "DELETE" }));
  });

  it("reports a committed archive accurately when local reconciliation throws", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    mocks.invalidatePagePreview.mockImplementationOnce(() => {
      throw new Error("Preview cache unavailable.");
    });
    mockWorkspaceApi(new ApiClientError(503, "tree_unavailable", "Tree refresh unavailable."));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    expect(
      await screen.findByText(
        "The page was archived, but the workspace could not be updated. Tree refresh unavailable.",
      ),
    ).toBeInTheDocument();
  });

  it("reconciles an uncertain archive when local handling throws", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    mocks.invalidatePagePreview.mockImplementationOnce(() => {
      throw new Error("Preview cache unavailable.");
    });
    mockWorkspaceApi(
      new ApiClientError(503, "tree_unavailable", "Tree refresh unavailable."),
      new ApiClientError(503, "archive_unavailable", "Archive service unavailable."),
    );
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    expect(
      await screen.findByText(
        "The page may have been archived, but the workspace could not be updated. Tree refresh unavailable.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps an unseen archived descendant removed and starts a fresh post-archive tree load", async () => {
    const staleReload = deferred<{ pages: Page[] }>();
    const child = { ...page, id: "child-page", parentId: page.id, position: "a1", title: "Child" };
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree?archived=true") return { pages: [page, child] };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        return treeLoads === 2 ? staleReload.promise : { pages: [page, child] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        return { ok: true, pageIds: [page.id, child.id] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    const archive = await screen.findByRole("button", { name: "Archive Roadmap" });
    reconnectWorkspace();
    await waitFor(() => expect(treeLoads).toBe(2));
    fireEvent.click(archive);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(`/api/pages/${page.id}`, expect.objectContaining({ method: "DELETE" })),
    );
    await act(async () => {
      staleReload.resolve({ pages: [page, child] });
      await staleReload.promise;
    });

    await waitFor(() => expect(treeLoads).toBe(3));
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Child" })).not.toBeInTheDocument();
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(page.id);
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(child.id);
    expect(api).not.toHaveBeenCalledWith("/api/pages/tree?archived=true");
  });

  it("uses authoritative archive ids instead of removing a locally stale child", async () => {
    const child = { ...page, id: "child-page", parentId: page.id, position: "a1", title: "Child" };
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [page, child] : [child] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        return { ok: true, pageIds: [page.id] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    await waitFor(() => expect(treeLoads).toBe(2));
    expect(await screen.findByRole("button", { name: "Archive Child" })).toBeInTheDocument();
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(page.id);
    expect(mocks.invalidatePagePreview).not.toHaveBeenCalledWith(child.id);
  });

  it("buffers known removals and clears an invalid-response error after a fresh archive reconciliation", async () => {
    const staleReload = deferred<{ pages: Page[] }>();
    const child = { ...page, id: "child-page", parentId: page.id, position: "a1", title: "Child" };
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page, child] };
        return treeLoads === 2 ? staleReload.promise : { pages: [] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") return { ok: true };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    const archive = await screen.findByRole("button", { name: "Archive Roadmap" });
    reconnectWorkspace();
    await waitFor(() => expect(treeLoads).toBe(2));
    fireEvent.click(archive);

    expect(
      await screen.findByText("The server returned an invalid archive response. Refreshing the page tree."),
    ).toBeInTheDocument();
    await act(async () => {
      staleReload.resolve({ pages: [page, child] });
      await staleReload.promise;
    });

    await waitFor(() => expect(treeLoads).toBe(3));
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Child" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("The server returned an invalid archive response. Refreshing the page tree."),
    ).not.toBeInTheDocument();
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(page.id);
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(child.id);
  });

  it("keeps an invalid-response warning while the post-archive tree remains stale", async () => {
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads < 3 ? [page] : [] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") return { ok: true };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    await waitFor(() => expect(treeLoads).toBe(2));
    expect(
      screen.getByText("The server returned an invalid archive response. Refreshing the page tree."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();

    reconnectWorkspace();

    await waitFor(() => expect(treeLoads).toBe(3));
    expect(
      screen.queryByText("The server returned an invalid archive response. Refreshing the page tree."),
    ).not.toBeInTheDocument();
  });

  it("releases locally inferred archive tombstones after repeated authoritative presence", async () => {
    const child = { ...page, id: "child-page", parentId: page.id, position: "a1", title: "Child" };
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: [page, child] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") return { ok: true };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    await waitFor(() => expect(treeLoads).toBe(2));
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Child" })).not.toBeInTheDocument();

    reconnectWorkspace();

    await waitFor(() => expect(treeLoads).toBe(3));
    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Child" })).toBeInTheDocument();
    expect(
      screen.getByText("The server returned an invalid archive response. Refreshing the page tree."),
    ).toBeVisible();
  });

  it.each([
    [
      "malformed JSON",
      new InvalidApiResponseError(200, {
        requestPath: `/api/pages/${page.id}`,
        responseUrl: null,
        contentType: "application/json",
        cause: new SyntaxError("Unexpected end of JSON input"),
      }),
    ],
    [
      "an unreadable JSON body",
      new UnreadableApiResponseError(200, {
        requestPath: `/api/pages/${page.id}`,
        responseUrl: null,
        contentType: "application/json",
        cause: new TypeError("Body stream failed"),
      }),
    ],
  ])("treats successful archive %s as a committed mutation", async (_label, responseError) => {
    const reconciliation = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return treeLoads === 1 ? { pages: [page] } : reconciliation.promise;
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        throw responseError;
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    expect(
      await screen.findByText("The server returned an invalid archive response. Refreshing the page tree."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(page.id);
    await act(async () => {
      reconciliation.resolve({ pages: [] });
      await reconciliation.promise;
    });
    expect(
      screen.queryByText("The server returned an invalid archive response. Refreshing the page tree."),
    ).not.toBeInTheDocument();
  });

  it("treats an archive response-validator exception as a committed mutation", async () => {
    const reconciliation = deferred<{ pages: Page[] }>();
    const validationFailure = new TypeError("Archive response validation failed.");
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => reported.mockRestore());
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return treeLoads === 1 ? { pages: [page] } : reconciliation.promise;
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        return new Proxy(
          {},
          {
            has() {
              throw validationFailure;
            },
          },
        );
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    expect(
      await screen.findByText("The server returned an invalid archive response. Refreshing the page tree."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(page.id);
    expect(reported).toHaveBeenCalledWith(
      "Successful mutation response could not be validated",
      expect.objectContaining({
        requestPath: `/api/pages/${page.id}`,
        method: "DELETE",
        errorName: "TypeError",
        errorMessage: validationFailure.message,
        errorStack: expect.any(String),
      }),
    );
    await act(async () => {
      reconciliation.resolve({ pages: [] });
      await reconciliation.promise;
    });
    expect(
      screen.queryByText("The server returned an invalid archive response. Refreshing the page tree."),
    ).not.toBeInTheDocument();
  });

  it("does not clear a newer archive failure for another page", async () => {
    const secondPage = { ...page, id: "second-page", position: "a1", title: "Second" };
    const reconciliation = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page, secondPage] };
        return treeLoads === 2 ? reconciliation.promise : { pages: [secondPage] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        throw new InvalidApiResponseError(200, {
          requestPath: path,
          responseUrl: null,
          contentType: "application/json",
          cause: new SyntaxError("Unexpected end of JSON input"),
        });
      }
      if (path === `/api/pages/${secondPage.id}` && init?.method === "DELETE") {
        throw new ApiClientError(503, "archive_unavailable", "Second archive failure.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));
    expect(await screen.findByText(/invalid archive response/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive Second" }));
    expect(await screen.findByText(/archive result could not be verified/i)).toBeInTheDocument();
    expect(screen.queryByText(/Second archive failure/)).not.toBeInTheDocument();

    await act(async () => {
      reconciliation.resolve({ pages: [page, secondPage] });
      await reconciliation.promise;
    });

    await waitFor(() => expect(treeLoads).toBe(3));
    expect(screen.getByText("The archive result could not be verified. Refreshing the page tree.")).toBeInTheDocument();
    expect(screen.queryByText(/invalid archive response/i)).not.toBeInTheDocument();
  });

  it.each([
    [
      "a non-JSON response",
      new InvalidApiResponseError(200, {
        requestPath: `/api/pages/${page.id}`,
        responseUrl: null,
        contentType: "text/html",
        cause: new SyntaxError("Unexpected token '<'"),
      }),
    ],
    [
      "a headerless empty response",
      new EmptyApiResponseError(204, {
        requestPath: `/api/pages/${page.id}`,
        responseUrl: null,
        contentType: null,
      }),
    ],
  ])("reports %s as an unverified archive response", async (_label, responseError) => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => reported.mockRestore());
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: [page] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") throw responseError;
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    await waitFor(() => expect(treeLoads).toBe(2));
    expect(screen.getByText("The archive result could not be verified. Refreshing the page tree.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(page.id);
    expect(reported).toHaveBeenCalledWith(
      "Archive result could not be verified",
      expect.objectContaining({
        pageId: page.id,
        operationId: expect.any(String),
        outcome: "uncertain",
        errorName: responseError.name,
        errorMessage: responseError.message,
        errorStack: expect.any(String),
      }),
    );
  });

  it("clears an unverified archive response after reconciliation confirms removal", async () => {
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [page] : [] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        throw new InvalidApiResponseError(200, {
          requestPath: path,
          responseUrl: null,
          contentType: "text/html",
          cause: new SyntaxError("Unexpected token '<'"),
        });
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    await waitFor(() => expect(treeLoads).toBe(2));
    expect(screen.queryByText(/archive result could not be verified/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
  });

  it("refreshes Trash when an uncertain archive is later confirmed", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    let treeLoads = 0;
    let trashLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [page] : [] };
      }
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return { pages: trashLoads === 1 ? [] : [archivedPage] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        throw new InvalidApiResponseError(200, {
          requestPath: path,
          responseUrl: null,
          contentType: "text/html",
          cause: new SyntaxError("Unexpected token '<'"),
        });
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    const archive = await screen.findByRole("button", { name: "Archive Roadmap" });
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    await waitFor(() => expect(trashLoads).toBe(1));
    fireEvent.click(archive);

    await waitFor(() => expect(trashLoads).toBe(2));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("does not reload the tree after a definitive archive rejection", async () => {
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: [page] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        throw new ApiClientError(422, "archive_rejected", "Archive rejected.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    expect(await screen.findByText("Archive rejected.")).toBeInTheDocument();
    expect(treeLoads).toBe(1);
  });

  it.each([404, 410])("reconciles a page_not_found response with status %i", async (status) => {
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [page] : [] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        throw new ApiClientError(status, "page_not_found", "Page not found.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    await waitFor(() => expect(treeLoads).toBe(2));
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    expect(screen.queryByText("Page not found.")).not.toBeInTheDocument();
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(page.id);
  });

  it("keeps a page_not_found removal pinned while reconciliation data is stale", async () => {
    const reconciliation = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    let trashLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return treeLoads === 1 ? { pages: [page] } : reconciliation.promise;
      }
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return { pages: [] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        throw new ApiClientError(404, "page_not_found", "Page not found.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    const archive = await screen.findByRole("button", { name: "Archive Roadmap" });
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    await waitFor(() => expect(trashLoads).toBe(1));
    fireEvent.click(archive);

    await waitFor(() => expect(treeLoads).toBe(2));
    await waitFor(() => expect(trashLoads).toBe(2));
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    expect(screen.queryByText("Page not found.")).not.toBeInTheDocument();
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(page.id);
    await act(async () => {
      reconciliation.resolve({ pages: [page] });
      await reconciliation.promise;
    });
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    expect(screen.queryByText("Page not found.")).not.toBeInTheDocument();
  });

  it("does not let an ordinary upsert bypass an archive tombstone", async () => {
    const reconciliation = deferred<{ pages: Page[] }>();
    const archivedPage = { ...page, archivedAt: 2 };
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return treeLoads === 1 ? { pages: [page] } : reconciliation.promise;
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        return { ok: true, pageIds: [page.id] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));
    await waitFor(() => expect(treeLoads).toBe(2));
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();

    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [{ ...page, title: "Late rename" }] }));

    expect(screen.queryByRole("button", { name: "Archive Late rename" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    await act(async () => {
      reconciliation.resolve({ pages: [] });
      await reconciliation.promise;
    });
  });

  it("does not count a buffered upsert as repeated server presence", async () => {
    const confirmingLoad = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads <= 2) return { pages: [page] };
        return confirmingLoad.promise;
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        return { ok: true, pageIds: [page.id] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));
    await waitFor(() => expect(treeLoads).toBe(2));
    reconnectWorkspace();
    await waitFor(() => expect(treeLoads).toBe(3));
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [{ ...page, title: "Late rename" }] }));
    await act(async () => {
      confirmingLoad.resolve({ pages: [] });
      await confirmingLoad.promise;
    });

    expect(screen.queryByRole("button", { name: "Archive Late rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
  });

  it("keeps a page_not_found removal through a failed reconciliation and one stale retry", async () => {
    const failedReconciliation = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        return treeLoads === 2 ? failedReconciliation.promise : { pages: [page] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        throw new ApiClientError(404, "page_not_found", "Page not found.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));
    await waitFor(() => expect(treeLoads).toBe(2));
    await act(async () => {
      failedReconciliation.reject(new ApiClientError(503, "tree_unavailable", "Tree unavailable."));
      await failedReconciliation.promise.catch(() => undefined);
    });

    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    reconnectWorkspace();

    await waitFor(() => expect(treeLoads).toBe(3));
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    expect(screen.queryByText("Page not found.")).not.toBeInTheDocument();

    reconnectWorkspace();

    await waitFor(() => expect(treeLoads).toBe(4));
    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
  });

  it("lets the user dismiss a scoped archive error", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    mockWorkspaceApi(undefined, new ApiClientError(422, "archive_rejected", "Archive rejected."));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));
    expect(await screen.findByText("Archive rejected.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss workspace errors" }));

    expect(screen.queryByText("Archive rejected.")).not.toBeInTheDocument();
  });

  it("starts a post-archive trash request instead of adopting an older load", async () => {
    const archiveResponse = deferred<{ ok: true; pageIds: string[] }>();
    const staleTrash = deferred<{ pages: Page[] }>();
    const archivedPage = { ...page, archivedAt: 2 };
    let trashLoads = 0;
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [page] : [] };
      }
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return trashLoads === 1 ? staleTrash.promise : { pages: [archivedPage] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") return archiveResponse.promise;
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(`/api/pages/${page.id}`, expect.objectContaining({ method: "DELETE" })),
    );
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    await waitFor(() => expect(trashLoads).toBe(1));
    await act(async () => {
      archiveResponse.resolve({ ok: true, pageIds: [page.id] });
      await archiveResponse.promise;
    });

    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(trashLoads).toBe(2);
    await act(async () => {
      staleTrash.resolve({ pages: [] });
      await staleTrash.promise;
    });
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("refreshes trash after a remote archive while trash is visible", async () => {
    let trashLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [page] };
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return { pages: [] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    await waitFor(() => expect(trashLoads).toBe(1));
    act(() => dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id], permanently: false }));

    await waitFor(() => expect(trashLoads).toBe(2));
  });

  it("keeps a remote removal pinned through a stale tree reload", async () => {
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: [page] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    act(() => dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id], permanently: false }));
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    reconnectWorkspace();

    await waitFor(() => expect(treeLoads).toBe(2));
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
  });

  it("does not let a late upsert bypass a permanent-removal tombstone", async () => {
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: [page] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    act(() => dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id], permanently: true }));
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [{ ...page, title: "Late rename" }] }));

    expect(screen.queryByRole("button", { name: "Archive Late rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    expect(treeLoads).toBe(1);
    expect(mocks.waitForReconciliationRetry).not.toHaveBeenCalled();
  });

  it("does not let an out-of-order restored event release a newer removal", async () => {
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [page] : [] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    act(() => dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id], permanently: false }));
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page], restored: true }));

    await waitFor(() => expect(treeLoads).toBe(3));
    expect(mocks.waitForReconciliationRetry).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
  });

  it("restores a remote page when the first confirming tree still omits it", async () => {
    const finalConfirmation = deferred<{ pages: Page[] }>();
    const retryDelay = deferred<void>();
    let treeLoads = 0;
    mocks.waitForReconciliationRetry.mockReturnValueOnce(retryDelay.promise);
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        return treeLoads === 2 ? { pages: [] } : finalConfirmation.promise;
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    act(() => dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id], permanently: false }));
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page], restored: true }));

    await waitFor(() => expect(treeLoads).toBe(2));
    expect(treeLoads).toBe(2);
    await act(async () => {
      retryDelay.resolve();
      await retryDelay.promise;
    });
    await waitFor(() => expect(treeLoads).toBe(3));
    await act(async () => {
      finalConfirmation.resolve({ pages: [page] });
      await finalConfirmation.promise;
    });
    expect(treeLoads).toBe(3);
    expect(mocks.waitForReconciliationRetry).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
  });

  it("confirms every restored page from the full page tree", async () => {
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: [page] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    act(() => dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id], permanently: false }));
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page], restored: true }));

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Simulate document access denial" })).toBeInTheDocument();
    expect(treeLoads).toBe(2);
    expect(mocks.waitForReconciliationRetry).not.toHaveBeenCalled();
  });

  it("does not release a restored descendant omitted from the confirming tree", async () => {
    const child = { ...page, id: "child-page", parentId: page.id, position: "a1", title: "Child" };
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [page, child] : [page] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Archive Child" })).toBeInTheDocument();
    act(() => dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id, child.id], permanently: false }));
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page, child], restored: true }));

    await waitFor(() => expect(treeLoads).toBe(3));
    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Child" })).not.toBeInTheDocument();
  });

  it("does not let a remote restore release an unrelated descendant tombstone", async () => {
    const child = { ...page, id: "child-page", parentId: page.id, position: "a1", title: "Child" };
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: [page, child] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Archive Child" })).toBeInTheDocument();
    act(() => {
      dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [child.id], permanently: false });
      dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id], permanently: false });
      dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page], restored: true });
    });

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Child" })).not.toBeInTheDocument();
    expect(treeLoads).toBe(2);
    expect(mocks.waitForReconciliationRetry).not.toHaveBeenCalled();
  });

  it("removes a remotely confirmed restore from a stale trash snapshot", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const confirmation = deferred<{ pages: Page[] }>();
    const staleTrash = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    let trashLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return treeLoads === 1 ? { pages: [page] } : confirmation.promise;
      }
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return trashLoads === 1 ? { pages: [archivedPage] } : staleTrash.promise;
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    act(() => {
      dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id], permanently: false });
      dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page], restored: true });
    });
    await waitFor(() => expect(trashLoads).toBeGreaterThan(1));
    await waitFor(() => expect(treeLoads).toBe(2));
    await act(async () => {
      confirmation.resolve({ pages: [page] });
      await confirmation.promise;
    });
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    await act(async () => {
      staleTrash.resolve({ pages: [archivedPage] });
      await staleTrash.promise;
    });

    expect(await screen.findByText("Trash is empty.")).toBeInTheDocument();
    expect(trashLoads).toBe(2);
  });

  it("shows a confirmed restore in trash after it is archived again", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    let trashLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [page] };
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return { pages: [archivedPage] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page], restored: true }));
    await waitFor(() => expect(trashLoads).toBe(2));
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();

    act(() => dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id], permanently: false }));

    await waitFor(() => expect(trashLoads).toBe(3));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("refreshes the active tree when Trash reveals a newer archive", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const rearchivedPage = { ...archivedPage, revision: page.revision + 1, updatedAt: page.updatedAt + 1 };
    const activeTreeRefresh = deferred<{ pages: Page[] }>();
    let archivedAgain = false;
    let trashLoads = 0;
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        return treeLoads === 2 ? activeTreeRefresh.promise : { pages: [] };
      }
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return { pages: [archivedAgain ? rearchivedPage : archivedPage] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page], restored: true }));
    await waitFor(() => expect(trashLoads).toBe(2));
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page], restored: true }));
    await waitFor(() => expect(trashLoads).toBe(3));

    archivedAgain = true;
    fireEvent.click(screen.getByRole("button", { name: /Search/ }));
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));

    await waitFor(() => expect(treeLoads).toBe(2));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeEnabled();
    await waitFor(() => expect(screen.queryByRole("button", { name: "□Roadmap" })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Search/ }));
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    await waitFor(() => expect(trashLoads).toBe(5));
    expect(treeLoads).toBe(2);
    await act(async () => {
      activeTreeRefresh.resolve({ pages: [page] });
      await activeTreeRefresh.promise;
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "□Roadmap" })).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(treeLoads).toBe(2);
  });

  it("retries a failed active-tree refresh for the latest Trash request without a stale error", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const rearchivedPage = { ...archivedPage, revision: page.revision + 1, updatedAt: page.updatedAt + 1 };
    const activeTreeRefresh = deferred<{ pages: Page[] }>();
    let archivedAgain = false;
    let trashLoads = 0;
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        return treeLoads === 2 ? activeTreeRefresh.promise : { pages: [] };
      }
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return { pages: [archivedAgain ? rearchivedPage : archivedPage] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page], restored: true }));
    await waitFor(() => expect(trashLoads).toBe(2));
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();

    archivedAgain = true;
    fireEvent.click(screen.getByRole("button", { name: /Search/ }));
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    await waitFor(() => expect(treeLoads).toBe(2));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /Search/ }));
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    await waitFor(() => expect(trashLoads).toBe(4));
    await act(async () => {
      activeTreeRefresh.reject(new ApiClientError(503, "tree_unavailable", "Tree refresh unavailable."));
      await activeTreeRefresh.promise.catch(() => undefined);
    });

    await waitFor(() => expect(treeLoads).toBe(3));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "□Roadmap" })).not.toBeInTheDocument();
    expect(screen.queryByText("Tree refresh unavailable.")).not.toBeInTheDocument();
  });

  it("keeps a failed Trash tree refresh owed until a later Trash load recovers it", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const rearchivedPage = { ...archivedPage, revision: page.revision + 1, updatedAt: page.updatedAt + 1 };
    let archivedAgain = false;
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        if (treeLoads < 4) throw new ApiClientError(503, "tree_unavailable", "Tree refresh unavailable.");
        return { pages: [] };
      }
      if (path === "/api/pages/tree?archived=true") {
        return { pages: [archivedAgain ? rearchivedPage : archivedPage] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page], restored: true }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument());

    archivedAgain = true;
    fireEvent.click(screen.getByRole("button", { name: /Search/ }));
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));

    expect(await screen.findByText("Tree refresh unavailable.")).toBeInTheDocument();
    expect(treeLoads).toBe(3);
    expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled();
    expect(screen.queryByText("Trash is empty.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "□Roadmap" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Search/ }));
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));

    await waitFor(() => expect(treeLoads).toBe(4));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "□Roadmap" })).not.toBeInTheDocument();
    expect(screen.queryByText("Tree refresh unavailable.")).not.toBeInTheDocument();
  });

  it("does not expose a just-restored page when the next active tree is stale", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [page] : [] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    await screen.findByRole("button", { name: "Archive Roadmap" });
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page], restored: true }));
    reconnectWorkspace();
    await waitFor(() => expect(treeLoads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));

    expect(await screen.findByText("Trash is empty.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    expect(treeLoads).toBe(2);
  });

  it("shows a restored page after an uncertain archive is confirmed by the active tree", async () => {
    const archivedPage = {
      ...page,
      archivedAt: 2,
      revision: page.revision + 1,
      updatedAt: page.updatedAt + 1,
    };
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [page] : [] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        throw new ApiClientError(503, "archive_unavailable", "Archive service unavailable.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page], restored: true }));
    fireEvent.click(screen.getByRole("button", { name: "Archive Roadmap" }));
    await waitFor(() => expect(treeLoads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));

    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("clears restore suppression when an active page becomes unavailable", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [page] : [] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    mocks.editorAction.mockImplementation((props: EditorPageProps) => props.onPageUnavailable(page.id));
    render(<App />);

    const unavailable = await screen.findByRole("button", { name: "Simulate document access denial" });
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page], restored: true }));
    fireEvent.click(unavailable);
    await waitFor(() => expect(treeLoads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));

    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("cancels a delayed reconciliation when the workspace unmounts", async () => {
    const retryDelay = deferred<void>();
    let treeLoads = 0;
    mocks.waitForReconciliationRetry.mockReturnValueOnce(retryDelay.promise);
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [page] : [] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    const app = render(<App />);

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    act(() => dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id], permanently: false }));
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [page], restored: true }));
    await waitFor(() => expect(mocks.waitForReconciliationRetry).toHaveBeenCalledOnce());
    const signal = mocks.waitForReconciliationRetry.mock.calls[0]?.[0] as AbortSignal;
    expect(signal.aborted).toBe(false);

    app.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      retryDelay.resolve();
      await retryDelay.promise;
    });
    expect(treeLoads).toBe(2);
  });

  it.each<[string, WorkspaceEvent]>([
    ["restore", { type: "pages-upserted", pages: [page], restored: true }],
    ["permanent delete", { type: "pages-removed", pageIds: [page.id], permanently: true }],
  ])("does not let an older trash response undo a remote %s event", async (_label, event) => {
    const staleTrash = deferred<{ pages: Page[] }>();
    const archivedPage = { ...page, archivedAt: 2 };
    let trashLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [] };
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        if (trashLoads === 1) return { pages: [archivedPage] };
        return trashLoads === 2 ? staleTrash.promise : { pages: [] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    act(() => dispatchWorkspaceEvent({ type: "pages-removed", pageIds: ["another-page"], permanently: false }));
    await waitFor(() => expect(trashLoads).toBe(2));
    act(() => dispatchWorkspaceEvent(event));
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
    await act(async () => {
      staleTrash.resolve({ pages: [archivedPage] });
      await staleTrash.promise;
    });

    await waitFor(() => expect(trashLoads).toBe(3));
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
  });

  it("does not restart an in-flight trash load for an ordinary page upsert", async () => {
    const trashLoad = deferred<{ pages: Page[] }>();
    const archivedPage = { ...page, archivedAt: 2 };
    const otherPage = { ...page, id: "other-page", title: "Other" };
    let trashLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [otherPage] };
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return trashLoad.promise;
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    await waitFor(() => expect(trashLoads).toBe(1));
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [{ ...otherPage, title: "Renamed" }] }));
    await act(async () => {
      trashLoad.resolve({ pages: [archivedPage] });
      await trashLoad.promise;
    });

    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(trashLoads).toBe(1);
  });

  it("runs the latest trash refresh when multiple invalidations are batched", async () => {
    let trashLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [page] };
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return { pages: [] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    await waitFor(() => expect(trashLoads).toBe(1));
    act(() => {
      dispatchWorkspaceEvent({ type: "pages-removed", pageIds: ["first"], permanently: false });
      dispatchWorkspaceEvent({ type: "pages-removed", pageIds: ["second"], permanently: true });
    });

    await waitFor(() => expect(trashLoads).toBe(2));
  });

  it("does not return to trash when its load finishes after later navigation", async () => {
    const trashLoad = deferred<{ pages: Page[] }>();
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [page] };
      if (path === "/api/pages/tree?archived=true") return trashLoad.promise;
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    expect(await screen.findByRole("heading", { name: "Trash" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Search/ }));
    expect(screen.getByRole("heading", { name: "Find anything" })).toBeInTheDocument();
    await act(async () => {
      trashLoad.resolve({ pages: [] });
      await trashLoad.promise;
    });

    expect(screen.getByRole("heading", { name: "Find anything" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Trash" })).not.toBeInTheDocument();
  });

  it("shows stale trash as refreshing and disables its actions", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const refresh = deferred<{ pages: Page[] }>();
    let trashLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [] };
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return trashLoads === 1 ? { pages: [archivedPage] } : refresh.promise;
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    expect(await screen.findByRole("button", { name: "Restore" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Search/ }));
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));

    expect(screen.getByRole("status")).toHaveTextContent("Refreshing trash…");
    expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
    await act(async () => {
      refresh.resolve({ pages: [] });
      await refresh.promise;
    });
  });

  it("records restore upserts before an older tree load settles", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const staleTree = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        return treeLoads === 2 ? staleTree.promise : { pages: [page] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") return { pages: [page] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    await screen.findByRole("button", { name: "Archive Roadmap" });
    reconnectWorkspace();
    await waitFor(() => expect(treeLoads).toBe(2));
    act(() => dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id], permanently: false }));
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(page.id));
    await act(async () => {
      staleTree.resolve({ pages: [] });
      await staleTree.promise;
    });

    expect(treeLoads).toBe(2);
    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
  });

  it("selects the restored root when the confirming tree lists a child first", async () => {
    const child = { ...page, id: "child-page", parentId: page.id, position: "a0", title: "Child" };
    const root = { ...page, position: "z0" };
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [root, child] : [child, root] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Archive Child" })).toBeInTheDocument();
    act(() => {
      dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id, child.id], permanently: false });
      dispatchWorkspaceEvent({ type: "pages-upserted", pages: [child, root], restored: true });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Simulate document access denial" }));
    expect((mocks.editorAction.mock.calls.at(-1)?.[0] as EditorPageProps | undefined)?.page.id).toBe(page.id);
  });

  it("selects the restored root on the confirmed local happy path", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [] };
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") return { pages: [page] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    await waitFor(() => expect(localStorage.getItem("notes:last-page")).toBe(page.id));
  });

  it("keeps the restored-root preference when the first confirming tree only has another page", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const otherPage = { ...page, id: "other-page", position: "b0", title: "Other" };
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [] };
        return treeLoads === 2 ? { pages: [otherPage] } : { pages: [otherPage, page] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") return { ok: true };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    await waitFor(() => expect(treeLoads).toBe(3));
    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    expect(localStorage.getItem("notes:last-page")).toBe(page.id);
  });

  it("falls back to an available page when a pending restored root is absent", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const otherPage = { ...page, id: "other-page", position: "b0", title: "Other" };
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [] : [otherPage] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") return { ok: true };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    expect(await screen.findByRole("button", { name: "Archive Other" })).toBeInTheDocument();
    expect(localStorage.getItem("notes:last-page")).toBe(otherPage.id);
  });

  it("preserves navigation to a page until its workspace event reaches the loaded tree", async () => {
    const otherPage = { ...page, id: "other-page", position: "b0", title: "Other" };
    const missingPage = { ...page, id: "missing-page", position: "c0", title: "Missing" };
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [page, otherPage] };
      if (path === "/api/pages/tree?archived=true") return { pages: [] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: missingPage.id }));
    });

    expect(screen.getByRole("heading", { name: "Opening page…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh the page tree" })).toBeInTheDocument();
    expect(screen.queryByText("A quiet workspace.")).not.toBeInTheDocument();
    expect(localStorage.getItem("notes:last-page")).toBe(page.id);
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [missingPage] }));

    await waitFor(() => expect(localStorage.getItem("notes:last-page")).toBe(missingPage.id));
    expect(screen.getByRole("button", { name: "Archive Missing" })).toBeInTheDocument();
  });

  it("makes pending-navigation retries single-flight and keeps waiting when the target remains absent", async () => {
    const missingPage = { ...page, id: "missing-page", position: "c0", title: "Missing" };
    const retry = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return treeLoads === 1 ? { pages: [page] } : retry.promise;
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: missingPage.id }));
    });
    expect(screen.getByRole("button", { name: "+ Page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create a root page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add child to Roadmap" })).toBeDisabled();

    const refresh = screen.getByRole("button", { name: "Refresh the page tree" });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    await waitFor(() => expect(treeLoads).toBe(2));
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();

    await act(async () => {
      retry.resolve({ pages: [page] });
      await retry.promise;
    });

    expect(screen.getByRole("heading", { name: "Opening page…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Return to current page" })).toBeEnabled();
    expect(treeLoads).toBe(2);

    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [missingPage] }));
    expect(await screen.findByRole("button", { name: "Archive Missing" })).toBeInTheDocument();
  });

  it("keeps the in-flight retry attached when the same pending page is selected again", async () => {
    const missingPage = { ...page, id: "missing-page", position: "c0", title: "Missing" };
    const retry = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return treeLoads === 1 ? { pages: [page] } : retry.promise;
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    await screen.findByRole("button", { name: "Archive Roadmap" });
    act(() => {
      window.dispatchEvent(new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: missingPage.id }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh the page tree" }));
    await waitFor(() => expect(treeLoads).toBe(2));

    act(() => {
      window.dispatchEvent(new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: missingPage.id }));
    });

    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
    expect(treeLoads).toBe(2);

    await act(async () => {
      retry.resolve({ pages: [page] });
      await retry.promise;
    });
    expect(screen.getByRole("button", { name: "Refresh the page tree" })).toBeEnabled();
  });

  it("invalidates a failed retry when a workspace event resolves its pending page", async () => {
    const missingPage = { ...page, id: "missing-page", position: "c0", title: "Missing" };
    const retry = deferred<{ pages: Page[] }>();
    const staleFailure = new ApiClientError(503, "tree_unavailable", "Stale tree failure.");
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return treeLoads === 1 ? { pages: [page] } : retry.promise;
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    await screen.findByRole("button", { name: "Archive Roadmap" });
    act(() => {
      window.dispatchEvent(new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: missingPage.id }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh the page tree" }));
    await waitFor(() => expect(treeLoads).toBe(2));

    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [missingPage] }));
    expect(await screen.findByRole("button", { name: "Archive Missing" })).toBeInTheDocument();

    await act(async () => {
      retry.reject(staleFailure);
      await retry.promise.catch(() => undefined);
    });
    expect(screen.queryByText("Stale tree failure.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Missing" })).toBeInTheDocument();
  });

  it("cancels only the retry observer while reconnect shares its page load", async () => {
    const firstMissingPage = { ...page, id: "first-missing-page", position: "c0", title: "First missing" };
    const secondMissingPage = { ...page, id: "second-missing-page", position: "d0", title: "Second missing" };
    const sharedTree = deferred<{ pages: Page[] }>();
    let sharedRequestInit: RequestInit | undefined;
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        if (treeLoads === 2) {
          sharedRequestInit = init;
          return sharedTree.promise;
        }
        return { pages: [page] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    await screen.findByRole("button", { name: "Archive Roadmap" });
    act(() => {
      window.dispatchEvent(new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: firstMissingPage.id }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh the page tree" }));
    await waitFor(() => expect(treeLoads).toBe(2));

    reconnectWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Return to current page" }));
    expect(sharedRequestInit?.signal).toBeUndefined();
    expect(screen.getByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: secondMissingPage.id }));
    });
    const replacementRetry = screen.getByRole("button", { name: "Refresh the page tree" });
    expect(replacementRetry).toBeEnabled();
    fireEvent.click(replacementRetry);
    expect(treeLoads).toBe(2);

    await act(async () => {
      sharedTree.resolve({ pages: [page] });
      await sharedTree.promise;
    });
    await waitFor(() => expect(treeLoads).toBe(3));
    expect(screen.getByRole("heading", { name: "Opening page…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh the page tree" })).toBeEnabled();
    expect(screen.queryByText(/page tree could not be refreshed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
  });

  it("keeps the pending-navigation escape available while a retry is in flight", async () => {
    const missingPage = { ...page, id: "missing-page", position: "c0", title: "Missing" };
    const retry = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return treeLoads === 1 ? { pages: [page] } : retry.promise;
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    await screen.findByRole("button", { name: "Archive Roadmap" });
    act(() => {
      window.dispatchEvent(new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: missingPage.id }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh the page tree" }));
    await waitFor(() => expect(treeLoads).toBe(2));

    const cancel = screen.getByRole("button", { name: "Return to current page" });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(screen.queryByRole("heading", { name: "Opening page…" })).not.toBeInTheDocument();

    await act(async () => {
      retry.resolve({ pages: [page] });
      await retry.promise;
    });
    expect(screen.getByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
  });

  it("ignores a failed pending-navigation retry after cancellation and permits a new retry", async () => {
    const firstMissingPage = { ...page, id: "first-missing-page", position: "c0", title: "First missing" };
    const secondMissingPage = { ...page, id: "second-missing-page", position: "d0", title: "Second missing" };
    const firstRetry = deferred<{ pages: Page[] }>();
    const staleFailure = new ApiClientError(503, "tree_unavailable", "Stale tree failure.");
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        if (treeLoads === 2) return firstRetry.promise;
        return { pages: [page, secondMissingPage] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    await screen.findByRole("button", { name: "Archive Roadmap" });
    act(() => {
      window.dispatchEvent(new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: firstMissingPage.id }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh the page tree" }));
    await waitFor(() => expect(treeLoads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: "Return to current page" }));

    act(() => {
      window.dispatchEvent(new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: secondMissingPage.id }));
    });
    expect(screen.getByRole("button", { name: "Refresh the page tree" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh the page tree" }));

    await act(async () => {
      firstRetry.reject(staleFailure);
      await firstRetry.promise.catch(() => undefined);
    });

    expect(await screen.findByRole("button", { name: "Archive Second missing" })).toBeInTheDocument();
    expect(treeLoads).toBe(3);
    expect(screen.queryByText("Stale tree failure.")).not.toBeInTheDocument();
  });

  it("lets the user abandon a pending navigation target", async () => {
    const missingPage = { ...page, id: "missing-page", position: "c0", title: "Missing" };
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [page] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: missingPage.id }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Return to current page" }));

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Opening page…" })).not.toBeInTheDocument();
  });

  it("abandons a pending navigation when the user leaves the pages view", async () => {
    const missingPage = { ...page, id: "missing-page", position: "c0", title: "Missing" };
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [page] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    await screen.findByRole("button", { name: "Archive Roadmap" });
    act(() => {
      window.dispatchEvent(new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: missingPage.id }));
    });
    fireEvent.click(screen.getByRole("button", { name: /Search/ }));

    expect(screen.getByRole("heading", { name: "Find anything" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Page" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Return to current page" })).not.toBeInTheDocument();
  });

  it("keeps a pending navigation target through a stale tree response", async () => {
    const missingPage = { ...page, id: "missing-page", position: "c0", title: "Missing" };
    const staleTree = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return treeLoads === 1 ? { pages: [page] } : staleTree.promise;
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    reconnectWorkspace();
    await waitFor(() => expect(treeLoads).toBe(2));
    act(() => {
      window.dispatchEvent(new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: missingPage.id }));
    });
    expect(screen.getByRole("heading", { name: "Opening page…" })).toBeInTheDocument();

    await act(async () => {
      staleTree.resolve({ pages: [page] });
      await staleTree.promise;
    });

    expect(screen.getByRole("heading", { name: "Opening page…" })).toBeInTheDocument();
    expect(localStorage.getItem("notes:last-page")).toBe(page.id);
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [missingPage] }));
    expect(await screen.findByRole("button", { name: "Archive Missing" })).toBeInTheDocument();
  });

  it("does not let an older restore preference overwrite a newer restored selection", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const newerRoot = { ...page, id: "newer-root", position: "b0", title: "Newer root" };
    const reconciliation = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return treeLoads === 1 ? { pages: [] } : reconciliation.promise;
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") return { ok: true };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(treeLoads).toBe(2));
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [newerRoot], restored: true }));
    await act(async () => {
      reconciliation.resolve({ pages: [page, newerRoot] });
      await reconciliation.promise;
    });

    expect(localStorage.getItem("notes:last-page")).toBe(newerRoot.id);
    expect(screen.getByRole("button", { name: "Archive Newer root" })).toBeInTheDocument();
  });

  it("does not let a confirmed restore response overwrite a newer removal", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const restoreRequest = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    let restoreCalls = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: [] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") {
        restoreCalls += 1;
        return restoreRequest.promise;
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restoreCalls).toBe(1));
    act(() => dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id], permanently: false }));
    await act(async () => {
      restoreRequest.resolve({ pages: [page] });
      await restoreRequest.promise;
    });

    await waitFor(() => expect(treeLoads).toBe(2));
    expect(mocks.waitForReconciliationRetry).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
  });

  it("does not merge a raw restore snapshot after a removal arrives during the load", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const restoreReconciliation = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        if (treeLoads === 2) throw new ApiClientError(503, "tree_unavailable", "Tree unavailable.");
        return restoreReconciliation.promise;
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        return { ok: true, pageIds: [page.id] };
      }
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") return { ok: true };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));
    expect(await screen.findByText("Tree unavailable.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(treeLoads).toBe(3));
    act(() => dispatchWorkspaceEvent({ type: "pages-removed", pageIds: [page.id], permanently: false }));

    await act(async () => {
      restoreReconciliation.resolve({ pages: [page] });
      await restoreReconciliation.promise;
    });

    expect(treeLoads).toBe(3);
    expect(mocks.waitForReconciliationRetry).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
  });

  it("keeps known restore tombstones pinned until an uncertain result is confirmed", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const restoreReconciliation = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        if (treeLoads === 2) throw new ApiClientError(503, "tree_unavailable", "Tree unavailable.");
        return restoreReconciliation.promise;
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        return { ok: true, pageIds: [page.id] };
      }
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") {
        throw new ApiClientError(503, "restore_unavailable", "Restore unavailable.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));
    expect(await screen.findByText("Tree unavailable.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(treeLoads).toBe(3));
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [{ ...page, title: "Late rename" }] }));

    expect(screen.queryByRole("button", { name: "Archive Late rename" })).not.toBeInTheDocument();
    await act(async () => {
      restoreReconciliation.resolve({ pages: [] });
      await restoreReconciliation.promise;
    });
    act(() => dispatchWorkspaceEvent({ type: "pages-upserted", pages: [{ ...page, title: "Confirmed rename" }] }));

    expect(await screen.findByRole("button", { name: "Archive Confirmed rename" })).toBeInTheDocument();
  });

  it("does not reconcile the page tree after a definitive restore rejection", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: [] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") {
        throw new ApiClientError(422, "restore_rejected", "Restore rejected.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    expect(await screen.findByText("Restore rejected.")).toBeInTheDocument();
    expect(treeLoads).toBe(1);
  });

  it("keeps an invalid restore response error when reconciliation does not find the root", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const finalReconciliation = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads < 3) return { pages: [] };
        return finalReconciliation.promise;
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") return { ok: true };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    expect(await screen.findByText(/invalid restore response/i)).toBeInTheDocument();
    await waitFor(() => expect(treeLoads).toBe(3));
    await act(async () => {
      finalReconciliation.resolve({ pages: [] });
      await finalReconciliation.promise;
    });
    expect(treeLoads).toBe(3);
    expect(screen.getByText(/invalid restore response/i)).toBeInTheDocument();
  });

  it.each<[string, unknown]>([
    ["a legacy response", { ok: true }],
    ["a null response", null],
    ["a malformed page list", { pages: [null] }],
    [
      "malformed successful JSON",
      new InvalidApiResponseError(200, {
        requestPath: `/api/pages/${page.id}/restore`,
        responseUrl: null,
        contentType: "application/json",
        cause: new SyntaxError("Unexpected end of JSON input"),
      }),
    ],
    [
      "an unreadable successful response",
      new UnreadableApiResponseError(200, {
        requestPath: `/api/pages/${page.id}/restore`,
        responseUrl: null,
        contentType: "application/json",
        cause: new TypeError("Body stream failed"),
      }),
    ],
    [
      "an empty successful response",
      new EmptyApiResponseError(204, {
        requestPath: `/api/pages/${page.id}/restore`,
        responseUrl: null,
        contentType: null,
      }),
    ],
    [
      "malformed non-JSON content",
      new InvalidApiResponseError(200, {
        requestPath: `/api/pages/${page.id}/restore`,
        responseUrl: null,
        contentType: "text/plain",
        cause: new SyntaxError("Unexpected token 'o'"),
      }),
    ],
  ])("reconciles the restore state after %s", async (_label, response) => {
    const archivedPage = { ...page, archivedAt: 2 };
    let treeLoads = 0;
    let trashLoads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [] : [page] };
      }
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return { pages: trashLoads === 1 ? [archivedPage] : [] };
      }
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") {
        if (response instanceof Error) throw response;
        return response;
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    expect(await screen.findByText("Trash is empty.")).toBeInTheDocument();
    expect(screen.queryByText("The page could not be restored.")).not.toBeInTheDocument();
    expect(
      screen.queryByText("The server returned an invalid restore response. Refreshing pages."),
    ).not.toBeInTheDocument();
    expect(treeLoads).toBe(2);
    expect(trashLoads).toBe(2);
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(page.id);
  });

  it("releases restored descendants discovered after a malformed response", async () => {
    const child = { ...page, id: "child-page", parentId: page.id, position: "a1", title: "Child" };
    const archivedPage = { ...page, archivedAt: 2 };
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page, child] };
        if (treeLoads === 2) throw new ApiClientError(503, "tree_unavailable", "Tree unavailable.");
        return { pages: [page, child] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        return { ok: true, pageIds: [page.id, child.id] };
      }
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") return { ok: true };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));
    expect(await screen.findByText("Tree unavailable.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Child" })).toBeInTheDocument();
    expect(treeLoads).toBe(3);
  });

  it("does not pin an observed descendant when the confirming tree omits the root", async () => {
    const child = { ...page, id: "child-page", parentId: page.id, position: "a1", title: "Child" };
    const archivedPage = { ...page, archivedAt: 2 };
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page, child] };
        if (treeLoads === 2) throw new ApiClientError(503, "tree_unavailable", "Tree unavailable.");
        return { pages: [child] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        return { ok: true, pageIds: [page.id, child.id] };
      }
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") return { ok: true };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));
    expect(await screen.findByText("Tree unavailable.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    await waitFor(() => expect(treeLoads).toBe(4));
    expect(treeLoads).toBe(4);
    expect(screen.getByRole("button", { name: "Archive Child" })).toBeInTheDocument();
  });

  it("starts a fresh page load after a legacy restore response and an older load", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const staleTree = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    let trashLoads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [] };
        return treeLoads === 2 ? staleTree.promise : { pages: [page] };
      }
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return { pages: [archivedPage] };
      }
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") return { ok: true };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    await waitFor(() => expect(treeLoads).toBe(1));
    reconnectWorkspace();
    await waitFor(() => expect(treeLoads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    expect(
      await screen.findByText("The server returned an invalid restore response. Refreshing pages."),
    ).toBeInTheDocument();
    expect(treeLoads).toBe(2);
    await act(async () => {
      staleTree.resolve({ pages: [] });
      await staleTree.promise;
    });

    await waitFor(() => expect(treeLoads).toBe(3));
    expect(await screen.findByRole("button", { name: "Archive Roadmap" })).toBeInTheDocument();
    expect(trashLoads).toBe(2);
    expect(
      screen.queryByText("The server returned an invalid restore response. Refreshing pages."),
    ).not.toBeInTheDocument();
  });

  it("releases a failed restore lock before an older page load settles", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const staleTree = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    let restoreCalls = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [] };
        return treeLoads === 2 ? staleTree.promise : { pages: [] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") {
        restoreCalls += 1;
        throw new ApiClientError(503, "restore_unavailable", "Restore service unavailable.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    await waitFor(() => expect(treeLoads).toBe(1));
    reconnectWorkspace();
    await waitFor(() => expect(treeLoads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    expect(await screen.findByText("Restore service unavailable.")).toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: "Restore" });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    expect(restoreCalls).toBe(2);

    await act(async () => {
      staleTree.resolve({ pages: [] });
      await staleTree.promise;
    });
    await waitFor(() => expect(treeLoads).toBe(3));
  });

  it("guards a restore subtree against duplicate clicks", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const restore = deferred<{ pages: Page[] }>();
    let restoreCalls = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [] };
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") {
        restoreCalls += 1;
        return restore.promise;
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    const restoreButton = await screen.findByRole("button", { name: "Restore" });
    act(() => {
      restoreButton.click();
      restoreButton.click();
    });

    expect(restoreCalls).toBe(1);
    expect(restoreButton).toBeDisabled();
    await act(async () => {
      restore.resolve({ pages: [page] });
      await restore.promise;
    });
  });

  it("reports a restore failure without an unhandled rejection", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    let treeLoads = 0;
    let trashLoads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: [] };
      }
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return { pages: [archivedPage] };
      }
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") {
        throw new ApiClientError(503, "restore_unavailable", "Restore service unavailable.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    expect(await screen.findByText("Restore service unavailable.")).toBeInTheDocument();
    await waitFor(() => expect(treeLoads).toBe(2));
    await waitFor(() => expect(trashLoads).toBe(2));
  });

  it("reports a permanent-delete failure without an unhandled rejection", async () => {
    const owner = { ...member, role: "owner" as const };
    const archivedPage = { ...page, archivedAt: 2 };
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return owner;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [] };
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}/permanent-delete` && init?.method === "POST") {
        throw new ApiClientError(503, "delete_unavailable", "Deletion service unavailable.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete forever" }));

    expect(await screen.findByText("Deletion service unavailable.")).toBeInTheDocument();
  });

  it("keeps an invalid restore error and a concurrent delete failure when reconciliation omits the root", async () => {
    const owner = { ...member, role: "owner" as const };
    const restoredPage = { ...page, archivedAt: 2 };
    const deletedPage = { ...restoredPage, id: "delete-page", title: "Delete me" };
    const treeReload = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return owner;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return treeLoads === 1 ? { pages: [] } : treeReload.promise;
      }
      if (path === "/api/pages/tree?archived=true") {
        return { pages: [restoredPage, deletedPage] };
      }
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") return { ok: true };
      if (path === `/api/pages/${deletedPage.id}/permanent-delete` && init?.method === "POST") {
        throw new ApiClientError(503, "delete_unavailable", "Deletion service unavailable.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    const restoreButton = (await screen.findAllByRole("button", { name: "Restore" }))[0]!;
    fireEvent.click(restoreButton);
    expect(await screen.findByText(/invalid restore response/i)).toBeInTheDocument();
    const deletedRow = screen.getByText("Delete me").parentElement;
    if (!(deletedRow instanceof HTMLDivElement)) throw new TypeError("Deleted page row was not rendered.");
    const deleteButton = within(deletedRow).getByRole("button", { name: "Delete forever" });
    await waitFor(() => expect(deleteButton).toBeEnabled());
    fireEvent.click(deleteButton);

    await act(async () => {
      treeReload.resolve({ pages: [] });
      await treeReload.promise;
    });
    expect(await screen.findByText(/Deletion service unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/invalid restore response/i)).toBeInTheDocument();
  });

  it("does not clear a newer same-page failure after restore reconciliation", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const staleTree = deferred<{ pages: Page[] }>();
    let treeLoads = 0;
    let restoreCalls = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [] };
        return treeLoads === 2 ? staleTree.promise : { pages: [] };
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") {
        restoreCalls += 1;
        if (restoreCalls === 1) return { ok: true };
        throw new ApiClientError(503, "restore_unavailable", "Newer restore failure.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    await waitFor(() => expect(treeLoads).toBe(1));
    reconnectWorkspace();
    await waitFor(() => expect(treeLoads).toBe(2));
    fireEvent.click(screen.getByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    expect(await screen.findByText(/invalid restore response/i)).toBeInTheDocument();

    const retry = await screen.findByRole("button", { name: "Restore" });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    expect(await screen.findByText("Newer restore failure.")).toBeInTheDocument();

    await act(async () => {
      staleTree.resolve({ pages: [] });
      await staleTree.promise;
    });
    await waitFor(() => expect(treeLoads).toBe(4));
    expect(treeLoads).toBe(4);
    expect(screen.getByText("Newer restore failure.")).toBeInTheDocument();
  });

  it("clears an invalid permanent-delete response after trash confirms deletion", async () => {
    const owner = { ...member, role: "owner" as const };
    const archivedPage = { ...page, archivedAt: 2 };
    const refreshedTrash = deferred<{ pages: Page[] }>();
    let trashLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return owner;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [] };
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return trashLoads === 1 ? { pages: [archivedPage] } : refreshedTrash.promise;
      }
      if (path === `/api/pages/${page.id}/permanent-delete` && init?.method === "POST") {
        throw new InvalidApiResponseError(200, {
          requestPath: path,
          responseUrl: null,
          contentType: "application/json",
          cause: new SyntaxError("Unexpected end of JSON input"),
        });
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete forever" }));
    expect(await screen.findByText(/invalid permanent-delete response/i)).toBeInTheDocument();

    await act(async () => {
      refreshedTrash.resolve({ pages: [] });
      await refreshedTrash.promise;
    });
    expect(await screen.findByText("Trash is empty.")).toBeInTheDocument();
    expect(screen.queryByText(/invalid permanent-delete response/i)).not.toBeInTheDocument();
  });

  it("guards permanent deletion and invalidates every deleted preview", async () => {
    const owner = { ...member, role: "owner" as const };
    const archivedPage = { ...page, archivedAt: 2 };
    const child = { ...archivedPage, id: "child-page", parentId: page.id, title: "Child" };
    const deletion = deferred<{ ok: true; pageIds: string[] }>();
    const confirmDelete = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmDelete);
    let deleteCalls = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return owner;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [] };
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage, child] };
      if (path === `/api/pages/${page.id}/permanent-delete` && init?.method === "POST") {
        deleteCalls += 1;
        return deletion.promise;
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    const deleteButton = (await screen.findAllByRole("button", { name: "Delete forever" }))[0]!;
    act(() => {
      deleteButton.click();
      deleteButton.click();
    });

    expect(confirmDelete).toHaveBeenCalledTimes(1);
    expect(deleteCalls).toBe(1);
    expect(deleteButton).toBeDisabled();
    await act(async () => {
      deletion.resolve({ ok: true, pageIds: [page.id, child.id] });
      await deletion.promise;
    });
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(page.id);
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(child.id);
  });

  it("clears a scoped mutation error when refreshed trash no longer contains its row", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    const refreshedTrash = deferred<{ pages: Page[] }>();
    let trashLoads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [] };
      if (path === "/api/pages/tree?archived=true") {
        trashLoads += 1;
        return trashLoads === 1 ? { pages: [archivedPage] } : refreshedTrash.promise;
      }
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") {
        throw new ApiClientError(503, "restore_unavailable", "Restore service unavailable.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    expect(await screen.findByText("Restore service unavailable.")).toBeInTheDocument();

    await act(async () => {
      refreshedTrash.resolve({ pages: [] });
      await refreshedTrash.promise;
    });
    expect(await screen.findByText("Trash is empty.")).toBeInTheDocument();
    expect(screen.queryByText("Restore service unavailable.")).not.toBeInTheDocument();
  });

  it("does not describe failed trash data as empty", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [page] };
      if (path === "/api/pages/tree?archived=true") {
        throw new ApiClientError(503, "trash_unavailable", "Trash service unavailable.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));

    expect(await screen.findByRole("heading", { name: "Trash" })).toBeInTheDocument();
    expect(await screen.findByText("Trash service unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("Trash is empty.")).not.toBeInTheDocument();
  });

  it("clears a recovered page-tree error without clearing an access error", async () => {
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        if (treeLoads === 2) throw new ApiClientError(503, "tree_unavailable", "Tree refresh unavailable.");
        return { pages: [] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    mocks.editorAction.mockImplementation((props: EditorPageProps) => {
      props.onAccessDenied(page.id, new ApiClientError(403, "forbidden", "Access revoked."));
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Simulate document access denial" }));
    expect(await screen.findByText("Access revoked. Tree refresh unavailable.")).toBeInTheDocument();

    reconnectWorkspace();

    expect(await screen.findByText("Access revoked.")).toBeInTheDocument();
    expect(screen.queryByText(/Tree refresh unavailable/)).not.toBeInTheDocument();
  });

  it("does not let an older mention-count response overwrite a newer count", async () => {
    const olderCount = deferred<{ unreadCount: number }>();
    const newerCount = deferred<{ unreadCount: number }>();
    let mentionLoads = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") {
        mentionLoads += 1;
        return mentionLoads === 1 ? olderCount.promise : newerCount.promise;
      }
      if (path === "/api/pages/tree") return { pages: [page] };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    await waitFor(() => expect(mentionLoads).toBe(1));
    reconnectWorkspace();
    await waitFor(() => expect(mentionLoads).toBe(2));
    await act(async () => {
      newerCount.resolve({ unreadCount: 2 });
      await newerCount.promise;
    });
    expect(screen.getByText("2")).toBeInTheDocument();

    await act(async () => {
      olderCount.resolve({ unreadCount: 9 });
      await olderCount.promise;
    });
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("9")).not.toBeInTheDocument();
  });

  it("keeps an unrelated mentions error when an archive starts", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    let treeLoads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") {
        throw new ApiClientError(503, "mentions_unavailable", "Mention count unavailable.");
      }
      if (path === "/api/pages/tree?archived=true") return { pages: [page] };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        return { pages: treeLoads === 1 ? [page] : [] };
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") {
        return { ok: true, pageIds: [page.id] };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    expect(await screen.findByText("Mention count unavailable.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive Roadmap" }));

    await waitFor(() => expect(treeLoads).toBe(2));
    expect(screen.getByText("Mention count unavailable.")).toBeInTheDocument();
  });

  it("reports both an unverified archive and a failed reconciliation refresh", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => reported.mockRestore());
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const archiveFailure = new ApiClientError(503, "archive_unavailable", "Archive service unavailable.");
    mockWorkspaceApi(new ApiClientError(503, "tree_unavailable", "Tree refresh unavailable."), archiveFailure);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    expect(
      await screen.findByText(
        "The archive result could not be verified. Refreshing the page tree. Tree refresh unavailable.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Archive service unavailable/)).not.toBeInTheDocument();
    const archiveLog = reported.mock.calls.find(([message]) => message === "Archive result could not be verified");
    expect(archiveLog?.[1]).toEqual(
      expect.objectContaining({
        pageId: page.id,
        operationId: expect.any(String),
        outcome: "uncertain",
        errorName: "ApiClientError",
        errorMessage: archiveFailure.message,
        errorStack: expect.any(String),
      }),
    );
    const operationId = (archiveLog?.[1] as { operationId?: unknown } | undefined)?.operationId;
    expect(operationId).toEqual(expect.any(String));
    expect(reported).toHaveBeenCalledWith(
      "Page tree could not be refreshed after an unverified archive",
      expect.objectContaining({
        pageId: page.id,
        operationId,
        archiveOutcome: "uncertain",
        errorName: "ApiClientError",
        errorMessage: "Tree refresh unavailable.",
        errorStack: expect.any(String),
      }),
    );
  });

  it("logs a failed reconciliation after a committed archive with invalid ids", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => reported.mockRestore());
    let treeLoads = 0;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") {
        treeLoads += 1;
        if (treeLoads === 1) return { pages: [page] };
        throw new ApiClientError(503, "tree_unavailable", "Tree refresh unavailable.");
      }
      if (path === `/api/pages/${page.id}` && init?.method === "DELETE") return { ok: true };
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    expect(
      await screen.findByText(
        "The server returned an invalid archive response. Refreshing the page tree. Tree refresh unavailable.",
      ),
    ).toBeInTheDocument();
    const archiveLog = reported.mock.calls.find(([message]) => message === "Archive result could not be verified");
    expect(archiveLog?.[1]).toEqual(
      expect.objectContaining({
        pageId: page.id,
        operationId: expect.any(String),
        outcome: "committed-invalid-response",
        errorName: null,
      }),
    );
    const operationId = (archiveLog?.[1] as { operationId?: unknown } | undefined)?.operationId;
    expect(reported).toHaveBeenCalledWith(
      "Page tree could not be refreshed after an unverified archive",
      expect.objectContaining({
        pageId: page.id,
        operationId,
        archiveOutcome: "committed",
        errorName: "ApiClientError",
        errorMessage: "Tree refresh unavailable.",
        errorStack: expect.any(String),
      }),
    );
  });
});
