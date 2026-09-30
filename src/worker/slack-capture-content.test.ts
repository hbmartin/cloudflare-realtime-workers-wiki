import { describe, expect, it } from "vitest";
import { captureMarkdown, MAX_CAPTURE_MARKDOWN_BYTES, MAX_CAPTURE_MESSAGES } from "./slack-capture-content";
import { markdownToDocument } from "../shared/import-content";

const input = {
  title: "Launch decision",
  permalink: "https://workspace.slack.com/archives/C123/p1700000000000001",
  capturedAt: Date.UTC(2026, 8, 29, 12),
  messages: [
    { ts: "1700000000.000001", user: "UOWNER", text: "Ship <https://example.com/path|the plan> &amp; tell <@UOTHER>" },
  ],
};

describe("Slack capture Markdown", () => {
  it("keeps attribution, source and public links while excluding private file URLs", () => {
    const markdown = captureMarkdown({
      ...input,
      messages: [
        {
          ...input.messages[0]!,
          reactions: [{ name: "thumbsup", count: 3 }],
          files: [
            {
              name: "Plan.pdf",
              permalink: "https://workspace.slack.com/files/UOWNER/F123",
              url_private: "https://token.example/private",
            },
          ],
        },
      ],
    });
    expect(markdown).toContain("# Launch decision");
    expect(markdown).toContain("2026-09-29T12:00:00.000Z");
    expect(markdown).toContain("[View source](<https://workspace.slack.com/archives/C123/p1700000000000001>)");
    expect(markdown).toContain("[the plan](<https://example.com/path>)");
    expect(markdown).toContain("@Slack member");
    expect(markdown).toContain("Reaction: thumbsup × 3");
    expect(markdown).toContain("Plan\\.pdf");
    expect(markdown).not.toContain("token.example");
  });

  it("rejects unsafe source links, too many messages and output beyond 2 MiB", () => {
    expect(() => captureMarkdown({ ...input, permalink: "https://example.com/not-slack" })).toThrow(
      "Slack source link is unavailable",
    );
    expect(() =>
      captureMarkdown({ ...input, messages: Array(MAX_CAPTURE_MESSAGES + 1).fill(input.messages[0]) }),
    ).toThrow("2,000 messages");
    expect(() =>
      captureMarkdown({
        ...input,
        messages: [{ ...input.messages[0]!, text: "a".repeat(MAX_CAPTURE_MARKDOWN_BYTES) }],
      }),
    ).toThrow("2 MiB");
  });

  it("imports each reaction and attachment as a separate paragraph", () => {
    const markdown = captureMarkdown({
      ...input,
      messages: [
        {
          ...input.messages[0]!,
          reactions: [
            { name: "thumbsup", count: 3 },
            { name: "ignored", count: 0 },
            { name: "heart", count: 1 },
          ],
          files: [{ name: "Plan.pdf", permalink: "https://workspace.slack.com/files/UOWNER/F123" }],
          attachments: [{ title: "Design", title_link: "https://example.com/design" }, { title: "Plain attachment" }],
        },
      ],
    });
    const paragraphs = markdownToDocument(markdown)
      .document.content![0]!.content!.map((container) => container.content![0]!)
      .filter((block) => block.type === "paragraph")
      .map((block) => block.content!.map((node) => node.text ?? "").join(""));
    expect(paragraphs.slice(1)).toEqual([
      "Ship the plan & tell @Slack member",
      "Reaction: thumbsup × 3",
      "Reaction: heart × 1",
      "Attachment: Plan.pdf",
      "Attachment: Design",
      "Attachment: Plain attachment",
    ]);
  });

  it("keeps the user's description separate from attributed Slack messages", () => {
    const markdown = captureMarkdown({ ...input, description: "# Follow up with legal" });
    const blocks = markdownToDocument(markdown).document.content![0]!.content!.map(
      (container) => container.content![0]!,
    );
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "heading",
      "paragraph",
      "heading",
      "paragraph",
      "heading",
      "paragraph",
    ]);
    expect(blocks[2]?.content?.[0]?.text).toBe("# Follow up with legal");
    expect(blocks[6]?.content?.[0]?.text).toContain("Ship");
  });
});
