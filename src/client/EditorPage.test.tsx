// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
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
}));

vi.mock("@blocknote/core/yjs", () => ({
  withCollaboration: vi.fn((options) => options),
  YjsThreadStore: class {},
}));

vi.mock("@blocknote/mantine", () => ({
  BlockNoteView: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@blocknote/react", () => ({
  SuggestionMenuController: () => null,
  ThreadsSidebar: () => null,
  useCreateBlockNote: () => ({ insertInlineContent: vi.fn() }),
}));

vi.mock("./BacklinksPanel", () => ({ BacklinksPanel: () => null }));
vi.mock("./mentions", () => ({ notesSchema: {} }));

const page: Page = {
  id: "page-1",
  workspaceId: "workspace-1",
  parentId: null,
  kind: "document",
  position: "a0",
  title: "Page",
  icon: null,
  revision: 1,
  contentEpoch: 1,
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
        onSessionExpired={vi.fn()}
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

    expect(mocks.api).toHaveBeenCalledTimes(5);
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
        onSessionExpired={vi.fn()}
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
    mocks.ready = Promise.reject(new Error("IndexedDB unavailable"));

    render(
      <EditorPage
        page={page}
        member={member}
        onPageChanged={vi.fn()}
        onPageUnavailable={vi.fn()}
        onAccessDenied={vi.fn()}
        onSessionExpired={vi.fn()}
        onSelectPage={vi.fn()}
        backlinksRevision={0}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      screen.getByText("Offline storage is unavailable, so editing and collaboration are disabled for this page."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Page title")).toHaveAttribute("readonly");
    expect(screen.queryByText("Opening your offline copy…")).not.toBeInTheDocument();
  });
});
