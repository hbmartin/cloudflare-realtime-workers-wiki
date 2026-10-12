// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import type { CollaborationBundle } from "./collaboration";
import { BlockLinkControls, blockLink, blockTarget, revealBlock } from "./block-links";

describe("private block links", () => {
  it("encodes stable IDs and replaces unrelated page targets", () => {
    const link = blockLink("page", "a b/😀", "https://notes.test/?page=old&compareFrom=stale#block=old");
    expect(new URL(link).search).toBe("?page=page");
    expect(blockTarget(new URL(link).hash)).toBe("a b/😀");
    expect(blockTarget("#block=%broken")).toBeNull();
    expect(blockTarget("#elsewhere")).toBeNull();
  });
  it("expands collapsed ancestors locally and respects reduced motion", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="bn-block-outer" data-id="parent"><div class="bn-block"><div class="bn-block-content"><div><div class="bn-toggle-wrapper" data-show-children="false"><button class="bn-toggle-button"></button></div></div></div><div class="bn-block-group"><div class="bn-block-outer" data-id="child"></div></div></div></div>`;
    document.body.appendChild(root);
    const click = vi.spyOn(root.querySelector<HTMLButtonElement>("button")!, "click");
    const target = root.querySelector<HTMLElement>('[data-id="child"]')!;
    target.scrollIntoView = vi.fn();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    expect(revealBlock(root, "child")).toBe(true);
    expect(click).toHaveBeenCalledOnce();
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
    expect(target.className).toBe("bn-block-outer");
    expect(revealBlock(root, "deleted")).toBe(false);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    root.remove();
  });
});

describe("block link navigation and native menus", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  beforeEach(() => {
    window.history.replaceState(null, "", "/?page=page#block=linked");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
  });
  afterEach(() => {
    cleanup();
    frames.clear();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });
  async function flushFrames() {
    await act(async () => {
      while (frames.size) {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(0));
      }
    });
  }
  function fixture({ offline = false, synced = true, id = "linked" } = {}) {
    const root = createRef<HTMLDivElement>();
    const handlers = new Map<string, () => void>();
    const provider = {
      synced,
      on: (event: string, callback: () => void) => handlers.set(event, callback),
      off: (event: string) => handlers.delete(event),
    };
    const bundle = { provider } as unknown as CollaborationBundle;
    const component = (disconnected: boolean) => (
      <div ref={root}>
        <div className="bn-editor">
          <div className="bn-block-outer" data-id={id}>
            <p contentEditable suppressContentEditableWarning>
              Text
            </p>
          </div>
        </div>
        <BlockLinkControls root={root} pageId="page" bundle={bundle} offline={disconnected} />
      </div>
    );
    const view = render(component(offline));
    const block = root.current!.querySelector<HTMLElement>(".bn-block-outer")!;
    const scroll = vi.fn();
    block.scrollIntoView = scroll;
    return { root, provider, handlers, scroll, view, component };
  }
  it("does not scroll a resolved fragment again on offline and reconnect transitions", async () => {
    const { view, component, scroll, handlers } = fixture();
    await flushFrames();
    expect(scroll).toHaveBeenCalledOnce();
    view.rerender(component(true));
    await flushFrames();
    view.rerender(component(false));
    handlers.get("sync")?.();
    await flushFrames();
    expect(scroll).toHaveBeenCalledOnce();
  });
  it("preserves native right-click and keyboard menus in editable text and copy fallback", async () => {
    const { root } = fixture();
    await flushFrames();
    const text = root.current!.querySelector("p")!;
    expect(fireEvent.contextMenu(text)).toBe(true);
    expect(fireEvent.keyDown(text, { key: "F10", shiftKey: true })).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Block actions" }), { key: "F10", shiftKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Copy link to block" }));
      });
      const fallback = screen.getByRole("textbox", { name: "Block link" });
      expect(fireEvent.contextMenu(fallback)).toBe(true);
      expect(fireEvent.keyDown(fallback, { key: "ContextMenu" })).toBe(true);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });
  it("stops observing deleted blocks and rearms only on explicit navigation", async () => {
    const { root, scroll } = fixture({ id: "other" });
    const scan = vi.spyOn(root.current!, "querySelectorAll");
    await flushFrames();
    expect(screen.getByLabelText("Block link status").textContent).toContain("no longer available");
    const scans = scan.mock.calls.length;
    root.current!.querySelector("p")!.appendChild(document.createElement("span"));
    await flushFrames();
    expect(scan).toHaveBeenCalledTimes(scans);
    root.current!.querySelector(".bn-block-outer")!.setAttribute("data-id", "linked");
    fireEvent(window, new HashChangeEvent("hashchange"));
    await flushFrames();
    expect(scroll).toHaveBeenCalledOnce();
  });
  it("keeps a missing cached target pending until reconnect and synchronization", async () => {
    const { root, view, component, provider, handlers, scroll } = fixture({
      offline: true,
      synced: false,
      id: "other",
    });
    await flushFrames();
    expect(screen.getByLabelText("Block link status").textContent).toContain("cached copy");
    root.current!.querySelector(".bn-block-outer")!.setAttribute("data-id", "linked");
    provider.synced = true;
    view.rerender(component(false));
    handlers.get("sync")?.();
    await flushFrames();
    expect(scroll).toHaveBeenCalledOnce();
  });
  it("reveals a pending offline target when it renders locally, then stops observing", async () => {
    const { root } = fixture({ offline: true, synced: false, id: "other" });
    await flushFrames();
    expect(screen.getByLabelText("Block link status").textContent).toContain("cached copy");
    const block = document.createElement("div");
    block.className = "bn-block-outer";
    block.dataset.id = "linked";
    const scroll = vi.fn();
    block.scrollIntoView = scroll;
    await act(async () => root.current!.querySelector(".bn-editor")!.appendChild(block));
    await flushFrames();
    expect(scroll).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Block link status").textContent).toBe("");
    const scan = vi.spyOn(root.current!, "querySelectorAll");
    await act(async () => block.appendChild(document.createElement("span")));
    await flushFrames();
    expect(scan).not.toHaveBeenCalled();
  });
  it.each(["menu", "trigger"])("handles Escape within its %s and restores trigger focus", async (target) => {
    fixture();
    await flushFrames();
    const trigger = screen.getByRole("button", { name: "Block actions" });
    fireEvent.click(trigger);
    const origin = target === "menu" ? screen.getByRole("menuitem") : trigger;
    await act(async () => origin.focus());
    expect(fireEvent.keyDown(origin, { key: "Escape" })).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(fireEvent.keyDown(origin, { key: "Escape" })).toBe(true);
  });
  it.each(["editor", "dialog"])("leaves Escape in another %s to that surface", async (target) => {
    const { root } = fixture();
    await flushFrames();
    const trigger = screen.getByRole("button", { name: "Block actions" });
    fireEvent.click(trigger);
    if (target === "dialog")
      render(
        <dialog open aria-label="Another dialog">
          <button>Close dialog</button>
        </dialog>,
      );
    const origin =
      target === "editor" ? root.current!.querySelector("p")! : screen.getByRole("button", { name: "Close dialog" });
    origin.tabIndex = 0;
    const handle = vi.fn((event: Event) => event.stopPropagation());
    origin.addEventListener("keydown", handle);
    await act(async () => origin.focus());
    expect(fireEvent.keyDown(origin, { key: "Escape" })).toBe(true);
    expect(handle).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Block actions" })).toBeNull();
    expect(document.activeElement).toBe(origin);
  });
  it("leaves outside-target Escape unconsumed while the menu remains open", async () => {
    const { root } = fixture();
    await flushFrames();
    fireEvent.click(screen.getByRole("button", { name: "Block actions" }));
    const outside = root.current!.querySelector("p")!;
    const handle = vi.fn();
    outside.addEventListener("keydown", handle);
    const focus = document.activeElement;
    expect(fireEvent.keyDown(outside, { key: "Escape" })).toBe(true);
    expect(handle).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "Block actions" })).toBeTruthy();
    expect(document.activeElement).toBe(focus);
  });
  it("dismisses on blank-area pointer down without consuming a later Escape", async () => {
    fixture();
    await flushFrames();
    const trigger = screen.getByRole("button", { name: "Block actions" });
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
    expect(document.activeElement).not.toBe(trigger);
  });
  it("keeps the menu open for internal pointer and focus transitions", async () => {
    fixture();
    await flushFrames();
    const trigger = screen.getByRole("button", { name: "Block actions" });
    fireEvent.click(trigger);
    const select = screen.getByRole("combobox", { name: "Block to link" });
    fireEvent.pointerDown(select);
    await act(async () => select.focus());
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => trigger.focus());
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
