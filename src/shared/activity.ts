export const CHANNEL_EVENT_TYPES = [
  "mention",
  "reply",
  "thread_resolved",
  "thread_reopened",
  "page_edit",
  "page_created",
  "page_moved",
  "page_archived",
  "task_status_changed",
] as const;
export type ChannelEventType = (typeof CHANNEL_EVENT_TYPES)[number];
export const ACTIVITY_LABELS: Record<ChannelEventType, string> = {
  mention: "Mention",
  reply: "Comment reply",
  thread_resolved: "Thread resolved",
  thread_reopened: "Thread reopened",
  page_edit: "Page edited",
  page_created: "Page created",
  page_moved: "Page moved",
  page_archived: "Page archived",
  task_status_changed: "Task status changed",
};
export type ActivityItem = {
  id: string;
  pageId: string;
  spaceId: string;
  title: string;
  excerpt: string;
  kind: string;
  actorName: string | null;
  eventType: ChannelEventType | null;
  createdAt: number;
  unresolvedThreads: number;
  taskStatus: "todo" | "doing" | "done" | null;
  departure: boolean;
  available: boolean;
};
export type ActivityResponse = { items: ActivityItem[]; nextCursor: string | null };
