import { describe, expect, it } from "vitest";
import type { Page } from "../shared/types";
import { authoritativePageSnapshot, mergePages, PageLoadEventBuffer, reconcilePageSnapshot } from "./page-state";

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
    const result = reconcilePageSnapshot(
      [page("a", 3, "new"), page("removed", 1)],
      [page("a", 2, "old"), page("removed", 1)],
      [page("created", 1)],
      new Set(["removed"]),
    );
    expect(result.pages).toEqual([page("a", 3, "new"), page("created", 1)]);
  });

  it("drops a local page that the authoritative snapshot no longer lists", () => {
    const result = reconcilePageSnapshot([page("a", 1), page("stale", 9)], [page("a", 1)], [], new Set());

    expect(result.pages).toEqual([page("a", 1)]);
    expect([...result.authoritativeIds]).toEqual(["a"]);
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
