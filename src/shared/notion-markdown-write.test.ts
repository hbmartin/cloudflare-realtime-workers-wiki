import { describe, expect, it } from "vitest";
import { parseWritableMarkdown } from "./notion-markdown-write";

function blockTypes(source: string) {
  return parseWritableMarkdown(source).map((block) => block.content?.[0]?.type);
}

describe("writable Notion Markdown", () => {
  it("parses supported blocks and inline formatting", () => {
    const blocks = parseWritableMarkdown(
      "## Plans **ready**\n\nA [link](https://example.com) and $x+1$.\n\n- [x] done\n- [ ] next\n\n> Quote\n\n```c#\nvar a = 1;\n```\n\n```mermaid\ngraph TD\n```\n\n![Sketch](https://example.com/sketch.png)\n",
    );
    expect(blocks.map((block) => block.content?.[0]?.type)).toEqual([
      "heading",
      "paragraph",
      "checkListItem",
      "checkListItem",
      "quote",
      "codeBlock",
      "mermaid",
      "image",
    ]);
    expect(blocks[0]?.content?.[0]?.content?.[1]).toMatchObject({
      type: "text",
      text: "ready",
      marks: [{ type: "bold" }],
    });
    expect(blocks[1]?.content?.[0]?.content).toContainEqual({ type: "inlineMath", attrs: { formula: "x+1" } });
    expect(blocks[5]?.content?.[0]?.attrs?.language).toBe("c#");
  });

  it("preserves nested list structure", () => {
    const blocks = parseWritableMarkdown("1. Parent\n   - Child\n2. Next\n");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.content?.[0]?.type).toBe("numberedListItem");
    expect(blocks[0]?.content?.[1]?.content?.[0]?.content?.[0]?.type).toBe("bulletListItem");
  });

  it("parses display math and empty content", () => {
    expect(blockTypes("$$\nx+y\n$$\n")).toEqual(["math"]);
    expect(parseWritableMarkdown(" \n")).toEqual([]);
  });

  it("keeps prices and escaped dollars as text beside actual math", () => {
    const blocks = parseWritableMarkdown("Cost $12 and $5. Escaped \\$x\\$ and $x + y$.\n");
    const content = blocks[0]!.content![0]!.content!;
    expect(content.filter((node) => node.type === "inlineMath")).toEqual([
      { type: "inlineMath", attrs: { formula: "x + y" } },
    ]);
    expect(content.map((node) => node.text ?? "").join("")).toContain("Cost $12 and $5. Escaped $x$");
  });

  it("preserves escaped formula characters across inline lexer tokens", () => {
    const content = parseWritableMarkdown("Set $A = \\{1,2\\}$ and $B = \\\\alpha$.\n")[0]!.content![0]!.content!;
    expect(content.filter((node) => node.type === "inlineMath")).toEqual([
      { type: "inlineMath", attrs: { formula: "A = \\{1,2\\}" } },
      { type: "inlineMath", attrs: { formula: "B = \\\\alpha" } },
    ]);
  });

  it("keeps escaped block-start text together and decodes image captions", () => {
    const paragraph = parseWritableMarkdown("1\\. Not a list\n")[0]!.content![0]!;
    expect(paragraph.type).toBe("paragraph");
    expect(paragraph.content).toEqual([{ type: "text", text: "1. Not a list" }]);
    const image = parseWritableMarkdown("![Revenue \\$5M](https://example.com/chart.png)\n")[0]!.content![0]!;
    expect(image.attrs?.caption).toBe("Revenue $5M");
  });

  it("counts delimiters after a backtick line that is not a code fence", () => {
    expect(() => parseWritableMarkdown("```x```\n" + "![x]".repeat(3_000))).toThrow("too many markup delimiters");
  });

  it.each([
    '<unknown url="notion://blocks/id"/>',
    "<script>alert(1)</script>",
    "[bad](javascript:alert(1))",
    "![not inline](https://example.com) and words",
    "a".repeat(129 * 1024),
    "![x]".repeat(3_000),
  ])("rejects content that would change meaning or exceed limits", (source) => {
    expect(() => parseWritableMarkdown(source)).toThrow(/Markdown|link|128 KiB/);
  });
});
