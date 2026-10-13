import { describe, expect, it } from "vitest";
import { tableFilterDefaults } from "./table-protocol";

describe("schema-aware table defaults", () => {
  it("keeps writable equality defaults and ignores computed, metadata and unknown properties", () => {
    expect(
      tableFilterDefaults(
        {
          kind: "group",
          operator: "and",
          filters: [
            { kind: "condition", columnId: "title", operator: "eq", value: "Default title" },
            { kind: "condition", columnId: "formula", operator: "eq", value: 1 },
            { kind: "condition", columnId: "creator", operator: "eq", value: "owner" },
            { kind: "condition", columnId: "unknown", operator: "eq", value: "missing" },
            { kind: "condition", columnId: "duplicate", operator: "eq", value: 1 },
            { kind: "condition", columnId: "duplicate", operator: "eq", value: 2 },
          ],
        },
        [
          { id: "title", type: "text" },
          { id: "formula", type: "formula" },
          { id: "creator", type: "created_by" },
          { id: "duplicate", type: "number" },
        ],
      ),
    ).toEqual({ title: "Default title" });
  });
});
