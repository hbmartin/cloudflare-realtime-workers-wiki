import { serializeMarkdownNode, type DocumentSerializationOptions } from "./document-projection";
import { documentBlocks, notionBlockRegistry, type NotionBlock } from "./notion-blocks";
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
  "tableOfContents",
  "breadcrumb",
  "linkToPage",
  "linkedDiagram",
]);
const MAX_MARKDOWN_BYTES = 512 * 1024;
const MAX_MARKDOWN_BLOCKS = 1000;
const LIST_ITEM_TYPES = new Set(["bulletListItem", "numberedListItem", "checkListItem"]);
const MEDIA_TYPES = new Set(["image", "audio", "video", "file", "pdf"]);

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

function representable(block: NotionBlock, options: DocumentSerializationOptions): boolean {
  if (!DIRECT_MARKDOWN_TYPES.has(block.type)) return false;
  if ((block.type === "linkToPage" || block.type === "linkedDiagram") && !options.pageHref) return false;
  if (MEDIA_TYPES.has(block.type)) {
    const url = block.node.attrs?.url;
    if (typeof url === "string" && url.startsWith("/api/attachments/") && !options.mediaHref?.(url)) return false;
  }
  if (!block.children.length) return true;
  if (!LIST_ITEM_TYPES.has(block.type)) return false;
  return block.children.every((child) => LIST_ITEM_TYPES.has(child.type) && representable(child, options));
}

/** Keep a position map beside the response so future selections can target unchanged block IDs. */
export function projectNotionMarkdown(
  document: ProseMirrorJson,
  publicBlockIds: ReadonlyMap<string, string> = new Map(),
  options: DocumentSerializationOptions = {},
  additionalBlocks: NotionBlock[] = [],
): NotionMarkdownProjection {
  const parts: string[] = [];
  const spans: MarkdownBlockSpan[] = [];
  let length = 0;
  let bytes = 0;
  let truncated = false;
  const unknownBlockIds: string[] = [];
  const blocks = [...documentBlocks(document), ...additionalBlocks];
  for (const block of blocks) {
    const id = publicBlockIds.get(block.internalId) ?? block.id;
    const supported = representable(block, options);
    const notionType = notionBlockRegistry[block.type as keyof typeof notionBlockRegistry]?.notionType ?? block.type;
    const content = supported
      ? serializeMarkdownNode(container(block), options).trimEnd()
      : `<unknown url="notion://blocks/${attribute(id)}" alt="${attribute(notionType)}"/>`;
    const text = content ? `${content}\n\n` : "";
    const nextBytes = new TextEncoder().encode(text).length;
    if (spans.length >= MAX_MARKDOWN_BLOCKS || bytes + nextBytes > MAX_MARKDOWN_BYTES) {
      truncated = true;
      if (unknownBlockIds.length < 100) unknownBlockIds.push(id);
      continue;
    }
    const from = length;
    parts.push(text);
    length += text.length;
    bytes += nextBytes;
    spans.push({ internalId: block.internalId, from, to: length });
  }
  const markdown = parts.join("").trimEnd() + "\n";
  for (const span of spans) {
    span.from = Math.min(span.from, markdown.length);
    span.to = Math.min(span.to, markdown.length);
  }
  return { markdown, spans, truncated, unknownBlockIds };
}
