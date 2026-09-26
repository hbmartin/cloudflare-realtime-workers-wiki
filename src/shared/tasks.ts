export const TASK_STATUSES = ["todo", "doing", "done"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = { todo: "To do", doing: "In progress", done: "Done" };
export type Task = {
  id: string;
  listId: string;
  listTitle: string;
  spaceId: string;
  title: string;
  assigneeId: string | null;
  assigneeName: string | null;
  status: TaskStatus;
  dueDate: string | null;
  detailPageId: string;
  revision: number;
  editable: boolean;
};
export type TaskResponse = { tasks: Task[]; hasMore: boolean; nextCursor: string | null };
export type TaskFields = { title: string; assigneeId: string | null; status: TaskStatus; dueDate: string | null };
export function taskColumns(pageId: string) {
  return { title: `${pageId}-title`, assignee: `${pageId}-assignee`, status: `${pageId}-status`, due: `${pageId}-due` };
}
