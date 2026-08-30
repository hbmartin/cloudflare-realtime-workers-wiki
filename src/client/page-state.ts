import type { Page } from "../shared/types";
import { PAGE_FIELDS } from "../shared/validation";

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
  private readonly seenOperations = new Map<string, { pageIds: Set<string>; pinGeneration: number | null }>();
  private readonly seenOperationOrder: string[] = [];
  private readonly entries = new Map<
    string,
    { pinnedDuringLoad: number; pinGeneration: number; firstFreshPresenceGeneration: number | null }
  >();

  pin(pageIds: Iterable<string>, currentLoadGeneration: number, operationId?: string) {
    const ids = [...new Set(pageIds)];
    if (!ids.length) return;
    let operation = operationId ? this.seenOperations.get(operationId) : undefined;
    if (operationId) {
      if (!operation) {
        operation = { pageIds: new Set(), pinGeneration: null };
        this.seenOperations.set(operationId, operation);
        this.seenOperationOrder.push(operationId);
        if (this.seenOperationOrder.length > PageRemovalTombstones.MAX_SEEN_OPERATIONS) {
          this.seenOperations.delete(this.seenOperationOrder.shift()!);
        }
      }
    }
    let pinGeneration = operation?.pinGeneration ?? null;
    for (const pageId of ids) {
      if (operation?.pageIds.has(pageId)) continue;
      operation?.pageIds.add(pageId);
      const previous = this.entries.get(pageId);
      if (
        previous &&
        (currentLoadGeneration < previous.pinnedDuringLoad ||
          (pinGeneration !== null && pinGeneration < previous.pinGeneration))
      ) {
        continue;
      }
      pinGeneration ??= ++this.latestPinGeneration;
      if (operation) operation.pinGeneration = pinGeneration;
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

function samePage(left: Page, right: Page) {
  return PAGE_FIELDS.every((field) => left[field] === right[field]);
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
