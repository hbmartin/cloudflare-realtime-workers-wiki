import { describe, expect, it, vi } from "vitest";
import { slackCommentText, slackReplyBody } from "./slack-thread-text";

describe("Slack thread text", () => {
  it("converts the supported formatting subset without interpreting HTML or broadcast syntax", async () => {
    const body = await slackReplyBody(
      "Hello *bold* _italic_ ~strike~ `code`\n&gt; quote\n```\n<script>literal</script>\n```\n<https://example.test|safe> <javascript:alert(1)|unsafe> <!channel> &amp; &lt;tag&gt;",
      async () => null,
    );
    const json = JSON.stringify(body);
    expect(json).toContain('"bold":true');
    expect(json).toContain('"italic":true');
    expect(json).toContain('"strike":true');
    expect(json).toContain('"code":true');
    expect(json).toContain('"type":"quote"');
    expect(json).toContain('"type":"codeBlock"');
    expect(json).toContain('"href":"https://example.test"');
    expect(json).not.toContain('"href":"javascript:');
    expect(json).toContain("<!channel>");
    expect(json).toContain("<script>literal</script>");
    expect(json).toContain("& <tag>");
  });
  it("creates only explicitly resolved mentions, with a non-disclosing fallback", async () => {
    const resolve = vi.fn(async (id: string) => (id === "UONE" ? { id: "member-1", name: "One" } : null));
    const body = await slackReplyBody("<@UONE> <@UTWO> <@UONE>", resolve);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(body)).toContain('"entityId":"member-1"');
    expect(JSON.stringify(body)).toContain("@Slack member");
    expect(JSON.stringify(body)).not.toContain("UTWO");
  });
  it("does not turn escaped or code mentions into live mentions", async () => {
    const body = await slackReplyBody("&lt;@UONE&gt; `<@UONE>` ```<@UONE>```", async () => ({
      id: "member-1",
      name: "One",
    }));
    expect(JSON.stringify(body)).not.toContain('"type":"mention"');
  });
  it("bounds bytes, lines, mentions, and inline complexity", async () => {
    await expect(slackReplyBody("x".repeat(17000), async () => null)).rejects.toThrow("Reply is too large");
    await expect(slackReplyBody("a\n".repeat(250), async () => null)).rejects.toThrow("Reply has too many lines");
    await expect(
      slackReplyBody(Array.from({ length: 51 }, (_, n) => `<@U${n}>`).join(" "), async () => null),
    ).rejects.toThrow("Reply has too many mentions");
    await expect(slackReplyBody("*bold* ".repeat(350), async () => null)).rejects.toThrow("Reply is too complex");
  });
  it("escapes outbound text and permits only verified Slack identity tokens", async () => {
    const body = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "<!channel> & <script> " },
          { type: "mention", props: { entityType: "user", entityId: "verified", label: "One" } },
          { type: "mention", props: { entityType: "user", entityId: "legacy", label: "Two <!everyone>" } },
        ],
      },
    ];
    const text = await slackCommentText(body, async (id) => (id === "verified" ? "UONE" : null));
    expect(text).toContain("<@UONE>");
    expect(text).toContain("@Two &lt;!everyone&gt;");
    expect(text).toContain("&lt;!channel&gt; &amp; &lt;script&gt;");
    expect(text).not.toContain("<!channel>");
    expect(await slackCommentText(body, async () => "UONE><!channel")).not.toContain("<@UONE>");
  });
  it("bounds outbound messages without leaving partial mention tokens", async () => {
    const text = await slackCommentText([{ type: "text", text: "x".repeat(2800) + " <@UONE>" }], async () => null);
    expect(text.length).toBeLessThan(2800);
    expect(text.endsWith("…")).toBe(true);
  });
  it("keeps delimiters inside words and preserves safe outbound link targets", async () => {
    const imported = await slackReplyBody("file_name_here and *bold* <https://example.test/a|link>", async () => null);
    const json = JSON.stringify(imported);
    expect(json).toContain("file_name_here");
    expect(json).toContain('"bold":true');
    expect(json).toContain('"href":"https://example.test/a"');
    const outbound = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "a|b " },
          { type: "link", href: "https://example.test/a?x=1&y=2", content: [{ type: "text", text: "See|this" }] },
          { type: "link", href: "javascript:alert(1)", content: [{ type: "text", text: " unsafe" }] },
        ],
      },
    ] as unknown as Parameters<typeof slackCommentText>[0];
    expect(await slackCommentText(outbound, async () => null)).toContain(
      "a|b <https://example.test/a?x=1&y=2|See¦this> unsafe",
    );
  });
});
