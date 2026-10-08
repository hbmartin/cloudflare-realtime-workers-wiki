// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PluginDocument, PluginSpaces } from "../shared/plugin-contracts";
import { PluginToolError, type PluginApi } from "./api";
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
    document: vi.fn().mockResolvedValue(page),
    create: vi
      .fn()
      .mockResolvedValue({ id: page.id, title: page.title, url: page.url, revision: 1, operationId: "operation" }),
    save: vi
      .fn()
      .mockResolvedValue({ id: page.id, title: page.title, url: page.url, revision: 5, operationId: "operation" }),
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
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
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
    await act(async () =>
      write.resolve({ id: page.id, title: page.title, url: page.url, revision: 5, operationId: "operation" }),
    );
    expect(screen.getByLabelText("Markdown draft")).toHaveValue("Keep this draft");
    expect(api.document).toHaveBeenCalledExactlyOnceWith("doc");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    api.document.mockResolvedValue({ ...page, markdown: "Keep this draft", revision: 5 });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Document saved.");
    expect(api.save.mock.calls[1]![0]).toEqual(api.save.mock.calls[0]![0]);
  });

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
