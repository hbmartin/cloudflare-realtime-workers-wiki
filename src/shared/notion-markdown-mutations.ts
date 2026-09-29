import { documentBlocks, type NotionBlock } from "./notion-blocks";
import type { MarkdownEdit } from "./notion-markdown-commands";
import type { NotionMarkdownProjection } from "./notion-markdown";
import { Lexer } from "marked";
import { MAX_MARKDOWN_DELIMITERS, MarkdownWriteError, parseWritableMarkdownWithSource } from "./notion-markdown-write";
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

function unchangedPairs(
  original: string[],
  replacement: string[],
  oldMeaning: string[] = [],
  newMeaning: string[] = [],
): Array<[number, number]> {
  const equal = (old: number, next: number) =>
    original[old] === replacement[next] || (oldMeaning[old] !== undefined && oldMeaning[old] === newMeaning[next]);
  const width = replacement.length + 1;
  const lengths = new Uint16Array((original.length + 1) * width);
  for (let old = original.length - 1; old >= 0; old -= 1)
    for (let next = replacement.length - 1; next >= 0; next -= 1)
      lengths[old * width + next] = equal(old, next)
        ? 1 + lengths[(old + 1) * width + next + 1]!
        : Math.max(lengths[(old + 1) * width + next]!, lengths[old * width + next + 1]!);
  const pairs: Array<[number, number]> = [];
  let old = 0;
  let next = 0;
  while (old < original.length && next < replacement.length) {
    if (equal(old, next)) {
      pairs.push([old++, next++]);
    } else if (lengths[(old + 1) * width + next]! >= lengths[old * width + next + 1]!) old += 1;
    else next += 1;
  }
  return pairs;
}

function markdownMeaningNode(node: ProseMirrorJson): unknown {
  const attrs = node.attrs ?? {};
  const meaningAttrs: Record<string, unknown> = {};
  const keys: Record<string, string[]> = {
    heading: ["level", "isToggleable"],
    checkListItem: ["checked"],
    codeBlock: ["language"],
    math: ["formula"],
    inlineMath: ["formula"],
    mermaid: ["source"],
    image: ["url", "caption"],
    link: ["href"],
  };
  for (const key of keys[node.type ?? ""] ?? []) if (attrs[key] !== undefined) meaningAttrs[key] = attrs[key];
  const children = (node.content ?? []).map(markdownMeaningNode);
  return {
    type: node.type,
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(Object.keys(meaningAttrs).length ? { attrs: meaningAttrs } : {}),
    ...(node.marks?.length ? { marks: node.marks.map((mark) => JSON.stringify(mark)).toSorted() } : {}),
    ...(children.length ? { children } : {}),
  };
}

function markdownMeaning(node: ProseMirrorJson): string {
  return JSON.stringify(markdownMeaningNode(node));
}

