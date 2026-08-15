import type { Page } from "../shared/types";

export class PageLoadEventBuffer {
  private recording = false;
  private readonly upserts = new Map<string, Page>();
  private readonly removals = new Set<string>();

  start() {
    this.recording = true;
  }

  recordUpserts(incoming: Page[]) {
    if (!this.recording) return;
    for (const page of incoming) {
      const previous = this.upserts.get(page.id);
      if (!previous || page.revision >= previous.revision) this.upserts.set(page.id, page);
      this.removals.delete(page.id);
    }
  }

  recordRemovals(pageIds: string[]) {
    if (!this.recording) return;
    for (const pageId of pageIds) {
      this.upserts.delete(pageId);
      this.removals.add(pageId);
    }
  }

  consume() {
    const result = {
      upserts: [...this.upserts.values()],
      removals: new Set(this.removals),
    };
    this.upserts.clear();
    this.removals.clear();
    this.recording = false;
    return result;
  }

  cancel() {
    this.upserts.clear();
    this.removals.clear();
    this.recording = false;
  }
}

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

export function authoritativePageSnapshot(
  snapshot: Page[],
  pendingUpserts: Page[],
  pendingRemovals: ReadonlySet<string>,
) {
  const pages = mergePages(snapshot, pendingUpserts).filter((page) => !pendingRemovals.has(page.id));
  return {
    pages,
    ids: new Set(pages.map((page) => page.id)),
  };
}

export function reconcilePageSnapshot(
  current: Page[],
  snapshot: Page[],
  pendingUpserts: Page[],
  pendingRemovals: ReadonlySet<string>,
) {
  const authoritative = authoritativePageSnapshot(snapshot, pendingUpserts, pendingRemovals);
  return {
    pages: mergePageSnapshot(current, authoritative.pages),
    authoritativeIds: authoritative.ids,
  };
}
