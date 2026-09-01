// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectionRetryDelay,
  observeUntilAborted,
  reconciliationRetryDelay,
  waitForReconciliationRetry,
} from "./retry";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
  it("jitters a 750 ms retry interval by 250 ms", () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1 - Number.EPSILON);

    expect(reconciliationRetryDelay()).toBe(500);
    expect(reconciliationRetryDelay()).toBe(1_000);
  });
});

describe("observeUntilAborted", () => {
  it("stops observing without cancelling the input promise", async () => {
    const controller = new AbortController();
    let resolveSource!: (value: string) => void;
    const source = new Promise<string>((resolve) => {
      resolveSource = resolve;
    });
    const observed = observeUntilAborted(source, controller.signal);

    controller.abort();

    await expect(observed).rejects.toBe(controller.signal.reason);
    resolveSource("completed");
    await expect(source).resolves.toBe("completed");
  });

  it("handles an input rejection when the signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const source = Promise.reject(new Error("late source failure"));

    await expect(observeUntilAborted(source, controller.signal)).rejects.toBe(controller.signal.reason);
    await Promise.resolve();
  });
});

describe("waitForReconciliationRetry", () => {
  it("resolves after the jittered delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const waiting = waitForReconciliationRetry();

    await vi.advanceTimersByTimeAsync(499);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(waiting).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the pending timer when cancelled", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = waitForReconciliationRetry(controller.signal);

    controller.abort();

    await expect(waiting).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
