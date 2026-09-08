import type { Job } from "./types";

const RUNNING_JOB_STATUSES = new Set<Job["status"]>(["queued", "running", "awaiting_confirmation", "canceling"]);

export function isJobActive(job: Pick<Job, "status" | "cleanupPending">) {
  return RUNNING_JOB_STATUSES.has(job.status) || job.cleanupPending;
}

export function jobPollDelay(jobs: ReadonlyArray<Pick<Job, "status" | "cleanupPending">>) {
  if (jobs.some((job) => RUNNING_JOB_STATUSES.has(job.status))) return 1_000;
  return jobs.some(isJobActive) ? 30_000 : null;
}
