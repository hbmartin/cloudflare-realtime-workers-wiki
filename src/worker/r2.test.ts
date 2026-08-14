import { describe, expect, it } from "vitest";
import { normalizeR2Range } from "./r2";

describe("R2 range normalization", () => {
  it("normalizes bounded ranges", () => {
    expect(normalizeR2Range({ offset: 100, length: 50 }, 1_000)).toEqual({ offset: 100, length: 50 });
  });

  it("handles R2 runtime objects that expose an undefined suffix getter", () => {
    const runtimeRange = { offset: 2, length: 4, suffix: undefined } as unknown as R2Range;
    expect(normalizeR2Range(runtimeRange, 10)).toEqual({ offset: 2, length: 4 });
  });

  it("normalizes open-ended ranges", () => {
    expect(normalizeR2Range({ offset: 100 }, 1_000)).toEqual({ offset: 100, length: 900 });
  });

  it("normalizes suffix ranges", () => {
    expect(normalizeR2Range({ suffix: 500 }, 1_000)).toEqual({ offset: 500, length: 500 });
  });

  it("clamps oversized suffixes and bounded ranges to the object", () => {
    expect(normalizeR2Range({ suffix: 5_000 }, 1_000)).toEqual({ offset: 0, length: 1_000 });
    expect(normalizeR2Range({ offset: 900, length: 500 }, 1_000)).toEqual({ offset: 900, length: 100 });
  });
});
