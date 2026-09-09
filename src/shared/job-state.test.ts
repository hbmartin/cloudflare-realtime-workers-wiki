import { describe, expect, it } from "vitest";
import type { Job } from "./types";
import { isCleanupJobStatus, isJobActive, jobPollDelay, latestJobSnapshot } from "./job-state";

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

  it("keeps cleanup eligibility in one shared status set", () => {
    expect(isCleanupJobStatus("running")).toBe(true);
    expect(isCleanupJobStatus("failed")).toBe(true);
    expect(isCleanupJobStatus("canceling")).toBe(true);
    expect(isCleanupJobStatus("queued")).toBe(false);
  });

  it("does not replace a newer job snapshot with a stale mutation response", () => {
    const snapshot = (status: Job["status"], updatedAt: number): Job => ({
      id: "job-1",
      workspaceId: "workspace-1",
      spaceId: null,
      type: "import",
      status,
      progress: { current: 0, total: 1, label: status },
      warnings: [],
      result: null,
      error: null,
      hasDownload: false,
      cleanupPending: status === "canceling",
      expiresAt: null,
      createdAt: 1,
      updatedAt,
    });
    const completed = snapshot("canceled", 3);

    expect(latestJobSnapshot(completed, snapshot("canceling", 2))).toBe(completed);
    expect(latestJobSnapshot(completed, snapshot("canceling", 3))).toBe(completed);
    expect(latestJobSnapshot(completed, snapshot("failed", 4)).status).toBe("failed");
  });
});
