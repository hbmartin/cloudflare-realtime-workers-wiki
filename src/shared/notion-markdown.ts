import { serializeDocument } from "./document-projection";
import { documentBlocks, type NotionBlock } from "./notion-blocks";
import type { ProseMirrorJson } from "./types";

export type MarkdownBlockSpan = { internalId: string; from: number; to: number };
export type NotionMarkdownProjection = {
  markdown: string;
  spans: MarkdownBlockSpan[];
  truncated: boolean;
  unknownBlockIds: string[];
};

const DIRECT_MARKDOWN_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "quote",
  "codeBlock",
  "divider",
  "math",
  "mermaid",
  "image",
  "audio",
  "video",
  "file",
  "pdf",
  "table",
  "tableOfContents",
  "breadcrumb",
  "linkToPage",
  "linkedDiagram",
]);

function attribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function container(block: NotionBlock): ProseMirrorJson {
  return {
    type: "blockContainer",
    attrs: { id: block.internalId },
    content: [
      block.node,
      ...(block.children.length ? [{ type: "blockGroup", content: block.children.map(container) }] : []),
    ],
  };
}

function representable(block: NotionBlock): boolean {
  return DIRECT_MARKDOWN_TYPES.has(block.type) && block.children.every(representable);
}

/** Keep a position map beside the response so future selections can target unchanged block IDs. */
export function projectNotionMarkdown(
  document: ProseMirrorJson,
  publicBlockIds: ReadonlyMap<string, string> = new Map(),
): NotionMarkdownProjection {
  const parts: string[] = [];
  const spans: MarkdownBlockSpan[] = [];
  let length = 0;
  for (const block of documentBlocks(document)) {
    const id = publicBlockIds.get(block.internalId) ?? block.id;
    const supported = representable(block);
    const text = supported
      ? serializeDocument({ type: "doc", content: [{ type: "blockGroup", content: [container(block)] }] }).markdown
      : `<unknown url="notion://blocks/${attribute(id)}" alt="${attribute(block.type)}"/>\n`;
    const from = length;
    parts.push(text);
    length += text.length;
    spans.push({ internalId: block.internalId, from, to: length });
  }
  return { markdown: parts.join("").trimEnd() + "\n", spans, truncated: false, unknownBlockIds: [] };
}
