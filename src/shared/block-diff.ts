import { documentBlocks, type NotionBlock } from "./notion-blocks";
import type { ProseMirrorJson } from "./types";

export type BlockChange = {
  id: string;
  kind: "added" | "removed" | "modified" | "moved";
  blockType: string;
  before: string;
  after: string;
};
export type DocumentDiff = { changes: BlockChange[]; counts: Record<BlockChange["kind"], number>; identical: boolean };
export type DigestComparison = { first: string; last: string; diff: DocumentDiff | null };
const COSMETIC = new Set([
  "backgroundColor",
  "textColor",
  "textAlignment",
  "color",
  "previewWidth",
  "previewHeight",
  "width",
  "height",
  "fontSize",
]);
type NormalizedNode = {
  type: string | undefined;
  text?: string;
  attrs: Record<string, unknown>;
  links: unknown[];
  content: NormalizedNode[];
};
function normalize(node: ProseMirrorJson): NormalizedNode {
  const content: NormalizedNode[] = [];
  for (const child of node.content ?? []) {
    if (child.type === "blockGroup") continue;
    const next = normalize(child),
      prior = content.at(-1);
    // Cosmetic marks can split one text run into several nodes.
    if (
      prior?.type === "text" &&
      next.type === "text" &&
      JSON.stringify(prior.links) === JSON.stringify(next.links) &&
      JSON.stringify(prior.attrs) === JSON.stringify(next.attrs)
    )
      prior.text = (prior.text ?? "") + (next.text ?? "");
    else content.push(next);
  }
  return {
    type: node.type,
    ...(node.text !== undefined ? { text: node.text } : {}),
    attrs: Object.fromEntries(
      Object.entries(node.attrs ?? {})
        .filter(([key]) => !COSMETIC.has(key))
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    links: (node.marks ?? []).filter((mark) => mark.type === "link").map((mark) => mark.attrs?.href ?? ""),
    content,
  };
}
function readable(node: NormalizedNode): string {
  let text = node.text ?? (node.type === "hardBreak" ? "\n" : "");
  text += node.content.map(readable).join("");
  for (const href of node.links) text += ` (${String(href)})`;
  for (const [key, value] of Object.entries(node.attrs)) {
    if (value !== undefined && value !== null && value !== "" && value !== "default")
      text += ` ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`;
  }
  return text;
}
type ComparedBlock = { block: NotionBlock; parent: string | null; signature: string; text: string };
function blocks(document: ProseMirrorJson) {
  const result = new Map<string, ComparedBlock>();
  const visit = (children: NotionBlock[], parent: string | null) => {
    for (const block of children) {
      const normalized = normalize(block.node);
      result.set(block.internalId, {
        block,
        parent,
        signature: JSON.stringify(normalized),
        text: readable(normalized).trim() || block.type,
      });
      visit(block.children, block.internalId);
    }
  };
  visit(documentBlocks(document), null);
  return result;
}
// A longest increasing subsequence distinguishes reorders from insertion/deletion shifts.
function stationary(ids: string[], previous: string[]) {
  const indexes = new Map(previous.map((id, index) => [id, index]));
  const tails: number[] = [],
    predecessors: number[] = [];
  ids.forEach((id, index) => {
    const value = indexes.get(id)!;
    let low = 0,
      high = tails.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (indexes.get(ids[tails[mid]!]!)! < value) low = mid + 1;
      else high = mid;
    }
    predecessors[index] = low ? tails[low - 1]! : -1;
    tails[low] = index;
  });
  const result = new Set<string>();
  for (let index = tails.at(-1) ?? -1; index >= 0; index = predecessors[index]!) result.add(ids[index]!);
  return result;
}
export function diffDocuments(before: ProseMirrorJson, after: ProseMirrorJson): DocumentDiff {
  const old = blocks(before),
    current = blocks(after),
    changes: BlockChange[] = [];
  const counts = { added: 0, removed: 0, modified: 0, moved: 0 };
  const push = (id: string, kind: BlockChange["kind"], value: ComparedBlock) => {
    counts[kind]++;
    changes.push({
      id,
      kind,
      blockType: value.block.type,
      before: old.get(id)?.text ?? "",
      after: current.get(id)?.text ?? "",
    });
  };
  const parents = new Map<string | null, string[]>();
  const priorSiblings = new Map<string | null, string[]>();
  for (const [id, value] of old) {
    const ids = priorSiblings.get(value.parent) ?? [];
    ids.push(id);
    priorSiblings.set(value.parent, ids);
  }
  for (const [id, value] of current) {
    const prior = old.get(id);
    if (!prior) push(id, "added", value);
    else {
      if (prior.signature !== value.signature) push(id, "modified", value);
      if (prior.parent !== value.parent) push(id, "moved", value);
      else {
        const siblings = parents.get(value.parent) ?? [];
        siblings.push(id);
        parents.set(value.parent, siblings);
      }
    }
  }
  for (const [parent, ids] of parents) {
    const selected = new Set(ids);
    const ordered = (priorSiblings.get(parent) ?? []).filter((id) => selected.has(id));
    const kept = stationary(ids, ordered);
    for (const id of ids) if (!kept.has(id)) push(id, "moved", current.get(id)!);
  }
  for (const [id, value] of old) if (!current.has(id)) push(id, "removed", value);
  return { changes, counts, identical: changes.length === 0 };
}
export function digestExcerpts(diff: DocumentDiff) {
  return diff.changes
    .filter((change) => change.kind !== "moved")
    .slice(0, 3)
    .map((change) => ({
      ...change,
      before: Array.from(change.before).slice(0, 240).join(""),
      after: Array.from(change.after).slice(0, 240).join(""),
    }));
}
