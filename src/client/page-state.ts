import type { Page } from "../shared/types";

export function mergePages(current: Page[], incoming: Page[]) {
  const pages = new Map(current.map((page) => [page.id, page]));
  for (const page of incoming) {
    const previous = pages.get(page.id);
    if (!previous || page.revision >= previous.revision) pages.set(page.id, page);
  }
  return [...pages.values()];
}

export function mergePageSnapshot(current: Page[], snapshot: Page[]) {
  const existing = new Map(current.map((page) => [page.id, page]));
  return snapshot.map((page) => {
    const previous = existing.get(page.id);
    return previous && previous.revision > page.revision ? previous : page;
  });
}

export function reconcilePageSnapshot(
  current: Page[],
  snapshot: Page[],
  pendingUpserts: Page[],
  pendingRemovals: ReadonlySet<string>,
) {
  const reconciled = mergePages(snapshot, pendingUpserts)
    .filter((page) => !pendingRemovals.has(page.id));
  return {
    pages: mergePageSnapshot(current, reconciled),
    authoritativeIds: new Set(reconciled.map((page) => page.id)),
  };
}
