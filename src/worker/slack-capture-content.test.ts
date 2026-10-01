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
            { name: "", count: 3 },
            { name: " \t ", count: 2 },
            { name: "ok\n\n    fake", count: 1 },
            { name: " thumbsup ", count: 2 },
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
      "Reaction: thumbsup × 2",
      "Reaction: heart × 1",
      "Attachment: Plan.pdf",
      "Attachment: Design",
      "Attachment: Plain attachment",
    ]);
  });

  it("keeps attachment links visible when Slack sends empty titles", () => {
    const markdown = captureMarkdown({
      ...input,
      messages: [
        {
          ...input.messages[0]!,
          files: [
            { title: " \r\n\t ", name: "Plan.pdf", permalink: "https://workspace.slack.com/files/UOWNER/F123" },
            { title: "", name: "\r\n\t", permalink: "https://workspace.slack.com/files/UOWNER/F124" },
          ],
          attachments: [{ title: " \r\n\t ", title_link: "https://example.com/design" }],
        },
      ],
    });
    expect(markdown).toContain("[Plan\\.pdf](<https://workspace.slack.com/files/UOWNER/F123>)");
    expect(markdown).toContain("[Slack attachment](<https://workspace.slack.com/files/UOWNER/F124>)");
    expect(markdown).toContain("[Slack attachment](<https://example.com/design>)");
  });

  it.each(["\n", "\r\n"])("keeps multiline capture metadata on one line (%j)", (newline) => {
    const markdown = captureMarkdown({
      ...input,
      title: `Launch${newline}${newline}  decision`,
      messages: [
        {
          ...input.messages[0]!,
          user: `UOWNER${newline}${newline}  label`,
          files: [
            { title: `Plan${newline}${newline}  draft`, permalink: "https://workspace.slack.com/files/UOWNER/F123" },
            { name: `Notes${newline}${newline}  draft` },
          ],
          attachments: [
            { title: `Design${newline}${newline}  draft`, title_link: "https://example.com/design" },
            { title: `Plain${newline}${newline}  draft` },
          ],
        },
      ],
    });
    const blocks = markdownToDocument(markdown).document.content![0]!.content!.map(
      (container) => container.content![0]!,
    );
    const text = blocks.map((block) => block.content?.map((node) => node.text ?? "").join(""));
    expect(text).toEqual([
      "Launch decision",
      "Slack source",
      "Captured from Slack on 2026-09-29T12:00:00.000Z. View source",
      "UOWNER label · 1700000000.000001",
      "Ship the plan & tell @Slack member",
      "Attachment: Plan draft",
      "Attachment: Notes draft",
      "Attachment: Design draft",
      "Attachment: Plain draft",
    ]);
    expect(blocks[5]?.content?.[1]?.marks).toEqual([
      { type: "link", attrs: { href: "https://workspace.slack.com/files/UOWNER/F123" } },
    ]);
    expect(blocks[7]?.content?.[1]?.marks).toEqual([{ type: "link", attrs: { href: "https://example.com/design" } }]);
  });

  it("normalizes bot headings and inline message link labels while preserving multiline bodies", () => {
    const markdown = captureMarkdown({
      ...input,
      description: "First description line\nSecond description line\n\nAnother paragraph",
      messages: [
        {
          ts: input.messages[0]!.ts,
          bot_id: " BOT\r\n\tLABEL ",
          text: "First message line\nSecond message line\n\n<https://example.com| label\rwith\ttabs >",
        },
      ],
    });
    expect(markdown).toContain("First description line\nSecond description line\n\nAnother paragraph");
    expect(markdown).toContain("### BOT LABEL · 1700000000.000001");
    expect(markdown).toContain("First message line\nSecond message line\n\n[label with tabs](<https://example.com/>)");
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
