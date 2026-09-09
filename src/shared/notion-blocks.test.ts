import { describe, expect, it } from "vitest";
import { collectTransclusions, serializeDocument, type ProseMirrorJson } from "./document-projection";
import {
  documentBlocks,
  notionInputToBlockContainer,
  notionPayloadForBlock,
  notionRichTextToProseMirror,
  proseMirrorInlineToNotion,
} from "./notion-blocks";

function document(...blocks: ProseMirrorJson[]): ProseMirrorJson {
  return { type: "doc", content: [{ type: "blockGroup", content: blocks }] };
}

describe("Notion block adapter", () => {
  it.each([
    ["paragraph", { rich_text: [{ text: { content: "Hello" } }] }],
    ["heading_4", { rich_text: [{ text: { content: "Deep" } }] }],
    ["to_do", { rich_text: [], checked: true }],
    ["callout", { rich_text: [], icon: { emoji: "💡" } }],
    ["equation", { expression: "x^2" }],
    ["table_of_contents", {}],
    ["breadcrumb", {}],
    ["bookmark", { url: "https://example.test" }],
    ["embed", { url: "https://www.youtube.com/watch?v=abc" }],
    ["pdf", { type: "external", external: { url: "https://example.test/a.pdf" } }],
  ])("round-trips a %s block", (type, payload) => {
    const container = notionInputToBlockContainer({ type, [type]: payload });
    const block = documentBlocks(document(container))[0]!;
    expect(notionPayloadForBlock(block).type).toBe(type);
    expect(serializeDocument(document(container)).html).toContain("<body>");
  });

  it("round-trips text, page/user mentions, links, equations, annotations, and colors", () => {
    const notion = [
      {
        type: "text",
        text: { content: "linked", link: { url: "https://example.test" } },
        annotations: { bold: true, italic: true, color: "blue_background" },
      },
      { type: "mention", mention: { type: "page", page: { id: "page-id" } }, plain_text: "Page" },
      { type: "mention", mention: { type: "user", user: { id: "user-id" } }, plain_text: "User" },
      { type: "equation", equation: { expression: "a+b" } },
    ];
    const proseMirror = notionRichTextToProseMirror(notion);
    expect(proseMirrorInlineToNotion(proseMirror)).toMatchObject([
      { type: "text", text: { content: "linked", link: { url: "https://example.test" } } },
      { type: "mention", mention: { type: "page", page: { id: "page-id" } } },
      { type: "mention", mention: { type: "user", user: { id: "user-id" } } },
      { type: "equation", equation: { expression: "a+b" } },
    ]);
  });

  it("returns unsupported for heading levels outside the API contract", () => {
    const block = documentBlocks(
      document({
        type: "blockContainer",
        attrs: { id: "legacy" },
        content: [{ type: "heading", attrs: { level: 6 }, content: [{ type: "text", text: "Legacy" }] }],
      }),
    )[0]!;
    expect(notionPayloadForBlock(block)).toEqual({ type: "unsupported", payload: {} });
  });

  it("indexes synced sources and references without traversing source content twice", () => {
    const source = notionInputToBlockContainer({
      type: "synced_block",
      synced_block: { synced_from: null, children: [{ paragraph: { rich_text: [{ text: { content: "Shared" } }] } }] },
    });
    const sourceId = String(source.attrs?.id);
    const reference = notionInputToBlockContainer({
      type: "synced_block",
      synced_block: { synced_from: { type: "block_id", block_id: sourceId }, source_page_id: "source-page" },
    });
    expect(collectTransclusions(document(source, reference))).toMatchObject({
      sources: [{ blockId: sourceId }],
      references: [{ sourcePageId: "source-page", blockId: sourceId }],
    });
  });

  it("rejects disallowed embeds and oversized rich text", () => {
    expect(() => notionInputToBlockContainer({ embed: { url: "https://untrusted.example/embed" } })).toThrow(/YouTube/);
    expect(() => notionRichTextToProseMirror([{ text: { content: "x".repeat(2_001) } }])).toThrow(/2000/);
  });

  it("infers only supported payload keys when type is omitted", () => {
    const container = notionInputToBlockContainer({
      object: "block",
      id: "caller-id",
      parent: { type: "page_id", page_id: "page-id" },
      created_time: "2026-01-01T00:00:00.000Z",
      paragraph: { rich_text: [{ text: { content: "Hello" } }] },
    });
    expect(container).toMatchObject({
      attrs: { id: "caller-id" },
      content: [{ type: "paragraph", content: [{ text: "Hello" }] }],
    });
    expect(() => notionInputToBlockContainer({ paragraph: {}, quote: {} })).toThrow(/ambiguous/);
  });
});
