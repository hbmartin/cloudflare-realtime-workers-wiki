import type { Page, PageNode } from "./types";

export function compareBinaryText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildTree(pages: Page[]): PageNode[] {
  const nodes = new Map(pages.map((page) => [page.id, { ...page, children: [] } satisfies PageNode]));
  const roots: PageNode[] = [];

  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    (parent?.children ?? roots).push(node);
  }

  const sort = (items: PageNode[]) => {
    items.sort((a, b) => compareBinaryText(a.position, b.position) || compareBinaryText(a.id, b.id));
    items.forEach((item) => sort(item.children));
  };
  sort(roots);
  return roots;
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
