// Adapted from Docmost c1305f002e47ece4d40f0aebba75d8d0f762d8ea,
// features/editor/components/presentation/presentation.utils.ts; AGPL-3.0.
export type MeasuredBlock = {
  index: number;
  type: string;
  headingLevel?: number;
  blank: boolean;
  top: number;
  bottom: number;
  marginTop: number;
  marginBottom: number;
};
export type SlideLayout = { nodeIndexes: number[]; scrollable: boolean };
export function paginateBlocks(blocks: MeasuredBlock[], height: number): SlideLayout[] {
  const slides: SlideLayout[] = [];
  let current: MeasuredBlock[] = [];
  let used = 0;
  const close = () => {
    if (current.length) slides.push({ nodeIndexes: current.map((block) => block.index), scrollable: used > height });
    current = [];
    used = 0;
  };
  for (const block of blocks) {
    if (block.blank) continue;
    if (block.type === "divider") {
      close();
      continue;
    }
    if (block.bottom <= block.top) continue;
    const previous = current.at(-1);
    const gap = previous
      ? block.index === previous.index + 1
        ? block.top - previous.bottom
        : Math.max(previous.marginBottom, block.marginTop)
      : 0;
    const extended = previous ? used - previous.marginBottom + gap + block.bottom - block.top + block.marginBottom : 0;
    if (previous && !(block.type === "heading" && block.headingLevel === 1) && extended <= height) {
      current.push(block);
      used = extended;
    } else {
      close();
      current.push(block);
      used = block.marginTop + block.bottom - block.top + block.marginBottom;
    }
    if (["table", "linkedTableView"].includes(block.type)) close();
  }
  close();
  return slides;
}
export function deckKeyAction(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "target" | "defaultPrevented">,
) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input,textarea,select,[contenteditable="true"],[role="menu"],[role="tablist"]')) return null;
  if (["Enter", " "].includes(event.key) && target?.closest('button,a,summary,video,audio,[role="button"]'))
    return null;
  const actions = {
    ArrowRight: "next",
    ArrowLeft: "previous",
    Home: "first",
    End: "last",
    Enter: "next",
    " ": "pageDown",
    PageDown: "pageDown",
    PageUp: "pageUp",
    ArrowDown: "lineDown",
    ArrowUp: "lineUp",
  } as const;
  return actions[event.key as keyof typeof actions] ?? null;
}
