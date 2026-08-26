import { afterEach, describe, expect, it, vi } from "vitest";
import { jitteredBackoff, jitteredInterval } from "./retry";

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

  it.each([
    [-1, 5_000, 300_000],
    [0.5, 5_000, 300_000],
    [Number.NaN, 5_000, 300_000],
    [0, 0, 300_000],
    [0, 0.1, 300_000],
    [0, Number.POSITIVE_INFINITY, 300_000],
    [0, 5_000, 0],
    [0, 5_000, 0.1],
    [0, 5_000, Number.POSITIVE_INFINITY],
  ])("rejects invalid backoff inputs %s, %s, and %s", (attempt, base, cap) => {
    expect(() => jitteredBackoff(attempt, base, cap)).toThrow(RangeError);
  });

  it("returns a positive delay at the minimum valid interval", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    expect(jitteredBackoff(0, 1, 1)).toBe(1);
  });
});

describe("jitteredInterval", () => {
  it.each([
    [0, 4_000],
    [0.5, 5_000],
    [1 - Number.EPSILON, 6_000],
  ])("maps random value %f across the complete interval", (random, expected) => {
    vi.spyOn(Math, "random").mockReturnValue(random);

    expect(jitteredInterval(5_000, 1_000)).toBe(expected);
  });

  it.each([
    [0, 0],
    [Number.POSITIVE_INFINITY, 1],
    [5_000, -1],
    [5_000, 5_000],
    [5_000, Number.NaN],
  ])("rejects an invalid interval %s and spread %s", (interval, spread) => {
    expect(() => jitteredInterval(interval, spread)).toThrow(RangeError);
  });

  it.each([
    [5_000, 0, 0, 5_000],
    [5_000, 4_999, 0, 1],
    [5_000, 4_999, 1 - Number.EPSILON, 9_999],
    [5_000, 4_999.9, 0, 1],
  ])(
    "returns a positive delay for interval %s, spread %s, and random value %s",
    (interval, spread, random, expected) => {
      vi.spyOn(Math, "random").mockReturnValue(random);

      expect(jitteredInterval(interval, spread)).toBe(expected);
    },
  );
});
