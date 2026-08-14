import { describe, expect, it } from "vitest";
import type { Page } from "./types";
import { buildTree, findNode, isDescendant } from "./tree-model";

const page = (id: string, parentId: string | null, position: string): Page => ({
  id, parentId, position, workspaceId: "w", kind: "document", title: id, icon: null,
  revision: 1, contentEpoch: 1, archivedAt: null, createdAt: 1, updatedAt: 1,
});

describe("page tree", () => {
  it("builds a deterministic ordered immutable tree", () => {
    const source = [page("child-b", "root", "b"), page("root", null, "a"), page("child-a", "root", "a")];
    const tree = buildTree(source);
    expect(tree[0].children.map((child) => child.id)).toEqual(["child-a", "child-b"]);
    expect(source[0]).not.toHaveProperty("children");
  });

  it("uses SQLite BINARY-compatible ordering for mixed-case positions", () => {
    const tree = buildTree([page("lower", null, "a"), page("upper", null, "A")]);
    expect(tree.map((item) => item.id)).toEqual(["upper", "lower"]);
  });

  it("finds descendants for cycle prevention", () => {
    const tree = buildTree([page("root", null, "a"), page("child", "root", "a"), page("leaf", "child", "a")]);
    expect(findNode(tree, "leaf")?.id).toBe("leaf");
    expect(isDescendant(tree, "root", "leaf")).toBe(true);
    expect(isDescendant(tree, "leaf", "root")).toBe(false);
  });
});
