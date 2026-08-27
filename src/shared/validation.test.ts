import { describe, expect, it } from "vitest";
import { columnType, isPage, nullableId, pageKind, role, text, ValidationError } from "./validation";

describe("request validation", () => {
  it("accepts only defined roles and column kinds", () => {
    expect(role("owner")).toBe("owner");
    expect(pageKind("document")).toBe("document");
    expect(columnType("select")).toBe("select");
    expect(() => role("admin")).toThrow(ValidationError);
    expect(() => pageKind("canvas")).toThrow(ValidationError);
    expect(() => columnType("formula")).toThrow(ValidationError);
  });

  it("recognizes shared page payloads", () => {
    const page = {
      id: "page",
      workspaceId: "workspace",
      parentId: null,
      kind: "document",
      position: "a0",
      title: "Roadmap",
      icon: null,
      revision: 1,
      contentEpoch: 1,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
    };

    expect(isPage(page)).toBe(true);
    expect(isPage({ ...page, kind: "canvas" })).toBe(false);
    expect(isPage({ ...page, revision: "1" })).toBe(false);
  });

  it("normalizes bounded text and nullable ids", () => {
    expect(text("  Notes  ", "title")).toBe("Notes");
    expect(nullableId("", "parentId")).toBeNull();
    expect(() => text("", "title")).toThrow(ValidationError);
    expect(() => nullableId("bad/id", "parentId")).toThrow(ValidationError);
  });
});
