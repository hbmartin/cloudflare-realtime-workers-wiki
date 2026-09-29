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
    expect(projection.markdown).toBe("## Plans\nShip it\n");
    expect(
      projection.spans.map(({ internalId, from, to }) => ({ internalId, text: projection.markdown.slice(from, to) })),
    ).toEqual([
      { internalId: first.attrs!.id, text: "## Plans\n" },
      { internalId: second.attrs!.id, text: "Ship it\n" },
    ]);
    expect(projection).toMatchObject({ truncated: false, unknownBlockIds: [] });
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
