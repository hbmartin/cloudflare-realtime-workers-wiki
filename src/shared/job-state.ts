import type { Job } from "./types";

const RUNNING_JOB_STATUSES = new Set<Job["status"]>(["queued", "running", "awaiting_confirmation", "canceling"]);
const CLEANUP_JOB_STATUSES = ["running", "failed", "canceling"] as const satisfies ReadonlyArray<Job["status"]>;
export const CLEANUP_JOB_STATUS_SQL = CLEANUP_JOB_STATUSES.map((status) => `'${status}'`).join(", ");
const CLEANUP_JOB_STATUS_SET = new Set<Job["status"]>(CLEANUP_JOB_STATUSES);

export function isJobActive(job: Pick<Job, "status" | "cleanupPending">) {
  return RUNNING_JOB_STATUSES.has(job.status) || job.cleanupPending;
}

export function jobPollDelay(jobs: ReadonlyArray<Pick<Job, "status" | "cleanupPending">>) {
  if (jobs.some((job) => RUNNING_JOB_STATUSES.has(job.status))) return 1_000;
  return jobs.some(isJobActive) ? 30_000 : null;
}

export function isCleanupJobStatus(status: Job["status"]) {
  return CLEANUP_JOB_STATUS_SET.has(status);
}

export function latestJobSnapshot(current: Job, incoming: Job) {
  return incoming.updatedAt > current.updatedAt ? incoming : current;
}
