// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiGenerate, AiStatus, AiStreamEvent } from "../shared/ai";
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
          id: "conversation",
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
        conversationId: "conversation",
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
afterEach(() => vi.restoreAllMocks());
function panel(editable = true, ready = true) {
  const apply = vi.fn(),
    capture = vi.fn(() => target);
  render(
    <WritingPanel
      pageId="doc"
      initialTarget={target}
      onCapture={capture}
      onApply={apply}
      onClose={vi.fn()}
      editable={editable}
      ready={() => ready}
    />,
  );
  return { apply, capture };
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
          conversationId: "conversation",
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
            ? { conversation: { id: "conversation", pageId: "doc", locked: true } }
            : { fast: true, best: false },
    );
    await act(async () =>
      render(
        <WritingPanel
          pageId="doc"
          initialTarget={target}
          conversationId="conversation"
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
  it("keeps provider model controls owner-only and never exposes an API credential field", async () => {
    render(<WritingSettings owner={false} />);
    expect(await screen.findByText("Connected: member@example.test")).toBeVisible();
    expect(screen.queryByText("Workspace writing controls")).toBeNull();
    expect(screen.queryByLabelText(/key/i)).toBeNull();
  });
});
