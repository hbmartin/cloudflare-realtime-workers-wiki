export const SCHEDULED_TASK_NAMES = [
  "archive_disconnects",
  "deletion_jobs",
  "upload_reaps",
  "page_move_receipts",
  "queued_jobs",
  "outbox",
  "slack_redrive",
  "job_artifacts",
  "notification_digests",
  "slack_digests",
  "slack_security_records",
  "webhook_history",
  "security_state",
] as const;

export type ScheduledTaskName = (typeof SCHEDULED_TASK_NAMES)[number];
