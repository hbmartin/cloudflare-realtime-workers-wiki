// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTree } from "../shared/tree-model";
import type { Page } from "../shared/types";
import { WorkspaceTree } from "./WorkspaceTree";

const page = (id: string, title: string, position: string, parentId: string | null = null): Page => ({
  id,
  title,
  position,
  parentId,
  kind: "document",
  workspaceId: "workspace",
  spaceId: "general",
  icon: null,
  revision: 1,
  contentEpoch: 1,
  isTemplate: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
});
const nodes = buildTree([page("ten", "Note 10", "a"), page("two", "note 2", "b"), page("child", "Child", "a", "ten")]);
function props() {
  return {
    nodes,
    selectedId: null,
    editable: true,
    canCreate: true,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onArchive: vi.fn(),
    onMove: vi.fn(),
    preferenceKey: "tree:member:workspace:general",
  };
}
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.animate = vi.fn();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("personal tree sorting and reveal", () => {
  it("keeps rendered and keyboard order together without changing metadata, and restores manual order", () => {
    const input = props();
    render(<WorkspaceTree {...input} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort space pages" }), { target: { value: "title-asc" } });
    expect(screen.getAllByRole("treeitem").map((item) => item.getAttribute("aria-label"))).toEqual([
      "note 2",
      "Note 10",
      "Child",
    ]);
    const first = screen.getByRole("treeitem", { name: "note 2" });
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("treeitem", { name: "Note 10" })).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
    expect(input.onMove).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Sort space pages" }), { target: { value: "manual" } });
    expect(screen.getAllByRole("treeitem").map((item) => item.getAttribute("aria-label"))).toEqual([
      "Note 10",
      "Child",
      "note 2",
    ]);
    expect(input.onMove).not.toHaveBeenCalled();
    expect(nodes.map((node) => node.position)).toEqual(["a", "b"]);
  });
  it("lets viewers choose personal sorting without exposing page mutations", () => {
    render(<WorkspaceTree {...props()} editable={false} canCreate={false} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort space pages" }), { target: { value: "title-desc" } });
    expect(screen.queryByRole("button", { name: "Archive Note 10" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("tree:member:workspace:general:sorting")!)).toEqual({ root: "title-desc" });
  });
  it("expands ancestors and focuses the same page on repeated reveal requests", async () => {
    localStorage.setItem("tree:member:workspace:general", JSON.stringify(["ten"]));
    const input = props();
    const view = render(<WorkspaceTree {...input} revealRequest={{ id: "child", sequence: 1 }} />);
    await waitFor(() => expect(screen.getByRole("treeitem", { name: "Child" })).toHaveFocus());
    screen.getByRole("treeitem", { name: "note 2" }).focus();
    view.rerender(<WorkspaceTree {...input} revealRequest={{ id: "child", sequence: 2 }} />);
    await waitFor(() => expect(screen.getByRole("treeitem", { name: "Child" })).toHaveFocus());
  });
  it("reveals a root page even though its ancestor path is empty", async () => {
    const onRevealHandled = vi.fn();
    render(<WorkspaceTree {...props()} revealRequest={{ id: "two", sequence: 1 }} onRevealHandled={onRevealHandled} />);
    await waitFor(() => expect(onRevealHandled).toHaveBeenCalledWith(1));
    expect(screen.getByRole("treeitem", { name: "note 2" })).toHaveFocus();
  });
  it("consumes an absent target after loading without stealing focus if the page later returns", async () => {
    const input = props();
    const onRevealHandled = vi.fn();
    const revealRequest = { id: "missing", sequence: 1 };
    const view = render(
      <WorkspaceTree {...input} revealRequest={revealRequest} onRevealHandled={onRevealHandled} treeReady />,
    );
    await waitFor(() => expect(onRevealHandled).toHaveBeenCalledWith(1));
    const retainedFocus = screen.getByRole("treeitem", { name: "note 2" });
    retainedFocus.focus();
    view.rerender(
      <WorkspaceTree
        {...input}
        nodes={buildTree([page("missing", "Returned", "c"), page("two", "note 2", "b")])}
        revealRequest={revealRequest}
        onRevealHandled={onRevealHandled}
        treeReady
      />,
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(onRevealHandled).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("treeitem", { name: "note 2" })).toHaveFocus();
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled();
  });
  it("retains an absent target during the initial load and reveals it when the tree arrives", async () => {
    const input = props();
    const onRevealHandled = vi.fn();
    const revealRequest = { id: "child", sequence: 1 };
    const view = render(
      <WorkspaceTree
        {...input}
        nodes={[]}
        revealRequest={revealRequest}
        onRevealHandled={onRevealHandled}
        treeReady={false}
      />,
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(onRevealHandled).not.toHaveBeenCalled();
    view.rerender(
      <WorkspaceTree {...input} revealRequest={revealRequest} onRevealHandled={onRevealHandled} treeReady />,
    );
    await waitFor(() => expect(onRevealHandled).toHaveBeenCalledWith(1));
    expect(screen.getByRole("treeitem", { name: "Child" })).toHaveFocus();
  });
  it("consumes a still-absent target once the initial tree load finishes", async () => {
    const input = props();
    const onRevealHandled = vi.fn();
    const revealRequest = { id: "child", sequence: 1 };
    const view = render(
      <WorkspaceTree
        {...input}
        nodes={[]}
        revealRequest={revealRequest}
        onRevealHandled={onRevealHandled}
        treeReady={false}
      />,
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(onRevealHandled).not.toHaveBeenCalled();
    view.rerender(
      <WorkspaceTree {...input} nodes={[]} revealRequest={revealRequest} onRevealHandled={onRevealHandled} treeReady />,
    );
    await waitFor(() => expect(onRevealHandled).toHaveBeenCalledWith(1));
    view.rerender(
      <WorkspaceTree {...input} revealRequest={revealRequest} onRevealHandled={onRevealHandled} treeReady />,
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(onRevealHandled).toHaveBeenCalledTimes(1);
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled();
  });
  it("consumes reveals once and expands a later externally selected branch", async () => {
    const input = {
      ...props(),
      nodes: buildTree([
        page("ten", "Note 10", "a"),
        page("child", "Child", "a", "ten"),
        page("two", "note 2", "b"),
        page("other", "Other child", "a", "two"),
      ]),
    };
    localStorage.setItem(input.preferenceKey, JSON.stringify(["ten", "two"]));
    const onRevealHandled = vi.fn();
    const revealRequest = { id: "child", sequence: 1 };
    const view = render(<WorkspaceTree {...input} revealRequest={revealRequest} onRevealHandled={onRevealHandled} />);
    await waitFor(() => expect(onRevealHandled).toHaveBeenCalledWith(1));
    view.rerender(
      <WorkspaceTree {...input} selectedId="other" revealRequest={revealRequest} onRevealHandled={onRevealHandled} />,
    );
    expect(screen.getByRole("treeitem", { name: "Other child" })).toBeInTheDocument();
    screen.getByRole("treeitem", { name: "Other child" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Note 10" }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(onRevealHandled).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("treeitem", { name: "Child" })).not.toBeInTheDocument();
    expect(HTMLElement.prototype.animate).toHaveBeenCalledTimes(1);
    view.rerender(
      <WorkspaceTree
        {...input}
        selectedId="other"
        revealRequest={{ id: "child", sequence: 2 }}
        onRevealHandled={onRevealHandled}
      />,
    );
    await waitFor(() => expect(onRevealHandled).toHaveBeenLastCalledWith(2));
    expect(screen.getByRole("treeitem", { name: "Child" })).toHaveFocus();
  });
});
