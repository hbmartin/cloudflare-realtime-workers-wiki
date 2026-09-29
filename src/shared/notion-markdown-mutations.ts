import { documentBlocks, type NotionBlock } from "./notion-blocks";
import type { MarkdownEdit } from "./notion-markdown-commands";
import type { NotionMarkdownProjection } from "./notion-markdown";
import { MarkdownWriteError, parseWritableMarkdown } from "./notion-markdown-write";
import { serializeMarkdownNode } from "./document-projection";
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
const NONEDITABLE_BLOCK_TYPES = new Set([
  "audio",
  "video",
  "file",
  "pdf",
  "tableOfContents",
  "breadcrumb",
  "linkToPage",
  "linkedDiagram",
]);

function commentAnchor(node: ProseMirrorJson): boolean {
  if (node.marks?.some((mark) => mark.type?.startsWith("comment--"))) return true;
  return (node.content ?? []).some(commentAnchor);
}

function blockHasCommentAnchor(block: NotionBlock): boolean {
  return commentAnchor(block.node) || block.children.some(blockHasCommentAnchor);
}

function blockHasProtectedContent(block: NotionBlock, protectedBlockIds: ReadonlySet<string>): boolean {
  return (
    blockHasCommentAnchor(block) ||
    protectedBlockIds.has(block.internalId) ||
    block.children.some((child) => blockHasProtectedContent(child, protectedBlockIds))
  );
}

