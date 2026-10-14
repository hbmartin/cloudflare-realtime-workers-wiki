// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiGenerate, AiStatus, AiStreamEvent } from "../shared/ai";
import { ApiClientError } from "./api";
import * as writingMarkdown from "../shared/ai-writing";
import { WritingPanel } from "./WritingPanel";
import { WritingSettings } from "./WritingSettings";
import { WritingPreview } from "./WritingPreview";
import type { WritingTarget } from "./writing-target";

const mocks = vi.hoisted(() => ({ api: vi.fn(), stream: vi.fn() }));
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: mocks.api }));
vi.mock("./writing-api", () => ({ streamWriting: mocks.stream }));
const target: WritingTarget = { kind: "page", epoch: 1, blocks: [], fromOffset: 0, toOffset: 0, text: "" };
const status: AiStatus = {
  settings: {
    enabled: true,
    apiEnabled: true,
    dailyQuota: 20,
    models: {
      chatgpt: { fast: { id: "chatgpt-fast", maxCharacters: 10000 }, best: { id: "", maxCharacters: 10000 } },
      api: { fast: { id: "api-fast", maxCharacters: 10000 }, best: { id: "api-best", maxCharacters: 10000 } },
    },
  },
  chatgptConfigured: true,
  apiConfigured: true,
  connected: true,
  accountLabel: "member@example.test",
  preference: null,
  quota: { remaining: 20, limit: 20, resetsAt: 1791676800000 },
};
const source = {
  pageId: "doc",
  title: "Current document",
  url: "https://example.test/?page=doc",
  kind: "document" as const,
  revision: 1,
  contentEpoch: 1,
  sequence: 1,
};
beforeEach(() => {
  mocks.api.mockReset();
  mocks.stream.mockReset();
  mocks.api.mockImplementation(async (path: string) => {
    if (path === "/api/ai/status") return status;
    if (path === "/api/pages/tree")
      return {
        pages: [
          { id: "doc", title: "Current document", kind: "document", contentEpoch: 1 },
          { id: "table", title: "Reference table", kind: "table", contentEpoch: 1 },
        ],
      };
    if (path.startsWith("/api/ai/models")) return { fast: true, best: !path.includes("chatgpt") };
    if (path.endsWith("apply-check")) return { contentEpoch: 1, protectedBlockIds: [] };
    if (path.includes("conversations"))
      return {
        conversation: {
          id: "11111111-1111-4111-8111-111111111111",
          pageId: "doc",
          locked: false,
          messages: [],
          sources: [{ pageId: "doc", scope: { kind: "page" } }],
        },
        conversations: [],
        nextCursor: null,
        locked: false,
      };
    return { ok: true };
  });
  mocks.stream.mockImplementation(
    async (_input: AiGenerate, _signal: AbortSignal, onEvent: (event: AiStreamEvent) => void) => {
      onEvent({
        type: "start",
        conversationId: "11111111-1111-4111-8111-111111111111",
        messageId: "message",
        sources: [source],
        changedPageIds: [],
        canApply: true,
        quota: { ...status.quota, remaining: 19 },
      });
      onEvent({ type: "delta", text: "# Improved writing\n\nClear **result**." });
      onEvent({ type: "complete" });
    },
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function panel(editable = true, ready = true, initialTarget = target) {
  const apply = vi.fn(),
    capture = vi.fn(() => target);
  const props = {
    pageId: "doc",
    initialTarget,
    onCapture: capture,
    onApply: apply,
    onClose: vi.fn(),
    editable,
    ready: () => ready,
  };
  const view = render(<WritingPanel {...props} />);
  return { apply, capture, props, ...view };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function savedConversation(output: string) {
  return {
    conversation: {
      id: "11111111-1111-4111-8111-111111111111",
      pageId: "doc",
      locked: false,
      messages: [
        {
          id: "message",
          action: "rewrite",
          prompt: "",
          output,
          status: "complete",
          funding: "api",
          quality: "fast",
          sources: [source],
          createdAt: 1,
        },
      ],
    },
  };
}
async function restoredPanel() {
  const view = panel();
  await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  await screen.findByRole("heading", { name: "Improved writing" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
  const original = mocks.api.getMockImplementation()!;
  const saved = savedConversation("# Improved writing\n\nClear **result**.");
  saved.conversation.messages.push({
    ...saved.conversation.messages[0]!,
    id: "failed-follow-up",
    status: "failed",
    output: "",
  });
  mocks.api.mockImplementation((path: string, options?: RequestInit) =>
    path === `/api/ai/conversations/${saved.conversation.id}` ||
    path === `/api/ai/conversations/${saved.conversation.id}/open`
      ? Promise.resolve(saved)
      : original(path, options),
  );
  mocks.stream.mockImplementation(
    async (_input: AiGenerate, _signal: AbortSignal, emit: (event: AiStreamEvent) => void) => {
      emit({
        type: "start",
        conversationId: saved.conversation.id,
        messageId: "failed-follow-up",
        sources: [source],
        changedPageIds: [],
        canApply: true,
        quota: status.quota,
      });
      emit({ type: "error", status: 503, code: "ai_provider_rejected", message: "Empty follow-up failed" });
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  await screen.findByText("Empty follow-up failed");
  const preview = () => view.container.querySelector('.writing-panel > [aria-label="Writing result"]');
  expect(preview()).toHaveTextContent("Improved writing");
  return { ...view, saved, original, preview };
}
async function completedPanel() {
  const original = mocks.api.getMockImplementation()!;
  const saved = savedConversation("# Improved writing\n\nClear **result**.");
  mocks.api.mockImplementation((path: string, options?: RequestInit) =>
    path === `/api/ai/conversations/${saved.conversation.id}` || path.endsWith("/open")
      ? Promise.resolve(saved)
      : original(path, options),
  );
  const view = panel();
  await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate" })));
  const preview = () => view.container.querySelector('.writing-panel > [aria-label="Writing result"]');
  expect(preview()).toHaveTextContent("Improved writing");
  return { ...view, saved, preview };
}
describe("writing UI", () => {
  it.each(["generation", "opening", "application", "stream"])(
    "reports one authentication alert for a failed %s",
    async (kind) => {
      const view = await completedPanel();
      const original = mocks.api.getMockImplementation()!;
      const failure = new ApiClientError(401, "challenge_required", "Sign in required");
      mocks.api.mockImplementation((path: string, options?: RequestInit) =>
        (kind === "opening" && path.endsWith("/open")) || (kind === "application" && path.endsWith("apply-check"))
          ? Promise.reject(failure)
          : original(path, options),
      );
      if (kind === "generation") mocks.stream.mockRejectedValueOnce(failure);
      if (kind === "stream")
        mocks.stream.mockImplementationOnce(
          async (_input: AiGenerate, _signal: AbortSignal, emit: (event: AiStreamEvent) => void) => {
            emit({
              type: "start",
              conversationId: view.saved.conversation.id,
              messageId: "revoked-stream",
              sources: [source],
              changedPageIds: [],
              canApply: true,
              quota: status.quota,
            });
            emit({ type: "error", status: 401, code: "challenge_required", message: "Sign in required" });
          },
        );
      await act(async () => {
        if (kind === "opening")
          view.rerender(
            <WritingPanel
              {...view.props}
              launchRequest={{ id: "denied", pageId: "doc", conversationId: view.saved.conversation.id }}
            />,
          );
        else
          fireEvent.click(
            screen.getByRole("button", { name: kind === "application" ? "Replace" : "Generate follow-up" }),
          );
      });
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.getByRole("alert")).toHaveTextContent("Sign in required");
      expect(view.preview()).toBeNull();
      expect(view.apply).not.toHaveBeenCalled();
    },
  );

  it.each(["focus", "reveal", "foreground"])(
    "preserves a discarded result through %s and polling",
    async (boundary) => {
      const view = await completedPanel();
      vi.useFakeTimers();
      await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
      await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      await act(async () => {
        if (boundary === "focus") fireEvent(window, new Event("focus"));
        else if (boundary === "reveal") view.rerender(<WritingPanel {...view.props} visible={false} />);
        else {
          vi.spyOn(document, "hidden", "get").mockReturnValue(true);
          fireEvent(document, new Event("visibilitychange"));
        }
      });
      if (boundary !== "focus")
        await act(async () => {
          if (boundary === "reveal") view.rerender(<WritingPanel {...view.props} visible />);
          else {
            vi.spyOn(document, "hidden", "get").mockReturnValue(false);
            fireEvent(document, new Event("visibilitychange"));
          }
        });
      await act(async () => vi.advanceTimersByTimeAsync(10000));
      expect(view.preview()).toBeNull();
      expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
      expect(screen.getByText("Conversation (1 requests)")).toBeVisible();
    },
  );

  it.each(["newer", "explicit", "fresh", "missing", "denial"])(
    "ends discard preservation after %s",
    async (boundary) => {
      const view = await completedPanel();
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      if (boundary === "newer")
        view.saved.conversation.messages.push({
          ...view.saved.conversation.messages[0]!,
          id: "newer",
          output: "New server result",
        });
      if (boundary === "missing") view.saved.conversation.messages = [];
      if (boundary === "denial") {
        const original = mocks.api.getMockImplementation()!;
        let denied = true;
        mocks.api.mockImplementation((path: string, options?: RequestInit) =>
          path.endsWith("/access")
            ? Promise.resolve({ locked: denied, activeGeneration: null })
            : original(path, options),
        );
        await act(async () => fireEvent(window, new Event("focus")));
        denied = false;
      }
      let preview = view.preview;
      if (boundary === "fresh") {
        view.unmount();
        const fresh = render(
          <WritingPanel
            {...view.props}
            launchRequest={{ id: "fresh", pageId: "doc", conversationId: view.saved.conversation.id }}
          />,
        );
        preview = () => fresh.container.querySelector('.writing-panel > [aria-label="Writing result"]');
      } else {
        await act(async () => {
          if (boundary === "explicit")
            view.rerender(
              <WritingPanel
                {...view.props}
                launchRequest={{ id: "opened", pageId: "doc", conversationId: view.saved.conversation.id }}
              />,
            );
          else fireEvent(window, new Event("focus"));
        });
      }
      const expected = boundary === "missing" ? /^$/ : boundary === "newer" ? /New server result/ : /Improved writing/;
      await waitFor(() => expect(preview()?.textContent ?? "").toMatch(expected));
      if (boundary === "missing") {
        view.saved.conversation.messages = savedConversation("Recreated saved result").conversation.messages;
        await act(async () => fireEvent(window, new Event("focus")));
      }
      expect(preview()?.textContent ?? "").toMatch(boundary === "missing" ? /Recreated saved result/ : expected);
    },
  );

  it("preserves discard after a pre-start failure and releases it on the next stream start", async () => {
    const view = await completedPanel();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    mocks.stream.mockRejectedValueOnce(new Error("Dispatch failed"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
    await act(async () => fireEvent(window, new Event("focus")));
    expect(view.preview()).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
    expect(view.preview()).toHaveTextContent("Improved writing");
    await act(async () => fireEvent(window, new Event("focus")));
    expect(view.preview()).toHaveTextContent("Improved writing");
  });

  it.each(["focus", "reveal", "foreground"])(
    "keeps selection identity after an empty started failure and %s",
    async (boundary) => {
      const initialTarget: WritingTarget = {
        ...target,
        kind: "selection",
        text: "Selected words",
        blocks: [{ id: "block", fingerprint: "saved" }],
      };
      const original = mocks.api.getMockImplementation()!;
      const saved = savedConversation("");
      saved.conversation.messages[0]!.status = "failed";
      mocks.api.mockImplementation((path: string, options?: RequestInit) =>
        path === `/api/ai/conversations/${saved.conversation.id}` ? Promise.resolve(saved) : original(path, options),
      );
      mocks.stream.mockImplementationOnce(
        async (_input: AiGenerate, _signal: AbortSignal, emit: (event: AiStreamEvent) => void) => {
          emit({
            type: "start",
            conversationId: saved.conversation.id,
            messageId: "message",
            sources: [source],
            changedPageIds: [],
            canApply: true,
            quota: status.quota,
          });
          emit({ type: "error", status: 503, code: "ai_provider_rejected", message: "Empty first failure" });
        },
      );
      const view = panel(true, true, initialTarget);
      await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate" })));
      await act(async () => {
        if (boundary === "focus") fireEvent(window, new Event("focus"));
        else if (boundary === "reveal") view.rerender(<WritingPanel {...view.props} visible={false} />);
        else {
          vi.spyOn(document, "hidden", "get").mockReturnValue(true);
          fireEvent(document, new Event("visibilitychange"));
        }
      });
      if (boundary !== "focus")
        await act(async () => {
          if (boundary === "reveal") view.rerender(<WritingPanel {...view.props} visible />);
          else {
            vi.spyOn(document, "hidden", "get").mockReturnValue(false);
            fireEvent(document, new Event("visibilitychange"));
          }
        });
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
      expect(view.capture).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Replace" })));
      expect(view.apply).toHaveBeenCalledWith(
        initialTarget,
        "# Improved writing\n\nClear **result**.",
        "replace",
        1,
        new Set(),
      );
    },
  );

  it.each(
    ["generate", "apply"].flatMap((operation) =>
      ["focus", "reveal", "foreground"].map((boundary) => ({ operation, boundary })),
    ),
  )("defers $boundary history verification until $operation finishes", async ({ operation, boundary }) => {
    const view = await completedPanel();
    vi.useFakeTimers();
    await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
    await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    const original = mocks.api.getMockImplementation()!;
    const done = deferred<{ contentEpoch: number; protectedBlockIds: string[] }>();
    let reads = 0,
      emit!: (event: AiStreamEvent) => void;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path === `/api/ai/conversations/${view.saved.conversation.id}`) reads++;
      return path.endsWith("apply-check") ? done.promise : original(path, options);
    });
    mocks.stream.mockImplementationOnce(
      async (_input: AiGenerate, _signal: AbortSignal, onEvent: (event: AiStreamEvent) => void) => {
        emit = onEvent;
        emit({
          type: "start",
          conversationId: view.saved.conversation.id,
          messageId: "busy",
          sources: [source],
          changedPageIds: [],
          canApply: true,
          quota: status.quota,
        });
        emit({ type: "delta", text: "Busy result" });
        await done.promise;
      },
    );
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: operation === "generate" ? "Generate follow-up" : "Replace" }),
      ),
    );
    await act(async () => {
      if (boundary === "focus") fireEvent(window, new Event("focus"));
      else if (boundary === "reveal") view.rerender(<WritingPanel {...view.props} visible={false} />);
      else {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        fireEvent(document, new Event("visibilitychange"));
      }
    });
    if (boundary !== "focus")
      await act(async () => {
        if (boundary === "reveal") view.rerender(<WritingPanel {...view.props} visible />);
        else {
          vi.spyOn(document, "hidden", "get").mockReturnValue(false);
          fireEvent(document, new Event("visibilitychange"));
        }
      });
    expect(screen.queryByText("Checking conversation access…")).toBeNull();
    expect(reads).toBe(0);
    await act(async () => {
      if (operation === "generate") {
        view.saved.conversation.messages.push({
          ...view.saved.conversation.messages[0]!,
          id: "busy",
          output: "Busy result",
        });
        emit({ type: "complete" });
      }
      done.resolve({ contentEpoch: 1, protectedBlockIds: [] });
    });
    expect(reads).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(reads).toBe(1);
    expect(view.preview()).toBeNull();
  });
  it.each(["locked", "missing"])(
    "ignores an old %s access response while a newer opening owns the gate",
    async (failure) => {
      const view = await restoredPanel();
      const original = mocks.api.getMockImplementation()!;
      const oldAccess = deferred<unknown>(),
        opened = deferred<unknown>();
      let accessReads = 0;
      mocks.api.mockImplementation((path: string, options?: RequestInit) => {
        if (path === "/api/ai/conversations/new-conversation/open") return opened.promise;
        if (path.endsWith("/access")) {
          accessReads++;
          return path.includes("new-conversation")
            ? Promise.resolve({ locked: false, activeGeneration: null })
            : oldAccess.promise;
        }
        return original(path, options);
      });
      fireEvent(window, new Event("focus"));
      await act(async () =>
        view.rerender(
          <WritingPanel
            {...view.props}
            launchRequest={{ id: "new-launch", pageId: "doc", conversationId: "new-conversation" }}
          />,
        ),
      );
      fireEvent(window, new Event("focus"));
      expect(accessReads).toBe(1);
      await act(async () =>
        failure === "locked"
          ? oldAccess.resolve({ locked: true, activeGeneration: null })
          : oldAccess.reject(new ApiClientError(404, "conversation_not_found", "Old conversation missing")),
      );
      expect(screen.getByText("Checking conversation access…")).toBeVisible();
      expect(screen.queryByText(/conversation is locked/)).toBeNull();
      await act(async () =>
        opened.resolve({
          conversation: { ...savedConversation("New selected draft").conversation, id: "new-conversation" },
        }),
      );
      expect(view.preview()).toHaveTextContent("New selected draft");
      expect(screen.queryByText("Checking conversation access…")).toBeNull();
    },
  );
  it("keeps a newer opening pending when a superseded opening completes", async () => {
    const view = await restoredPanel();
    const original = mocks.api.getMockImplementation()!;
    const first = deferred<unknown>(),
      second = deferred<unknown>();
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path.endsWith("/first/open")
        ? first.promise
        : path.endsWith("/second/open")
          ? second.promise
          : original(path, options),
    );
    await act(async () =>
      view.rerender(
        <WritingPanel {...view.props} launchRequest={{ id: "first", pageId: "doc", conversationId: "first" }} />,
      ),
    );
    await act(async () =>
      view.rerender(
        <WritingPanel {...view.props} launchRequest={{ id: "second", pageId: "doc", conversationId: "second" }} />,
      ),
    );
    await act(async () =>
      first.resolve({ conversation: { ...savedConversation("Obsolete draft").conversation, id: "first" } }),
    );
    expect(screen.getByText("Checking conversation access…")).toBeVisible();
    await act(async () =>
      second.resolve({ conversation: { ...savedConversation("Selected draft").conversation, id: "second" } }),
    );
    expect(view.preview()).toHaveTextContent("Selected draft");
    expect(screen.queryByText("Obsolete draft")).toBeNull();
  });
  it("resumes the prior monitor after an explicit opening fails", async () => {
    const view = await restoredPanel();
    const original = mocks.api.getMockImplementation()!;
    const opened = deferred<unknown>();
    let accesses = 0;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path.endsWith("/new/open")) return opened.promise;
      if (path.endsWith("/access")) {
        accesses++;
        return Promise.resolve({ locked: false, activeGeneration: null });
      }
      return original(path, options);
    });
    await act(async () =>
      view.rerender(
        <WritingPanel {...view.props} launchRequest={{ id: "new", pageId: "doc", conversationId: "new" }} />,
      ),
    );
    fireEvent(window, new Event("focus"));
    expect(accesses).toBe(0);
    await act(async () => opened.reject(new TypeError("Opening unavailable")));
    expect(screen.getByText("The conversation could not be opened.")).toBeVisible();
    await act(async () => fireEvent(window, new Event("focus")));
    expect(accesses).toBe(1);
    expect(screen.queryByText("Checking conversation access…")).toBeNull();
  });
  it.each(["before-start", "remote-cancel"])(
    "keeps a recovered draft and application identity after %s",
    async (failure) => {
      const view = await restoredPanel();
      if (failure === "before-start") mocks.stream.mockRejectedValueOnce(new Error("Dispatch failed"));
      else {
        view.saved.conversation.messages.at(-1)!.status = "cancelled";
        mocks.stream.mockImplementationOnce(
          async (_input: AiGenerate, _signal: AbortSignal, emit: (event: AiStreamEvent) => void) => {
            emit({
              type: "start",
              conversationId: view.saved.conversation.id,
              messageId: "failed-follow-up",
              sources: [source],
              changedPageIds: [],
              canApply: true,
              quota: status.quota,
            });
            emit({ type: "error", code: "ai_stream_failed", status: 409, message: "Generation cancelled" });
          },
        );
      }
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Regenerate" })));
      await act(async () => fireEvent(window, new Event("focus")));
      expect(view.preview()).toHaveTextContent("Improved writing");
      expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Replace" })));
      expect(view.apply).toHaveBeenCalledWith(
        target,
        "# Improved writing\n\nClear **result**.",
        "replace",
        1,
        new Set(),
      );
      expect(mocks.api).toHaveBeenCalledWith("/api/ai/results/message/apply-check", expect.anything());
    },
  );
  it("releases an access request that finishes after generation changes the content revision", async () => {
    vi.useFakeTimers();
    const original = mocks.api.getMockImplementation()!;
    const saved = savedConversation("Saved draft"),
      access = deferred<unknown>();
    let accesses = 0;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path.endsWith("/access")) return ++accesses === 1 ? Promise.reject(new Error("Unverified")) : access.promise;
      return path.endsWith("/open") ? Promise.resolve(saved) : original(path, options);
    });
    const view = panel();
    await act(async () =>
      view.rerender(
        <WritingPanel
          {...view.props}
          launchRequest={{ id: "saved", pageId: "doc", conversationId: saved.conversation.id }}
        />,
      ),
    );
    expect(screen.getByRole("button", { name: "Retry conversation access" })).toBeEnabled();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    mocks.stream.mockRejectedValueOnce(new Error("Dispatch failed"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Regenerate" })));
    await act(async () => access.reject(new Error("Still unverified")));
    expect(screen.getByRole("button", { name: "Retry conversation access" })).toBeEnabled();
  });
  it("keeps a failed background reload gated and retries it on the next poll", async () => {
    const view = await restoredPanel();
    const original = mocks.api.getMockImplementation()!;
    let reads = 0;
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path === `/api/ai/conversations/${view.saved.conversation.id}` && ++reads === 1
        ? Promise.reject(new TypeError("History unavailable"))
        : original(path, options),
    );
    vi.useFakeTimers();
    view.rerender(<WritingPanel {...view.props} visible={false} />);
    await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    expect(screen.getByText("Conversation access is unverified.")).toBeVisible();
    expect(view.preview()).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(view.preview()).toHaveTextContent("Improved writing");
    expect(reads).toBe(2);
  });
  it("retries remote-completion reload failures on ordinary polls until saved output is refreshed", async () => {
    vi.useFakeTimers();
    const original = mocks.api.getMockImplementation()!;
    const saved = savedConversation("Saved partial"),
      path = `/api/ai/conversations/${saved.conversation.id}`;
    let active = true,
      reads = 0;
    mocks.api.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === `${path}/access`)
        return {
          locked: false,
          activeGeneration: active ? { messageId: "message", createdAt: 1, deadlineAt: 330001 } : null,
        };
      if (url === path || url === `${path}/open`) {
        if (url === path && ++reads <= 2) throw new TypeError("History unavailable");
        return {
          conversation: {
            ...saved.conversation,
            messages: [
              {
                ...saved.conversation.messages[0],
                status: active ? "running" : "complete",
                output: active ? "Saved partial" : "Completed remotely",
              },
            ],
          },
        };
      }
      return original(url, options);
    });
    let view!: ReturnType<typeof panel>;
    await act(async () => {
      view = panel();
    });
    await act(async () =>
      view.rerender(
        <WritingPanel
          {...view.props}
          launchRequest={{ id: "remote", pageId: "doc", conversationId: saved.conversation.id }}
        />,
      ),
    );
    const preview = () => view.container.querySelector('.writing-panel > [aria-label="Writing result"]');
    expect(preview()).toHaveTextContent("Saved partial");
    active = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(reads).toBe(attempt);
      expect(screen.getByText("Conversation access is unverified.")).toBeVisible();
      expect(preview()).toBeNull();
    }
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(3);
    expect(preview()).toHaveTextContent("Completed remotely");
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(3);
  });
  it.each(["locked", "missing"])("honors an in-flight %s denial across generation", async (failure) => {
    const view = await restoredPanel();
    vi.useFakeTimers();
    await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
    await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    const original = mocks.api.getMockImplementation()!;
    const access = deferred<unknown>();
    let signal!: AbortSignal;
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path.endsWith("/access") ? access.promise : original(path, options),
    );
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    mocks.stream.mockImplementationOnce(
      async (_input: AiGenerate, abort: AbortSignal, emit: (event: AiStreamEvent) => void) => {
        signal = abort;
        emit({
          type: "start",
          conversationId: view.saved.conversation.id,
          messageId: "retry",
          sources: [source],
          changedPageIds: [],
          canApply: true,
          quota: status.quota,
        });
        await new Promise<void>((resolve) => abort.addEventListener("abort", () => resolve(), { once: true }));
      },
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Regenerate" })));
    await act(async () =>
      failure === "locked"
        ? access.resolve({ locked: true, activeGeneration: null })
        : access.reject(new ApiClientError(404, "conversation_not_found", "Missing")),
    );
    expect(signal.aborted).toBe(true);
    expect(view.preview()).toBeNull();
    expect(screen.queryByText("Checking conversation access…")).toBeNull();
  });
  it("keeps a replacement monitor pending after the disposed monitor settles", async () => {
    const view = await restoredPanel();
    const original = mocks.api.getMockImplementation()!;
    const old = deferred<unknown>(),
      current = deferred<unknown>();
    let reads = 0;
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path.endsWith("/access") ? (++reads === 1 ? old.promise : current.promise) : original(path, options),
    );
    await act(async () => fireEvent(window, new Event("focus")));
    await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
    await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    await act(async () => old.resolve({ locked: true, activeGeneration: null }));
    expect(screen.getByText("Checking conversation access…")).toBeVisible();
    expect(screen.getByRole("button", { name: "New conversation" })).toBeDisabled();
    await act(async () => current.resolve({ locked: false, activeGeneration: null }));
    expect(view.preview()).toHaveTextContent("Improved writing");
    expect(screen.getByRole("button", { name: "New conversation" })).toBeEnabled();
  });
  it.each([401, 404, 403])("handles a classified history denial %i without a stale retry alert", async (code) => {
    const view = await restoredPanel();
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path === `/api/ai/conversations/${view.saved.conversation.id}`
        ? Promise.reject(
            new ApiClientError(
              code,
              code === 404 ? "conversation_not_found" : code === 403 ? "conversation_locked" : "challenge_required",
              "Classified denial",
            ),
          )
        : original(path, options),
    );
    await act(async () => fireEvent(window, new Event("focus")));
    expect(screen.queryByText("Conversation access is unverified.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry conversation access" }) !== null).toBe(code === 401);
    expect(screen.queryAllByRole("alert").some((alert) => alert.textContent === "Classified denial")).toBe(
      code === 401,
    );
  });
  it("retains history search and loaded depth while revalidating after a focus check", async () => {
    const view = await restoredPanel();
    const original = mocks.api.getMockImplementation()!;
    const access = deferred<unknown>();
    const item = (id: string) => ({
      ...view.saved.conversation,
      id,
      title: `History ${id}`,
      expiresAt: Date.now() + 86400000,
    });
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path.endsWith("/access")) return access.promise;
      if (path.startsWith("/api/ai/conversations?"))
        return Promise.resolve(
          path.includes("cursor=")
            ? { conversations: [item("second")], nextCursor: "third" }
            : { conversations: [item("first")], nextCursor: "second" },
        );
      return original(path, options);
    });
    fireEvent.click(screen.getByRole("button", { name: "Document writing history" }));
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "retained search" } });
    await screen.findByRole("button", { name: "History first" });
    fireEvent.click(screen.getByRole("button", { name: "Load more conversations" }));
    await screen.findByRole("button", { name: "History second" });
    const reads = mocks.api.mock.calls.filter(([path]) => String(path).startsWith("/api/ai/conversations?")).length;
    fireEvent(window, new Event("focus"));
    expect(screen.queryByRole("searchbox")).toBeNull();
    await act(async () => access.resolve({ locked: false, activeGeneration: null }));
    expect(screen.getByRole("searchbox")).toBe(search);
    expect(search).toHaveValue("retained search");
    expect(screen.getByRole("button", { name: "History second" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more conversations" })).toBeEnabled());
    expect(mocks.api.mock.calls.filter(([path]) => String(path).startsWith("/api/ai/conversations?")).length).toBe(
      reads + 2,
    );
  });
  it.each([-600000, 600000])("uses server reset timing with client skew %i and a later clock change", async (skew) => {
    vi.useFakeTimers();
    const original = mocks.api.getMockImplementation()!;
    const clientNow = Date.now(),
      serverNow = clientNow - skew,
      began = performance.now(),
      reset = serverNow + 1000;
    let reads = 0;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path !== "/api/ai/status") return original(path, options);
      reads++;
      const checkedAt = serverNow + performance.now() - began;
      return Promise.resolve({
        ...status,
        preference: "api",
        quota: {
          ...status.quota,
          checkedAt,
          resetsAt: checkedAt < reset ? reset : reset + 86400000,
          remaining: checkedAt < reset ? 0 : 20,
        },
      });
    });
    await act(async () => panel());
    expect(reads).toBe(1);
    vi.setSystemTime(clientNow + 3600000);
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(reads).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(reads).toBe(2);
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
  });
  it.each(["active", "completed"])(
    "keeps newer stream quota when an earlier status refresh resolves after generation is %s",
    async (phase) => {
      vi.useFakeTimers();
      const original = mocks.api.getMockImplementation()!,
        now = Date.now(),
        older = deferred<AiStatus>(),
        fresh = deferred<AiStatus>(),
        done = deferred<void>();
      let reads = 0;
      mocks.api.mockImplementation((path: string, options?: RequestInit) => {
        if (path !== "/api/ai/status") return original(path, options);
        if (++reads === 2) return older.promise;
        if (reads === 3) return fresh.promise;
        return Promise.resolve({
          ...status,
          preference: "api",
          quota: {
            ...status.quota,
            remaining: reads === 1 ? 1 : 20,
            checkedAt: Date.now(),
            resetsAt: reads === 1 ? now + 1000 : Date.now() + 86400000,
          },
        });
      });
      mocks.stream.mockImplementationOnce(
        async (_input: AiGenerate, _signal: AbortSignal, emit: (event: AiStreamEvent) => void) => {
          emit({
            type: "start",
            conversationId: "11111111-1111-4111-8111-111111111111",
            messageId: "last-allowed",
            sources: [source],
            changedPageIds: [],
            canApply: true,
            quota: { ...status.quota, remaining: 0, checkedAt: Date.now(), resetsAt: now + 1000 },
          });
          emit({ type: "delta", text: "Last allowed result" });
          await done.promise;
          emit({ type: "complete" });
        },
      );
      await act(async () => panel());
      await act(async () => fireEvent(window, new Event("focus")));
      await act(async () => vi.advanceTimersByTimeAsync(200));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate" })));
      if (phase === "completed") await act(async () => done.resolve());
      await act(async () => vi.advanceTimersByTimeAsync(400));
      await act(async () =>
        older.resolve({
          ...status,
          connected: false,
          quota: { ...status.quota, remaining: 1, checkedAt: now, resetsAt: now + 1000 },
        }),
      );
      expect(screen.getByText(/^0 of 20 API requests remaining/)).toBeVisible();
      expect(screen.getByRole("radio", { name: "ChatGPT plan" })).toBeDisabled();
      expect(
        screen.getByRole("button", { name: phase === "completed" ? "Generate" : "Cancel generation" }),
      ).toHaveProperty("disabled", phase === "completed");
      expect(reads).toBe(phase === "completed" ? 3 : 2);
      await act(async () => vi.advanceTimersByTimeAsync(399));
      expect(reads).toBe(phase === "completed" ? 3 : 2);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(reads).toBe(3);
      await act(async () =>
        fresh.resolve({
          ...status,
          quota: { ...status.quota, remaining: 20, checkedAt: Date.now(), resetsAt: Date.now() + 86400000 },
        }),
      );
      expect(screen.getByText(/^20 of 20 API requests remaining/)).toBeVisible();
      await act(async () => done.resolve());
    },
  );
  it("keeps a newer status quota when an older generation start arrives later", async () => {
    const original = mocks.api.getMockImplementation()!,
      now = Date.now(),
      start = deferred<void>(),
      done = deferred<void>();
    let reads = 0;
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path === "/api/ai/status"
        ? Promise.resolve({
            ...status,
            preference: "api",
            quota: {
              ...status.quota,
              remaining: ++reads === 1 ? 1 : 0,
              checkedAt: now + reads * 1000,
              resetsAt: now + 86400000,
            },
          })
        : original(path, options),
    );
    mocks.stream.mockImplementationOnce(
      async (_input: AiGenerate, _signal: AbortSignal, emit: (event: AiStreamEvent) => void) => {
        await start.promise;
        emit({
          type: "start",
          conversationId: "11111111-1111-4111-8111-111111111111",
          messageId: "late-start",
          sources: [source],
          changedPageIds: [],
          canApply: true,
          quota: { ...status.quota, remaining: 1, checkedAt: now + 1500, resetsAt: now + 86400000 },
        });
        await done.promise;
        emit({ type: "complete" });
      },
    );
    const view = panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate" })));
    await act(async () => fireEvent(window, new Event("focus")));
    await act(async () => start.resolve());
    expect(screen.getByText(/^0 of 20 API requests remaining/)).toBeVisible();
    await act(async () => done.resolve());
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    view.unmount();
  });
  it.each([
    { existing: 1000, incoming: 1000 },
    { existing: 1000, incoming: undefined },
    { existing: undefined, incoming: 1000 },
    { existing: undefined, incoming: undefined },
  ])("accepts equal or legacy quota timestamps $existing → $incoming", async ({ existing, incoming }) => {
    vi.useFakeTimers();
    const original = mocks.api.getMockImplementation()!,
      now = Date.now();
    let reads = 0;
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path === "/api/ai/status"
        ? Promise.resolve({
            ...status,
            preference: "api",
            quota: {
              ...status.quota,
              remaining: ++reads === 1 ? 1 : 0,
              checkedAt:
                (reads === 1 ? existing : incoming) === undefined
                  ? undefined
                  : now + (reads === 1 ? existing! : incoming!),
              resetsAt: now + 86400000,
            },
          })
        : original(path, options),
    );
    await act(async () => panel());
    await act(async () => fireEvent(window, new Event("focus")));
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    expect(screen.getByText(/^0 of 20 API requests remaining/)).toBeVisible();
    expect(reads).toBe(2);
  });
  it.each(["legacy", "server", "changing-legacy", "changing-server", "failure"])(
    "backs off unchanged overdue %s quota responses and resets after recovery",
    async (clock) => {
      vi.useFakeTimers();
      const original = mocks.api.getMockImplementation()!;
      const now = Date.now();
      let reads = 0,
        recovered = false;
      mocks.api.mockImplementation((path: string, options?: RequestInit) => {
        if (path !== "/api/ai/status") return original(path, options);
        reads++;
        if (clock === "failure" && reads > 1 && !recovered) return Promise.reject(new TypeError("Offline"));
        return Promise.resolve({
          ...status,
          preference: "api",
          quota: {
            ...status.quota,
            remaining: recovered ? 20 : 0,
            resetsAt: recovered ? Date.now() + 86400000 : (clock.startsWith("changing-") ? Date.now() : now) - 1000,
            ...(clock.endsWith("server") ? { checkedAt: Date.now() } : {}),
          },
        });
      });
      await act(async () => panel());
      expect(reads).toBe(2);
      for (const delay of [5000, 15000, 60000, 300000, 300000]) {
        const before = reads;
        await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
        expect(reads).toBe(before);
        await act(async () => vi.advanceTimersByTimeAsync(1));
        expect(reads).toBe(before + 1);
      }
      recovered = true;
      await act(async () => fireEvent(window, new Event("focus")));
      expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
      const before = reads;
      await act(async () => vi.advanceTimersByTimeAsync(300000));
      expect(reads).toBe(before);
    },
  );
  it("does no quota polling under ChatGPT and refreshes when switching to API", async () => {
    vi.useFakeTimers();
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path === "/api/ai/status"
        ? Promise.resolve({ ...status, quota: { ...status.quota, resetsAt: Date.now() - 1000 } })
        : original(path, options),
    );
    await act(async () => panel());
    const reads = () => mocks.api.mock.calls.filter(([path]) => path === "/api/ai/status").length;
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    fireEvent(window, new Event("focus"));
    expect(reads()).toBe(1);
    await act(async () => fireEvent.click(screen.getByRole("radio", { name: "Workspace API" })));
    expect(reads()).toBe(2);
    expect(screen.getByRole("radio", { name: "Workspace API" })).toBeChecked();
  });
  it("retries failed focus refreshes before a previously future reset", async () => {
    vi.useFakeTimers();
    const original = mocks.api.getMockImplementation()!;
    let reads = 0;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path !== "/api/ai/status") return original(path, options);
      if (++reads > 1) return Promise.reject(new TypeError("Status unavailable"));
      return Promise.resolve({
        ...status,
        preference: "api",
        quota: { ...status.quota, checkedAt: Date.now(), resetsAt: Date.now() + 86400000 },
      });
    });
    await act(async () => panel());
    await act(async () => fireEvent(window, new Event("focus")));
    expect(reads).toBe(2);
    for (const delay of [5000, 15000, 60000, 300000]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
      const before = reads;
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(reads).toBe(before + 1);
    }
  });
  it.each(["reveal", "foreground", "reconnect"])(
    "refreshes quota after %s and coalesces overlapping focus without changing funding",
    async (boundary) => {
      vi.useFakeTimers();
      const original = mocks.api.getMockImplementation()!;
      const fresh = deferred<AiStatus>();
      let reads = 0;
      mocks.api.mockImplementation((path: string, options?: RequestInit) => {
        if (path !== "/api/ai/status") return original(path, options);
        if (++reads > 1) return fresh.promise;
        return Promise.resolve({
          ...status,
          preference: "api",
          quota: { ...status.quota, remaining: 0, checkedAt: Date.now(), resetsAt: Date.now() + 1000 },
        });
      });
      let view!: ReturnType<typeof panel>;
      await act(async () => {
        view = panel();
      });
      await act(async () => {
        if (boundary === "reveal") view.rerender(<WritingPanel {...view.props} visible={false} />);
        else if (boundary === "foreground") {
          vi.spyOn(document, "hidden", "get").mockReturnValue(true);
          fireEvent(document, new Event("visibilitychange"));
        } else {
          vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
          fireEvent(window, new Event("offline"));
        }
      });
      await act(async () => vi.advanceTimersByTimeAsync(60000));
      expect(reads).toBe(1);
      await act(async () => {
        if (boundary === "reveal") view.rerender(<WritingPanel {...view.props} visible />);
        else if (boundary === "foreground") {
          vi.spyOn(document, "hidden", "get").mockReturnValue(false);
          fireEvent(document, new Event("visibilitychange"));
        } else {
          vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
          fireEvent(window, new Event("online"));
        }
        fireEvent(window, new Event("focus"));
      });
      expect(reads).toBe(2);
      await act(async () =>
        fresh.resolve({
          ...status,
          preference: "chatgpt",
          quota: { ...status.quota, checkedAt: Date.now(), resetsAt: Date.now() + 86400000 },
        }),
      );
      expect(screen.getByRole("radio", { name: "Workspace API" })).toBeChecked();
      expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
      await act(async () => vi.advanceTimersByTimeAsync(300000));
      expect(reads).toBe(2);
    },
  );

  it.each(["focus", "reveal", "foreground"])(
    "preserves a restored draft and its application identity after %s",
    async (boundary) => {
      const view = await restoredPanel();
      await act(async () => {
        if (boundary === "focus") fireEvent(window, new Event("focus"));
        else if (boundary === "reveal") view.rerender(<WritingPanel {...view.props} visible={false} />);
        else {
          vi.spyOn(document, "hidden", "get").mockReturnValue(true);
          fireEvent(document, new Event("visibilitychange"));
        }
      });
      if (boundary !== "focus")
        await act(async () => {
          if (boundary === "reveal") view.rerender(<WritingPanel {...view.props} visible />);
          else {
            vi.spyOn(document, "hidden", "get").mockReturnValue(false);
            fireEvent(document, new Event("visibilitychange"));
          }
        });
      expect(view.preview()).toHaveTextContent("Improved writing");
      expect(screen.getByText("Conversation (2 requests)")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("# Improved writing\n\nClear **result**.");
      fireEvent.click(screen.getByRole("button", { name: "Replace" }));
      await waitFor(() =>
        expect(view.apply).toHaveBeenCalledWith(
          target,
          "# Improved writing\n\nClear **result**.",
          "replace",
          1,
          new Set(),
        ),
      );
      expect(mocks.api).toHaveBeenCalledWith("/api/ai/results/message/apply-check", expect.anything());
    },
  );
  it.each(["newer", "changed", "missing", "explicit", "discard", "denial"])(
    "invalidates restored-draft preservation on %s",
    async (reason) => {
      const view = await restoredPanel();
      if (reason === "newer")
        view.saved.conversation.messages.push({
          ...view.saved.conversation.messages[0]!,
          id: "newer",
          output: "Newer server draft",
        });
      if (reason === "changed") view.saved.conversation.messages[0]!.output = "Changed saved draft";
      if (reason === "missing") view.saved.conversation.messages.shift();
      if (reason === "denial") {
        const original = mocks.api.getMockImplementation()!;
        mocks.api.mockImplementation((path: string, options?: RequestInit) =>
          path.endsWith("/access")
            ? Promise.resolve({ locked: true, activeGeneration: null })
            : original(path, options),
        );
      }
      if (reason === "discard") fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      await act(async () => {
        if (reason === "explicit")
          view.rerender(
            <WritingPanel
              {...view.props}
              launchRequest={{ id: "explicit", pageId: "doc", conversationId: view.saved.conversation.id }}
            />,
          );
        else fireEvent(window, new Event("focus"));
      });
      expect(view.preview()?.textContent ?? null).toBe(reason === "newer" ? "Newer server draft" : null);
      const replace = screen.queryByRole<HTMLButtonElement>("button", { name: "Replace" });
      expect(replace === null || replace.disabled).toBe(true);
      expect(view.apply).not.toHaveBeenCalled();
    },
  );
  it("replaces a restored draft when a new generation succeeds", async () => {
    const view = await restoredPanel();
    mocks.stream.mockImplementation(
      async (_input: AiGenerate, _signal: AbortSignal, emit: (event: AiStreamEvent) => void) => {
        emit({
          type: "start",
          conversationId: view.saved.conversation.id,
          messageId: "new-generation",
          sources: [source],
          changedPageIds: [],
          canApply: true,
          quota: status.quota,
        });
        emit({ type: "delta", text: "New generated draft" });
        emit({ type: "complete" });
      },
    );
    view.saved.conversation.messages.push({
      ...view.saved.conversation.messages[0]!,
      id: "new-generation",
      output: "New generated draft",
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" }));
    await waitFor(() => expect(view.preview()).toHaveTextContent("New generated draft"));
    await act(async () => fireEvent(window, new Event("focus")));
    expect(view.preview()).toHaveTextContent("New generated draft");
  });
  it("invalidates a restored draft when the immediate post-failure history read returns a newer message", async () => {
    const view = await restoredPanel();
    view.saved.conversation.messages.push({
      ...view.saved.conversation.messages[0]!,
      id: "newer",
      output: "Newer server draft",
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" }));
    await waitFor(() => expect(view.preview()).toHaveTextContent("Newer server draft"));
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
    expect(view.apply).not.toHaveBeenCalled();
  });
  it("opens the latest failed message in a fresh panel rather than restoring an earlier draft", async () => {
    const view = await restoredPanel();
    view.unmount();
    const fresh = render(
      <WritingPanel
        {...view.props}
        launchRequest={{ id: "fresh", pageId: "doc", conversationId: view.saved.conversation.id }}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Saved result opened/)).toBeVisible());
    expect(fresh.container.querySelector('.writing-panel > [aria-label="Writing result"]')).toBeNull();
  });
  it("does not re-gate an authenticated saved opening while the monitoring read is pending", async () => {
    const original = mocks.api.getMockImplementation()!;
    const access = deferred<unknown>();
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path.endsWith("/open")
        ? Promise.resolve(savedConversation("Saved draft"))
        : path.endsWith("/access")
          ? access.promise
          : original(path, options),
    );
    const view = panel();
    view.rerender(
      <WritingPanel
        {...view.props}
        launchRequest={{ id: "saved", pageId: "doc", conversationId: "11111111-1111-4111-8111-111111111111" }}
      />,
    );
    await waitFor(() =>
      expect(view.container.querySelector('.writing-panel > [aria-label="Writing result"]')).toHaveTextContent(
        "Saved draft",
      ),
    );
    expect(screen.queryByText("Checking conversation access…")).toBeNull();
    await act(async () => access.resolve({ locked: false, activeGeneration: null }));
  });
  it.each(["manual", "automatic", "new conversation"])(
    "offers %s recovery from an unverified access gate",
    async (recovery) => {
      panel();
      await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
      vi.useFakeTimers();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate" })));
      expect(screen.getByRole("heading", { name: "Improved writing" })).toBeVisible();
      const original = mocks.api.getMockImplementation()!;
      let fail = true,
        accesses = 0;
      const pending = deferred<unknown>();
      mocks.api.mockImplementation((path: string, options?: RequestInit) => {
        if (path.endsWith("/access")) {
          accesses++;
          return fail ? Promise.reject(new TypeError("Network unavailable")) : pending.promise;
        }
        if (path === "/api/ai/conversations/11111111-1111-4111-8111-111111111111")
          return Promise.resolve(savedConversation("Recovered draft"));
        return original(path, options);
      });
      await act(async () => fireEvent(window, new Event("focus")));
      expect(screen.getByText("Conversation access is unverified.")).toBeVisible();
      expect(screen.queryByText("Checking conversation access…")).toBeNull();
      expect(screen.getByRole("button", { name: "New conversation" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Retry conversation access" })).toBeEnabled();
      expect(screen.queryByLabelText("Writing result")).toBeNull();
      let pendingRetryDisabled: boolean | undefined;
      if (recovery === "new conversation") {
        fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
      } else {
        fail = false;
        if (recovery === "manual") {
          fireEvent.click(screen.getByRole("button", { name: "Retry conversation access" }));
          fireEvent.click(screen.getByRole("button", { name: "Retry conversation access" }));
        } else await act(async () => vi.advanceTimersByTimeAsync(5000));
        pendingRetryDisabled = screen.getByRole<HTMLButtonElement>("button", {
          name: "Retry conversation access",
        }).disabled;
        await act(async () => pending.resolve({ locked: false, activeGeneration: null }));
      }
      expect(pendingRetryDisabled).toBe(recovery === "new conversation" ? undefined : true);
      expect(accesses).toBe(recovery === "new conversation" ? 1 : 2);
      expect(screen.queryByText("Conversation access is unverified.")).toBeNull();
      expect(
        screen.getByRole("button", { name: recovery === "new conversation" ? "Generate" : "Generate follow-up" }),
      ).toBeEnabled();
      expect(screen.queryAllByLabelText("Writing result")[0]?.textContent ?? null).toBe(
        recovery === "new conversation" ? null : "Recovered draft",
      );
      expect(screen.queryByRole("button", { name: "Retry conversation access" })).toBeNull();
    },
  );
  it("coalesces focus with an in-flight poll and refreshes the conversation after verification", async () => {
    const original = mocks.api.getMockImplementation()!;
    const pending = deferred<unknown>();
    let accesses = 0;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path.endsWith("/access")) {
        accesses++;
        return pending.promise;
      }
      if (path === "/api/ai/conversations/11111111-1111-4111-8111-111111111111")
        return Promise.resolve(savedConversation("Refreshed draft"));
      return original(path, options);
    });
    panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("heading", { name: "Improved writing" });
    const before = mocks.api.mock.calls.filter(
      ([path]) => path === "/api/ai/conversations/11111111-1111-4111-8111-111111111111",
    ).length;
    fireEvent(window, new Event("focus"));
    fireEvent(window, new Event("focus"));
    expect(accesses).toBe(1);
    await act(async () => pending.resolve({ locked: false, activeGeneration: null }));
    expect(screen.getAllByLabelText("Writing result")[0]).toHaveTextContent("Refreshed draft");
    expect(
      mocks.api.mock.calls.filter(([path]) => path === "/api/ai/conversations/11111111-1111-4111-8111-111111111111"),
    ).toHaveLength(before + 1);
  });
  it("shows model loading instead of retry until an unavailable lookup completes", async () => {
    const original = mocks.api.getMockImplementation()!;
    const pending = deferred<{ fast: boolean; best: boolean }>();
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path.startsWith("/api/ai/models") ? pending.promise : original(path, options),
    );
    panel();
    expect(await screen.findByText("Checking model access…")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry model access" })).toBeNull();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    await act(async () => pending.resolve({ fast: false, best: false }));
    expect(screen.queryByText("Checking model access…")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry model access" })).toBeEnabled();
  });
  it("rejects a blank initial selection instead of dispatching the whole page", async () => {
    const view = panel();
    view.unmount();
    render(
      <WritingPanel
        {...view.props}
        initialTarget={{
          ...target,
          kind: "selection",
          text: " \n ",
          blocks: [{ id: "selected", fingerprint: "unchanged" }],
        }}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByText("Select readable document text.")).toBeVisible();
    expect(mocks.stream).not.toHaveBeenCalled();
  });
  it.each(["deadline", "reopen", "foreground", "online", "focus"])(
    "refreshes an exhausted quota at its %s boundary without switching funding",
    async (boundary) => {
      vi.useFakeTimers();
      const now = Date.now(),
        reset = now + 1000;
      vi.setSystemTime(now);
      const original = mocks.api.getMockImplementation()!;
      mocks.api.mockImplementation((path: string, options?: RequestInit) =>
        path === "/api/ai/status"
          ? Promise.resolve({
              ...status,
              preference: Date.now() < reset ? "api" : "chatgpt",
              quota: {
                ...status.quota,
                remaining: Date.now() < reset ? 0 : 20,
                resetsAt: Date.now() < reset ? reset : reset + 86400000,
              },
            })
          : original(path, options),
      );
      let view!: ReturnType<typeof panel>;
      await act(async () => {
        view = panel();
      });
      expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
      const reads = () => mocks.api.mock.calls.filter(([path]) => path === "/api/ai/status").length;
      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
      if (boundary === "reopen") view.rerender(<WritingPanel {...view.props} visible={false} />);
      if (boundary === "foreground") {
        hidden.mockReturnValue(true);
        await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      }
      if (boundary === "online") {
        online.mockReturnValue(false);
        await act(async () => window.dispatchEvent(new Event("offline")));
      }
      if (boundary === "focus") {
        vi.setSystemTime(reset + 1);
        await act(async () => window.dispatchEvent(new Event("focus")));
      } else {
        await act(async () => vi.advanceTimersByTimeAsync(1001));
      }
      expect(reads()).toBe(["deadline", "focus"].includes(boundary) ? 2 : 1);
      await act(async () => {
        if (boundary === "reopen") view.rerender(<WritingPanel {...view.props} visible />);
        if (boundary === "foreground") {
          hidden.mockReturnValue(false);
          document.dispatchEvent(new Event("visibilitychange"));
        }
        if (boundary === "online") {
          online.mockReturnValue(true);
          window.dispatchEvent(new Event("online"));
        }
      });
      expect(reads()).toBe(2);
      expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
      expect(screen.getByLabelText("Workspace API")).toBeChecked();
      expect(screen.getByText(/20 of 20 API requests remaining/)).toBeVisible();
    },
  );
  it("retains exhausted quota after a failed refresh, retries in five seconds, and prevents overlapping status reads", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const original = mocks.api.getMockImplementation()!;
    const pending = deferred<AiStatus>();
    let reads = 0;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path !== "/api/ai/status") return original(path, options);
      reads++;
      if (reads === 2) return pending.promise;
      return Promise.resolve({
        ...status,
        preference: "api",
        quota: { ...status.quota, remaining: reads === 1 ? 0 : 20, resetsAt: now + (reads === 1 ? 1000 : 86400000) },
      });
    });
    await act(async () => {
      panel();
    });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(reads).toBe(2);
    await act(async () => pending.reject(new TypeError("Status unavailable")));
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    expect(screen.getByText(/0 of 20 API requests remaining/)).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(4999));
    expect(reads).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(reads).toBe(3);
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
  });
  it.each(["open", "history"])(
    "invalidates a delayed %s read after denial and allows a fresh authorized reload",
    async (kind) => {
      const original = mocks.api.getMockImplementation()!;
      const stale = deferred<ReturnType<typeof savedConversation>>();
      let holdRead = kind === "history",
        denied = false,
        readStarted = false,
        recovered = false;
      mocks.api.mockImplementation((path: string, options?: RequestInit) => {
        if (path.endsWith("/access") && denied) {
          return kind === "open"
            ? Promise.resolve({ locked: true, activeGeneration: null })
            : Promise.reject(new ApiClientError(401, "challenge_required", "Verify account protection"));
        }
        if (path === "/api/ai/conversations/11111111-1111-4111-8111-111111111111") {
          if (holdRead) {
            readStarted = true;
            return stale.promise;
          }
          if (recovered) return Promise.resolve(savedConversation("Authorized again"));
        }
        return original(path, options);
      });
      const view = panel();
      await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Generate" }));
      await screen.findByRole("heading", { name: "Improved writing" });
      await waitFor(() => expect(screen.getByRole("button", { name: "Regenerate" })).toBeEnabled());
      if (kind === "open") {
        holdRead = true;
        fireEvent(window, new Event("focus"));
      }
      await waitFor(() => expect(readStarted).toBe(true));
      view.rerender(<WritingPanel {...view.props} visible={false} />);
      denied = true;
      await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
      expect(screen.queryByText("Checking conversation access…")).toBeNull();
      await act(async () => stale.resolve(savedConversation("Private obsolete history")));
      expect(screen.queryAllByText("Private obsolete history")).toHaveLength(0);
      expect(screen.queryByLabelText("Writing result")).toBeNull();
      expect(screen.queryByText(/conversation is locked/) !== null).toBe(kind === "open");
      holdRead = false;
      denied = false;
      recovered = true;
      await act(async () => fireEvent(window, new Event("focus")));
      expect(screen.getAllByLabelText("Writing result")[0]).toHaveTextContent("Authorized again");
      expect(screen.queryByText(/conversation is locked/)).toBeNull();
    },
  );
  it("rejects queued stream events and prior-result restoration after a newer access denial", async () => {
    panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("heading", { name: "Improved writing" });
    let emit!: (event: AiStreamEvent) => void;
    const running = deferred<void>();
    mocks.stream.mockImplementationOnce(
      async (_input: AiGenerate, _signal: AbortSignal, onEvent: (event: AiStreamEvent) => void) => {
        emit = onEvent;
        await running.promise;
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path.endsWith("/access") ? Promise.resolve({ locked: true, activeGeneration: null }) : original(path, options),
    );
    await act(async () => fireEvent(window, new Event("focus")));
    expect(screen.getByText(/conversation is locked/)).toBeVisible();
    await act(async () => {
      emit({ type: "delta", text: "Queued private output" });
      emit({ type: "error", code: "ai_provider_rejected", status: 502, message: "Provider rejected" });
      running.resolve();
    });
    expect(screen.queryByText("Queued private output")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Improved writing" })).toBeNull();
    expect(screen.queryByText("Checking conversation access…")).toBeNull();
  });
  it.each(["reset", "dispose"])("invalidates a pending history read on conversation %s", async (boundary) => {
    const original = mocks.api.getMockImplementation()!;
    const stale = deferred<ReturnType<typeof savedConversation>>();
    let readStarted = false;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path === "/api/ai/conversations/11111111-1111-4111-8111-111111111111") {
        readStarted = true;
        return stale.promise;
      }
      return original(path, options);
    });
    const view = panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("heading", { name: "Improved writing" });
    await waitFor(() => expect(readStarted).toBe(true));
    if (boundary === "reset") fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    else {
      view.unmount();
      panel();
    }
    await act(async () => stale.resolve(savedConversation("Obsolete conversation history")));
    expect(screen.queryAllByText("Obsolete conversation history")).toHaveLength(0);
    expect(screen.queryByLabelText("Writing result")).toBeNull();
  });
  it("does not apply a result when access was denied during its application check", async () => {
    const view = panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("heading", { name: "Improved writing" });
    const original = mocks.api.getMockImplementation()!;
    const check = deferred<{ contentEpoch: number; protectedBlockIds: string[] }>();
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path.endsWith("apply-check")
        ? check.promise
        : path.endsWith("/access")
          ? Promise.resolve({ locked: true, activeGeneration: null })
          : original(path, options),
    );
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await act(async () => fireEvent(window, new Event("focus")));
    await act(async () => check.resolve({ contentEpoch: 1, protectedBlockIds: [] }));
    expect(view.apply).not.toHaveBeenCalled();
    expect(screen.getByText(/conversation is locked/)).toBeVisible();
  });
  it.each(["retained", "pending"])("clears %s private history titles when access is denied", async (kind) => {
    const original = mocks.api.getMockImplementation()!;
    const list = {
      conversations: [{ id: "saved", title: "Private conversation title", expiresAt: Date.now() }],
      nextCursor: null,
    };
    const pending = deferred<typeof list>();
    let denied = false;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path.startsWith("/api/ai/conversations?"))
        return kind === "pending" ? pending.promise : Promise.resolve(list);
      if (path.endsWith("/access") && denied) return Promise.resolve({ locked: true, activeGeneration: null });
      return original(path, options);
    });
    panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("heading", { name: "Improved writing" });
    fireEvent.click(screen.getByRole("button", { name: "Document writing history" }));
    await waitFor(() =>
      expect(mocks.api.mock.calls.some(([path]) => path.startsWith("/api/ai/conversations?"))).toBe(true),
    );
    denied = true;
    await act(async () => fireEvent(window, new Event("focus")));
    await act(async () => pending.resolve(list));
    expect(screen.queryByText("Private conversation title")).toBeNull();
    expect(screen.queryByRole("region", { name: "Private writing history" })).toBeNull();
    expect(screen.getByText(/conversation is locked/)).toBeVisible();
  });
  it("keeps a newer launch gated when an older focus reload finishes", async () => {
    const original = mocks.api.getMockImplementation()!;
    const stale = deferred<ReturnType<typeof savedConversation>>(),
      next = deferred<ReturnType<typeof savedConversation>>();
    let hold = false;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (hold && path === "/api/ai/conversations/11111111-1111-4111-8111-111111111111") return stale.promise;
      if (path === "/api/ai/conversations/new-conversation/open") return next.promise;
      if (path === "/api/ai/conversations/new-conversation/access")
        return Promise.resolve({ locked: true, activeGeneration: null });
      return original(path, options);
    });
    const view = panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("heading", { name: "Improved writing" });
    hold = true;
    await act(async () => fireEvent(window, new Event("focus")));
    view.rerender(
      <WritingPanel
        {...view.props}
        launchRequest={{ id: "new-launch", pageId: "doc", conversationId: "new-conversation" }}
      />,
    );
    await act(async () => stale.resolve(savedConversation("Obsolete focus result")));
    expect(screen.getByText("Checking conversation access…")).toBeVisible();
    expect(screen.queryAllByLabelText("Writing result")).toHaveLength(0);
    await act(async () =>
      next.resolve({ conversation: { ...savedConversation("").conversation, id: "new-conversation", locked: true } }),
    );
    expect(screen.queryByText("Checking conversation access…")).toBeNull();
    expect(screen.getByText(/conversation is locked/)).toBeVisible();
  });
  it.each(["reopen", "focus", "foreground"])(
    "keeps a new stream visible through transient access failure, but gates %s until access returns",
    async (boundary) => {
      const original = mocks.api.getMockImplementation()!;
      const initialAccess = deferred<unknown>(),
        reopenedAccess = deferred<unknown>(),
        running = deferred<void>();
      let accesses = 0,
        emit!: (event: AiStreamEvent) => void;
      mocks.api.mockImplementation((path: string, options?: RequestInit) => {
        if (path.endsWith("/access")) {
          accesses++;
          return accesses === 1
            ? initialAccess.promise
            : accesses === 3
              ? reopenedAccess.promise
              : Promise.resolve({ locked: false, activeGeneration: null });
        }
        return original(path, options);
      });
      mocks.stream.mockImplementation(
        async (_input: AiGenerate, _signal: AbortSignal, onEvent: (event: AiStreamEvent) => void) => {
          emit = onEvent;
          onEvent({
            type: "start",
            conversationId: "11111111-1111-4111-8111-111111111111",
            messageId: "live",
            sources: [source],
            changedPageIds: [],
            canApply: true,
            quota: status.quota,
          });
          onEvent({ type: "delta", text: "Live output" });
          await running.promise;
        },
      );
      const view = panel();
      await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
      vi.useFakeTimers();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate" })));
      expect(screen.queryByText("Checking conversation access…")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(100));
      expect(screen.getByLabelText("Writing result")).toHaveTextContent("Live output");
      await act(async () => initialAccess.reject(new TypeError("Network unavailable")));
      expect(screen.getByRole("alert")).toHaveTextContent("Retrying automatically");
      expect(screen.getByLabelText("Writing result")).toHaveTextContent("Live output");
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => {
        if (boundary === "reopen") {
          view.rerender(<WritingPanel {...view.props} visible={false} />);
        } else if (boundary === "foreground") {
          vi.spyOn(document, "hidden", "get").mockReturnValue(true);
          fireEvent(document, new Event("visibilitychange"));
        }
      });
      await act(async () => {
        if (boundary === "reopen") view.rerender(<WritingPanel {...view.props} visible />);
        if (boundary === "focus") fireEvent(window, new Event("focus"));
        if (boundary === "foreground") {
          vi.spyOn(document, "hidden", "get").mockReturnValue(false);
          fireEvent(document, new Event("visibilitychange"));
        }
      });
      expect(screen.getByText("Checking conversation access…")).toBeVisible();
      expect(screen.queryByLabelText("Writing result")).toBeNull();
      await act(async () => reopenedAccess.resolve({ locked: false, activeGeneration: null }));
      expect(screen.getByLabelText("Writing result")).toHaveTextContent("Live output");
      await act(async () => {
        emit({ type: "complete" });
        running.resolve();
      });
    },
  );
  it("clears a recovered access error without erasing an application error", async () => {
    panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("heading", { name: "Improved writing" });
    const original = mocks.api.getMockImplementation()!;
    let failAccess = true;
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path.endsWith("apply-check")
        ? Promise.reject(new Error("Application unavailable"))
        : path.endsWith("/access") && failAccess
          ? Promise.reject(new TypeError("Network unavailable"))
          : original(path, options),
    );
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await screen.findByText("The result could not be applied.");
    await act(async () => fireEvent(window, new Event("focus")));
    expect(screen.getByText(/Retrying automatically/)).toBeVisible();
    failAccess = false;
    await act(async () => fireEvent(window, new Event("focus")));
    expect(screen.queryByText(/Retrying automatically/)).toBeNull();
    expect(screen.getByText("The result could not be applied.")).toBeVisible();
  });
  it("retries unavailable models, ignores a superseded lookup, and clears only model errors", async () => {
    const original = mocks.api.getMockImplementation()!;
    const stale = deferred<{ fast: boolean; best: boolean }>();
    let lookups = 0;
    mocks.api.mockImplementation((path: string, options?: RequestInit) => {
      if (path.startsWith("/api/ai/models")) {
        lookups++;
        if (lookups === 1) return Promise.resolve({ fast: false, best: false });
        if (lookups === 2) return stale.promise;
        if (lookups === 3) return Promise.reject(new TypeError("Network unavailable"));
        return Promise.resolve({ fast: true, best: false });
      }
      return original(path, options);
    });
    const view = panel();
    await waitFor(() => expect(lookups).toBe(1));
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    fireEvent.click(await screen.findByRole("button", { name: "Retry model access" }));
    expect(screen.queryByRole("button", { name: "Retry model access" })).toBeNull();
    expect(screen.getByText("Checking model access…")).toBeVisible();
    view.rerender(<WritingPanel {...view.props} visible={false} />);
    view.rerender(<WritingPanel {...view.props} visible />);
    await screen.findByText("Model access could not be checked.");
    await act(async () => stale.resolve({ fast: true, best: false }));
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry model access" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    expect(screen.queryByText("Model access could not be checked.")).toBeNull();
    expect(screen.getByLabelText("ChatGPT plan")).toBeChecked();
  });
  it("prefers connected ChatGPT, disables unconfigured Best, and applies only a completed formatted preview", async () => {
    const { apply } = panel();
    const generate = await screen.findByRole("button", { name: "Generate" });
    await waitFor(() => expect(generate).toBeEnabled());
    expect(screen.getByLabelText("ChatGPT plan")).toBeChecked();
    expect(screen.getByRole("option", { name: "Best" })).toBeDisabled();
    fireEvent.click(generate);
    expect(await screen.findByRole("heading", { name: "Improved writing" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Writing result" })).toBeNull();
    expect(screen.getByRole("link", { name: "Current document" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith(target, "# Improved writing\n\nClear **result**.", "replace", 1, new Set()),
    );
  });
  it("uses explicit API funding and translation language and remembers the choice", async () => {
    panel();
    await screen.findByLabelText("Workspace API");
    fireEvent.click(screen.getByLabelText("Workspace API"));
    fireEvent.change(screen.getByLabelText("Writing action"), { target: { value: "translate" } });
    fireEvent.change(screen.getByLabelText("Target language"), { target: { value: "Spanish" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(mocks.stream).toHaveBeenCalled());
    expect(mocks.stream.mock.calls[0]?.[0]).toMatchObject({
      funding: "api",
      quality: "fast",
      action: "translate",
      targetLanguage: "Spanish",
    });
    expect(mocks.api).toHaveBeenCalledWith(
      "/api/ai/preference",
      expect.objectContaining({ method: "POST", body: '{"funding":"api"}' }),
    );
    expect(screen.getByText(/20 of 20 API requests remaining/)).toBeVisible();
  });
  it("previews sequential numbered items and task completion without editable controls", () => {
    const { container } = render(
      <WritingPreview markdown={"1. First item\n2. Second item\n\n- [x] Finished\n- [ ] Pending"} />,
    );
    const items = container.querySelectorAll(".writing-list-item");
    expect(items[0]).toHaveTextContent("1.First item");
    expect(items[1]).toHaveTextContent("2.Second item");
    expect(items[2]).toHaveTextContent("☑Finished");
    expect(items[3]).toHaveTextContent("☐Pending");
    expect(container.querySelector("[contenteditable]")).toBeNull();
  });
  it("keeps an old draft copyable while disabling replacement after the source selection changes", async () => {
    const { capture, apply } = panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("button", { name: "Replace" })).toBeEnabled();
    capture.mockReturnValue({
      ...target,
      kind: "selection",
      text: "New source selection",
      blocks: [{ id: "new-block", fingerprint: "different" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Use selected text" }));
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Improved writing" })).toBeVisible();
    expect(apply).not.toHaveBeenCalled();
  });
  it("lets viewers copy a result while disabling Insert and Replace", async () => {
    panel(false);
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(await screen.findByRole("button", { name: "Replace" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Insert" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
  });
  it("preserves cancellation output as copy only and sends an explicit cancellation", async () => {
    mocks.stream.mockImplementation(
      async (_input: AiGenerate, signal: AbortSignal, onEvent: (event: AiStreamEvent) => void) => {
        onEvent({
          type: "start",
          conversationId: "11111111-1111-4111-8111-111111111111",
          messageId: "message",
          sources: [source],
          changedPageIds: [],
          canApply: true,
          quota: status.quota,
        });
        onEvent({ type: "delta", text: "Partial draft" });
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    );
    panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel generation" }));
    expect(await screen.findByText("Partial result — copy only")).toBeVisible();
    expect(screen.getByText("Partial draft")).toBeVisible();
    expect(screen.getByRole("button", { name: "Insert" })).toBeDisabled();
    expect(mocks.api.mock.calls.some(([path]) => String(path).includes("/cancel"))).toBe(true);
  });
  it("does not start before document synchronization", async () => {
    panel(true, false);
    await screen.findByLabelText("ChatGPT plan");
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    expect(screen.getByText(/Waiting for the document to finish syncing/)).toBeVisible();
    expect(mocks.stream).not.toHaveBeenCalled();
  });
  it("locks private content when a history response denies source access", async () => {
    mocks.api.mockImplementation(async (path: string) =>
      path === "/api/ai/status"
        ? status
        : path === "/api/pages/tree"
          ? { pages: [] }
          : path.endsWith("/open")
            ? { conversation: { id: "11111111-1111-4111-8111-111111111111", pageId: "doc", locked: true } }
            : path.endsWith("/access")
              ? { locked: true, activeGeneration: null }
              : { fast: true, best: false },
    );
    await act(async () =>
      render(
        <WritingPanel
          pageId="doc"
          initialTarget={target}
          launchRequest={{ id: "locked", pageId: "doc", conversationId: "11111111-1111-4111-8111-111111111111" }}
          onCapture={() => target}
          onApply={vi.fn()}
          onClose={vi.fn()}
          editable
          ready={() => true}
        />,
      ),
    );
    expect(await screen.findByText(/This conversation is locked/)).toBeVisible();
    expect(screen.queryByLabelText("Writing instruction")).toBeNull();
  });
  it("renders untrusted preview content as inert text and never fetches images", () => {
    const { container } = render(
      <WritingPreview markdown={'<img src="https://tracker.test/pixel"><script>alert(1)</script>'} />,
    );
    expect(container.querySelectorAll("img,script,iframe")).toHaveLength(0);
    expect(container).toHaveTextContent("<img");
  });
  it.each([424, 502, 503])("keeps prior results and funding controls after provider HTTP %i", async (statusCode) => {
    panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("heading", { name: "Improved writing" });
    mocks.stream.mockRejectedValueOnce(
      new ApiClientError(
        statusCode,
        statusCode === 424 ? "chatgpt_reconnect" : "ai_provider_credentials",
        "Reconnect or switch funding",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reconnect or switch funding");
    expect(mocks.stream).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Improved writing" })).toBeVisible();
    expect(screen.getByLabelText("Workspace API")).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Workspace API"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Regenerate" })).toBeEnabled());
    expect(screen.queryByText(/conversation is locked/)).toBeNull();
  });
  it("preserves the previous result and its application identity when the provider rejects after start", async () => {
    panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("heading", { name: "Improved writing" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Regenerate" })).toBeEnabled());
    const original = mocks.api.getMockImplementation()!;
    const saved = savedConversation("# Improved writing\n\nClear **result**.");
    saved.conversation.messages.push({
      ...saved.conversation.messages[0]!,
      id: "rejected",
      output: "",
      status: "failed",
      sources: [],
    });
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path === `/api/ai/conversations/${saved.conversation.id}` ? Promise.resolve(saved) : original(path, options),
    );
    mocks.stream.mockImplementationOnce(
      async (_input: AiGenerate, _signal: AbortSignal, onEvent: (event: AiStreamEvent) => void) => {
        onEvent({
          type: "start",
          conversationId: "11111111-1111-4111-8111-111111111111",
          messageId: "rejected",
          sources: [],
          changedPageIds: [],
          canApply: true,
          quota: status.quota,
        });
        onEvent({ type: "error", code: "ai_provider_rejected", status: 502, message: "Provider credential rejected" });
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await screen.findByText("Provider credential rejected");
    await waitFor(() => expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled());
    expect(screen.getAllByRole("heading", { name: "Improved writing" })[0]).toBeVisible();
    expect(screen.getByLabelText("Workspace API")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith("/api/ai/results/message/apply-check", expect.anything()),
    );
  });
  it.each(["quota", "enabled"])("uses the same %s guard for Generate and Regenerate", async (guard) => {
    const original = mocks.api.getMockImplementation()!;
    let complete = false;
    mocks.api.mockImplementation(async (path: string, options?: RequestInit) =>
      path === "/api/ai/status" && complete
        ? {
            ...status,
            preference: "api",
            settings: { ...status.settings, enabled: guard !== "enabled" },
            quota: { ...status.quota, remaining: guard === "quota" ? 0 : 20 },
          }
        : original(path, options),
    );
    panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByLabelText("Workspace API"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    complete = true;
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Regenerate" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(mocks.stream).toHaveBeenCalledOnce();
  });
  it("blocks duplicate operations and state changes throughout application", async () => {
    const view = panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("heading", { name: "Improved writing" });
    const original = mocks.api.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path.endsWith("apply-check")
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(path, options),
    );
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    for (const name of ["Regenerate", "Generate", "New conversation", "Discard", "Use selected text"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByLabelText("Writing action")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await act(async () => finish({ contentEpoch: 1, protectedBlockIds: [] }));
    expect(view.apply).toHaveBeenCalledOnce();
  });
  it("batches live previews at 100ms, copies the full buffer, and immediately flushes completion", async () => {
    let emit!: (event: AiStreamEvent) => void, finish!: () => void;
    mocks.stream.mockImplementation(
      async (_input: AiGenerate, _signal: AbortSignal, onEvent: (event: AiStreamEvent) => void) => {
        emit = onEvent;
        onEvent({
          type: "start",
          conversationId: "11111111-1111-4111-8111-111111111111",
          messageId: "message",
          sources: [],
          changedPageIds: [],
          canApply: true,
          quota: status.quota,
        });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    );
    panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    const parser = vi.spyOn(writingMarkdown, "parseAiMarkdown");
    vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate" })));
    act(() => {
      for (let i = 0; i < 50; i++) emit({ type: "delta", text: "a" });
    });
    await act(async () => vi.advanceTimersByTimeAsync(99));
    expect(screen.queryByLabelText("Writing result")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByLabelText("Writing result")).toHaveTextContent("a".repeat(50));
    expect(parser).toHaveBeenCalledOnce();
    act(() => emit({ type: "delta", text: " latest" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("a".repeat(50) + " latest");
    await act(async () => {
      emit({ type: "complete" });
      finish();
    });
    expect(screen.getByLabelText("Writing result")).toHaveTextContent("latest");
    expect(parser).toHaveBeenCalledTimes(2);
  });
  it("retains streams, drafts, and stable readiness subscriptions while hidden with no idle polling", async () => {
    let emit!: (event: AiStreamEvent) => void, finish!: () => void, signal!: AbortSignal;
    mocks.stream.mockImplementation(
      async (_input: AiGenerate, abort: AbortSignal, onEvent: (event: AiStreamEvent) => void) => {
        signal = abort;
        emit = onEvent;
        onEvent({
          type: "start",
          conversationId: "11111111-1111-4111-8111-111111111111",
          messageId: "message",
          sources: [],
          changedPageIds: [],
          canApply: true,
          quota: status.quota,
        });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    );
    const view = panel(),
      unsubscribe = vi.fn(),
      subscribe = vi.fn(() => unsubscribe);
    view.rerender(<WritingPanel {...view.props} subscribeReadiness={subscribe} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Writing instruction"), { target: { value: "Retained instruction" } });
    vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate" })));
    const parser = vi.spyOn(writingMarkdown, "parseAiMarkdown");
    view.rerender(<WritingPanel {...view.props} subscribeReadiness={subscribe} visible={false} />);
    const calls = mocks.api.mock.calls.length;
    act(() => emit({ type: "delta", text: "Hidden work" }));
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(signal.aborted).toBe(false);
    expect(mocks.api).toHaveBeenCalledTimes(calls);
    expect(parser).not.toHaveBeenCalled();
    await act(async () => {
      emit({ type: "complete" });
      finish();
    });
    expect(parser).not.toHaveBeenCalled();
    const original = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path === "/api/ai/conversations/11111111-1111-4111-8111-111111111111"
        ? Promise.resolve(savedConversation("Hidden work"))
        : original(path, options),
    );
    await act(async () => view.rerender(<WritingPanel {...view.props} subscribeReadiness={subscribe} visible />));
    expect(screen.getByLabelText("Follow-up instruction")).toHaveValue("Retained instruction");
    expect(screen.getAllByLabelText("Writing result")[0]).toHaveTextContent("Hidden work");
    fireEvent.change(screen.getByLabelText("Follow-up instruction"), { target: { value: "Another instruction" } });
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(
      mocks.api.mock.calls.some(([path]) => String(path).endsWith("/open") || String(path).endsWith("/cancel")),
    ).toBe(false);
  });
  it("reveals running work on re-launch, then retargets idle work without losing its result", async () => {
    let finish!: () => void;
    mocks.stream.mockImplementation(
      async (_input: AiGenerate, _signal: AbortSignal, onEvent: (event: AiStreamEvent) => void) => {
        onEvent({
          type: "start",
          conversationId: "11111111-1111-4111-8111-111111111111",
          messageId: "message",
          sources: [],
          changedPageIds: [],
          canApply: true,
          quota: status.quota,
        });
        onEvent({ type: "delta", text: "Retained result" });
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        onEvent({ type: "complete" });
      },
    );
    const view = panel(),
      selection = { ...target, kind: "selection" as const, text: "Different selection" };
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    view.rerender(<WritingPanel {...view.props} launchRequest={{ id: "one", pageId: "doc", target: selection }} />);
    expect(screen.getByText(/Finish or cancel the current operation/)).toBeVisible();
    await waitFor(() => expect(screen.getByText("Entire page", { exact: true })).toBeVisible());
    await act(async () => finish());
    view.rerender(<WritingPanel {...view.props} launchRequest={{ id: "two", pageId: "doc", target: selection }} />);
    expect(screen.getByText("Selected text", { exact: true })).toBeVisible();
    expect(screen.getByLabelText("Writing result")).toHaveTextContent("Retained result");
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
  });
  it("opens a saved running message once, disables follow-ups, and cancels with a GET refresh", async () => {
    const original = mocks.api.getMockImplementation()!;
    let active = true;
    mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/cancel")) {
        active = false;
        return { ok: true };
      }
      if (path.endsWith("/access"))
        return {
          locked: false,
          activeGeneration: active ? { messageId: "remote", createdAt: 1, deadlineAt: 330001 } : null,
        };
      if (path.startsWith("/api/ai/conversations/11111111-1111-4111-8111-111111111111"))
        return {
          conversation: {
            id: "11111111-1111-4111-8111-111111111111",
            pageId: "doc",
            locked: false,
            messages: [
              {
                id: "remote",
                action: "rewrite",
                prompt: "",
                output: "Saved partial",
                status: active ? "running" : "cancelled",
                funding: "api",
                quality: "fast",
                createdAt: 1,
                sources: [],
              },
            ],
          },
        };
      return original(path, options);
    });
    const view = panel();
    await act(async () =>
      view.rerender(
        <WritingPanel
          {...view.props}
          launchRequest={{ id: "saved", pageId: "doc", conversationId: "11111111-1111-4111-8111-111111111111" }}
        />,
      ),
    );
    expect(screen.getByRole("button", { name: "Cancel generation" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel generation" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel generation" })).toBeNull());
    view.rerender(
      <WritingPanel
        {...view.props}
        launchRequest={{ id: "saved", pageId: "doc", conversationId: "11111111-1111-4111-8111-111111111111" }}
        visible={false}
      />,
    );
    await act(async () =>
      view.rerender(
        <WritingPanel
          {...view.props}
          launchRequest={{ id: "saved", pageId: "doc", conversationId: "11111111-1111-4111-8111-111111111111" }}
        />,
      ),
    );
    expect(mocks.api.mock.calls.filter(([path]) => String(path).endsWith("/open"))).toHaveLength(1);
    expect(mocks.api).toHaveBeenCalledWith("/api/ai/generations/remote/cancel", { method: "POST" });
    expect(screen.getAllByLabelText("Writing result")[0]).toHaveTextContent("Saved partial");
  });
  it("hides retained private output until a reopen access check finishes and distinguishes expiry", async () => {
    const view = panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await screen.findByRole("heading", { name: "Improved writing" });
    view.rerender(<WritingPanel {...view.props} visible={false} />);
    const original = mocks.api.getMockImplementation()!;
    let deny!: (cause: unknown) => void;
    mocks.api.mockImplementation((path: string, options?: RequestInit) =>
      path.endsWith("/access")
        ? new Promise((_resolve, reject) => {
            deny = reject;
          })
        : original(path, options),
    );
    view.rerender(<WritingPanel {...view.props} visible />);
    expect(screen.queryByLabelText("Writing result")).toBeNull();
    expect(screen.getByText("Checking conversation access…")).toBeVisible();
    await act(async () => deny(new ApiClientError(404, "conversation_not_found", "Expired")));
    expect(screen.getByText(/deleted or expired/)).toBeVisible();
    expect(screen.queryByText(/conversation is locked/)).toBeNull();
    expect(screen.getByRole("button", { name: "New conversation" })).toBeEnabled();
  });
  it("does not reparse history on instruction edits or poll access in a background browser document", async () => {
    const original = mocks.api.getMockImplementation()!;
    const savedMessage = {
      id: "message",
      action: "rewrite",
      prompt: "",
      output: "Historical output",
      status: "complete",
      funding: "api",
      quality: "fast",
      sources: [],
      createdAt: 1,
    };
    mocks.api.mockImplementation(async (path: string, options?: RequestInit) =>
      path === "/api/ai/conversations/11111111-1111-4111-8111-111111111111"
        ? { conversation: { id: "11111111-1111-4111-8111-111111111111", locked: false, messages: [savedMessage] } }
        : original(path, options),
    );
    const parser = vi.spyOn(writingMarkdown, "parseAiMarkdown");
    panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(parser.mock.calls.filter(([text]) => text === "Historical output")).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("Follow-up instruction"), { target: { value: "New prompt" } });
    expect(parser.mock.calls.filter(([text]) => text === "Historical output")).toHaveLength(1);
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const calls = mocks.api.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(mocks.api).toHaveBeenCalledTimes(calls);
    hidden.mockReturnValue(false);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocks.api.mock.calls.filter(([path]) => String(path).endsWith("/access")).length).toBeGreaterThan(1);
    // Foreground verification now reloads the saved latest result as well as remounting history.
    expect(parser.mock.calls.filter(([text]) => text === "Historical output")).toHaveLength(3);
  });
  it("keeps provider model controls owner-only and never exposes an API credential field", async () => {
    render(<WritingSettings owner={false} />);
    expect(await screen.findByText("Connected: member@example.test")).toBeVisible();
    expect(screen.queryByText("Workspace writing controls")).toBeNull();
    expect(screen.queryByLabelText(/key/i)).toBeNull();
  });
});

describe("writing synchronization races", () => {
  it.each(["visible", "hidden"])(
    "retains remote completion during apply and retries its history read while %s",
    async (visibility) => {
      const view = await completedPanel();
      vi.useFakeTimers();
      await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
      await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
      const original = mocks.api.getMockImplementation()!;
      const done = deferred<{ contentEpoch: number; protectedBlockIds: string[] }>();
      const path = `/api/ai/conversations/${view.saved.conversation.id}`;
      let active = true,
        reads = 0;
      mocks.api.mockImplementation((url: string, options?: RequestInit) => {
        if (url.endsWith("apply-check")) return done.promise;
        if (url === `${path}/access`)
          return Promise.resolve({
            locked: false,
            activeGeneration: active ? { messageId: "remote-follow-up", createdAt: 1, deadlineAt: 330001 } : null,
          });
        if (url === path && ++reads === 1) return Promise.reject(new TypeError("History unavailable"));
        return original(url, options);
      });
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Replace" })));
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      active = false;
      view.saved.conversation.messages.push({
        ...view.saved.conversation.messages[0]!,
        id: "remote-follow-up",
        output: "Remote follow-up completed",
      });
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(reads).toBe(0);
      if (visibility === "hidden")
        await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
      await act(async () => done.resolve({ contentEpoch: 1, protectedBlockIds: [] }));
      expect(view.apply).toHaveBeenCalledTimes(1);
      if (visibility === "hidden") await act(async () => vi.advanceTimersByTimeAsync(15000));
      expect(reads).toBe(visibility === "hidden" ? 0 : 1);
      if (visibility === "hidden") {
        await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
      }
      expect(reads).toBe(1);
      expect(screen.getByText("Conversation access is unverified.")).toBeVisible();
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(reads).toBe(2);
      expect(view.preview()).toHaveTextContent("Remote follow-up completed");
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(10000));
      expect(reads).toBe(2);
    },
  );

  it.each(["success", "failure"])(
    "retires an old passive reload after a conversation switch even on late %s",
    async (outcome) => {
      const view = await completedPanel();
      vi.useFakeTimers();
      await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
      await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
      const original = mocks.api.getMockImplementation()!;
      const stale = deferred<ReturnType<typeof savedConversation>>();
      const fresh = deferred<ReturnType<typeof savedConversation>>();
      const next = savedConversation("New conversation output");
      next.conversation.id = "new-conversation";
      let extraReads = 0;
      mocks.api.mockImplementation((url: string, options?: RequestInit) => {
        if (url === `/api/ai/conversations/${view.saved.conversation.id}`) return stale.promise;
        if (url === "/api/ai/conversations/new-conversation/open") return Promise.resolve(next);
        if (url === "/api/ai/conversations/new-conversation/access")
          return Promise.resolve({ locked: false, activeGeneration: null });
        if (url === "/api/ai/conversations/new-conversation") {
          extraReads++;
          return fresh.promise;
        }
        return original(url, options);
      });
      await act(async () => fireEvent(window, new Event("focus")));
      await act(async () =>
        view.rerender(
          <WritingPanel
            {...view.props}
            launchRequest={{ id: "switch", pageId: "doc", conversationId: "new-conversation" }}
          />,
        ),
      );
      expect(extraReads).toBe(0);
      expect(view.preview()).toHaveTextContent("New conversation output");
      expect(screen.queryByText("Checking conversation access…")).toBeNull();
      await act(async () => fireEvent(window, new Event("focus")));
      expect(extraReads).toBe(1);
      await act(async () =>
        outcome === "success" ? stale.resolve(view.saved) : stale.reject(new TypeError("Old history failed")),
      );
      expect(screen.getByText("Checking conversation access…")).toBeVisible();
      expect(view.preview()).toBeNull();
      await act(async () => fresh.resolve(next));
      expect(view.preview()).toHaveTextContent("New conversation output");
      expect(screen.queryByRole("alert")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(10000));
      expect(extraReads).toBe(1);
    },
  );

  it.each(["discard", "restored"])(
    "preserves a %s override through failed explicit open and focus/reveal",
    async (override) => {
      const view = override === "restored" ? await restoredPanel() : await completedPanel();
      const original = mocks.api.getMockImplementation()!;
      if (override === "discard") fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      mocks.api.mockImplementation((url: string, options?: RequestInit) =>
        url.endsWith("/open") ? Promise.reject(new TypeError("Open failed")) : original(url, options),
      );
      const props = {
        ...view.props,
        launchRequest: { id: "failed-switch", pageId: "doc", conversationId: "other-conversation" },
      };
      await act(async () => view.rerender(<WritingPanel {...props} />));
      expect(screen.getByRole("alert")).toHaveTextContent("The conversation could not be opened.");
      await act(async () => fireEvent(window, new Event("focus")));
      await act(async () => view.rerender(<WritingPanel {...props} visible={false} />));
      await act(async () => view.rerender(<WritingPanel {...props} visible />));
      expect(view.preview()?.textContent ?? "").toMatch(override === "discard" ? /^$/ : /Improved writing/);
      const replace = screen.queryByRole<HTMLButtonElement>("button", { name: "Replace" });
      expect(replace === null || replace.disabled).toBe(override === "discard");
      if (replace) await act(async () => fireEvent.click(replace));
      expect(view.apply.mock.calls).toEqual(
        override === "discard" ? [] : [[target, "# Improved writing\n\nClear **result**.", "replace", 1, new Set()]],
      );
      expect(mocks.api.mock.calls.some(([url]) => url === "/api/ai/results/message/apply-check")).toBe(
        override === "restored",
      );
    },
  );

  it.each(["complete", "empty-failure"])(
    "retries terminal history failures without blocking a %s live result",
    async (outcome) => {
      const view = await completedPanel();
      vi.useFakeTimers();
      await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
      await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
      const original = mocks.api.getMockImplementation()!;
      const done = deferred<void>();
      let reads = 0;
      mocks.api.mockImplementation((url: string, options?: RequestInit) => {
        if (url === `/api/ai/conversations/${view.saved.conversation.id}` && ++reads <= 2)
          return Promise.reject(new TypeError("History timed out"));
        return original(url, options);
      });
      mocks.stream.mockImplementationOnce(
        async (_input: AiGenerate, _signal: AbortSignal, emit: (event: AiStreamEvent) => void) => {
          emit({
            type: "start",
            conversationId: view.saved.conversation.id,
            messageId: "follow-up",
            sources: [source],
            changedPageIds: [],
            canApply: true,
            quota: status.quota,
          });
          if (outcome === "complete") emit({ type: "delta", text: "Successful live follow-up" });
          await done.promise;
          if (outcome === "complete") emit({ type: "complete" });
          else emit({ type: "error", status: 503, code: "ai_provider_rejected", message: "Empty follow-up failed" });
        },
      );
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
      await act(async () => fireEvent(window, new Event("focus")));
      expect(reads).toBe(0);
      view.saved.conversation.messages.push({
        ...view.saved.conversation.messages[0]!,
        id: "follow-up",
        output: outcome === "complete" ? "Successful live follow-up" : "",
        status: outcome === "complete" ? "complete" : "failed",
      });
      await act(async () => done.resolve());
      const expected = outcome === "complete" ? "Successful live follow-up" : "Improved writing";
      expect(view.preview()).toHaveTextContent(expected);
      expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled();
      expect(screen.queryByText("Checking conversation access…")).toBeNull();
      expect(reads).toBe(1);
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(reads).toBe(2);
      expect(view.preview()).toHaveTextContent(expected);
      expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled();
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(reads).toBe(3);
      expect(screen.getByText("Conversation (2 requests)")).toBeVisible();
      expect(view.preview()).toHaveTextContent(expected);
      expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      await act(async () => vi.advanceTimersByTimeAsync(10000));
      expect(reads).toBe(3);
      expect(view.preview()).toBeNull();
    },
  );

  it("keeps access polling and rejects a late history response after denial during a slow terminal read", async () => {
    const view = await completedPanel();
    vi.useFakeTimers();
    await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
    await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    const original = mocks.api.getMockImplementation()!;
    const history = deferred<ReturnType<typeof savedConversation>>();
    let reads = 0,
      accessReads = 0,
      denied = false;
    mocks.api.mockImplementation((url: string, options?: RequestInit) => {
      if (url === `/api/ai/conversations/${view.saved.conversation.id}`) {
        reads++;
        return history.promise;
      }
      if (url.endsWith("/access")) {
        accessReads++;
        return Promise.resolve({ locked: denied, activeGeneration: null });
      }
      return original(url, options);
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(reads).toBe(1);
    expect(accessReads).toBe(3);
    expect(view.preview()).toHaveTextContent("Improved writing");
    expect(screen.getByRole("button", { name: "Replace" })).toBeEnabled();
    denied = true;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(view.preview()).toBeNull();
    await act(async () => history.resolve(savedConversation("Private obsolete history")));
    expect(screen.queryByText("Private obsolete history")).toBeNull();
    expect(screen.getByText(/conversation is locked/)).toBeVisible();
  });

  it("preserves pending local history across a failed explicit open and ignores the superseded read", async () => {
    const view = await completedPanel();
    vi.useFakeTimers();
    await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
    await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    const original = mocks.api.getMockImplementation()!;
    const stale = deferred<ReturnType<typeof savedConversation>>();
    let reads = 0;
    mocks.api.mockImplementation((url: string, options?: RequestInit) => {
      if (url.endsWith("/other/open")) return Promise.reject(new TypeError("Open failed"));
      if (url === `/api/ai/conversations/${view.saved.conversation.id}` && ++reads === 1) return stale.promise;
      return original(url, options);
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
    await act(async () =>
      view.rerender(
        <WritingPanel {...view.props} launchRequest={{ id: "failed-open", pageId: "doc", conversationId: "other" }} />,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(2);
    expect(view.preview()).toHaveTextContent("Improved writing");
    await act(async () => stale.resolve(savedConversation("Obsolete history")));
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(reads).toBe(2);
    expect(screen.queryByText("Obsolete history")).toBeNull();
  });

  it("retains failed terminal synchronization while hidden and resumes it on reveal", async () => {
    const view = await completedPanel();
    vi.useFakeTimers();
    await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
    await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    const original = mocks.api.getMockImplementation()!;
    let reads = 0;
    mocks.api.mockImplementation((url: string, options?: RequestInit) =>
      url === `/api/ai/conversations/${view.saved.conversation.id}` && ++reads === 1
        ? Promise.reject(new TypeError("History unavailable"))
        : original(url, options),
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
    await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(reads).toBe(1);
    await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    expect(reads).toBe(2);
    expect(view.preview()).toHaveTextContent("Improved writing");
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(reads).toBe(2);
  });

  it.each(["equal", "greater", "legacy", "failure"])(
    "fences a pre-reservation status with %s timestamp/outcome and fetches a fresh refund sample",
    async (ordering) => {
      vi.useFakeTimers();
      const original = mocks.api.getMockImplementation()!,
        now = Date.now();
      const older = deferred<AiStatus>(),
        fresh = deferred<AiStatus>(),
        done = deferred<void>();
      let reads = 0;
      const available: AiStatus = {
        ...status,
        preference: "api",
        quota: { ...status.quota, remaining: 1, checkedAt: now, resetsAt: now + 86400000 },
      };
      mocks.api.mockImplementation((url: string, options?: RequestInit) => {
        if (url !== "/api/ai/status") return original(url, options);
        reads++;
        if (reads === 1) return Promise.resolve(available);
        return reads === 2 ? older.promise : fresh.promise;
      });
      mocks.stream.mockImplementationOnce(
        async (_input: AiGenerate, _signal: AbortSignal, emit: (event: AiStreamEvent) => void) => {
          emit({
            type: "start",
            conversationId: "11111111-1111-4111-8111-111111111111",
            messageId: "last-request",
            sources: [source],
            changedPageIds: [],
            canApply: true,
            quota: { ...available.quota, remaining: 0 },
          });
          emit({ type: "delta", text: "Last allowed result" });
          await done.promise;
          emit({ type: "error", status: 429, code: "ai_provider_rejected", message: "Request refunded" });
        },
      );
      await act(async () => panel());
      await act(async () => fireEvent(window, new Event("focus")));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate" })));
      await act(async () => fireEvent(window, new Event("focus")));
      await act(async () => done.resolve());
      if (ordering === "failure") await act(async () => older.reject(new TypeError("Status failed")));
      else
        await act(async () =>
          older.resolve({
            ...available,
            connected: false,
            quota: {
              ...available.quota,
              checkedAt: ordering === "legacy" ? undefined : now + (ordering === "greater" ? 1000 : 0),
            },
          }),
        );
      expect(reads).toBe(3);
      expect(screen.getByText(/^0 of 20 API requests remaining/)).toBeVisible();
      expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
      expect(screen.getByRole("radio", { name: "ChatGPT plan" })).toHaveProperty("disabled", ordering !== "failure");
      await act(async () => fresh.resolve({ ...available, quota: { ...available.quota, checkedAt: now + 2000 } }));
      expect(reads).toBe(3);
      expect(screen.getByText(/^1 of 20 API requests remaining/)).toBeVisible();
      expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
      expect(screen.getByRole("radio", { name: "Workspace API" })).toBeChecked();
    },
  );
});

describe("writing terminal quota refresh", () => {
  it.each(["refund", "complete"].flatMap((terminal) => ["success", "failure"].map((sample) => ({ terminal, sample }))))(
    "rechecks quota after $terminal when a post-reservation sample ends with $sample",
    async ({ terminal, sample }) => {
      vi.useFakeTimers();
      const original = mocks.api.getMockImplementation()!,
        now = Date.now();
      const older = deferred<AiStatus>(),
        fresh = deferred<AiStatus>(),
        done = deferred<void>();
      const available: AiStatus = {
        ...status,
        preference: "api",
        quota: { ...status.quota, remaining: 1, checkedAt: now, resetsAt: now + 86400000 },
      };
      let reads = 0;
      mocks.api.mockImplementation((url: string, options?: RequestInit) => {
        if (url !== "/api/ai/status") return original(url, options);
        reads++;
        if (reads === 1) return Promise.resolve(available);
        return reads === 2 ? older.promise : fresh.promise;
      });
      mocks.stream.mockImplementationOnce(
        async (_input: AiGenerate, _signal: AbortSignal, emit: (event: AiStreamEvent) => void) => {
          emit({
            type: "start",
            conversationId: "11111111-1111-4111-8111-111111111111",
            messageId: "last-request",
            sources: [source],
            changedPageIds: [],
            canApply: true,
            quota: { ...available.quota, remaining: 0 },
          });
          emit({ type: "delta", text: "Last allowed result" });
          await done.promise;
          emit(
            terminal === "refund"
              ? { type: "error", status: 429, code: "ai_provider_rejected", message: "Request refunded" }
              : { type: "complete" },
          );
        },
      );
      await act(async () => panel());
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate" })));
      await act(async () => {
        fireEvent(window, new Event("focus"));
        fireEvent(window, new Event("focus"));
      });
      expect(reads).toBe(2);
      await act(async () => done.resolve());
      if (sample === "failure") await act(async () => older.reject(new TypeError("Status failed")));
      else
        await act(async () =>
          older.resolve({
            ...available,
            connected: false,
            quota: { ...available.quota, remaining: terminal === "refund" ? 0 : 1, checkedAt: now + 1000 },
          }),
        );
      expect(reads).toBe(3);
      expect(screen.getByText(/^0 of 20 API requests remaining/)).toBeVisible();
      expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
      expect(screen.getByRole("radio", { name: "ChatGPT plan" })).toHaveProperty("disabled", sample === "success");
      await act(async () => {
        fireEvent(window, new Event("focus"));
        fireEvent(window, new Event("focus"));
      });
      expect(reads).toBe(3);
      await act(async () =>
        fresh.resolve({
          ...available,
          quota: { ...available.quota, remaining: terminal === "refund" ? 1 : 0, checkedAt: now + 2000 },
        }),
      );
      expect(screen.getByRole("button", { name: "Generate" })).toHaveProperty("disabled", terminal !== "refund");
      expect(
        screen.getByText(new RegExp(`^${terminal === "refund" ? 1 : 0} of 20 API requests remaining`)),
      ).toBeVisible();
      expect(screen.getByRole("radio", { name: "Workspace API" })).toBeChecked();
      await act(async () => vi.advanceTimersByTimeAsync(10000));
      expect(reads).toBe(3);
    },
  );
});

describe("writing refresh ownership", () => {
  it.each(["equal", "greater", "legacy", "failure"])(
    "fences a mid-generation pre-refund status with %s timestamp/outcome",
    async (ordering) => {
      vi.useFakeTimers();
      const original = mocks.api.getMockImplementation()!;
      const now = Date.now();
      const available: AiStatus = {
        ...status,
        preference: "api",
        quota: { ...status.quota, remaining: 1, checkedAt: now, resetsAt: now + 86400000 },
      };
      const older = deferred<AiStatus>(),
        fresh = deferred<AiStatus>(),
        done = deferred<void>();
      let reads = 0;
      mocks.api.mockImplementation((url: string, options?: RequestInit) => {
        if (url !== "/api/ai/status") return original(url, options);
        reads++;
        if (reads === 1) return Promise.resolve(available);
        return reads === 2 ? older.promise : fresh.promise;
      });
      mocks.stream.mockImplementationOnce(
        async (_input: AiGenerate, _signal: AbortSignal, emit: (event: AiStreamEvent) => void) => {
          emit({
            type: "start",
            conversationId: "11111111-1111-4111-8111-111111111111",
            messageId: "last-request",
            sources: [source],
            changedPageIds: [],
            canApply: true,
            quota: { ...available.quota, remaining: 0, checkedAt: now + 500 },
          });
          await done.promise;
          emit({ type: "error", status: 429, code: "ai_provider_rejected", message: "Request refunded" });
        },
      );
      await act(async () => panel());
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate" })));
      await act(async () => fireEvent(window, new Event("focus")));
      expect(reads).toBe(2);
      await act(async () => done.resolve());
      if (ordering === "failure") await act(async () => older.reject(new TypeError("Status failed")));
      else
        await act(async () =>
          older.resolve({
            ...available,
            quota: {
              ...available.quota,
              remaining: 0,
              checkedAt: ordering === "legacy" ? undefined : now + (ordering === "greater" ? 1000 : 500),
            },
          }),
        );
      expect(reads).toBe(3);
      expect(screen.getByText(/^0 of 20 API requests remaining/)).toBeVisible();
      expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
      await act(async () => fresh.resolve({ ...available, quota: { ...available.quota, checkedAt: now + 2000 } }));
      expect(screen.getByText(/^1 of 20 API requests remaining/)).toBeVisible();
      expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
      expect(reads).toBe(3);
    },
  );

  it.each([
    { boundary: "focus", first: "access" },
    { boundary: "focus", first: "history" },
    { boundary: "reveal", first: "access" },
    { boundary: "reveal", first: "history" },
    { boundary: "foreground", first: "access" },
    { boundary: "foreground", first: "history" },
  ])("upgrades terminal history across $boundary when $first finishes first", async ({ boundary, first }) => {
    const view = await completedPanel();
    vi.useFakeTimers();
    await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
    await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    const original = mocks.api.getMockImplementation()!;
    const history = deferred<ReturnType<typeof savedConversation>>(),
      fresh = deferred<ReturnType<typeof savedConversation>>(),
      access = deferred<unknown>();
    const local = savedConversation("# Improved writing\n\nClear **result**.");
    local.conversation.messages.push({ ...local.conversation.messages[0]!, id: "local", output: "Local follow-up" });
    const saved = {
      conversation: {
        ...local.conversation,
        messages: [
          ...local.conversation.messages,
          { ...local.conversation.messages[0]!, id: "remote", output: "Remote follow-up" },
        ],
      },
    };
    let reads = 0,
      accessReads = 0;
    mocks.api.mockImplementation((url: string, options?: RequestInit) => {
      if (url === `/api/ai/conversations/${view.saved.conversation.id}`)
        return ++reads === 1 ? history.promise : fresh.promise;
      if (url.endsWith("/access")) {
        accessReads++;
        return access.promise;
      }
      return original(url, options);
    });
    mocks.stream.mockImplementationOnce(
      async (_input: AiGenerate, _signal: AbortSignal, emit: (event: AiStreamEvent) => void) => {
        emit({
          type: "start",
          conversationId: view.saved.conversation.id,
          messageId: "local",
          sources: [source],
          changedPageIds: [],
          canApply: true,
          quota: status.quota,
        });
        emit({ type: "delta", text: "Local follow-up" });
        emit({ type: "complete" });
      },
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
    expect(reads).toBe(1);
    expect(view.preview()).toHaveTextContent("Local follow-up");
    if (boundary === "focus")
      await act(async () => {
        fireEvent(window, new Event("focus"));
        fireEvent(window, new Event("focus"));
      });
    else if (boundary === "reveal") {
      await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
      await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    } else {
      const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      await act(async () => fireEvent(document, new Event("visibilitychange")));
      hidden.mockReturnValue(false);
      await act(async () => fireEvent(document, new Event("visibilitychange")));
    }
    expect(accessReads).toBe(1);
    expect(reads).toBe(1);
    expect(screen.getByText("Checking conversation access…")).toBeVisible();
    expect(view.preview()).toBeNull();
    if (first === "history") await act(async () => history.resolve(local));
    expect(view.preview()).toBeNull();
    await act(async () => access.resolve({ locked: false, activeGeneration: null }));
    expect(reads).toBe(2);
    expect(screen.getByText("Checking conversation access…")).toBeVisible();
    await act(async () => {
      fireEvent(window, new Event("focus"));
      fireEvent(window, new Event("focus"));
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reads).toBe(2);
    expect(accessReads).toBe(1);
    await act(async () => fresh.resolve(saved));
    expect(screen.queryByText("Checking conversation access…")).toBeNull();
    expect(view.preview()).toHaveTextContent("Remote follow-up");
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
    await act(async () => history.resolve(local));
    expect(screen.getByText("Conversation (3 requests)")).toBeVisible();
    expect(view.preview()).toHaveTextContent("Remote follow-up");
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(reads).toBe(2);
  });

  it("restores hidden content on the first poll after delayed stream cleanup", async () => {
    const view = await completedPanel();
    vi.useFakeTimers();
    await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
    await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    const original = mocks.api.getMockImplementation()!;
    const stream = deferred<void>();
    const recovered = savedConversation("Recovered server result");
    recovered.conversation.messages[0]!.id = "recovered";
    let locked = true,
      reads = 0;
    mocks.api.mockImplementation((url: string, options?: RequestInit) => {
      if (url === `/api/ai/conversations/${view.saved.conversation.id}`) {
        reads++;
        return Promise.resolve(recovered);
      }
      if (url.endsWith("/access")) return Promise.resolve({ locked, activeGeneration: null });
      return original(url, options);
    });
    mocks.stream.mockImplementationOnce(
      (_input: AiGenerate, _signal: AbortSignal, emit: (event: AiStreamEvent) => void) => {
        emit({
          type: "start",
          conversationId: view.saved.conversation.id,
          messageId: "running",
          sources: [source],
          changedPageIds: [],
          canApply: true,
          quota: status.quota,
        });
        return stream.promise;
      },
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
    await act(async () => fireEvent(window, new Event("focus")));
    expect(view.preview()).toBeNull();
    expect((mocks.stream.mock.calls.at(-1)![1] as AbortSignal).aborted).toBe(true);
    locked = false;
    await act(async () => fireEvent(window, new Event("focus")));
    expect(reads).toBe(0);
    await act(async () => stream.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(1);
    expect(view.preview()).toHaveTextContent("Recovered server result");
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(1);
  });

  it("rejects a local read from before a new generation and synchronizes its terminal history", async () => {
    const view = await completedPanel();
    const original = mocks.api.getMockImplementation()!;
    const stale = deferred<ReturnType<typeof savedConversation>>(),
      terminal = deferred<ReturnType<typeof savedConversation>>();
    let reads = 0;
    mocks.api.mockImplementation((url: string, options?: RequestInit) =>
      url === `/api/ai/conversations/${view.saved.conversation.id}`
        ? ++reads === 1
          ? stale.promise
          : terminal.promise
        : original(url, options),
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
    expect(reads).toBe(2);
    const saved = savedConversation("# Improved writing\n\nClear **result**.");
    saved.conversation.messages.push({
      ...saved.conversation.messages[0]!,
      id: "terminal",
      output: "Saved terminal history",
    });
    await act(async () => terminal.resolve(saved));
    await act(async () => stale.resolve(savedConversation("Obsolete generation history")));
    expect(screen.getByText("Conversation (2 requests)")).toBeVisible();
    expect(screen.queryByText("Obsolete generation history")).toBeNull();
    expect(view.preview()).toHaveTextContent("Improved writing");
  });

  it("retains passive refresh intent across a failed open and a new generation", async () => {
    const view = await completedPanel();
    vi.useFakeTimers();
    await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
    await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    const original = mocks.api.getMockImplementation()!;
    const saved = savedConversation("Latest server result");
    saved.conversation.messages[0]!.id = "remote";
    let reads = 0;
    mocks.api.mockImplementation((url: string, options?: RequestInit) => {
      if (url.endsWith("/other/open")) return Promise.reject(new TypeError("Open failed"));
      if (url === `/api/ai/conversations/${view.saved.conversation.id}`)
        return ++reads === 1 ? Promise.reject(new TypeError("Passive read failed")) : Promise.resolve(saved);
      return original(url, options);
    });
    await act(async () => fireEvent(window, new Event("focus")));
    expect(reads).toBe(1);
    await act(async () =>
      view.rerender(
        <WritingPanel {...view.props} launchRequest={{ id: "failed-open", pageId: "doc", conversationId: "other" }} />,
      ),
    );
    expect(screen.getByRole("button", { name: "Generate follow-up" })).toBeEnabled();
    mocks.stream.mockRejectedValueOnce(new TypeError("Dispatch failed"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
    expect(reads).toBe(2);
    expect(view.preview()).toHaveTextContent("Latest server result");
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
  });

  it("supersedes a slow local read immediately when a remote generation completes", async () => {
    const view = await completedPanel();
    vi.useFakeTimers();
    await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
    await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    const original = mocks.api.getMockImplementation()!;
    const local = deferred<ReturnType<typeof savedConversation>>(),
      fresh = deferred<ReturnType<typeof savedConversation>>();
    let active = true,
      reads = 0;
    mocks.api.mockImplementation((url: string, options?: RequestInit) => {
      if (url === `/api/ai/conversations/${view.saved.conversation.id}`)
        return ++reads === 1 ? local.promise : fresh.promise;
      if (url.endsWith("/access"))
        return Promise.resolve({
          locked: false,
          activeGeneration: active ? { messageId: "remote", createdAt: 1, deadlineAt: 330001 } : null,
        });
      return original(url, options);
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(1);
    active = false;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(2);
    expect(screen.getByText("Checking conversation access…")).toBeVisible();
    await act(async () => local.resolve(savedConversation("Obsolete local history")));
    expect(screen.queryByText("Obsolete local history")).toBeNull();
    expect(screen.getByText("Checking conversation access…")).toBeVisible();
    const saved = savedConversation("Remote result");
    saved.conversation.messages[0]!.id = "remote";
    await act(async () => fresh.resolve(saved));
    expect(view.preview()).toHaveTextContent("Remote result");
    expect(screen.queryByText("Checking conversation access…")).toBeNull();
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(reads).toBe(2);
  });
});

describe("writing history during apply", () => {
  it.each(["before", "after"])(
    "supersedes local history that settles %s an apply with a queued passive refresh",
    async (timing) => {
      const view = await completedPanel();
      vi.useFakeTimers();
      await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
      await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
      const original = mocks.api.getMockImplementation()!;
      const local = deferred<ReturnType<typeof savedConversation>>(),
        applied = deferred<{ contentEpoch: number; protectedBlockIds: string[] }>();
      const saved = savedConversation("New server result");
      saved.conversation.messages[0]!.id = "remote-follow-up";
      let reads = 0;
      mocks.api.mockImplementation((url: string, options?: RequestInit) => {
        if (url.endsWith("apply-check")) return applied.promise;
        if (url === `/api/ai/conversations/${view.saved.conversation.id}`)
          return ++reads === 1 ? local.promise : Promise.resolve(saved);
        return original(url, options);
      });
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
      expect(reads).toBe(1);
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Replace" })));
      await act(async () => fireEvent(window, new Event("focus")));
      if (timing === "before") await act(async () => local.resolve(savedConversation("Obsolete local history")));
      expect(view.preview()).toHaveTextContent("Improved writing");
      expect(reads).toBe(1);
      await act(async () => applied.resolve({ contentEpoch: 1, protectedBlockIds: [] }));
      expect(view.apply).toHaveBeenCalledWith(
        target,
        "# Improved writing\n\nClear **result**.",
        "replace",
        1,
        new Set(),
      );
      await act(async () => local.resolve(savedConversation("Obsolete local history")));
      expect(reads).toBe(2);
      expect(view.preview()).toHaveTextContent("New server result");
      expect(screen.queryByText("Obsolete local history")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(10000));
      expect(reads).toBe(2);
    },
  );

  it.each(
    ["focus", "reveal", "foreground", "hidden"].flatMap((boundary) =>
      ["success", "failure"].map((outcome) => ({ boundary, outcome })),
    ),
  )("refreshes saved history after $boundary during apply ends with $outcome", async ({ boundary, outcome }) => {
    const view = await completedPanel();
    vi.useFakeTimers();
    await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
    await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    const original = mocks.api.getMockImplementation()!;
    const applied = deferred<{ contentEpoch: number; protectedBlockIds: string[] }>();
    let reads = 0;
    mocks.api.mockImplementation((url: string, options?: RequestInit) => {
      if (url.endsWith("apply-check")) return applied.promise;
      if (url === `/api/ai/conversations/${view.saved.conversation.id}`) reads++;
      return original(url, options);
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Replace" })));
    view.saved.conversation.messages.push({
      ...view.saved.conversation.messages[0]!,
      id: "remote-follow-up",
      output: "# Remote follow-up",
    });
    await act(async () => {
      if (boundary === "focus" || boundary === "hidden") fireEvent(window, new Event("focus"));
      else if (boundary === "reveal") view.rerender(<WritingPanel {...view.props} visible={false} />);
      else {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        fireEvent(document, new Event("visibilitychange"));
      }
    });
    if (boundary === "reveal" || boundary === "foreground")
      await act(async () => {
        if (boundary === "reveal") view.rerender(<WritingPanel {...view.props} visible />);
        else {
          vi.spyOn(document, "hidden", "get").mockReturnValue(false);
          fireEvent(document, new Event("visibilitychange"));
        }
      });
    expect(reads).toBe(0);
    expect(view.apply).not.toHaveBeenCalled();
    expect(view.preview()).toHaveTextContent("Improved writing");
    if (boundary === "hidden") await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
    await act(async () =>
      outcome === "success"
        ? applied.resolve({ contentEpoch: 1, protectedBlockIds: [] })
        : applied.reject(new TypeError("Application unavailable")),
    );
    expect(view.apply.mock.calls).toEqual(
      outcome === "success" ? [[target, "# Improved writing\n\nClear **result**.", "replace", 1, new Set()]] : [],
    );
    expect(reads).toBe(boundary === "hidden" ? 0 : 1);
    if (boundary === "hidden") {
      await act(async () => vi.advanceTimersByTimeAsync(10000));
      await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    }
    expect(reads).toBe(1);
    expect(view.preview()).toHaveTextContent("Remote follow-up");
    expect(screen.queryByRole("alert")?.textContent ?? null).toBe(
      outcome === "failure" ? "The result could not be applied." : null,
    );
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(reads).toBe(1);
  });

  it("defers an override-changing saved result until an in-flight apply finishes", async () => {
    const view = await restoredPanel();
    vi.useFakeTimers();
    await act(async () => view.rerender(<WritingPanel {...view.props} visible={false} />));
    await act(async () => view.rerender(<WritingPanel {...view.props} visible />));
    const original = mocks.api.getMockImplementation()!;
    const history = deferred<ReturnType<typeof savedConversation>>();
    const applied = deferred<{ contentEpoch: number; protectedBlockIds: string[] }>();
    const saved = savedConversation("New server result");
    let reads = 0;
    mocks.api.mockImplementation((url: string, options?: RequestInit) => {
      if (url.endsWith("apply-check")) return applied.promise;
      if (url === `/api/ai/conversations/${view.saved.conversation.id}`)
        return ++reads === 1 ? history.promise : Promise.resolve(saved);
      return original(url, options);
    });
    // A pre-start failure preserves the recovered draft and schedules a saved-history read.
    mocks.stream.mockRejectedValueOnce(new TypeError("Dispatch failed"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Generate follow-up" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Replace" })));
    await act(async () => history.resolve(saved));
    expect(reads).toBe(1);
    expect(view.preview()).toHaveTextContent("Improved writing");
    expect(view.preview()).not.toHaveTextContent("New server result");
    await act(async () => applied.resolve({ contentEpoch: 1, protectedBlockIds: [] }));
    expect(view.apply).toHaveBeenCalledWith(target, "# Improved writing\n\nClear **result**.", "replace", 1, new Set());
    expect(reads).toBe(2);
    expect(view.preview()).toHaveTextContent("New server result");
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(reads).toBe(2);
  });
});
