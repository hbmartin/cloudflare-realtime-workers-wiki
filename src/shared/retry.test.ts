import { afterEach, describe, expect, it, vi } from "vitest";
import { jitteredBackoff } from "./retry";

afterEach(() => vi.restoreAllMocks());

describe("jitteredBackoff", () => {
  it.each([
    [0, 5_000],
    [1, 10_000],
    [5, 160_000],
    [6, 300_000],
    [40, 300_000],
    [2_000, 300_000],
  ])("applies equal jitter below the capped ceiling for attempt %i", (attempt, ceiling) => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1 - Number.EPSILON);

    expect(jitteredBackoff(attempt, 5_000, 300_000)).toBe(ceiling / 2);
    expect(jitteredBackoff(attempt, 5_000, 300_000)).toBe(ceiling);
  });
});
