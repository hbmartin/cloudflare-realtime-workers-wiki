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

  it("marks an oversized middle block and omits later content as a suffix", () => {
    const first = notionInputToBlockContainer({ paragraph: { rich_text: [{ text: { content: "First" } }] } });
    const huge = {
      type: "blockContainer",
      attrs: { id: "oversized-block" },
      content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(600_000) }] }],
    } as ReturnType<typeof notionInputToBlockContainer>;
    const last = notionInputToBlockContainer({ paragraph: { rich_text: [{ text: { content: "Last" } }] } });
    const projection = projectNotionMarkdown(page(first, huge, last));
    expect(projection.truncated).toBe(true);
    expect(projection.unknownBlockIds).toEqual([huge.attrs!.id, last.attrs!.id]);
    expect(projection.markdown).toContain("notion://blocks/oversized-block");
    expect(projection.markdown).not.toContain("\nLast\n");
  });

  it("keeps consecutive list items tight", () => {
    const first = notionInputToBlockContainer({ bulleted_list_item: { rich_text: [{ text: { content: "One" } }] } });
    const second = notionInputToBlockContainer({ bulleted_list_item: { rich_text: [{ text: { content: "Two" } }] } });
    expect(projectNotionMarkdown(page(first, second)).markdown).toBe("- One\n- Two\n");
  });

  it("separates a tight list from an unknown or truncated following item", () => {
    const first = notionInputToBlockContainer({ bulleted_list_item: { rich_text: [{ text: { content: "One" } }] } });
    const unsupported = notionInputToBlockContainer({
      bulleted_list_item: {
        rich_text: [{ text: { content: "Two" } }],
        children: [{ paragraph: { rich_text: [{ text: { content: "Nested" } }] } }],
      },
    });
    expect(projectNotionMarkdown(page(first, unsupported)).markdown).toContain("- One\n\n<unknown");
    const preceding = Array.from({ length: 999 }, () =>
      notionInputToBlockContainer({ paragraph: { rich_text: [{ text: { content: "Before" } }] } }),
    );
    const later = notionInputToBlockContainer({ bulleted_list_item: { rich_text: [{ text: { content: "Later" } }] } });
    expect(projectNotionMarkdown(page(...preceding, first, later)).markdown).toContain("- One\n\n<unknown");
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
