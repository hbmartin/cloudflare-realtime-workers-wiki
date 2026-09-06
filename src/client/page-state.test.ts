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
    spaceId: "workspace-general",
    parentId: null,
    kind: "document",
    position: id,
    title,
    icon: null,
    revision,
    contentEpoch: 1,
    isTemplate: false,
    archivedAt: null,
    createdAt: 1,
    updatedAt: revision,
  };
}

describe("page state reconciliation", () => {
  it("ignores delayed page upserts with an older revision", () => {
    const current = [page("a", 3, "new")];

    expect(mergePages(current, [page("a", 2, "old")])).toBe(current);
  });

  it("preserves the current array when an upsert is already present", () => {
    const existing = page("a", 3, "current");
    const current = [existing];

    expect(mergePages(current, [existing])).toBe(current);
  });

  it("preserves the current array for a structurally identical upsert", () => {
    const current = [page("a", 3, "current")];

    expect(mergePages(current, [page("a", 3, "current")])).toBe(current);
  });

  it("applies a structurally changed upsert with the same revision", () => {
    const current = [page("a", 3, "old title")];

    expect(mergePages(current, [page("a", 3, "new title")])).toEqual([page("a", 3, "new title")]);
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

  it("preserves the current array for a structurally identical snapshot", () => {
    const current = [page("a", 1), page("b", 2)];

    expect(mergePageSnapshot(current, [page("a", 1), page("b", 2)])).toBe(current);
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

    expect(tombstones.hasEntries()).toBe(true);
    expect(tombstones.applyLoad(new Set(), 2)).toEqual(new Set(["removed"]));
    expect(tombstones.has("removed")).toBe(false);
    expect(tombstones.hasEntries()).toBe(false);
    expect(tombstones.applyLoad(new Set(), 3)).toEqual(new Set());
  });

  it("restarts recovery grace for a new removal", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin(["removed"], 5, "first-removal");
    expect(tombstones.applyLoad(new Set(["removed"]), 6)).toEqual(new Set(["removed"]));

    tombstones.pin(["removed"], 6, "second-removal");

    expect(tombstones.applyLoad(new Set(["removed"]), 7)).toEqual(new Set(["removed"]));
    expect(tombstones.applyLoad(new Set(["removed"]), 8)).toEqual(new Set());
  });

  it("does not restart recovery grace for a duplicate removal operation", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin(["removed"], 5, "same-removal");
    expect(tombstones.applyLoad(new Set(["removed"]), 6)).toEqual(new Set(["removed"]));

    tombstones.pin(["removed"], 6, "same-removal");

    expect(tombstones.applyLoad(new Set(["removed"]), 7)).toEqual(new Set());
  });

  it("adds authoritative page ids reported by a duplicate removal operation", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin(["root"], 5, "same-removal");
    const checkpoint = tombstones.checkpoint();

    tombstones.pin(["root", "child"], 6, "same-removal");

    expect(tombstones.has("root")).toBe(true);
    expect(tombstones.has("child")).toBe(true);
    expect(tombstones.checkpoint()).toBe(checkpoint);
    expect(tombstones.pageIdsPinnedAfter(checkpoint)).toEqual(new Set());
  });

  it("does not let an older operation overwrite a newer removal for the same page", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin(["root"], 5, "older-removal");
    const checkpoint = tombstones.checkpoint();
    tombstones.pin(["child"], 6, "newer-removal");

    tombstones.pin(["root", "child"], 7, "older-removal");
    tombstones.release(["child"], checkpoint);

    expect(tombstones.has("child")).toBe(true);
    expect(tombstones.pageIdsPinnedAfter(checkpoint)).toEqual(new Set(["child"]));
  });

  it("does not re-pin a released tombstone for a delayed duplicate operation", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin(["removed"], 5, "same-removal");
    const checkpoint = tombstones.checkpoint();
    tombstones.release(["removed"], checkpoint);

    tombstones.pin(["removed"], 6, "same-removal");

    expect(tombstones.has("removed")).toBe(false);
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

  it("does not consume an operation id for an empty pin", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin([], 5, "removal");

    tombstones.pin(["removed"], 5, "removal");

    expect(tombstones.has("removed")).toBe(true);
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

  it("reports removals pinned after a reconciliation checkpoint", () => {
    const tombstones = new PageRemovalTombstones();
    tombstones.pin(["older"], 1);
    const checkpoint = tombstones.checkpoint();
    tombstones.pin(["newer"], 1);

    expect(tombstones.pageIdsPinnedAfter(checkpoint)).toEqual(new Set(["newer"]));
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
