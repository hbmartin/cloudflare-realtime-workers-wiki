import { describe, expect, it } from "vitest";
import type { Page } from "../shared/types";
import {
  authoritativePageSnapshot,
  mergePages,
  mergePageSnapshot,
  PageLoadEventBuffer,
  PageRemovalTombstones,
} from "./page-state";

function page(id: string, revision: number, title = id): Page {
  return {
    id,
    workspaceId: "workspace",
    parentId: null,
    kind: "document",
    position: id,
    title,
    icon: null,
    revision,
    contentEpoch: 1,
    archivedAt: null,
    createdAt: 1,
    updatedAt: revision,
  };
}

describe("page state reconciliation", () => {
  it("ignores delayed page upserts with an older revision", () => {
    expect(mergePages([page("a", 3, "new")], [page("a", 2, "old")])).toEqual([page("a", 3, "new")]);
  });

  it("applies events that arrived while a tree snapshot was loading", () => {
    const authoritative = authoritativePageSnapshot(
      [page("a", 2, "old"), page("removed", 1)],
      [page("created", 1)],
      new Set(["removed"]),
    );
    const pages = mergePageSnapshot([page("a", 3, "new"), page("removed", 1)], authoritative.pages);

    expect(pages).toEqual([page("a", 3, "new"), page("created", 1)]);
  });

  it("drops a local page that the authoritative snapshot no longer lists", () => {
    const authoritative = authoritativePageSnapshot([page("a", 1)], [], new Set());
    const pages = mergePageSnapshot([page("a", 1), page("stale", 9)], authoritative.pages);

    expect(pages).toEqual([page("a", 1)]);
    expect([...authoritative.ids]).toEqual(["a"]);
  });

  it("discards a failed load's event window before a later retry", () => {
    const events = new PageLoadEventBuffer();
    events.start();
    events.recordRemovals(["old-removal"]);
    events.recordUpserts([page("old-upsert", 1)]);
    events.cancel();

    events.recordUpserts([page("ignored", 1)]);
    events.start();
    events.recordUpserts([page("retry-upsert", 2)]);

    expect(events.consume()).toEqual({
      upserts: [page("retry-upsert", 2)],
      removals: new Set(),
    });
  });

  it("retains archive removals through an in-flight load and one fresh stale observation", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin(["removed"], 2);

    expect(tombstones.applyLoad(new Set(["removed"]), 2)).toEqual(new Set(["removed"]));
    expect(tombstones.applyLoad(new Set(["removed"]), 3)).toEqual(new Set(["removed"]));
    expect(tombstones.applyLoad(new Set(["removed"]), 4)).toEqual(new Set());
  });

  it("rejects a repeated or older tree-load generation", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin(["removed"], 2);
    tombstones.applyLoad(new Set(["removed"]), 3);

    expect(() => tombstones.applyLoad(new Set(["removed"]), 3)).toThrow(/strictly increasing/);
  });

  it("releases an archive removal when a fresh load confirms it is absent", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin(["removed"], 1);

    expect(tombstones.applyLoad(new Set(), 2)).toEqual(new Set(["removed"]));
    expect(tombstones.has("removed")).toBe(false);
    expect(tombstones.applyLoad(new Set(), 3)).toEqual(new Set());
  });

  it("restarts recovery grace for a new removal", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin(["removed"], 5);
    expect(tombstones.applyLoad(new Set(["removed"]), 6)).toEqual(new Set(["removed"]));

    tombstones.pin(["removed"], 6);

    expect(tombstones.applyLoad(new Set(["removed"]), 7)).toEqual(new Set(["removed"]));
    expect(tombstones.applyLoad(new Set(["removed"]), 8)).toEqual(new Set());
  });

  it("does not restart recovery grace for an older removal", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin(["removed"], 5);
    expect(tombstones.applyLoad(new Set(["removed"]), 6)).toEqual(new Set(["removed"]));

    tombstones.pin(["removed"], 4);

    expect(tombstones.applyLoad(new Set(["removed"]), 7)).toEqual(new Set());
  });

  it("does not advance the removal checkpoint for an empty pin", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin(["removed"], 5);
    const checkpoint = tombstones.checkpoint();

    tombstones.pin([], 6);

    expect(tombstones.checkpoint()).toBe(checkpoint);
  });

  it("releases an archive removal when the page is explicitly restored", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin(["restored"], 1);
    const checkpoint = tombstones.checkpoint();

    tombstones.release(["restored"], checkpoint);

    expect(tombstones.applyLoad(new Set(["restored"]), 2)).toEqual(new Set());
  });

  it("does not release a removal pinned after the restoring operation began", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin(["restored"], 1);
    const checkpoint = tombstones.checkpoint();
    tombstones.pin(["restored"], 1);

    tombstones.release(["restored"], checkpoint);

    expect(tombstones.has("restored")).toBe(true);
  });

  it("computes the authoritative pages and ids once", () => {
    const result = authoritativePageSnapshot(
      [page("snapshot", 1), page("removed", 1)],
      [page("created", 1)],
      new Set(["removed"]),
    );

    expect(result.pages).toEqual([page("snapshot", 1), page("created", 1)]);
    expect([...result.ids]).toEqual(["snapshot", "created"]);
  });
});
