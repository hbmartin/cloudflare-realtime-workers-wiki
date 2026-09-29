import { documentBlocks, type NotionBlock } from "./notion-blocks";
import type { MarkdownEdit } from "./notion-markdown-commands";
import type { NotionMarkdownProjection } from "./notion-markdown";
import { MarkdownWriteError, parseWritableMarkdown } from "./notion-markdown-write";
import type { ProseMirrorJson } from "./types";

export type MarkdownMutation =
  | { type: "replace_block"; internalId: string; container: ProseMirrorJson }
  | { type: "delete_block"; internalId: string }
  | {
      type: "append_children";
      children: ProseMirrorJson[];
      position: { type: "start" | "end" | "after_block"; afterInternalId?: string };
    };

type Group = { first: number; after: number; edits: MarkdownEdit[] };

function commentAnchor(node: ProseMirrorJson): boolean {
  if (node.marks?.some((mark) => mark.type?.startsWith("comment--"))) return true;
  return (node.content ?? []).some(commentAnchor);
}

function blockHasCommentAnchor(block: NotionBlock): boolean {
  return commentAnchor(block.node) || block.children.some(blockHasCommentAnchor);
}

function affectedRange(projection: NotionMarkdownProjection, edit: MarkdownEdit): Pick<Group, "first" | "after"> {
  const spans = projection.spans;
  if (edit.from === edit.to) {
    const boundary = spans.findIndex((span) => span.from >= edit.from);
    if (boundary >= 0 && spans[boundary]!.from === edit.from) return { first: boundary, after: boundary };
    const inside = spans.findIndex((span) => span.from < edit.from && edit.from < span.to);
    if (inside >= 0) return { first: inside, after: inside + 1 };
    return { first: spans.length, after: spans.length };
  }
  const first = spans.findIndex((span) => span.to > edit.from && span.from < edit.to);
  if (first < 0) throw new MarkdownWriteError("The Markdown selection cannot be mapped to document blocks.");
  let after = first + 1;
  while (after < spans.length && spans[after]!.from < edit.to) after += 1;
  return { first, after };
}

function groupsFor(projection: NotionMarkdownProjection, edits: MarkdownEdit[]): Group[] {
  const groups: Group[] = [];
  for (const edit of edits) {
    const range = affectedRange(projection, edit);
    const preceding = groups.at(-1);
    if (preceding && range.first < preceding.after) {
      preceding.after = Math.max(preceding.after, range.after);
      preceding.edits.push(edit);
    } else groups.push({ ...range, edits: [edit] });
  }
  return groups;
}

/** Identify the original blocks and insertion boundaries before a retry. */
export function markdownEditTargets(projection: NotionMarkdownProjection, edits: MarkdownEdit[]) {
  return edits.map((edit) => {
    const { first, after } = affectedRange(projection, edit);
    const spans = projection.spans.slice(first, after);
    return {
      selected: projection.markdown.slice(edit.from, edit.to),
      blocks: spans.map((span) => ({
        id: span.internalId,
        markdown: projection.markdown.slice(span.from, span.to),
      })),
      before: spans.length ? null : (projection.spans[first - 1]?.internalId ?? null),
      after: spans.length ? null : (projection.spans[after]?.internalId ?? null),
    };
  });
}

function replacementText(markdown: string, from: number, to: number, edits: MarkdownEdit[]) {
  let text = markdown.slice(from, to);
  for (const edit of edits.toReversed()) {
    const localFrom = edit.from - from;
    const localTo = edit.to - from;
    text = text.slice(0, localFrom) + edit.text + text.slice(localTo);
  }
  return text;
}

/** Build one document-room transaction without rewriting any unselected block. */
export function markdownMutations(
  document: ProseMirrorJson,
  projection: NotionMarkdownProjection,
  edits: MarkdownEdit[],
  allowDeletingContent: boolean,
): MarkdownMutation[] {
  if (projection.truncated) throw new MarkdownWriteError("A truncated page cannot be edited as Markdown.");
  if (edits.length === 1 && edits[0]?.from === 0 && edits[0]?.to === projection.markdown.length) {
    const replacement = edits[0].text;
    let prefix = 0;
    while (
      prefix < replacement.length &&
      prefix < projection.markdown.length &&
      replacement[prefix] === projection.markdown[prefix]
    )
      prefix += 1;
    if (prefix === replacement.length && prefix === projection.markdown.length) return [];
    let suffix = 0;
    while (
      suffix < replacement.length - prefix &&
      suffix < projection.markdown.length - prefix &&
      replacement[replacement.length - suffix - 1] === projection.markdown[projection.markdown.length - suffix - 1]
    )
      suffix += 1;
    edits = [
      {
        from: prefix,
        to: projection.markdown.length - suffix,
        text: replacement.slice(prefix, replacement.length - suffix),
      },
    ];
  }
  const blocks = documentBlocks(document);
  if (
    projection.spans.length < blocks.length ||
    projection.spans.slice(0, blocks.length).some((span, index) => span.internalId !== blocks[index]?.internalId)
  )
    throw new MarkdownWriteError("The Markdown projection does not match the document blocks.");
  const groups = groupsFor(projection, edits);
  const operations: MarkdownMutation[] = [];
  for (const group of groups.toReversed()) {
    if (group.first > blocks.length || group.after > blocks.length)
      throw new MarkdownWriteError("This edit would change a child page outside the document.");
    const original = blocks.slice(group.first, group.after);
    if (original.some(blockHasCommentAnchor))
      throw new MarkdownWriteError("A selected block has comment anchors. Use the block API to edit it safely.");
    const from = projection.spans[group.first]?.from ?? projection.markdown.length;
    const to = group.after > group.first ? projection.spans[group.after - 1]!.to : from;
    const selectedMarkdown = projection.markdown.slice(from, to);
    if (selectedMarkdown.includes("<unknown") && !allowDeletingContent)
      throw new MarkdownWriteError("The edit would remove unsupported or child-page content.");
    if (selectedMarkdown.includes("<unknown") && group.first !== 0 && group.after !== blocks.length)
      throw new MarkdownWriteError("A range cannot partially overwrite unknown content.");
    const replacement = parseWritableMarkdown(replacementText(projection.markdown, from, to, group.edits));
    const retained = Math.min(original.length, replacement.length);
    for (let index = 0; index < retained; index += 1) {
      const id = original[index]!.internalId;
      const container = replacement[index]!;
      operations.push({
        type: "replace_block",
        internalId: id,
        container: { ...container, attrs: { ...container.attrs, id } },
      });
    }
    for (const block of original.slice(retained))
      operations.push({ type: "delete_block", internalId: block.internalId });
    const added = replacement.slice(retained);
    if (added.length) {
      const precedingId = retained ? original[retained - 1]!.internalId : blocks[group.first - 1]?.internalId;
      operations.push({
        type: "append_children",
        children: added,
        position: precedingId ? { type: "after_block", afterInternalId: precedingId } : { type: "start" },
      });
    }
  }
  if (operations.length > 100) throw new MarkdownWriteError("The Markdown edit has too many block operations.");
  return operations;
}
