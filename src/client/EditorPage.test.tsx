// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "../shared/types";
import type { ClientMemberContext } from "../shared/types";
import { ApiClientError } from "./api";
import { EditorPage } from "./EditorPage";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (value: unknown) => void>();
  const provider = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    destroy: vi.fn(),
    off: vi.fn(),
    on: vi.fn((event: string, handler: (value: never) => void) => {
      handlers.set(event, handler as (value: unknown) => void);
    }),
    awareness: { setLocalState: vi.fn() },
    synced: false,
    sendMessage: vi.fn(),
  };
  return {
    api: vi.fn(),
    destroy: vi.fn(),
    handlers,
    provider,
    ready: Promise.resolve() as Promise<void>,
    slashItems: null as null | ((query: string) => Promise<Array<{ title: string; onItemClick: () => void }>>),
    unsynced: false,
  };
});

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: mocks.api,
}));

vi.mock("./collaboration", () => ({
  createCollaboration: vi.fn(() => ({
    doc: {
      getMap: vi.fn(() => new Map()),
      getXmlFragment: vi.fn(() => ({})),
    },
    provider: mocks.provider,
    ready: mocks.ready,
    get hasUnsyncedChanges() {
      return mocks.unsynced;
    },
    destroy: mocks.destroy,
  })),
  loadOfflineCopy: vi.fn(),
  userColor: vi.fn(() => "#2563eb"),
}));

vi.mock("@blocknote/core/comments", () => ({
  CommentsExtension: vi.fn(() => ({})),
  DefaultThreadStoreAuth: class {},
  ThreadStoreAuth: class {},
  ThreadStore: class {
    auth: unknown;
    constructor(auth: unknown) {
      this.auth = auth;
    }
  },
}));

vi.mock("@blocknote/core/yjs", () => ({
  withCollaboration: vi.fn((options) => options),
  YjsThreadStore: class {},
}));

vi.mock("@blocknote/mantine", () => ({
  BlockNoteView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@blocknote/react", () => ({
  getDefaultReactSlashMenuItems: () => [],
  SuggestionMenuController: ({
    getItems,
    triggerCharacter,
  }: {
    getItems: typeof mocks.slashItems;
    triggerCharacter: string;
  }) => {
    if (triggerCharacter === "/") mocks.slashItems = getItems;
    return null;
  },
  ThreadsSidebar: () => <div data-testid="thread-sidebar" />,
  useCreateBlockNote: () => ({ insertInlineContent: vi.fn() }),
}));

vi.mock("./BacklinksPanel", () => ({ BacklinksPanel: () => null }));
vi.mock("./editor-blocks", () => ({ editorBlockFactories: [] }));
vi.mock("./mentions", () => ({ notesSchema: {}, notesCommentSchema: {} }));

