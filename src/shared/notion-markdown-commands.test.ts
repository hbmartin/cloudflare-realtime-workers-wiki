import { describe, expect, it } from "vitest";
import { applyMarkdownEdits, parseMarkdownCommand } from "./notion-markdown-commands";

const markdown = "## Plans\n\nFirst paragraph\n\nSecond paragraph\n";

describe("Notion Markdown command selection", () => {
  it("replaces one unique string and rejects missing or duplicate matches", () => {
    const command = parseMarkdownCommand(
      { type: "update_content", update_content: { content_updates: [{ old_str: "First", new_str: "Updated" }] } },
      markdown,
    );
    expect(applyMarkdownEdits(markdown, command.edits)).toContain("Updated paragraph");
    expect(() =>
      parseMarkdownCommand(
        { type: "update_content", update_content: { content_updates: [{ old_str: "paragraph", new_str: "text" }] } },
        markdown,
      ),
    ).toThrow(/ambiguous/);
    expect(() =>
      parseMarkdownCommand(
        { type: "update_content", update_content: { content_updates: [{ old_str: "", new_str: "x" }] } },
        markdown,
      ),
    ).toThrow(/empty/);
    expect(() =>
      parseMarkdownCommand(
        { type: "update_content", update_content: { content_updates: [{ old_str: "missing", new_str: "x" }] } },
        markdown,
      ),
    ).toThrow(/missing/);
  });

  it("replaces all non-overlapping matches in one atomic command", () => {
    const command = parseMarkdownCommand(
      {
        type: "update_content",
        update_content: { content_updates: [{ old_str: "paragraph", new_str: "section", replace_all_matches: true }] },
      },
      markdown,
    );
    expect(applyMarkdownEdits(markdown, command.edits)).toContain("First section\n\nSecond section");
  });

  it("inserts after an ellipsis selection or at the start", () => {
    const after = parseMarkdownCommand(
      { type: "insert_content", insert_content: { content: "\n\nNew", after: "First...paragraph" } },
      markdown,
    );
    expect(applyMarkdownEdits(markdown, after.edits)).toContain("First paragraph\n\nNew");
    const start = parseMarkdownCommand(
      { type: "insert_content", insert_content: { content: "Intro\n\n", position: { type: "start" } } },
      markdown,
    );
    expect(applyMarkdownEdits(markdown, start.edits)).toMatch(/^Intro/);
    expect(() =>
      parseMarkdownCommand(
        { type: "insert_content", insert_content: { content: "x", after: "First", position: { type: "end" } } },
        markdown,
      ),
    ).toThrow(/combined/);
  });

  it("replaces a bounded range and rejects overlap", () => {
    const command = parseMarkdownCommand(
      {
        type: "replace_content_range",
        replace_content_range: { content_range: "First...paragraph", content: "Changed" },
      },
      markdown,
    );
    expect(applyMarkdownEdits(markdown, command.edits)).toContain("Changed\n\nSecond");
    expect(() =>
      parseMarkdownCommand(
        {
          type: "update_content",
          update_content: {
            content_updates: [
              { old_str: "First paragraph", new_str: "x" },
              { old_str: "paragraph", new_str: "y", replace_all_matches: true },
            ],
          },
        },
        markdown,
      ),
    ).toThrow(/overlap/);
  });
});
