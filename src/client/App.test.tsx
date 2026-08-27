// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ClientMemberContext, Page, WorkspaceEvent } from "../shared/types";
import type { EditorPageProps } from "./EditorPage";
import { ApiClientError, api, InvalidApiResponseError } from "./api";
import { App } from "./App";

const mocks = vi.hoisted(() => ({
  createWorkspaceEvents: vi.fn((_workspaceId: string, _onEvent: unknown, _onReconnect: () => void) => ({
    destroy: vi.fn(),
    provider: {},
  })),
  editorAction: vi.fn(),
  invalidatePagePreview: vi.fn(),
  signInEmail: vi.fn(),
  signOut: vi.fn(),
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
  });

  afterEach(() => vi.unstubAllGlobals());

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

  it("records an unavailable-page removal after starting reconciliation", async () => {
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
  });

  it("keeps an unseen archived descendant removed when archive joins a stale tree load", async () => {
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
        return staleReload.promise;
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

    await waitFor(() => expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Archive Child" })).not.toBeInTheDocument();
    expect(treeLoads).toBe(2);
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(page.id);
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(child.id);
    expect(api).not.toHaveBeenCalledWith("/api/pages/tree?archived=true");
  });

  it("buffers known removals and clears an invalid-response error after archive reconciliation", async () => {
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
        return treeLoads === 1 ? { pages: [page, child] } : staleReload.promise;
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

    expect(screen.queryByRole("button", { name: "Archive Roadmap" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Child" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("The server returned an invalid archive response. Refreshing the page tree."),
    ).not.toBeInTheDocument();
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(page.id);
    expect(mocks.invalidatePagePreview).toHaveBeenCalledWith(child.id);
  });

  it("treats a malformed successful archive body as a committed mutation", async () => {
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

  it.each<[string, WorkspaceEvent]>([
    ["restore", { type: "pages-upserted", pages: [page] }],
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

  it("reports a restore failure without an unhandled rejection", async () => {
    const archivedPage = { ...page, archivedAt: 2 };
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/install") return { initialized: true };
      if (path === "/api/me") return member;
      if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
      if (path === "/api/pages/tree") return { pages: [] };
      if (path === "/api/pages/tree?archived=true") return { pages: [archivedPage] };
      if (path === `/api/pages/${page.id}/restore` && init?.method === "POST") {
        throw new ApiClientError(503, "restore_unavailable", "Restore service unavailable.");
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Trash/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    expect(await screen.findByText("Restore service unavailable.")).toBeInTheDocument();
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

  it("reports both an archive failure and a failed reconciliation refresh", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => reported.mockRestore());
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    mockWorkspaceApi(
      new ApiClientError(503, "tree_unavailable", "Tree refresh unavailable."),
      new ApiClientError(503, "archive_unavailable", "Archive service unavailable."),
    );
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive Roadmap" }));

    expect(await screen.findByText("Archive service unavailable. Tree refresh unavailable.")).toBeInTheDocument();
    expect(reported).toHaveBeenCalledWith(
      "Page tree could not be refreshed after an archive failure",
      expect.any(ApiClientError),
    );
  });
});
