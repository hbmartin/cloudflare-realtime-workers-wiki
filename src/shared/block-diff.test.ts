import { describe, expect, it } from "vitest";
import { diffBlockIds, plainVersion } from "./block-diff";

describe("history block comparison", () => {
  it("reports stable block ids added and removed", () => {
    const diff = diffBlockIds(`<block id="one"/><block id="old"/>`, `<block id="one"/><block id="new"/>`);
    expect(diff.added).toEqual(["new"]);
    expect(diff.removed).toEqual(["old"]);
    expect(diff.identical).toBe(false);
  });

  it("creates a readable fallback preview", () => {
    expect(plainVersion("<p>Hello</p><p>world</p>")).toBe("Hello\nworld");
  });
});
