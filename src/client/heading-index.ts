export type HeadingBlock = {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: readonly HeadingBlock[];
};
export type IndexedHeading = { id: string; level: number; text: string };
function headingOf(block: HeadingBlock): IndexedHeading | null {
  if (block.type !== "heading" || Number(block.props?.level ?? 1) > 4) return null;
  const text = Array.isArray(block.content)
    ? block.content
        .map(
          (item: { text?: string; props?: { label?: string }; content?: { text?: string }[] }) =>
            item.text ?? item.props?.label ?? item.content?.map((run) => run.text ?? "").join("") ?? "",
        )
        .join("")
    : "";
  return text.trim() ? { id: block.id, level: Number(block.props?.level ?? 1), text } : null;
}
export function updateHeadingIndex(
  index: Map<string, IndexedHeading>,
  changes: readonly { type: string; block: HeadingBlock }[],
) {
  let changed = false;
  const visit = (block: HeadingBlock, remove: boolean) => {
    const heading = remove ? null : headingOf(block);
    const previous = index.get(block.id);
    if (heading) {
      if (!previous || previous.text !== heading.text || previous.level !== heading.level) {
        index.set(block.id, heading);
        changed = true;
      }
    } else if (previous) {
      index.delete(block.id);
      changed = true;
    }
    for (const child of block.children ?? []) visit(child, remove);
  };
  for (const change of changes) {
    visit(change.block, change.type === "delete");
    if (change.type === "move") {
      const containsHeading = (block: HeadingBlock): boolean =>
        index.has(block.id) || (block.children ?? []).some(containsHeading);
      if (containsHeading(change.block)) changed = true;
    }
  }
  return changed;
}
