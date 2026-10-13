import { MarkdownWriteError } from "./notion-markdown-write";
import { serializeMarkdownNode, type DocumentSerializationOptions } from "./document-projection";
import { documentBlocks, notionBlockRegistry, type NotionBlock } from "./notion-blocks";
import { hasUrlControls } from "./text";
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
export const MAX_MARKDOWN_BLOCKS = 1000;
export const MAX_UNKNOWN_BLOCK_IDS = 100;
const CONTENT_BUDGET_BYTES = MAX_MARKDOWN_BYTES - 16 * 1024;
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

const protectedInline = (node: ProseMirrorJson): boolean =>
  ["statusBadge", "footnoteReference"].includes(node.type ?? "") || (node.content ?? []).some(protectedInline);

function boundedCanonicalDocument(document: ProseMirrorJson) {
  const pending = [{ node: document, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > 250_000 || depth > 64)
      throw new MarkdownWriteError("Document traversal exceeds its structural limits.", "document_limits");
    if (node === null || typeof node !== "object" || Array.isArray(node))
      throw new MarkdownWriteError("Document node is malformed.", "invalid_document");
    if (node.content !== undefined && !Array.isArray(node.content))
      throw new MarkdownWriteError("Document content is malformed.", "invalid_document");
    for (const child of node.content ?? []) pending.push({ node: child, depth: depth + 1 });
  }
}

function representable(block: NotionBlock, options: DocumentSerializationOptions): boolean {
  if (!DIRECT_MARKDOWN_TYPES.has(block.type)) return false;
  if (protectedInline(block.node)) return false;
  if ((block.type === "linkToPage" || block.type === "linkedDiagram") && !options.pageHref) return false;
  if (block.type === "math" && typeof block.node.attrs?.formula === "string" && block.node.attrs.formula.includes("$$"))
    return false;
  if (MEDIA_TYPES.has(block.type)) {
    const url = block.node.attrs?.url;
    if (typeof url === "string" && hasUrlControls(url)) return false;
    if (typeof url === "string" && options.mediaHref?.(url) === null) return false;
    if (typeof url === "string" && url.startsWith("/api/attachments/") && !options.mediaHref) return false;
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
  limits: { complete?: boolean } = {},
): NotionMarkdownProjection {
  const parts: string[] = [];
  const spans: MarkdownBlockSpan[] = [];
  let length = 0;
  let bytes = 0;
  let truncated = false;
  const unknownBlockIds: string[] = [];
  if (limits.complete) boundedCanonicalDocument(document);
  const blocks = [...documentBlocks(document), ...additionalBlocks];
  const encoder = new TextEncoder();
  const appendOmitted = (block: NotionBlock, id: string, marker: string) => {
    if (unknownBlockIds.length >= MAX_UNKNOWN_BLOCK_IDS) return;
    const text = `${parts.at(-1)?.endsWith("\n\n") || !parts.length ? "" : "\n"}${marker}\n\n`;
    const markerBytes = encoder.encode(text).length;
    if (bytes + markerBytes > MAX_MARKDOWN_BYTES) return;
    const from = length;
    parts.push(text);
    length += text.length;
    bytes += markerBytes;
    spans.push({ internalId: block.internalId, from, to: length });
    unknownBlockIds.push(id);
  };
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const id = publicBlockIds.get(block.internalId) ?? block.id;
    const notionType = additionalBlocks.includes(block)
      ? "child_page"
      : (notionBlockRegistry[block.type as keyof typeof notionBlockRegistry]?.notionType ?? block.type);
    const marker = `<unknown url="notion://blocks/${attribute(id)}" alt="${attribute(notionType)}"/>`;
    if (truncated || (!limits.complete && spans.length >= MAX_MARKDOWN_BLOCKS)) {
      truncated = true;
      appendOmitted(block, id, marker);
      continue;
    }
    const supported = representable(block, options);
    const content = supported ? serializeMarkdownNode(container(block), options).trimEnd() : marker;
    const next = blocks[index + 1];
    const suffix =
      LIST_ITEM_TYPES.has(block.type) && next?.type === block.type && representable(next, options) ? "\n" : "\n\n";
    const text = content ? `${content}${suffix}` : "";
    const nextBytes = encoder.encode(text).length;
    if (!limits.complete && bytes + nextBytes > CONTENT_BUDGET_BYTES) {
      truncated = true;
      appendOmitted(block, id, marker);
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

/** Read a window from canonical content without allocating a second full Markdown copy. */
export function notionMarkdownWindow(
  document: ProseMirrorJson,
  options: DocumentSerializationOptions,
  offset: number,
  limit: number,
) {
  boundedCanonicalDocument(document);
  const blocks = documentBlocks(document);
  const unknownBlockIds: string[] = [];
  let textLength = 0;
  let markdown = "";
  let pendingSuffix = "";
  const append = (text: string) => {
    const start = Math.max(0, offset - textLength);
    const end = Math.min(text.length, offset + limit - textLength);
    if (end > start) markdown += text.slice(start, end);
    textLength += text.length;
  };
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    const supported = representable(block, options);
    const content = supported
      ? serializeMarkdownNode(container(block), options).trimEnd()
      : `<unknown url="notion://blocks/${attribute(block.id)}" alt="${attribute(notionBlockRegistry[block.type as keyof typeof notionBlockRegistry]?.notionType ?? block.type)}"/>`;
    if (!supported && unknownBlockIds.length < MAX_UNKNOWN_BLOCK_IDS) unknownBlockIds.push(block.id);
    if (!content) continue;
    if (pendingSuffix) append(pendingSuffix);
    append(content);
    const next = blocks[index + 1];
    pendingSuffix =
      LIST_ITEM_TYPES.has(block.type) && next?.type === block.type && representable(next, options) ? "\n" : "\n\n";
  }
  append("\n");
  // A UTF-16 limit may land inside an emoji. Leave it intact for the next chunk.
  const last = markdown.charCodeAt(markdown.length - 1);
  if (last >= 0xd800 && last <= 0xdbff && offset + markdown.length < textLength) markdown = markdown.slice(0, -1);
  return { markdown, textLength, unknownBlockIds };
}
