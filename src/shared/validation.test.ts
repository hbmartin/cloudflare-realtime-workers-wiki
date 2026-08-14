import { describe, expect, it } from "vitest";
import { columnType, nullableId, role, text, ValidationError } from "./validation";

describe("request validation", () => {
  it("accepts only defined roles and column kinds", () => {
    expect(role("owner")).toBe("owner");
    expect(columnType("select")).toBe("select");
    expect(() => role("admin")).toThrow(ValidationError);
    expect(() => columnType("formula")).toThrow(ValidationError);
  });

  it("normalizes bounded text and nullable ids", () => {
    expect(text("  Notes  ", "title")).toBe("Notes");
    expect(nullableId("", "parentId")).toBeNull();
    expect(() => text("", "title")).toThrow(ValidationError);
    expect(() => nullableId("bad/id", "parentId")).toThrow(ValidationError);
  });
});
