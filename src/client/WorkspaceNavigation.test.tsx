// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page, PageNode } from "../shared/types";
import { WorkspaceTree } from "./WorkspaceTree";
import { QuickSwitcher } from "./WorkspaceUI";

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

  it("clamps Quick Switcher selection when its results shrink", () => {
    const pages = [page("one", "One"), page("two", "Two"), page("three", "Three")];
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <QuickSwitcher pages={pages} recentIds={["one", "two", "three"]} onSelect={onSelect} onClose={onClose} />,
    );
    const input = screen.getByRole("combobox", { name: "Find a page" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "quick-result-2");

    view.rerender(<QuickSwitcher pages={pages} recentIds={["one"]} onSelect={onSelect} onClose={onClose} />);

    expect(input).toHaveAttribute("aria-activedescendant", "quick-result-0");
    expect(screen.getByRole("option", { name: "One" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("one");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
