import { Fragment, Slice, type Node } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import type { AiSource } from "../shared/ai";
import { writingProtected, parseAiMarkdown } from "../shared/ai-writing";
import { projectionLeafText } from "../shared/document-projection";

export class WritingTargetError extends Error {}

type BlockPosition = { id: string; node: Node; pos: number };
export type WritingTarget = {
  kind: "page" | "selection" | "anchor";
  epoch: number;
  blocks: { id: string; fingerprint: string }[];
  fromOffset: number;
  toOffset: number;
  text: string;
};
export type WritingLaunchRequest = { id: string; pageId: string; target?: WritingTarget; conversationId?: string };
function positions(doc: Node): BlockPosition[] {
  const output: BlockPosition[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "blockContainer" && typeof node.attrs.id === "string")
      output.push({ id: node.attrs.id, node, pos });
  });
  return output;
}
export function captureWritingTarget(
  doc: Node,
  from: number,
  to: number,
  epoch: number,
  kind: WritingTarget["kind"] = from === to ? "page" : "selection",
): WritingTarget {
  const all = positions(doc);
  const blocks =
    kind === "page"
      ? all
      : kind === "anchor"
        ? all.filter((block) => block.pos < from && block.pos + block.node.nodeSize > from).slice(-1)
        : all.filter((block) => block.pos < to && block.pos + block.node.nodeSize > from);
  const first = blocks[0];
  return {
    kind,
    epoch,
    blocks: blocks.map((block) => ({ id: block.id, fingerprint: JSON.stringify(block.node.toJSON()) })),
    fromOffset: from - (first?.pos ?? 0),
    toOffset: to - (first?.pos ?? 0),
    text: kind === "selection" ? doc.textBetween(from, to, "\n", (leaf) => projectionLeafText(leaf.toJSON())) : "",
  };
}
export function targetSource(target: WritingTarget, pageId: string): AiSource {
  return {
    pageId,
    scope:
      target.kind === "selection"
        ? {
            kind: "selection",
            blockIds: target.blocks.map((block) => block.id),
            text: target.text,
            contentEpoch: target.epoch,
          }
        : { kind: "page" },
  };
}
export function writingTargetState(doc: Node, target: WritingTarget, epoch: number) {
  const all = positions(doc),
    selected = target.blocks.map((block) => all.find((item) => item.id === block.id));
  const lost = epoch !== target.epoch || selected.some((item) => !item) || !selected.length;
  const changed =
    lost ||
    selected.some((item, index) => JSON.stringify(item!.node.toJSON()) !== target.blocks[index]!.fingerprint) ||
    (target.kind === "page" &&
      (all.length !== target.blocks.length || all.some((block, index) => block.id !== target.blocks[index]?.id)));
  return {
    lost,
    changed,
    all,
    selected,
    from: (selected[0]?.pos ?? 0) + target.fromOffset,
    to: (selected[0]?.pos ?? 0) + target.toOffset,
  };
}
export function applyWriting(
  tr: Transaction,
  target: WritingTarget,
  epoch: number,
  markdown: string,
  mode: "replace" | "insert",
  protectedIds: ReadonlySet<string>,
) {
  const state = writingTargetState(tr.doc, target, epoch);
  const blocks = parseAiMarkdown(markdown).map((block) => tr.doc.type.schema.nodeFromJSON(block));
  if (mode === "replace") {
    if (target.kind === "anchor") throw new WritingTargetError("Choose document text to replace.");
    if (state.changed)
      throw new WritingTargetError(
        "The target changed or was restored. Regenerate from the current text, copy the result, or choose a new insertion location.",
      );
    if (state.selected.some((block) => writingProtected(block!.node.toJSON(), protectedIds)))
      throw new WritingTargetError(
        "This selection contains an attachment, embed, mention, comment anchor, or other protected structure. Select plain writing or insert the result separately.",
      );
    if (target.kind === "page") {
      const group = tr.doc.firstChild!;
      tr.replaceWith(1, group.nodeSize - 1, blocks);
    } else {
      // ProseMirror fits the closed block slice, preserving text before/after an
      // inline selection. The live editor dispatches this as one Yjs undo step.
      tr.replaceRange(state.from, state.to, new Slice(Fragment.fromArray(blocks), 0, 0));
    }
  } else if (target.kind === "page") {
    const group = tr.doc.firstChild!;
    tr.insert(group.nodeSize - 1, blocks);
  } else {
    if (state.lost || (target.kind === "selection" && state.changed))
      throw new WritingTargetError(
        "The insertion anchor changed or disappeared. Choose a new location in the document.",
      );
    const last = state.selected.at(-1)!;
    if (target.kind === "anchor") tr.insert(last!.pos + last!.node.nodeSize, blocks);
    else tr.replaceRange(state.to, state.to, new Slice(Fragment.fromArray(blocks), 0, 0));
  }
}
