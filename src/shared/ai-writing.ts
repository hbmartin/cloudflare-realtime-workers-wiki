import { parseWritableMarkdown } from "./notion-markdown-write";
import type { ProseMirrorJson } from "./types";

const STANDARD_BLOCKS = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "quote",
  "codeBlock",
  "divider",
]);
export function writingProtected(node: ProseMirrorJson, commentBlockIds: ReadonlySet<string> = new Set()): boolean {
  if (node.type === "blockContainer" && typeof node.attrs?.id === "string" && commentBlockIds.has(node.attrs.id))
    return true;
  if (
    node.marks?.some(
      (mark) =>
        !["bold", "italic", "underline", "strike", "code", "link", "textColor", "backgroundColor"].includes(
          mark.type ?? "",
        ),
    )
  )
    return true;
  if (
    node.type &&
    !["doc", "blockGroup", "blockContainer", "text", "hardBreak", ...STANDARD_BLOCKS].includes(node.type)
  )
    return true;
  return (node.content ?? []).some((child) => writingProtected(child, commentBlockIds));
}
const normalize = (node: ProseMirrorJson): ProseMirrorJson =>
  node.type === "mermaid"
    ? {
        type: "codeBlock",
        attrs: { language: "mermaid" },
        content: node.attrs?.source ? [{ type: "text", text: String(node.attrs.source) }] : [],
      }
    : { ...node, ...(node.content ? { content: node.content.map(normalize) } : {}) };

export function parseAiMarkdown(markdown: string): ProseMirrorJson[] {
  const blocks = parseWritableMarkdown(markdown);
  const normalized = blocks.map(normalize);
  if (normalized.some((node) => writingProtected(node)))
    throw new Error(
      "The result contains a structure outside standard writing Markdown. Copy it or ask for paragraphs, headings, lists, links, and code blocks.",
    );
  if (!normalized.length) throw new Error("The result is empty.");
  return normalized;
}