function preserveBlockStyle(previous: ProseMirrorJson, next: ProseMirrorJson): ProseMirrorJson {
  const previousNode = previous.content?.[0];
  const nextNode = next.content?.[0];
  if (!previousNode || !nextNode || previousNode.type !== nextNode.type) return next;
  const attrs = { ...nextNode.attrs };
  for (const key of ["backgroundColor", "textColor", "textAlignment"])
    if (previousNode.attrs?.[key] !== undefined) attrs[key] = previousNode.attrs[key];
  return { ...next, content: [{ ...nextNode, attrs }, ...next.content!.slice(1)] };
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
  const pairs = [
    ...unchangedPairs(
      oldSignatures,
      newSignatures,
      block.children.map((child) => markdownMeaning(blockContainer(child))),
      children.map(markdownMeaning),
    ),
    [block.children.length, children.length] as const,
  ];
  const aligned = [...children];
  let oldStart = 0;
  let newStart = 0;
  for (const [oldEnd, newEnd] of pairs) {
    const retained = Math.min(oldEnd - oldStart, newEnd - newStart);
    for (let index = 0; index < retained; index += 1) {
      const prior = block.children[oldStart + index]!;
      const next = aligned[newStart + index]!;
      const styled =
        oldEnd - oldStart === 1 && newEnd - newStart === 1 ? preserveBlockStyle(blockContainer(prior), next) : next;
      aligned[newStart + index] = preserveNestedIds(prior, {
        ...styled,
        attrs: { ...styled.attrs, id: prior.internalId },
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

function parseGroupPreservingMath(
  source: string,
  originals: Array<{ block: NotionBlock; span: NotionMarkdownProjection["spans"][number] }>,
  markdown: string,
  edits: MarkdownEdit[],
  allowDeletingContent: boolean,
) {
  const protectedMath = originals.filter(({ block }) => block.type === "math");
  if (!protectedMath.length) return { ...parseWritableMarkdownWithSource(source), deletedMathIds: [] as string[] };
  if (new TextEncoder().encode(source).length > 128 * 1024)
    throw new MarkdownWriteError("Markdown content exceeds 128 KiB.");
  const normalizedSource = source.replaceAll(/\r\n?/g, "\n");
  const codeRanges: Array<{ from: number; to: number }> = [];
  let tokenOffset = 0;
  for (const token of new Lexer({ gfm: true }).blockTokens(normalizedSource)) {
    const located = normalizedSource.indexOf(token.raw, tokenOffset);
    if (located < 0) throw new MarkdownWriteError("Markdown block offsets could not be resolved.");
    tokenOffset = located + token.raw.length;
    if (token.type === "code") codeRanges.push({ from: located, to: tokenOffset });
    if (token.type !== "paragraph" && token.type !== "text") continue;
    const runs: Array<{ from: number; to: number; length: number }> = [];
    for (let index = 0; index < token.raw.length; index += 1) {
      if (token.raw[index] !== "`") continue;
      let end = index + 1;
      while (token.raw[end] === "`") end += 1;
      const length = end - index;
      let slashes = 0;
      for (let before = index - 1; before >= 0 && token.raw[before] === "\\"; before -= 1) slashes += 1;
      const escaped = slashes % 2 === 1;
      if (!escaped || length > 1)
        runs.push({ from: index + Number(escaped), to: end, length: length - Number(escaped) });
      index = end - 1;
    }
    const nextByLength = new Map<number, number>();
    const closers: number[] = [];
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      closers[index] = nextByLength.get(runs[index]!.length) ?? -1;
      nextByLength.set(runs[index]!.length, index);
    }
    for (let index = 0; index < runs.length; index += 1) {
      const open = runs[index]!;
      const closeIndex = closers[index]!;
      if (closeIndex < 0) continue;
      codeRanges.push({ from: located + open.from, to: located + runs[closeIndex]!.to });
      index = closeIndex;
    }
  }
  codeRanges.sort((left, right) => left.from - right.from);
  let codeIndex = 0;
  const blocks: ProseMirrorJson[] = [];
  const rawBlocks: string[] = [];
  const deletedMathIds: string[] = [];
  let cursor = 0;
  let markupDelimiters = 0;
  const append = (segment: string) => {
    const parsed = parseWritableMarkdownWithSource(segment, MAX_MARKDOWN_DELIMITERS - markupDelimiters);
    markupDelimiters += parsed.delimiterCount;
    blocks.push(...parsed.blocks);
    if (blocks.length > 1000) throw new MarkdownWriteError("Markdown content exceeds 1000 blocks.");
    rawBlocks.push(...parsed.rawBlocks);
  };
  for (const { block, span } of protectedMath) {
    codeIndex = 0;
    const originalRaw = markdown.slice(span.from, span.to).trimEnd();
    const raw = originalRaw.replaceAll(/\r\n?/g, "\n");
    let found = normalizedSource.indexOf(raw, cursor);
    while (found >= 0) {
      while (codeRanges[codeIndex] && codeRanges[codeIndex]!.to <= found) codeIndex += 1;
      if (
        (found === 0 || normalizedSource[found - 1] === "\n") &&
        (found + raw.length === normalizedSource.length || normalizedSource[found + raw.length] === "\n") &&
        !(codeRanges[codeIndex] && codeRanges[codeIndex]!.from <= found)
      )
        break;
      found = normalizedSource.indexOf(raw, found + 1);
    }
    if (found < 0) {
      if (normalizedSource.includes(raw))
        throw new MarkdownWriteError("Math blocks cannot be moved or placed inside Markdown code.");
      if (
        allowDeletingContent &&
        edits.some((edit) => edit.from <= span.from && edit.to >= span.from + originalRaw.length)
      ) {
        deletedMathIds.push(block.internalId);
        continue;
      }
      throw new MarkdownWriteError("Math blocks must be edited through the block API.");
    }
    append(normalizedSource.slice(cursor, found));
    blocks.push(blockContainer(block));
    rawBlocks.push(raw);
    if (blocks.length > 1000) throw new MarkdownWriteError("Markdown content exceeds 1000 blocks.");
    cursor = found + raw.length;
  }
  append(normalizedSource.slice(cursor));
  return { blocks, rawBlocks, delimiterCount: markupDelimiters, deletedMathIds };
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
  const existingIds = new Set(blocks.map((block) => block.internalId));
  if (
    projection.spans.length < blocks.length ||
    projection.spans.slice(0, blocks.length).some((span, index) => span.internalId !== blocks[index]?.internalId)
  )
    throw new MarkdownWriteError("The Markdown projection does not match the document blocks.");
  const groups = groupsFor(projection, edits);
  const operations: MarkdownMutation[] = [];
  for (const group of groups.toReversed()) {
    const operationStart = operations.length;
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
    for (const [index, span] of projection.spans.slice(group.first, group.after).entries()) {
      const marker = projection.markdown.slice(span.from, span.to).trim();
      if (!marker.startsWith('<unknown url="notion://blocks/')) continue;
      if (original[index]?.type === "math") continue;
      const contentEnd = span.from + projection.markdown.slice(span.from, span.to).trimEnd().length;
      if (!allowDeletingContent || !group.edits.some((edit) => edit.from <= span.from && edit.to >= contentEnd))
        throw new MarkdownWriteError("A range cannot partially overwrite unknown content.");
    }
    const groupSource = replacementText(projection.markdown, from, to, group.edits);
    const originalSpans = original.map((block, index) => ({ block, span: projection.spans[group.first + index]! }));
    const parsed = parseGroupPreservingMath(
      groupSource,
      originalSpans,
      projection.markdown,
      group.edits,
      allowDeletingContent,
    );
    const replacement = parsed.blocks;
    const deletedMathIds = new Set(parsed.deletedMathIds);
    for (const { block } of originalSpans) {
      if (!deletedMathIds.has(block.internalId)) continue;
      if (blockHasProtectedContent(block, protectedBlockIds))
        throw new MarkdownWriteError(
          "A selected block has comments or comment anchors. Use the block API to edit it safely.",
        );
      operations.push({ type: "delete_block", internalId: block.internalId });
    }
    const retainedOriginal = originalSpans.flatMap(({ block, span }) => {
      return span.from !== span.to && !deletedMathIds.has(block.internalId) ? [{ block, span }] : [];
    });
    const oldSignatures = retainedOriginal.map(({ span }) => projection.markdown.slice(span.from, span.to).trimEnd());
    const newSignatures = parsed.rawBlocks;
    const pairs = [
      ...unchangedPairs(
        oldSignatures,
        newSignatures,
        retainedOriginal.map(({ block }) => markdownMeaning(blockContainer(block))),
        replacement.map(markdownMeaning),
      ),
      [retainedOriginal.length, replacement.length] as const,
    ];
    let oldStart = 0;
    let newStart = 0;
    let precedingId = blocks[group.first - 1]?.internalId;
    for (const [oldEnd, newEnd] of pairs) {
      const retained = Math.min(oldEnd - oldStart, newEnd - newStart);
      for (let index = 0; index < retained; index += 1) {
        const block = retainedOriginal[oldStart + index]!.block;
        if (blockHasProtectedContent(block, protectedBlockIds))
          throw new MarkdownWriteError(
            "A selected block has comments or comment anchors. Use the block API to edit it safely.",
          );
        if (NONEDITABLE_BLOCK_TYPES.has(block.type))
          throw new MarkdownWriteError("This block cannot be changed as Markdown. Use the block API.");
        const replacementBlock = replacement[newStart + index]!;
        const styled =
          oldEnd - oldStart === 1 && newEnd - newStart === 1
            ? preserveBlockStyle(blockContainer(block), replacementBlock)
            : replacementBlock;
        let container = canonicalizeMedia(preserveNestedIds(block, styled), canonicalMediaUrls);
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
      for (const { block } of retainedOriginal.slice(oldStart + retained, oldEnd)) {
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
      if (added.some((container) => existingIds.has(String(container.attrs?.id))))
        throw new MarkdownWriteError("An existing block cannot be inserted again as Markdown.");
      if (added.length) {
        operations.push({
          type: "append_children",
          children: added,
          position: precedingId ? { type: "after_block", afterInternalId: precedingId } : { type: "start" },
        });
        precedingId = String(added.at(-1)!.attrs?.id);
      }
      if (oldEnd < retainedOriginal.length) precedingId = retainedOriginal[oldEnd]!.block.internalId;
      oldStart = oldEnd + 1;
      newStart = newEnd + 1;
    }
    if (
      originalSpans.some(({ span }) => span.from === span.to) &&
      operations.slice(operationStart).some((operation) => operation.type !== "replace_block")
    )
      throw new MarkdownWriteError(
        "This selection contains an invisible block. Use the block API to reorder or remove it.",
      );
  }
  if (operations.length > 100) throw new MarkdownWriteError("The Markdown edit has too many block operations.");
  return operations;
}
