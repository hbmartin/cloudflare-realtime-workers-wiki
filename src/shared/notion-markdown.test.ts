import { describe, expect, it } from "vitest";
import { notionInputToBlockContainer } from "./notion-blocks";
import { projectNotionMarkdown } from "./notion-markdown";

function page(...blocks: ReturnType<typeof notionInputToBlockContainer>[]) {
  return { type: "doc", content: [{ type: "blockGroup", content: blocks }] };
}

describe("Notion Markdown projection", () => {
  it("projects supported blocks with stable source spans", () => {
    const first = notionInputToBlockContainer({ heading_2: { rich_text: [{ text: { content: "Plans" } }] } });
    const second = notionInputToBlockContainer({ paragraph: { rich_text: [{ text: { content: "Ship it" } }] } });
    const projection = projectNotionMarkdown(page(first, second));
    expect(projection.markdown).toBe("## Plans\n\nShip it\n");
    expect(
      projection.spans.map(({ internalId, from, to }) => ({ internalId, text: projection.markdown.slice(from, to) })),
    ).toEqual([
      { internalId: first.attrs!.id, text: "## Plans\n\n" },
      { internalId: second.attrs!.id, text: "Ship it\n" },
    ]);
    expect(projection).toMatchObject({ truncated: false, unknownBlockIds: [] });
  });

  it("separates paragraphs, dividers, and unknown markers as blocks", () => {
    const first = notionInputToBlockContainer({ paragraph: { rich_text: [{ text: { content: "Ship it" } }] } });
    const divider = notionInputToBlockContainer({ divider: {} });
    const unknown = notionInputToBlockContainer({ bookmark: { url: "https://example.test" } });
    const last = notionInputToBlockContainer({ paragraph: { rich_text: [{ text: { content: "Next" } }] } });
    const projection = projectNotionMarkdown(page(first, divider, unknown, last));
    expect(projection.markdown).toContain("Ship it\n\n---\n\n<unknown");
    expect(projection.markdown).toContain("/>\n\nNext\n");
    expect(projection.spans.every(({ from, to }) => from <= to && to <= projection.markdown.length)).toBe(true);
  });

  it("reports omitted block IDs when the page projection is truncated", () => {
    const blocks = Array.from({ length: 1002 }, (_, index) =>
      notionInputToBlockContainer({ paragraph: { rich_text: [{ text: { content: `Line ${index}` } }] } }),
    );
    const projection = projectNotionMarkdown(page(...blocks));
    expect(projection.truncated).toBe(true);
    expect(projection.unknownBlockIds).toEqual(blocks.slice(1000).map((block) => block.attrs!.id));
    expect(projection.markdown).not.toContain("Line 1001");
  });

  it("uses an inert marker for unsupported content, including nested content", () => {
    const bookmark = notionInputToBlockContainer({ bookmark: { url: "https://example.test" } });
    const nested = notionInputToBlockContainer({
      paragraph: {
        rich_text: [{ text: { content: "Parent" } }],
        children: [{ embed: { url: "https://www.youtube.com/watch?v=abc" } }],
      },
    });
    const ids = new Map([[String(bookmark.attrs?.id), 'a"<unsafe']]);
    const projection = projectNotionMarkdown(page(bookmark, nested), ids);
    expect(projection.markdown).toContain('url="notion://blocks/a&quot;&lt;unsafe"');
    expect(projection.markdown).toContain('alt="bookmark"');
    expect(projection.markdown).toContain('alt="paragraph"');
    expect(projection.markdown).not.toContain("https://example.test");
    expect(projection.markdown).not.toContain("Parent");
  });
});
