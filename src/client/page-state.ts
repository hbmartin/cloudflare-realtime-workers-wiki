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
 * Keeps page removals applied across failed or stale tree loads. A tree load
 * may confirm a removal only when it started after the removal was pinned.
 */
export class PageRemovalTombstones {
  // The HTTP response and workspace event can report the same archive. Keep a
  // bounded history so delayed duplicates cannot restart or resurrect its grace period.
  private static readonly MAX_SEEN_OPERATIONS = 256;
  private latestPinGeneration = 0;
  private lastAppliedLoadGeneration = 0;
  private readonly seenOperations = new Set<string>();
  private readonly seenOperationOrder: string[] = [];
  private readonly entries = new Map<
    string,
    { pinnedDuringLoad: number; pinGeneration: number; firstFreshPresenceGeneration: number | null }
  >();

  pin(pageIds: Iterable<string>, currentLoadGeneration: number, operationId?: string) {
    const ids = [...pageIds];
    if (!ids.length) return;
    if (operationId && this.seenOperations.has(operationId)) return;
    if (operationId) {
      this.seenOperations.add(operationId);
      this.seenOperationOrder.push(operationId);
      if (this.seenOperationOrder.length > PageRemovalTombstones.MAX_SEEN_OPERATIONS) {
        this.seenOperations.delete(this.seenOperationOrder.shift()!);
      }
    }
    let pinGeneration: number | null = null;
    for (const pageId of ids) {
      pinGeneration ??= ++this.latestPinGeneration;
      this.entries.set(pageId, {
        pinnedDuringLoad: currentLoadGeneration,
        pinGeneration,
        firstFreshPresenceGeneration: null,
      });
    }
  }

  /** Captures which removals existed before an operation started. */
  checkpoint() {
    return this.latestPinGeneration;
  }

  pageIdsPinnedAfter(checkpoint: number) {
    const pageIds = new Set<string>();
    for (const [pageId, entry] of this.entries) {
      if (entry.pinGeneration > checkpoint) pageIds.add(pageId);
    }
    return pageIds;
  }

  /** Releases only removals that are no newer than the supplied checkpoint. */
  release(pageIds: Iterable<string>, checkpoint: number) {
    for (const pageId of pageIds) {
      const entry = this.entries.get(pageId);
      if (entry && entry.pinGeneration <= checkpoint) this.entries.delete(pageId);
    }
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
    if (loadGeneration <= this.lastAppliedLoadGeneration) {
      throw new Error("Page removal tombstones require strictly increasing load generations.");
    }
    this.lastAppliedLoadGeneration = loadGeneration;
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

const PAGE_FIELDS = [
  "id",
  "workspaceId",
  "parentId",
  "kind",
  "position",
  "title",
  "icon",
  "revision",
  "contentEpoch",
  "archivedAt",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof Page)[];

type UncomparedPageField = Exclude<keyof Page, (typeof PAGE_FIELDS)[number]>;

function samePage(left: Page, right: Page) {
  const allPageFieldsAreCompared: UncomparedPageField extends never ? true : never = true;
  return allPageFieldsAreCompared && PAGE_FIELDS.every((field) => left[field] === right[field]);
}

export function mergePages(current: Page[], incoming: Page[]) {
  const pages = new Map(current.map((page) => [page.id, page]));
  let changed = false;
  for (const page of incoming) {
    const previous = pages.get(page.id);
    if (!previous || (page.revision >= previous.revision && !samePage(previous, page))) {
      pages.set(page.id, page);
      changed = true;
    }
  }
  return changed ? [...pages.values()] : current;
}

export function mergePageSnapshot(current: Page[], snapshot: Page[]) {
  const existing = new Map(current.map((page) => [page.id, page]));
  let changed = current.length !== snapshot.length;
  const next = snapshot.map((page, index) => {
    const previous = existing.get(page.id);
    const merged = previous && (previous.revision > page.revision || samePage(previous, page)) ? previous : page;
    if (current[index] !== merged) changed = true;
    return merged;
  });
  return changed ? next : current;
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
