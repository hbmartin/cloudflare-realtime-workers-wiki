import { describe, expect, it } from "vitest";
import type { Job } from "./types";
import { isJobActive, jobPollDelay } from "./job-state";

const job = (status: Job["status"], cleanupPending = false) => ({ status, cleanupPending });

describe("job activity state", () => {
  it("treats cleanup as active even after the job itself fails", () => {
    expect(isJobActive(job("failed", true))).toBe(true);
    expect(isJobActive(job("failed"))).toBe(false);
  });

  it("polls running work quickly and deferred cleanup with a backoff", () => {
    expect(jobPollDelay([job("running")])).toBe(1_000);
    expect(jobPollDelay([job("failed", true)])).toBe(30_000);
    expect(jobPollDelay([job("failed", true), job("canceling", true)])).toBe(1_000);
    expect(jobPollDelay([job("succeeded")])).toBeNull();
  });
});
