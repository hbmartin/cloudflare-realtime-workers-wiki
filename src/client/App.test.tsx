// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ClientMemberContext, Page } from "../shared/types";
import type { EditorPageProps } from "./EditorPage";
import { ApiClientError, api } from "./api";
import { App } from "./App";

const mocks = vi.hoisted(() => ({
  createWorkspaceEvents: vi.fn(() => ({ destroy: vi.fn(), provider: {} })),
  editorAction: vi.fn(),
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

function mockWorkspaceApi(treeReloadFailure: ApiClientError, archiveFailure?: ApiClientError) {
  let treeLoads = 0;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === "/api/install") return { initialized: true };
    if (path === "/api/me") return member;
    if (path === "/api/mentions/unread-count") return { unreadCount: 0 };
    if (path === "/api/pages/tree") {
      treeLoads += 1;
      if (treeLoads === 1) return { pages: [page] };
      throw treeReloadFailure;
    }
    if (path === `/api/pages/${page.id}` && init?.method === "DELETE" && archiveFailure) throw archiveFailure;
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