const page: Page = {
  id: "page-1",
  workspaceId: "workspace-1",
  spaceId: "workspace-1-general",
  parentId: null,
  kind: "document",
  position: "a0",
  title: "Page",
  icon: null,
  revision: 1,
  contentEpoch: 1,
  isTemplate: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const member: ClientMemberContext = {
  user: { id: "user-1", name: "Owner", email: "owner@example.test" },
  workspace: { id: "workspace-1", name: "Workspace", locationHint: null },
  role: "owner",
};

const storedValues = new Map<string, string>();
const storage = {
  clear: () => storedValues.clear(),
  getItem: (key: string) => storedValues.get(key) ?? null,
  removeItem: (key: string) => storedValues.delete(key),
  setItem: (key: string, value: string) => storedValues.set(key, value),
};

async function advanceRetry(milliseconds: number) {
  await act(async () => {
    vi.advanceTimersByTime(milliseconds);
    await Promise.resolve();
  });
}

describe("EditorPage close reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    mocks.api.mockReset();
    mocks.destroy.mockReset();
    mocks.handlers.clear();
    mocks.provider.connect.mockReset();
    mocks.provider.disconnect.mockReset();
    mocks.provider.on.mockClear();
    mocks.ready = Promise.resolve();
    mocks.slashItems = null;
    mocks.unsynced = false;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("continues metadata reconciliation after the initial retry budget", async () => {
    const unavailable = vi.fn();
    mocks.api.mockRejectedValue(new ApiClientError(503, "unavailable", "Unavailable"));
    render(
      <EditorPage
        page={page}
        member={member}
        onPageChanged={vi.fn()}
        onPageUnavailable={unavailable}
        onAccessDenied={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );

    const connectionClose = mocks.handlers.get("connection-close");
    expect(connectionClose).toBeTypeOf("function");
    await act(async () => {
      connectionClose!(new CloseEvent("close", { code: 4410 }));
      await Promise.resolve();
    });
    for (const delay of [1_000, 2_000, 4_000, 8_000]) await advanceRetry(delay);

    expect(mocks.api.mock.calls.filter(([path]) => path === "/api/pages/page-1")).toHaveLength(5);
    expect(mocks.provider.disconnect).toHaveBeenCalledOnce();
    expect(mocks.provider.connect).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();

    mocks.api.mockResolvedValue({ page });
    await advanceRetry(16_000);
    expect(mocks.provider.connect).not.toHaveBeenCalled();
    await advanceRetry(1_000);
    expect(mocks.provider.connect).toHaveBeenCalledOnce();
  });

  it("quarantines unsynced owner edits after the size limit makes the editor read-only", async () => {
    mocks.unsynced = true;
    mocks.api.mockResolvedValue({ page });
    render(
      <EditorPage
        page={page}
        member={member}
        onPageChanged={vi.fn()}
        onPageUnavailable={vi.fn()}
        onAccessDenied={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );

    const customMessage = mocks.handlers.get("custom-message");
    const connectionClose = mocks.handlers.get("connection-close");
    expect(customMessage).toBeTypeOf("function");
    expect(connectionClose).toBeTypeOf("function");
    await act(async () => {
      customMessage!(JSON.stringify({ type: "document-size", bytes: 20_000_000, readOnly: true }));
      connectionClose!(new CloseEvent("close", { code: 4410 }));
      await Promise.resolve();
    });

    expect(localStorage.getItem("notes:recovery:workspace-1:page-1")).toBe(
      JSON.stringify({ key: "workspace-1:page-1:1:1", epoch: 1 }),
    );
  });

  it("keeps the editor closed when offline storage is unavailable", async () => {
    vi.useRealTimers();
    mocks.ready = Promise.reject(new Error("IndexedDB unavailable"));

    render(
      <EditorPage
        page={page}
        member={member}
        onPageChanged={vi.fn()}
        onPageUnavailable={vi.fn()}
        onAccessDenied={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );
    expect(
      await screen.findByText(
        "Offline storage is unavailable, so editing and collaboration are disabled for this page.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Page title")).toHaveAttribute("readonly");
    expect(screen.queryByText("Opening your offline copy…")).not.toBeInTheDocument();
  });

  it("adds accessible names to comment editors generated by BlockNote", async () => {
    vi.useRealTimers();
    mocks.api.mockResolvedValue({ threads: [] });
    render(
      <EditorPage
        page={page}
        member={member}
        onPageChanged={vi.fn()}
        onPageUnavailable={vi.fn()}
        onAccessDenied={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Comments" }));
    screen
      .getByTestId("thread-sidebar")
      .insertAdjacentHTML("beforeend", '<div role="textbox" contenteditable="false"></div>');
    expect(await screen.findByRole("textbox", { name: "Comment content" })).toBeInTheDocument();
  });

  it.each([
    [new ApiClientError(422, "invalid_icon", "Choose one emoji."), "Choose one emoji."],
    [new Error("offline"), "The page icon could not be saved."],
  ])("reports page-icon PATCH failures without an unhandled rejection", async (failure, message) => {
    vi.useRealTimers();
    vi.spyOn(window, "prompt").mockReturnValue("🔥");
    mocks.api.mockRejectedValue(failure);
    render(
      <EditorPage
        page={page}
        member={member}
        onPageChanged={vi.fn()}
        onPageUnavailable={vi.fn()}
        onAccessDenied={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Page details" }));
    fireEvent.click(screen.getByRole("button", { name: "Add icon" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("keeps an editor error through an icon failure and successful retry", async () => {
    vi.useRealTimers();
    let iconAttempts = 0;
    vi.spyOn(window, "prompt").mockReturnValue("🔥");
    mocks.api.mockImplementation(async (path, init) => {
      if (path === "/api/pages" && init?.method === "POST")
        throw new ApiClientError(503, "unavailable", "The sub-page could not be created now.");
      if (path === `/api/pages/${page.id}` && init?.method === "PATCH") {
        iconAttempts += 1;
        if (iconAttempts === 1) throw new Error("offline");
        return { page: { ...page, icon: "🔥", revision: 2 } };
      }
      throw new Error(`Unexpected ${path}`);
    });
    render(
      <EditorPage
        page={page}
        member={member}
        onPageChanged={vi.fn()}
        onPageUnavailable={vi.fn()}
        onAccessDenied={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );
    await waitFor(() => expect(mocks.slashItems).toBeTypeOf("function"));
    const items = await mocks.slashItems!("");
    await act(async () => items.find((item) => item.title === "Sub-page")!.onItemClick());
    expect(await screen.findByText("The sub-page could not be created now.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Page details" }));
    fireEvent.click(screen.getByRole("button", { name: "Add icon" }));
    expect(await screen.findByText("The page icon could not be saved.")).toBeInTheDocument();
    expect(screen.getByText("The sub-page could not be created now.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Page details" }));
    fireEvent.click(screen.getByRole("button", { name: "Add icon" }));
    await waitFor(() => expect(screen.queryByText("The page icon could not be saved.")).not.toBeInTheDocument());
    expect(screen.getByText("The sub-page could not be created now.")).toBeInTheDocument();
  });
});
