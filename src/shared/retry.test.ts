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
});
