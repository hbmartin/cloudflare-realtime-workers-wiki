import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionRetryDelay, reconciliationRetryDelay } from "./retry";

afterEach(() => vi.restoreAllMocks());

describe("connectionRetryDelay", () => {
  it.each([
    [0, 1_000],
    [1, 2_000],
    [4, 16_000],
    [5, 30_000],
    [20, 30_000],
  ])("applies equal jitter below the capped ceiling for attempt %i", (attempt, ceiling) => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1 - Number.EPSILON);

    expect(connectionRetryDelay(attempt)).toBe(ceiling / 2);
    expect(connectionRetryDelay(attempt)).toBe(ceiling);
  });
});

describe("reconciliationRetryDelay", () => {
  it("uses equal jitter before retrying a stale read", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1 - Number.EPSILON);

    expect(reconciliationRetryDelay()).toBe(500);
    expect(reconciliationRetryDelay()).toBe(1_000);
  });
});