function affectedRange(projection: NotionMarkdownProjection, edit: MarkdownEdit): Pick<Group, "first" | "after"> {
  const spans = projection.spans;
  if (!spans.length) return { first: 0, after: 0 };
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
export function markdownEditTargets(
  document: ProseMirrorJson,
  projection: NotionMarkdownProjection,
  edits: MarkdownEdit[],
) {
  const bodyBlocks = new Map(documentBlocks(document).map((block) => [block.internalId, block]));
  return edits.map((edit) => {
    let { first, after } = affectedRange(projection, edit);
    if (edit.from === edit.to && edit.from === projection.markdown.length && first === projection.spans.length) {
      first = Math.min(first, bodyBlocks.size);
      after = first;
    }
    const spans = projection.spans.slice(first, after);
    return {
      blocks: spans.map((span) => ({
        id: span.internalId,
        source: bodyBlocks.get(span.internalId) ?? projection.markdown.slice(span.from, span.to),
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

function unchangedPairs(original: string[], replacement: string[]): Array<[number, number]> {
  const width = replacement.length + 1;
  const lengths = new Uint16Array((original.length + 1) * width);
  for (let old = original.length - 1; old >= 0; old -= 1)
    for (let next = replacement.length - 1; next >= 0; next -= 1)
      lengths[old * width + next] =
        original[old] === replacement[next]
          ? 1 + lengths[(old + 1) * width + next + 1]!
          : Math.max(lengths[(old + 1) * width + next]!, lengths[old * width + next + 1]!);
  const pairs: Array<[number, number]> = [];
  let old = 0;
  let next = 0;
  while (old < original.length && next < replacement.length) {
    if (original[old] === replacement[next]) {
      pairs.push([old++, next++]);
    } else if (lengths[(old + 1) * width + next]! >= lengths[old * width + next + 1]!) old += 1;
    else next += 1;
  }
  return pairs;
}

function blockContainer(block: NotionBlock): ProseMirrorJson {
  return {
    type: "blockContainer",
    attrs: { id: block.internalId },
    content: [
      block.node,
      ...(block.children.length ? [{ type: "blockGroup", content: block.children.map(blockContainer) }] : []),
    ],
  };
}

function preserveNestedIds(block: NotionBlock, container: ProseMirrorJson) {
  const group = container.content?.find((child) => child.type === "blockGroup");
  const children = group?.content;
  if (!children?.length || !block.children.length) return container;
  const oldSignatures = block.children.map((child) => serializeMarkdownNode(blockContainer(child)).trimEnd());
  const newSignatures = children.map((child) => serializeMarkdownNode(child).trimEnd());
  const pairs = [...unchangedPairs(oldSignatures, newSignatures), [block.children.length, children.length] as const];
  const aligned = [...children];
  let oldStart = 0;
  let newStart = 0;
  for (const [oldEnd, newEnd] of pairs) {
    const retained = Math.min(oldEnd - oldStart, newEnd - newStart);
    for (let index = 0; index < retained; index += 1) {
      const prior = block.children[oldStart + index]!;
      const next = aligned[newStart + index]!;
      aligned[newStart + index] = preserveNestedIds(prior, {
        ...next,
        attrs: { ...next.attrs, id: prior.internalId },
      });
    }
    if (oldEnd < block.children.length) aligned[newEnd] = blockContainer(block.children[oldEnd]!);
    oldStart = oldEnd + 1;
    newStart = newEnd + 1;
  }
  return {
    ...container,
    content: container.content!.map((child) => (child === group ? { ...child, content: aligned } : child)),
  };
}

function canonicalizeMedia(node: ProseMirrorJson, mediaUrls: ReadonlyMap<string, string>): ProseMirrorJson {
  const attrs = node.attrs ? { ...node.attrs } : undefined;
  if (attrs && typeof attrs.url === "string" && mediaUrls.has(attrs.url)) attrs.url = mediaUrls.get(attrs.url)!;
  return {
    ...node,
    ...(attrs ? { attrs } : {}),
    ...(node.content ? { content: node.content.map((child) => canonicalizeMedia(child, mediaUrls)) } : {}),
  };
}

/** Build one document-room transaction without rewriting any unselected block. */
export function markdownMutations(
  document: ProseMirrorJson,
  projection: NotionMarkdownProjection,
  edits: MarkdownEdit[],
  allowDeletingContent: boolean,
  protectedBlockIds: ReadonlySet<string> = new Set(),
  canonicalMediaUrls: ReadonlyMap<string, string> = new Map(),
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
    const operationCount = operations.length;
    if (
      group.first === projection.spans.length &&
      group.first === group.after &&
      group.edits.every((edit) => edit.from === edit.to && edit.from === projection.markdown.length)
    ) {
      group.first = blocks.length;
      group.after = blocks.length;
    }
    if (group.first > blocks.length || group.after > blocks.length)
      throw new MarkdownWriteError("This edit would change a child page outside the document.");
    const original = blocks.slice(group.first, group.after);
    const from =
      group.first === group.after
        ? group.edits[0]!.from
        : (projection.spans[group.first]?.from ?? projection.markdown.length);
    const to = group.after > group.first ? projection.spans[group.after - 1]!.to : from;
    const selectedMarkdown = projection.markdown.slice(from, to);
    for (const span of projection.spans.slice(group.first, group.after)) {
      const marker = projection.markdown.slice(span.from, span.to).trim();
      if (!marker.startsWith('<unknown url="notion://blocks/')) continue;
      if (!allowDeletingContent || !group.edits.some((edit) => edit.from <= span.from && edit.to >= span.to))
        throw new MarkdownWriteError("A range cannot partially overwrite unknown content.");
    }
    const replacement = parseWritableMarkdown(replacementText(projection.markdown, from, to, group.edits));
    const oldSignatures = original.map((_, index) => {
      const span = projection.spans[group.first + index]!;
      return projection.markdown.slice(span.from, span.to).trimEnd();
    });
    const newSignatures = replacement.map((container) => serializeMarkdownNode(container).trimEnd());
    const pairs = [...unchangedPairs(oldSignatures, newSignatures), [original.length, replacement.length] as const];
    let oldStart = 0;
    let newStart = 0;
    let precedingId = blocks[group.first - 1]?.internalId;
    for (const [oldEnd, newEnd] of pairs) {
      const retained = Math.min(oldEnd - oldStart, newEnd - newStart);
      for (let index = 0; index < retained; index += 1) {
        const block = original[oldStart + index]!;
        if (blockHasProtectedContent(block, protectedBlockIds))
          throw new MarkdownWriteError(
            "A selected block has comments or comment anchors. Use the block API to edit it safely.",
          );
        if (NONEDITABLE_BLOCK_TYPES.has(block.type))
          throw new MarkdownWriteError("This block cannot be changed as Markdown. Use the block API.");
        let container = canonicalizeMedia(preserveNestedIds(block, replacement[newStart + index]!), canonicalMediaUrls);
        if (block.type === "image" && container.content?.[0]?.type === "image") {
          const image = container.content[0];
          if (image.attrs?.url === block.node.attrs?.url)
            container = {
              ...container,
              content: [
                { ...image, attrs: { ...image.attrs, name: block.node.attrs?.name } },
                ...container.content.slice(1),
              ],
            };
        }
        operations.push({
          type: "replace_block",
          internalId: block.internalId,
          container: { ...container, attrs: { ...container.attrs, id: block.internalId } },
        });
        precedingId = block.internalId;
      }
      for (const block of original.slice(oldStart + retained, oldEnd)) {
        if (blockHasProtectedContent(block, protectedBlockIds))
          throw new MarkdownWriteError(
            "A selected block has comments or comment anchors. Use the block API to edit it safely.",
          );
        if (NONEDITABLE_BLOCK_TYPES.has(block.type) && !allowDeletingContent)
          throw new MarkdownWriteError("Removing this block requires allow_deleting_content.");
        operations.push({ type: "delete_block", internalId: block.internalId });
      }
      const added = replacement
        .slice(newStart + retained, newEnd)
        .map((container) => canonicalizeMedia(container, canonicalMediaUrls));
      if (added.length) {
        operations.push({
          type: "append_children",
          children: added,
          position: precedingId ? { type: "after_block", afterInternalId: precedingId } : { type: "start" },
        });
        precedingId = String(added.at(-1)!.attrs?.id);
      }
      if (oldEnd < original.length) precedingId = original[oldEnd]!.internalId;
      oldStart = oldEnd + 1;
      newStart = newEnd + 1;
    }
    if (
      operations.length === operationCount &&
      replacementText(projection.markdown, from, to, group.edits) !== selectedMarkdown
    )
      throw new MarkdownWriteError("The Markdown edit cannot be represented without changing other content.");
  }
  if (operations.length > 100) throw new MarkdownWriteError("The Markdown edit has too many block operations.");
  return operations;
}
