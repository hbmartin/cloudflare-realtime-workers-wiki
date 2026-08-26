import { describe, expect, it } from "vitest";
import { mergeMutationRevision } from "./table-revision";

describe("mergeMutationRevision", () => {
  it("does not turn a concurrently invalidated revision back into a known revision", () => {
    expect(mergeMutationRevision(null, 7)).toBeNull();
  });

  it("advances an older known revision without regressing a newer snapshot", () => {
    expect(mergeMutationRevision(5, 7)).toBe(7);
    expect(mergeMutationRevision(8, 7)).toBe(8);
  });
});
