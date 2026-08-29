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

/**
 * Keeps archive removals applied across failed or stale tree loads. A tree load
 * may confirm a removal only when it started after the removal was pinned.
 */
export class PageRemovalTombstones {
  private readonly entries = new Map<
    string,
    { pinnedDuringLoad: number; firstFreshPresenceGeneration: number | null }
  >();

  pin(pageIds: Iterable<string>, currentLoadGeneration: number) {
    for (const pageId of pageIds) {
      const previous = this.entries.get(pageId);
      if (previous && currentLoadGeneration < previous.pinnedDuringLoad) continue;
      this.entries.set(pageId, {
        pinnedDuringLoad: currentLoadGeneration,
        firstFreshPresenceGeneration: null,
      });
    }
  }

  release(pageIds: Iterable<string>) {
    for (const pageId of pageIds) this.entries.delete(pageId);
  }

  has(pageId: string) {
    return this.entries.has(pageId);
  }

  /**
   * Applies one tree-load observation and returns the ids that load must hide.
   * One fresh load may still contain stale pre-removal data; repeated presence
   * is treated as authoritative so an incorrect tombstone cannot live forever.
   * Each strictly increasing load generation must be applied exactly once.
   */
  applyLoad(observedPageIds: ReadonlySet<string>, loadGeneration: number) {
    const hiddenPageIds = new Set<string>();
    for (const [pageId, entry] of this.entries) {
      if (loadGeneration <= entry.pinnedDuringLoad) {
        hiddenPageIds.add(pageId);
        continue;
      }
      if (!observedPageIds.has(pageId)) {
        hiddenPageIds.add(pageId);
        this.entries.delete(pageId);
        continue;
      }
      if (entry.firstFreshPresenceGeneration === null) {
        entry.firstFreshPresenceGeneration = loadGeneration;
        hiddenPageIds.add(pageId);
      } else {
        this.entries.delete(pageId);
      }
    }
    return hiddenPageIds;
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
