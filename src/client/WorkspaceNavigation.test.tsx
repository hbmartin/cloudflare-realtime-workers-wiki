// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, PageNode } from "../shared/types";
import { WorkspaceTree } from "./WorkspaceTree";
import { CommandPalette } from "./CommandPalette";

const page = (id: string, title: string, parentId: string | null = null): Page => ({
  id,
  workspaceId: "workspace",
  spaceId: "general",
  parentId,
  kind: "document",
  position: id,
  title,
  icon: null,
  revision: 1,
  contentEpoch: 1,
  isTemplate: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
});

describe("workspace navigation", () => {
  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
      clear: () => stored.clear(),
      key: (index: number) => [...stored.keys()][index] ?? null,
      get length() {
        return stored.size;
      },
    } satisfies Storage);
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  });

  it("expands the previous sibling before keyboard reparenting into it", async () => {
    const first = { ...page("first", "First"), children: [{ ...page("child", "Child", "first"), children: [] }] };
    const second = { ...page("second", "Second"), children: [] };
    const nodes: PageNode[] = [first, second];
    localStorage.setItem("collapsed", JSON.stringify([first.id]));
    const onMove = vi.fn();

    render(
      <WorkspaceTree
        nodes={nodes}
        selectedId={second.id}
        editable={true}
        canCreate={true}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onArchive={vi.fn()}
        onMove={onMove}
        preferenceKey="collapsed"
      />,
    );

    expect(screen.getByRole("treeitem", { name: "First" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(screen.getByRole("treeitem", { name: "Second" }), { key: "ArrowRight", altKey: true });

    expect(onMove).toHaveBeenCalledWith("second", "first", null, null);
    await waitFor(() =>
      expect(screen.getByRole("treeitem", { name: "First" })).toHaveAttribute("aria-expanded", "true"),
    );
  });

  it("clamps palette selection when its results shrink", () => {
    const pages = [page("one", "One"), page("two", "Two"), page("three", "Three")];
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <CommandPalette
        mode="pages"
        pages={pages}
        recentIds={["one", "two", "three"]}
        commands={[]}
        onSelectPage={onSelect}
        onClose={onClose}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Find a page" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "palette-result-2");

    view.rerender(
      <CommandPalette
        mode="pages"
        pages={pages}
        recentIds={["one"]}
        commands={[]}
        onSelectPage={onSelect}
        onClose={onClose}
      />,
    );

    expect(input).toHaveAttribute("aria-activedescendant", "palette-result-0");
    expect(screen.getByRole("option", { name: /One/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("one");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows accessible pages and available commands in the requested mode", () => {
    const pages = [page("allowed", "Allowed"), { ...page("archived", "Archived"), archivedAt: 1 }];
    const commands = [
      { id: "search", label: "Search workspace", shortcut: "", isAvailable: () => true, run: vi.fn() },
      { id: "move", label: "Move current page", shortcut: "", isAvailable: () => false, run: vi.fn() },
    ];
    const props = {
      pages,
      recentIds: ["missing", "allowed", "archived"],
      commands,
      onSelectPage: vi.fn(),
      onClose: vi.fn(),
    };
    const view = render(<CommandPalette mode="all" {...props} />);
    expect(screen.getByRole("option", { name: /Allowed/ })).toBeVisible();
    expect(screen.getByRole("option", { name: /Search workspace/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /Archived|Move current page/ })).toBeNull();
    view.rerender(<CommandPalette mode="pages" {...props} />);
    expect(screen.queryByRole("option", { name: /Search workspace/ })).toBeNull();
    view.rerender(<CommandPalette mode="commands" {...props} />);
    expect(screen.queryByRole("option", { name: /Allowed/ })).toBeNull();
    view.rerender(<CommandPalette mode="help" {...props} />);
    expect(screen.getByRole("option", { name: /Find a page or command/ })).toBeVisible();
  });

  it("restores the preceding focus when Escape closes the palette", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const view = render(
      <CommandPalette mode="all" pages={[]} recentIds={[]} commands={[]} onSelectPage={vi.fn()} onClose={onClose} />,
    );
    expect(screen.getByRole("combobox")).toHaveFocus();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: true, cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
