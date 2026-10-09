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
function panel(editable = true, ready = true) {
  const apply = vi.fn(),
    capture = vi.fn(() => target);
  const props = {
    pageId: "doc",
    initialTarget: target,
    onCapture: capture,
    onApply: apply,
    onClose: vi.fn(),
    editable,
    ready: () => ready,
  };
  const view = render(<WritingPanel {...props} />);
  return { apply, capture, props, ...view };
}
describe("writing UI", () => {
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
          conversationId="11111111-1111-4111-8111-111111111111"
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
    expect(screen.getByRole("heading", { name: "Improved writing" })).toBeVisible();
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
    await act(async () => view.rerender(<WritingPanel {...view.props} subscribeReadiness={subscribe} visible />));
    expect(screen.getByLabelText("Writing instruction")).toHaveValue("Retained instruction");
    expect(screen.getByLabelText("Writing result")).toHaveTextContent("Hidden work");
    fireEvent.change(screen.getByLabelText("Writing instruction"), { target: { value: "Another instruction" } });
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
  it("does not reparse unchanged history or poll access in a background browser document", async () => {
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
    expect(parser.mock.calls.filter(([text]) => text === "Historical output")).toHaveLength(2);
  });
  it("keeps provider model controls owner-only and never exposes an API credential field", async () => {
    render(<WritingSettings owner={false} />);
    expect(await screen.findByText("Connected: member@example.test")).toBeVisible();
    expect(screen.queryByText("Workspace writing controls")).toBeNull();
    expect(screen.queryByLabelText(/key/i)).toBeNull();
  });
});
