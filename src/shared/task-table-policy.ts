import type { TableCommand } from "./table-protocol";
import { taskColumns } from "./tasks";

function reject(): never {
  throw Object.assign(
    new Error("Use the task editor to change tasks. Fixed task properties and status options are protected."),
    { status: 422, code: "task_service_required" },
  );
}

/** Reserved task fields also own detail pages, receipts and notifications. Only the
 * authenticated Task service may mutate them; extra properties and saved views use
 * ordinary table commands. Enforced again inside the table authority. */
export function validateTaskTableCommand(pageId: string, command: TableCommand): void {
  const reserved = new Set(Object.values(taskColumns(pageId)));
  const payload = command.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) reject();
  if (["create_row", "delete_row", "move_row"].includes(command.kind)) reject();
  if (command.kind === "update_cells" && Object.keys((payload.values ?? {}) as object).some((id) => reserved.has(id)))
    reject();
  if (
    [
      "update_column",
      "delete_column",
      "prepare_type",
      "commit_type",
      "cancel_type",
      "add_option",
      "delete_option",
    ].includes(command.kind) &&
    reserved.has(String(payload.columnId))
  )
    reject();
  if (command.kind === "bulk") {
    if (!Array.isArray(payload.commands) || payload.commands.length > 2250) reject();
    for (const item of payload.commands as TableCommand[]) {
      if (!item || typeof item !== "object" || item.kind === "bulk") reject();
      validateTaskTableCommand(pageId, item);
    }
  }
}
