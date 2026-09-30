export const SCHEDULED_TASK_NAMES = [
  "archive_disconnects",
  "deletion_jobs",
  "upload_reaps",
  "page_move_receipts",
  "queued_jobs",
  "notion_markdown_tasks",
  "outbox",
  "link_previews",
  "slack_redrive",
  "job_artifacts",
  "notification_digests",
  "date_reminders",
  "slack_digests",
  "slack_security_records",
  "webhook_history",
  "security_state",
  "oauth_security_records",
  "mcp_staged_pages",
  "table_search_values",
] as const;

export type ScheduledTaskName = (typeof SCHEDULED_TASK_NAMES)[number];
