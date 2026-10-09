// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PluginDocument, PluginSpaces } from "../shared/plugin-contracts";
import { PluginToolError, type CreateInput, type PluginApi, type SaveInput } from "./api";
import { PluginApp } from "./PluginApp";
import { MarkdownPreview } from "./MarkdownPreview";

const document: PluginDocument = {
  id: "doc",
  title: "Project notes",
  url: "https://notes.example/?page=doc",
  spaceId: "space",
  parentId: null,
  markdown: "Original text",
  revision: 4,
  contentEpoch: 2,
  truncated: false,
  unknownBlockIds: [],
  canEdit: true,
};
function fixture(overrides: Partial<PluginDocument> = {}, permissions = true) {
  const page = { ...document, ...overrides };
  let stored = page;
  const spaces: PluginSpaces = {
    workspace: { id: "wiki", name: "Test wiki" },
    scopes: ["pages:read", "pages:write"],
    spaces: [{ id: "space", name: "Private test", canEdit: permissions }],
  };
  const api = {
    spaces: vi.fn().mockResolvedValue(spaces),
    pages: vi.fn().mockResolvedValue({ pages: [{ ...page, kind: "document" }], nextCursor: null }),
    search: vi
      .fn()
      .mockResolvedValue({ pages: [{ ...page, kind: "document", snippet: "Original" }], nextCursor: null }),
    document: vi.fn().mockImplementation(async (_id: string) => stored),
    create: vi.fn().mockImplementation(async (input: CreateInput) => {
      stored = { ...page, title: input.title, markdown: input.markdown, revision: 1, contentEpoch: 1 };
      return { id: page.id, title: input.title, url: page.url, revision: 1, operationId: input.operation_id };
    }),
    save: vi.fn().mockImplementation(async (input: SaveInput) => {
      stored = {
        ...stored,
        revision: input.expected_revision + 1,
        contentEpoch: input.expected_content_epoch,
        markdown: input.command.replace_content.new_str,
      };
      return {
        id: input.page_id,
        title: stored.title,
        url: stored.url,
        revision: stored.revision,
        operationId: input.operation_id,
      };
    }),
    context: vi.fn().mockResolvedValue(undefined),
    link: vi.fn().mockResolvedValue(undefined),
  } satisfies PluginApi;
  return { api, page };
}
async function edit(api: PluginApi) {
  render(<PluginApp api={api} initialPageId="doc" />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
  fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "My unsaved draft" } });
}
async function beginCreate() {
  const button = screen.getByRole("button", { name: "New document" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("NoteFlare embedded editor", () => {
  it("browses and searches documents and shares page identity on open", async () => {
    const { api, page } = fixture();
    render(<PluginApp api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Project notes" }));
    expect(await screen.findByRole("heading", { name: "Project notes" })).toBeVisible();
    expect(api.context).toHaveBeenCalledWith(page, "");
    fireEvent.change(screen.getByLabelText("Search wiki"), { target: { value: "Original" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(api.search).toHaveBeenCalledWith("Original", undefined));
  });

  it("saves with the fetched revision and epoch and reuses the operation ID after a failed response", async () => {
    const { api, page } = fixture();
    api.save.mockRejectedValueOnce(new PluginToolError("Try again", "document_busy", true));
    await edit(api);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try again");
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("My unsaved draft");
    api.document.mockResolvedValue({ ...page, revision: 5, markdown: "My unsaved draft" });
    fireEvent.click(screen.getByRole("button", { name: "Retry previous save" }));
    await screen.findByText("Document saved.");
    const input = api.save.mock.calls[0]![0];
    expect(input).toMatchObject({
      expected_revision: 4,
      expected_content_epoch: 2,
      command: { type: "replace_content", replace_content: { new_str: "My unsaved draft" } },
    });
    expect(api.save.mock.calls[1]![0]).toEqual(input);
  });

  it("preserves a stale draft until the user explicitly reconciles it with the current document", async () => {
    const { api, page } = fixture();
    api.save.mockRejectedValueOnce(new PluginToolError("The document changed", "page_changed", false));
    await edit(api);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Your draft is preserved/);
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("My unsaved draft");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(api.save).toHaveBeenCalledTimes(1);
    api.document.mockResolvedValue({ ...page, revision: 8, contentEpoch: 3, markdown: "Someone else’s edit" });
    fireEvent.click(screen.getByRole("button", { name: "Review current version" }));
    await screen.findByText("Someone else’s edit");
    fireEvent.click(screen.getByRole("button", { name: "I’ve reconciled my draft" }));
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("My unsaved draft");
    api.document.mockResolvedValue({ ...page, revision: 9, contentEpoch: 3, markdown: "My unsaved draft" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Document saved.");
    expect(api.save.mock.calls[1]![0]).toMatchObject({ expected_revision: 8, expected_content_epoch: 3 });
    expect(api.save.mock.calls[1]![0].operation_id).not.toBe(api.save.mock.calls[0]![0].operation_id);
  });

  it("guards navigation, can keep editing, and discards only on an explicit choice", async () => {
    const { api } = fixture();
    await edit(api);
    fireEvent.click(screen.getByRole("button", { name: "Space roots" }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(api.pages).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("My unsaved draft");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard and continue" }));
    await waitFor(() => expect(screen.queryByLabelText("Markdown draft")).not.toBeInTheDocument());
    expect(api.save).not.toHaveBeenCalled();
  });

  it("reloads a conflicted document only after the user chooses to discard the draft", async () => {
    const { api, page } = fixture();
    api.save.mockRejectedValue(new PluginToolError("Changed", "page_changed", false));
    await edit(api);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Your draft is preserved/);
    api.document.mockResolvedValue({ ...page, revision: 8, markdown: "Current content" });
    fireEvent.click(screen.getByRole("button", { name: "Reload document" }));
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeDisabled();
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("My unsaved draft");
    fireEvent.click(screen.getByRole("button", { name: "Discard and continue" }));
    expect(await screen.findByText("Current content")).toBeVisible();
    expect(api.save).toHaveBeenCalledTimes(1);
  });

  it("saves before navigating and creates in the browsed parent", async () => {
    const { api } = fixture();
    await edit(api);
    fireEvent.click(screen.getByRole("button", { name: "Browse children of Project notes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(api.pages).toHaveBeenCalledWith("space", "doc"));
    fireEvent.click(screen.getByRole("button", { name: "New document" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "New notes" } });
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "New content" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({ space_id: "space", parent_id: "doc", title: "New notes", markdown: "New content" }),
      ),
    );
  });

  it.each([{ canEdit: false }, { truncated: true }, { markdown: "x".repeat(65_536) }])(
    "keeps protected or oversized documents readable without enabling edits: %j",
    async (overrides) => {
      const { api } = fixture(overrides, false);
      render(<PluginApp api={api} initialPageId="doc" />);
      expect(await screen.findByRole("button", { name: "Edit Markdown" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "New document" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: /Open in NoteFlare/ }));
      expect(api.link).toHaveBeenCalledWith(document.url);
    },
  );

  it("explains rejected protected edits and preserves the draft", async () => {
    const { api } = fixture({ unknownBlockIds: ["attachment"] });
    api.save.mockRejectedValue(
      new PluginToolError("This edit would remove a protected comment anchor", "invalid_markdown", false),
    );
    await edit(api);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("protected comment anchor");
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("My unsaved draft");
    expect(screen.getByRole("button", { name: /Open in NoteFlare/ })).toBeEnabled();
  });

  it("shares selected text but does not share subsequent typing", async () => {
    const { api, page } = fixture();
    await edit(api);
    expect(api.context).toHaveBeenCalledTimes(1);
    const draft = screen.getByLabelText<HTMLTextAreaElement>("Markdown draft");
    draft.setSelectionRange(3, 10);
    fireEvent.select(draft);
    await waitFor(() => expect(api.context).toHaveBeenLastCalledWith(page, "unsaved"));
  });

  it("starts a fresh edit from the saved content after Cancel then Save and continue", async () => {
    const { api, page } = fixture();
    await edit(api);
    api.document.mockResolvedValue({ ...page, markdown: "My unsaved draft", revision: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(screen.queryByLabelText("Markdown draft")).not.toBeInTheDocument());
    expect(screen.getByText("My unsaved draft")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Edit Markdown" }));
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("My unsaved draft");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("ignores an older host response after the current page has an unsaved draft", async () => {
    const { api, page } = fixture();
    const view = render(<PluginApp api={api} initialPageId="doc" />);
    await screen.findByRole("button", { name: "Edit Markdown" });
    const earlier = deferred<PluginDocument>();
    const later = { ...page, id: "later", title: "Later document", markdown: "Later content" };
    api.document.mockImplementation((id: string) => (id === "earlier" ? earlier.promise : Promise.resolve(later)));
    view.rerender(<PluginApp api={api} initialPageId="earlier" />);
    await waitFor(() => expect(api.document).toHaveBeenCalledWith("earlier"));
    view.rerender(<PluginApp api={api} initialPageId="later" />);
    await screen.findByRole("heading", { name: "Later document" });
    fireEvent.click(screen.getByRole("button", { name: "Edit Markdown" }));
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Unsaved on Later" } });
    await act(async () => earlier.resolve({ ...page, id: "earlier", title: "Earlier document" }));
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("Unsaved on Later");
    expect(screen.getByRole("heading", { name: "Later document" })).toBeVisible();
    expect(api.context).toHaveBeenLastCalledWith(later, "");
  });

  it.each(["success", "failure"])("keeps the latest host request busy after an older %s", async (outcome) => {
    const { api, page } = fixture();
    const view = render(<PluginApp api={api} initialPageId="doc" />);
    await screen.findByRole("button", { name: "Edit Markdown" });
    const earlier = deferred<PluginDocument>();
    const later = deferred<PluginDocument>();
    api.document.mockImplementation((id: string) => (id === "earlier" ? earlier.promise : later.promise));
    view.rerender(<PluginApp api={api} initialPageId="earlier" />);
    view.rerender(<PluginApp api={api} initialPageId="later" />);
    await act(async () => {
      if (outcome === "success") earlier.resolve({ ...page, id: "earlier", title: "Earlier document" });
      else earlier.reject(new Error("Old request failed"));
    });
    expect(screen.getByRole("button", { name: "Edit Markdown" })).toBeDisabled();
    expect(screen.getByText("Loading NoteFlare…")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.context).toHaveBeenCalledTimes(1);
    await act(async () => later.resolve({ ...page, id: "later", title: "Latest document" }));
    expect(screen.getByRole("heading", { name: "Latest document" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit Markdown" })).toBeEnabled();
  });

  it("ignores an old error after the latest host page opens", async () => {
    const { api, page } = fixture();
    const view = render(<PluginApp api={api} initialPageId="doc" />);
    await screen.findByRole("button", { name: "Edit Markdown" });
    const earlier = deferred<PluginDocument>();
    api.document.mockImplementation((id: string) =>
      id === "earlier" ? earlier.promise : Promise.resolve({ ...page, id: "later", title: "Latest document" }),
    );
    view.rerender(<PluginApp api={api} initialPageId="earlier" />);
    view.rerender(<PluginApp api={api} initialPageId="later" />);
    await screen.findByRole("heading", { name: "Latest document" });
    await act(async () => earlier.reject(new Error("Old request failed")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Markdown" })).toBeEnabled();
  });

  it("uses the latest host page when the spaces bootstrap finishes", async () => {
    const { api, page } = fixture();
    const spaces = deferred<PluginSpaces>();
    const available = await api.spaces();
    api.spaces.mockReturnValue(spaces.promise);
    api.document.mockResolvedValue({ ...page, id: "latest", title: "Latest document" });
    const view = render(<PluginApp api={api} initialPageId="earlier" />);
    view.rerender(<PluginApp api={api} initialPageId="latest" />);
    await act(async () => spaces.resolve(available));
    await screen.findByRole("heading", { name: "Latest document" });
    expect(api.document).toHaveBeenCalledExactlyOnceWith("latest");
    expect(api.context).toHaveBeenCalledExactlyOnceWith({ ...page, id: "latest", title: "Latest document" }, "");
  });

  it("supersedes a pending initial document with the latest host page", async () => {
    const { api, page } = fixture();
    const earlier = deferred<PluginDocument>();
    api.document.mockImplementation((id: string) =>
      id === "earlier" ? earlier.promise : Promise.resolve({ ...page, id: "latest", title: "Latest document" }),
    );
    const view = render(<PluginApp api={api} initialPageId="earlier" />);
    await waitFor(() => expect(api.document).toHaveBeenCalledWith("earlier"));
    view.rerender(<PluginApp api={api} initialPageId="latest" />);
    await screen.findByRole("heading", { name: "Latest document" });
    await act(async () => earlier.resolve({ ...page, id: "earlier", title: "Earlier document" }));
    expect(screen.getByRole("heading", { name: "Latest document" })).toBeVisible();
    expect(api.context).toHaveBeenCalledTimes(1);
  });

  it("supersedes the bootstrap listing without losing the latest document or navigation", async () => {
    const { api, page } = fixture();
    const earlier = deferred<Awaited<ReturnType<PluginApi["pages"]>>>();
    api.pages.mockReturnValueOnce(earlier.promise);
    const view = render(<PluginApp api={api} />);
    await waitFor(() => expect(api.pages).toHaveBeenCalledWith("space", undefined));
    api.document.mockResolvedValue({ ...page, id: "latest", title: "Latest document" });
    view.rerender(<PluginApp api={api} initialPageId="latest" />);
    await screen.findByRole("heading", { name: "Latest document" });
    await act(async () => earlier.resolve({ pages: [], nextCursor: null }));
    expect(screen.getByRole("heading", { name: "Latest document" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Project notes" })).toBeVisible();
    expect(api.context).toHaveBeenCalledTimes(1);
  });

  it("supersedes a pending local browse with host navigation", async () => {
    const { api, page } = fixture();
    const view = render(<PluginApp api={api} initialPageId="doc" />);
    await screen.findByRole("button", { name: "Edit Markdown" });
    const children = deferred<Awaited<ReturnType<PluginApi["pages"]>>>();
    api.pages.mockReturnValue(children.promise);
    fireEvent.click(screen.getByRole("button", { name: "Browse children of Project notes" }));
    api.document.mockResolvedValue({ ...page, id: "latest", title: "Latest document" });
    view.rerender(<PluginApp api={api} initialPageId="latest" />);
    await screen.findByRole("heading", { name: "Latest document" });
    fireEvent.click(screen.getByRole("button", { name: "Edit Markdown" }));
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Keep this draft" } });
    await act(async () => children.resolve({ pages: [], nextCursor: null }));
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("Keep this draft");
    expect(api.context).toHaveBeenCalledTimes(2);
  });

  it("supersedes a pending local open with host navigation", async () => {
    const { api, page } = fixture();
    const view = render(<PluginApp api={api} />);
    const earlier = deferred<PluginDocument>();
    api.document.mockReturnValueOnce(earlier.promise);
    fireEvent.click(await screen.findByRole("button", { name: "Project notes" }));
    api.document.mockResolvedValue({ ...page, id: "latest", title: "Latest document" });
    view.rerender(<PluginApp api={api} initialPageId="latest" />);
    await screen.findByRole("heading", { name: "Latest document" });
    await act(async () => earlier.resolve(page));
    expect(screen.getByRole("heading", { name: "Latest document" })).toBeVisible();
    expect(api.context.mock.calls.some(([shared]) => shared?.id === "doc")).toBe(false);
  });

  it("retains the dirty draft when host navigation is declined", async () => {
    const { api } = fixture();
    const view = render(<PluginApp api={api} initialPageId="doc" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Keep this draft" } });
    view.rerender(<PluginApp api={api} initialPageId="latest" />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("Keep this draft");
    expect(api.document).toHaveBeenCalledExactlyOnceWith("doc");
  });

  it("retains the operation ID when host navigation interrupts an uncertain save", async () => {
    const { api, page } = fixture();
    const view = render(<PluginApp api={api} initialPageId="doc" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Keep this draft" } });
    const write = deferred<Awaited<ReturnType<PluginApi["save"]>>>();
    api.save.mockReturnValueOnce(write.promise);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    view.rerender(<PluginApp api={api} initialPageId="latest" />);
    await screen.findByRole("dialog");
    await act(async () => write.reject(new Error("The save outcome is unknown.")));
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("Keep this draft");
    expect(api.document).toHaveBeenCalledExactlyOnceWith("doc");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    api.document.mockResolvedValue({ ...page, markdown: "Keep this draft", revision: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Retry previous save" }));
    await screen.findByText("Document saved.");
    expect(api.save.mock.calls[1]![0]).toEqual(api.save.mock.calls[0]![0]);
  });

  it("records an interrupted create, preserves newer typing, and updates the created page next", async () => {
    const { api, page } = fixture();
    const write = deferred<Awaited<ReturnType<PluginApi["create"]>>>();
    api.create.mockReturnValueOnce(write.promise);
    const view = render(<PluginApp api={api} />);
    await beginCreate();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Created notes" } });
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Submitted text" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    view.rerender(<PluginApp api={api} initialPageId="latest" />);
    expect(await screen.findByText(/cannot undo a save/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save and continue" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.getByLabelText("Markdown draft")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Newer text" } });
    fireEvent.click(screen.getByRole("button", { name: "Retry previous save" }));
    expect(api.create).toHaveBeenCalledTimes(1);
    api.document.mockResolvedValue({
      ...page,
      id: "created",
      title: "Created notes",
      markdown: "Submitted text",
      revision: 1,
      contentEpoch: 1,
    });
    await act(async () =>
      write.resolve({ id: "created", title: "Created notes", url: page.url, revision: 1, operationId: "create" }),
    );
    await screen.findByText("Previous save confirmed. Your newer changes are still unsaved.");
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("Newer text");
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
    api.document.mockResolvedValue({
      ...page,
      id: "created",
      title: "Created notes",
      markdown: "Newer text",
      revision: 2,
      contentEpoch: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Document saved.");
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ page_id: "created", expected_revision: 1, expected_content_epoch: 1 }),
    );
    expect(api.document.mock.calls.some(([id]) => id === "latest")).toBe(false);
  });

  it("keeps newer text and uses the acknowledged revision after host navigation interrupts an update", async () => {
    const { api, page } = fixture();
    const write = deferred<Awaited<ReturnType<PluginApi["save"]>>>();
    const view = render(<PluginApp api={api} initialPageId="doc" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Submitted text" } });
    api.save.mockReturnValueOnce(write.promise);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    view.rerender(<PluginApp api={api} initialPageId="latest" />);
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Newer text" } });
    api.document.mockResolvedValue({ ...page, markdown: "Submitted text", revision: 5 });
    await act(async () =>
      write.resolve({ id: page.id, title: page.title, url: page.url, revision: 5, operationId: "update" }),
    );
    await screen.findByText("Previous save confirmed. Your newer changes are still unsaved.");
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("Newer text");
    api.document.mockResolvedValue({ ...page, markdown: "Newer text", revision: 6 });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Document saved.");
    expect(api.save.mock.calls[1]![0]).toMatchObject({
      expected_revision: 5,
      expected_content_epoch: 2,
      command: { replace_content: { new_str: "Newer text" } },
    });
  });

  it.each(["create", "update"] as const)(
    "retries an uncertain %s with the original input despite newer edits",
    async (kind) => {
      const { api, page } = fixture();
      if (kind === "create") {
        render(<PluginApp api={api} />);
        await beginCreate();
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Created notes" } });
        api.create.mockRejectedValueOnce(new PluginToolError("Outcome unknown", "page_create_unknown", false));
      } else {
        await edit(api);
        api.save.mockRejectedValueOnce(new PluginToolError("Outcome unknown", "mcp_access_denied", false));
      }
      fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Submitted text" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Outcome unknown");
      expect(screen.queryByLabelText("Title")?.hasAttribute("disabled") ?? false).toBe(kind === "create");
      fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Newer text" } });
      fireEvent.click(screen.getByRole("button", { name: "Retry previous save" }));
      await screen.findByText("Previous save confirmed. Your newer changes are still unsaved.");
      expect(screen.getByLabelText("Markdown draft")).toHaveValue("Newer text");
      const calls = kind === "create" ? api.create.mock.calls : api.save.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[1]![0]).toEqual(calls[0]![0]);
      expect(kind === "create" ? api.save : api.create).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      expect(api.context).toHaveBeenLastCalledWith(expect.objectContaining({ id: page.id }), "");
    },
  );

  it.each(["create", "update"] as const)("retries only the fetch after an acknowledged %s", async (kind) => {
    const { api } = fixture();
    if (kind === "create") {
      render(<PluginApp api={api} />);
      await beginCreate();
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Created notes" } });
      fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Submitted text" } });
    } else await edit(api);
    api.document.mockRejectedValueOnce(new Error("Refresh failed"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Refresh failed");
    expect(screen.queryByLabelText("Title")?.hasAttribute("disabled") ?? false).toBe(kind === "create");
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Newer text" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved document" }));
    await screen.findByText("Previous save confirmed. Your newer changes are still unsaved.");
    expect(kind === "create" ? api.create : api.save).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("Newer text");
  });

  it("does not continue navigation after confirming an older save while newer text remains unsaved", async () => {
    const { api } = fixture();
    api.save.mockRejectedValueOnce(new Error("Unknown outcome"));
    await edit(api);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Unknown outcome");
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Newer text" } });
    fireEvent.click(screen.getByRole("button", { name: "Space roots" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save and continue" }));
    await screen.findByText("Previous save confirmed. Your newer changes are still unsaved.");
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("Newer text");
    expect(api.pages).toHaveBeenCalledTimes(2); // Bootstrap and refresh, without running the pending browse.
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.save).toHaveBeenCalledTimes(3);
    expect(api.save.mock.calls[2]![0]).toMatchObject({
      expected_revision: 5,
      command: { replace_content: { new_str: "Newer text" } },
    });
  });

  it.each([
    { revision: 6, contentEpoch: 2 },
    { revision: 5, contentEpoch: 3 },
  ])("requires reconciliation when a save refresh finds remote changes: %j", async (version) => {
    const { api, page } = fixture();
    await edit(api);
    api.document.mockResolvedValue({ ...page, ...version, markdown: "Remote text" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/the document changed again/);
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("My unsaved draft");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText("Remote text")).toBeVisible();
    expect(api.save).toHaveBeenCalledTimes(1);
  });

  it("requires reconciliation when a created page was reset before its acknowledged refresh", async () => {
    const { api, page } = fixture();
    render(<PluginApp api={api} />);
    await beginCreate();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Created notes" } });
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "My new text" } });
    api.document.mockResolvedValue({ ...page, revision: 1, contentEpoch: 2, markdown: "Reset text" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/the document changed again/);
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("My new text");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("adopts canonical saved Markdown when no newer edits were made", async () => {
    const { api, page } = fixture();
    await edit(api);
    api.document.mockResolvedValue({ ...page, revision: 5, markdown: "Canonical Markdown\n" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Document saved.");
    fireEvent.click(screen.getByRole("button", { name: "Edit Markdown" }));
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("Canonical Markdown\n");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it.each(["success", "failure"])("isolates an abandoned create after a late %s", async (outcome) => {
    const { api, page } = fixture();
    const write = deferred<Awaited<ReturnType<PluginApi["create"]>>>();
    api.create.mockReturnValueOnce(write.promise);
    const view = render(<PluginApp api={api} />);
    await beginCreate();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Abandoned" } });
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Submitted text" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    api.document.mockResolvedValue({ ...page, id: "latest", title: "Latest document" });
    view.rerender(<PluginApp api={api} initialPageId="latest" />);
    fireEvent.click(await screen.findByRole("button", { name: "Discard and continue" }));
    await screen.findByRole("heading", { name: "Latest document" });
    const contexts = api.context.mock.calls.length;
    const listings = api.pages.mock.calls.length;
    await act(async () => {
      if (outcome === "success")
        write.resolve({ id: "abandoned", title: "Abandoned", url: page.url, revision: 1, operationId: "create" });
      else write.reject(new Error("Abandoned error"));
    });
    expect(screen.getByRole("heading", { name: "Latest document" })).toBeVisible();
    expect(api.document).toHaveBeenCalledExactlyOnceWith("latest");
    expect(api.context).toHaveBeenCalledTimes(contexts);
    expect(api.pages).toHaveBeenCalledTimes(listings);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Document saved.")).not.toBeInTheDocument();
  });

  it("ignores the saved-page refresh when its draft session was discarded", async () => {
    const { api, page } = fixture();
    await edit(api);
    const refresh = deferred<PluginDocument>();
    api.document.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.document).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Space roots" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and continue" }));
    await screen.findByRole("heading", { name: "Your wiki, beside your chat" });
    const contexts = api.context.mock.calls.length;
    await act(async () => refresh.resolve({ ...page, revision: 5, markdown: "My unsaved draft" }));
    expect(screen.getByRole("heading", { name: "Your wiki, beside your chat" })).toBeVisible();
    expect(api.context).toHaveBeenCalledTimes(contexts);
    expect(screen.queryByText("Document saved.")).not.toBeInTheDocument();
  });

  it("invalidates an old save session when the API is replaced", async () => {
    const { api, page } = fixture();
    const replacement = fixture({ id: "replacement", title: "Replacement document" }).api;
    const view = render(<PluginApp api={api} initialPageId="doc" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Old draft" } });
    const write = deferred<Awaited<ReturnType<PluginApi["save"]>>>();
    api.save.mockReturnValueOnce(write.promise);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    view.rerender(<PluginApp api={replacement} initialPageId="replacement" />);
    await screen.findByRole("heading", { name: "Replacement document" });
    await act(async () =>
      write.resolve({ id: page.id, title: page.title, url: page.url, revision: 5, operationId: "old" }),
    );
    expect(screen.getByRole("heading", { name: "Replacement document" })).toBeVisible();
    expect(api.document).toHaveBeenCalledExactlyOnceWith("doc");
    expect(api.context).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Document saved.")).not.toBeInTheDocument();
  });

  it("releases a definitely rejected create so its title and content can be corrected", async () => {
    const { api } = fixture();
    api.create.mockRejectedValueOnce(new PluginToolError("Invalid content", "invalid_markdown", false));
    render(<PluginApp api={api} />);
    await beginCreate();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "First title" } });
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Invalid draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Invalid content");
    expect(screen.getByLabelText("Title")).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Corrected title" } });
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Corrected draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Document saved.");
    expect(api.create.mock.calls[1]![0].operation_id).not.toBe(api.create.mock.calls[0]![0].operation_id);
    expect(api.create.mock.calls[1]![0]).toMatchObject({ title: "Corrected title", markdown: "Corrected draft" });
  });

  it.each(["create", "update"] as const)(
    "allows correcting a rejected %s after a document limit failure",
    async (kind) => {
      const { api, page } = fixture();
      const rejected = new PluginToolError("The mutation exceeds document limits.", "document_limit", false);
      if (kind === "create") {
        api.create.mockRejectedValueOnce(rejected);
        render(<PluginApp api={api} />);
        await beginCreate();
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "First title" } });
      } else {
        api.save.mockRejectedValueOnce(rejected);
        await edit(api);
      }
      fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Rejected draft" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("The mutation exceeds document limits.");
      expect(screen.getByLabelText("Markdown draft")).toHaveValue("Rejected draft");
      expect(screen.getByLabelText("Markdown draft")).toBeEnabled();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      expect(screen.getByLabelText(kind === "create" ? "Title" : "Markdown draft")).toBeEnabled();
      if (kind === "create") {
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Corrected title" } });
      }
      fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Corrected draft" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Document saved.");
      const calls = kind === "create" ? api.create.mock.calls : api.save.mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[1]![0].operation_id).not.toBe(calls[0]![0].operation_id);
      expect(calls[1]![0]).toMatchObject(
        kind === "create"
          ? { space_id: "space", title: "Corrected title", markdown: "Corrected draft" }
          : {
              page_id: page.id,
              expected_revision: page.revision,
              expected_content_epoch: page.contentEpoch,
              command: { type: "replace_content", replace_content: { new_str: "Corrected draft" } },
            },
      );
      expect(kind === "create" ? api.save : api.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: "create", protectedPage: {} },
    { kind: "update", protectedPage: {} },
    { kind: "update", protectedPage: { canEdit: false } },
    { kind: "create", protectedPage: { truncated: true } },
  ] as const)(
    "keeps typing during a delayed $kind refresh and respects refreshed permissions: $protectedPage",
    async ({ kind, protectedPage }) => {
      const { api, page } = fixture();
      const view = render(<PluginApp api={api} initialPageId={kind === "update" ? "doc" : undefined} />);
      if (kind === "create") {
        await beginCreate();
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Created notes" } });
      } else fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
      fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Submitted text" } });
      const refresh = deferred<PluginDocument>();
      api.document.mockReturnValueOnce(refresh.promise);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(api.document).toHaveBeenCalledTimes(kind === "create" ? 1 : 2));
      view.rerender(<PluginApp api={api} initialPageId="earlier" />);
      view.rerender(<PluginApp api={api} initialPageId="latest" />);
      fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
      expect(screen.getByLabelText("Markdown draft")).toBeEnabled();
      fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Typed during refresh" } });
      expect(screen.getByRole("button", { name: "Refresh saved document" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Refresh saved document" }));
      expect(kind === "create" ? api.create : api.save).toHaveBeenCalledTimes(1);
      await act(async () =>
        refresh.resolve({
          ...page,
          ...protectedPage,
          markdown: "Submitted text",
          revision: kind === "create" ? 1 : 5,
          contentEpoch: kind === "create" ? 1 : 2,
        }),
      );
      await screen.findByText("Previous save confirmed. Your newer changes are still unsaved.");
      expect(screen.getByLabelText("Markdown draft")).toHaveValue("Typed during refresh");
      expect(api.document.mock.calls.some(([id]) => id === "earlier" || id === "latest")).toBe(false);
      expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
        "disabled",
        "canEdit" in protectedPage || "truncated" in protectedPage,
      );
    },
  );

  it("a discarded session's late completion cannot unlock a successor session's pending save", async () => {
    const { api, page } = fixture();
    const first = deferred<Awaited<ReturnType<PluginApi["create"]>>>();
    const second = deferred<Awaited<ReturnType<PluginApi["save"]>>>();
    api.create.mockReturnValueOnce(first.promise);
    const view = render(<PluginApp api={api} />);
    await beginCreate();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Abandoned" } });
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "First draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    api.document.mockResolvedValue({ ...page, id: "latest", title: "Latest document" });
    view.rerender(<PluginApp api={api} initialPageId="latest" />);
    fireEvent.click(await screen.findByRole("button", { name: "Discard and continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Successor draft" } });
    api.save.mockReturnValueOnce(second.promise);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () =>
      first.resolve({ id: "abandoned", title: "Abandoned", url: page.url, revision: 1, operationId: "first" }),
    );
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("Successor draft");
    expect(screen.getByRole("button", { name: "Retry previous save" })).toBeDisabled();
    expect(api.document).toHaveBeenCalledExactlyOnceWith("latest");
    api.document.mockResolvedValue({
      ...page,
      id: "latest",
      title: "Latest document",
      revision: 5,
      markdown: "Successor draft",
    });
    await act(async () =>
      second.resolve({ id: "latest", title: "Latest document", url: page.url, revision: 5, operationId: "second" }),
    );
    await screen.findByText("Document saved.");
    expect(screen.getByRole("heading", { name: "Latest document" })).toBeVisible();
  });

  it.each(["write", "refresh"])("invalidates the save session after unmount during its %s", async (phase) => {
    const { api, page } = fixture();
    const view = render(<PluginApp api={api} initialPageId="doc" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    fireEvent.change(screen.getByLabelText("Markdown draft"), { target: { value: "Submitted text" } });
    const write = deferred<Awaited<ReturnType<PluginApi["save"]>>>();
    const refresh = deferred<PluginDocument>();
    if (phase === "write") api.save.mockReturnValueOnce(write.promise);
    else api.document.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.document).toHaveBeenCalledTimes(phase === "refresh" ? 2 : 1));
    view.unmount();
    const documents = api.document.mock.calls.length;
    const contexts = api.context.mock.calls.length;
    const listings = api.pages.mock.calls.length;
    await act(async () => {
      if (phase === "write")
        write.resolve({ id: page.id, title: page.title, url: page.url, revision: 5, operationId: "write" });
      else refresh.resolve({ ...page, revision: 5, markdown: "Submitted text" });
    });
    expect(api.document).toHaveBeenCalledTimes(documents);
    expect(api.context).toHaveBeenCalledTimes(contexts);
    expect(api.pages).toHaveBeenCalledTimes(listings);
  });

  it.each(["rich block", "attachment", "comment anchor"])(
    "allows correcting a definite protected %s rejection",
    async (protectedItem) => {
      const { api } = fixture({ unknownBlockIds: ["protected"] });
      api.save.mockRejectedValueOnce(
        new PluginToolError(`This edit would remove a protected ${protectedItem}`, "invalid_markdown", false),
      );
      await edit(api);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByRole("alert");
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      fireEvent.change(screen.getByLabelText("Markdown draft"), {
        target: { value: "Corrected draft retaining protected content" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Document saved.");
      expect(api.save.mock.calls[1]![0].operation_id).not.toBe(api.save.mock.calls[0]![0].operation_id);
      expect(api.save.mock.calls[1]![0].command.replace_content.new_str).toBe(
        "Corrected draft retaining protected content",
      );
    },
  );

  it.each(["operation_receipt_unverifiable", "operation_id_reused"])(
    "requires explicit reconciliation before replacing an update with %s",
    async (code) => {
      const { api, page } = fixture();
      api.save.mockRejectedValueOnce(new PluginToolError("Read and reconcile the current document.", code, false));
      await edit(api);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByRole("alert");
      expect(screen.getByRole("button", { name: "Retry previous save" })).toBeDisabled();
      expect(api.document).toHaveBeenCalledExactlyOnceWith("doc");
      api.document.mockResolvedValue({ ...page, revision: 8, contentEpoch: 3, markdown: "External baseline text" });
      fireEvent.click(screen.getByRole("button", { name: "Review current version" }));
      await screen.findByText("External baseline text");
      expect(screen.getByLabelText("Markdown draft")).toHaveValue("My unsaved draft");
      fireEvent.click(screen.getByRole("button", { name: "I’ve reconciled my draft" }));
      api.document.mockResolvedValue({ ...page, revision: 9, contentEpoch: 3, markdown: "My unsaved draft" });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText("Document saved.");
      expect(api.save.mock.calls[1]![0]).toMatchObject({ expected_revision: 8, expected_content_epoch: 3 });
      expect(api.save.mock.calls[1]![0].operation_id).not.toBe(api.save.mock.calls[0]![0].operation_id);
    },
  );

  it("does not publish a pending document after unmount", async () => {
    const { api, page } = fixture();
    const documentRequest = deferred<PluginDocument>();
    api.document.mockReturnValue(documentRequest.promise);
    const view = render(<PluginApp api={api} initialPageId="doc" />);
    await waitFor(() => expect(api.document).toHaveBeenCalledWith("doc"));
    view.unmount();
    await act(async () => documentRequest.resolve(page));
    expect(api.context).not.toHaveBeenCalled();
    expect(api.pages).not.toHaveBeenCalled();
  });

  it("does not start page navigation after the spaces request resolves following unmount", async () => {
    const { api } = fixture();
    const available = await api.spaces();
    const spaces = deferred<PluginSpaces>();
    api.spaces.mockReturnValue(spaces.promise);
    const view = render(<PluginApp api={api} initialPageId="doc" />);
    view.unmount();
    await act(async () => spaces.resolve(available));
    expect(api.document).not.toHaveBeenCalled();
    expect(api.pages).not.toHaveBeenCalled();
    expect(api.context).not.toHaveBeenCalled();
  });

  it("ignores context failures from a superseded page", async () => {
    const { api, page } = fixture();
    const context = deferred<void>();
    api.context.mockReturnValueOnce(context.promise);
    const view = render(<PluginApp api={api} initialPageId="doc" />);
    await screen.findByRole("button", { name: "Edit Markdown" });
    api.document.mockResolvedValue({ ...page, id: "latest", title: "Latest document" });
    view.rerender(<PluginApp api={api} initialPageId="latest" />);
    await screen.findByRole("heading", { name: "Latest document" });
    await act(async () => context.reject(new Error("Old context failed")));
    expect(screen.queryByText(/Chat context could not be updated/)).not.toBeInTheDocument();
  });
});

it("renders unsafe Markdown as inert text and never loads external images or executes HTML", () => {
  const openLink = vi.fn();
  const { container } = render(
    <MarkdownPreview
      markdown={
        '<script>alert(1)</script>\n\n<img src="https://evil.example/tracker">\n\n![remote](https://evil.example/image)\n\n[bad](javascript:alert%281%29) [safe](https://notes.example)'
      }
      openLink={openLink}
    />,
  );
  expect(container.querySelector("script, img, iframe")).toBeNull();
  expect(screen.getByText("<script>alert(1)</script>")).toBeVisible();
  expect(screen.queryByRole("button", { name: "bad" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "safe" }));
  expect(openLink).toHaveBeenCalledWith("https://notes.example");
});
