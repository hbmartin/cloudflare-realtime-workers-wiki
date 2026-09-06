// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { allowedEmbedUrl, renderedMath, safeBookmarkUrl } from "./editor-blocks";

describe("core editor blocks", () => {
  it("renders untrusted math without enabling dangerous commands", () => {
    const html = renderedMath(String.raw`\href{javascript:alert(1)}{bad}`, false);
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("katex");
  });

  it("embeds only explicit providers and turns ordinary web URLs into bookmarks", () => {
    expect(allowedEmbedUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(allowedEmbedUrl("https://example.com/video")).toBeNull();
    expect(safeBookmarkUrl("https://example.com/video")).toBe("https://example.com/video");
    expect(safeBookmarkUrl("javascript:alert(1)")).toBeNull();
  });
});
