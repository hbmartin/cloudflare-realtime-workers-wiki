import type { Page, PageNode } from "./types";

export function compareBinaryText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sort(items: PageNode[]) {
  items.sort((a, b) => compareBinaryText(a.position, b.position) || compareBinaryText(a.id, b.id));
  items.forEach((item) => sort(item.children));
}

export function buildTree(pages: Page[]): PageNode[] {
  const nodes = new Map(pages.map((page) => [page.id, { ...page, children: [] } satisfies PageNode]));
  const roots: PageNode[] = [];

  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    (parent?.children ?? roots).push(node);
  }

  sort(roots);
  return roots;
}

export type BranchSort = "manual" | "title-asc" | "title-desc" | "updated-desc" | "updated-asc";
export const BRANCH_SORT_LABELS: Record<BranchSort, string> = {
  manual: "Manual",
  "title-asc": "Title A–Z",
  "title-desc": "Title Z–A",
  "updated-desc": "Updated newest",
  "updated-asc": "Updated oldest",
};
const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export function sortedTree(
  nodes: readonly PageNode[],
  preferences: Readonly<Record<string, BranchSort>>,
  branch = "root",
): PageNode[] {
  const mode = preferences[branch] ?? "manual";
  const result = nodes.map((node) => ({ ...node, children: sortedTree(node.children, preferences, node.id) }));
  return result.sort((a, b) => {
    const comparison =
      mode === "title-asc" || mode === "title-desc"
        ? titleCollator.compare(a.title, b.title) * (mode === "title-desc" ? -1 : 1)
        : mode === "updated-asc" || mode === "updated-desc"
          ? (a.updatedAt - b.updatedAt) * (mode === "updated-desc" ? -1 : 1)
          : 0;
    return comparison || compareBinaryText(a.position, b.position) || compareBinaryText(a.id, b.id);
  });
}

export function findNode(tree: PageNode[], id: string): PageNode | null {
  for (const node of tree) {
    if (node.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested) return nested;
  }
  return null;
}

export function isDescendant(tree: PageNode[], ancestorId: string, descendantId: string): boolean {
  const ancestor = findNode(tree, ancestorId);
  return ancestor ? findNode(ancestor.children, descendantId) !== null : false;
}
