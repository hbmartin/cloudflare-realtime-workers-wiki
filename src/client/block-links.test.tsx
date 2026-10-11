// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { blockLink, blockTarget, revealBlock } from "./block-links";

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
