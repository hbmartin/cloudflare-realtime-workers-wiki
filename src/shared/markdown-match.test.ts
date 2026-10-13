import { describe, expect, it } from "vitest";
import { closestMarkdownMatch } from "./markdown-match";
import { parseMarkdownCommand } from "./notion-markdown-commands";

describe("advisory Markdown matches", () => {
  it("suggests exact source including markup and never resolves a missing selection", () => {
    expect(closestMarkdownMatch("Intro\n\n**First paragraph**\n", "**Firs paragraph**")).toBe("**First paragraph**");
    expect(() =>
      parseMarkdownCommand(
        {
          type: "update_content",
          update_content: { content_updates: [{ old_str: "**Firs paragraph**", new_str: "Changed" }] },
        },
        "**First paragraph**\n",
      ),
    ).toThrow(
      expect.objectContaining({
        name: "MarkdownWriteError",
        code: "old_str_not_found",
        details: { matchCount: 0, suggestion: "**First paragraph**" },
      }),
    );
  });
  it("distinguishes ambiguity and suppresses unrelated or expensive suggestions", () => {
    expect(closestMarkdownMatch("An unrelated sentence.", "Banana spaceship")).toBeUndefined();
    expect(closestMarkdownMatch("x".repeat(2000), "x".repeat(1001))).toBeUndefined();
    expect(() =>
      parseMarkdownCommand(
        { type: "update_content", update_content: { content_updates: [{ old_str: "same", new_str: "x" }] } },
        "same same",
      ),
    ).toThrow(expect.objectContaining({ code: "old_str_ambiguous", details: { matchCount: 2 } }));
  });
});
