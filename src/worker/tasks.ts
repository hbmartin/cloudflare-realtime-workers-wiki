import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import type { Env, MemberContext } from "./env";
import { HttpError, sha256 } from "./http";
import { effectiveSpaceRole, pageForMember } from "./page-access";
import { canonicalJson, sha256Hex } from "../shared/import-integrity";
import { ID_PATTERN, PAGE_TITLE_MAX } from "../shared/validation";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  taskColumns,
  type Task,
  type TaskFields,
  type TaskResponse,
  type TaskStatus,
} from "../shared/tasks";
import { TABLE_MAX_ROWS } from "../shared/table-limits";
import { notificationFanoutStatements } from "./notifications";
import { refreshPageSearchV2Statements, refreshPageSearchV2SubtreeStatements } from "./search-index";

export function taskListStatements(db: D1Database, pageId: string) {
  const columns = taskColumns(pageId);
  return [
    ...(
      [
        [columns.title, "Task", "text"],
        [columns.assignee, "Assignee", "text"],
        [columns.status, "Status", "select"],
        [columns.due, "Due date", "date"],
      ] as const
    ).map(([id, name, type], position) =>
      db
        .prepare("INSERT INTO table_columns (id,page_id,name,type,position) VALUES (?,?,?,?,?)")
        .bind(id, pageId, name, type, position),
    ),
    ...TASK_STATUSES.map((status, position) =>
      db
        .prepare("INSERT INTO table_select_options (id,column_id,label,position) VALUES (?,?,?,?)")
        .bind(`${pageId}-${status}`, columns.status, TASK_STATUS_LABELS[status], position),
    ),
  ];
}

const TASK_FROM = `FROM table_rows r JOIN pages list ON list.id=r.page_id AND list.is_task_list=1
 JOIN table_state state ON state.page_id=list.id
 JOIN table_row_pages link ON link.row_id=r.id JOIN pages detail ON detail.id=link.page_id
 JOIN spaces s ON s.id=list.space_id
 LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=?
 LEFT JOIN table_cells title ON title.row_id=r.id AND title.column_id=list.id||'-title'
 LEFT JOIN table_cells assignee ON assignee.row_id=r.id AND assignee.column_id=list.id||'-assignee'
 LEFT JOIN user u ON u.id=assignee.text_value
 LEFT JOIN table_cells status ON status.row_id=r.id AND status.column_id=list.id||'-status'
 LEFT JOIN table_cells due ON due.row_id=r.id AND due.column_id=list.id||'-due'
 WHERE list.workspace_id=? AND list.archived_at IS NULL AND list.import_job_id IS NULL
 AND (?='owner' OR s.visibility='workspace' OR sm.user_id IS NOT NULL)`;

export async function listTasks(
  env: Env,
  member: MemberContext,
  query: {
    listId?: string | undefined;
    mine?: boolean;
    status?: string | undefined;
    due?: string | undefined;
    q?: string | undefined;
    cursor?: string | undefined;
    limit?: number;
    rowId?: string;
    includeArchived?: boolean;
  } = {},
): Promise<TaskResponse> {
  const limit = Math.max(1, Math.min(200, query.limit ?? 100));
  let filter = query.includeArchived ? "" : " AND detail.archived_at IS NULL";
  const binds: unknown[] = [member.user.id, member.workspace.id, member.role];
  if (query.listId) {
    await pageForMember(env, member, query.listId);
    filter += " AND list.id=?";
    binds.push(query.listId);
  }
  if (query.rowId) {
    filter += " AND r.id=?";
    binds.push(query.rowId);
  }
  if (query.mine) {
    filter += " AND assignee.text_value=?";
    binds.push(member.user.id);
  }
  if (query.status) {
    if (!TASK_STATUSES.includes(query.status as TaskStatus))
      throw new HttpError(422, "invalid_task_status", "Choose a valid status.");
    filter += " AND coalesce(status.select_value,list.id||'-todo')=list.id||'-'||?";
    binds.push(query.status);
  }
  if (query.q) {
    filter += " AND instr(lower(title.text_value),lower(?))>0";
    binds.push(query.q.slice(0, 200));
  }
  if (query.due === "overdue") {
    filter += " AND due.date_value < ? AND coalesce(status.select_value,'')<>list.id||'-done'";
    binds.push(new Date().toISOString().slice(0, 10));
  } else if (query.due === "undated") filter += " AND due.date_value IS NULL";
  else if (query.due === "today") {
    filter += " AND due.date_value=?";
    binds.push(new Date().toISOString().slice(0, 10));
  } else if (query.due) throw new HttpError(422, "invalid_due_filter", "Choose today, overdue, or undated.");
  if (query.cursor) {
    filter += " AND r.id>?";
    binds.push(query.cursor);
  }
  const rows = await env.DB.prepare(`SELECT r.id,list.id list_id,list.title list_title,list.space_id,
    title.text_value title,assignee.text_value assignee_id,u.name assignee_name,
    coalesce(status.select_value,list.id||'-todo') status,
    due.date_value due_date,detail.id detail_page_id,state.revision,s.visibility,sm.role space_role
    ${TASK_FROM}${filter} ORDER BY r.id LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<{
      id: string;
      list_id: string;
      list_title: string;
      space_id: string;
      title: string;
      assignee_id: string | null;
      assignee_name: string | null;
      status: string;
      due_date: string | null;
      detail_page_id: string;
      revision: number;
      visibility: "workspace" | "private";
      space_role: "editor" | "viewer" | null;
    }>();
  const tasks: Task[] = rows.results.slice(0, limit).map((r) => ({
    id: r.id,
    listId: r.list_id,
    listTitle: r.list_title,
    spaceId: r.space_id,
    title: r.title,
    assigneeId: r.assignee_id,
    assigneeName: r.assignee_name,
    status: r.status.slice(r.list_id.length + 1) as TaskStatus,
    dueDate: r.due_date,
    detailPageId: r.detail_page_id,
    revision: r.revision,
    editable: effectiveSpaceRole(member.role, r.visibility, r.space_role) !== "viewer",
  }));
  return {
    tasks,
    hasMore: rows.results.length > limit,
    nextCursor: rows.results.length > limit ? tasks.at(-1)!.id : null,
  };
}

export async function taskAssignees(env: Env, member: MemberContext, listId: string) {
  const page = await pageForMember(env, member, listId);
  if (!page.is_task_list) throw new HttpError(422, "task_list_required", "Choose a task list.");
  const rows = await env.DB.prepare(`SELECT u.id,u.name FROM workspace_members wm JOIN user u ON u.id=wm.user_id
    LEFT JOIN space_members sm ON sm.user_id=wm.user_id AND sm.space_id=?
    WHERE wm.workspace_id=? AND (?='workspace' OR wm.role='owner' OR sm.user_id IS NOT NULL) ORDER BY u.name,u.id`)
    .bind(page.space_id, member.workspace.id, page.visibility)
    .all<{ id: string; name: string }>();
  return rows.results;
}

function fields(value: Record<string, unknown>, previous?: Task): TaskFields {
  const title = value.title === undefined ? previous?.title : value.title;
  const assigneeId = value.assigneeId === undefined ? (previous?.assigneeId ?? null) : value.assigneeId;
  const status = value.status === undefined ? (previous?.status ?? "todo") : value.status;
  const dueDate = value.dueDate === undefined ? (previous?.dueDate ?? null) : value.dueDate;
  if (typeof title !== "string" || !title.trim() || title.length > PAGE_TITLE_MAX)
    throw new HttpError(422, "invalid_task_title", `Enter a task title of up to ${PAGE_TITLE_MAX} characters.`);
  if (assigneeId !== null && (typeof assigneeId !== "string" || !ID_PATTERN.test(assigneeId)))
    throw new HttpError(422, "invalid_assignee", "Choose an assignee.");
  if (!TASK_STATUSES.includes(status as TaskStatus))
    throw new HttpError(422, "invalid_task_status", "Choose a valid status.");
  if (
    dueDate !== null &&
    (typeof dueDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
      !Number.isFinite(Date.parse(dueDate)) ||
      new Date(dueDate).toISOString().slice(0, 10) !== dueDate)
  )
    throw new HttpError(422, "invalid_due_date", "Choose a valid due date.");
  return { title: title.trim(), assigneeId, status: status as TaskStatus, dueDate };
}

/** An action either owns the existing browser lease or acquires a short, exclusive lease.
 * Every statement is fenced inside one D1 transaction. A receipt makes retries safe. */
export async function mutateTask(
  env: Env,
  member: MemberContext,
  listId: string,
  rowId: string | null,
  body: Record<string, unknown>,
  authorization?: { sql: string; binds: unknown[] },
) {
  const page = await pageForMember(env, member, listId);
  if (!page.is_task_list) throw new HttpError(422, "task_list_required", "Choose a task list.");
  if (page.effective_role === "viewer") throw new HttpError(403, "editor_required", "Editing access is required.");
  const operationId = body.operationId;
  if (typeof operationId !== "string" || !ID_PATTERN.test(operationId))
    throw new HttpError(422, "operation_id_required", "A stable operation ID is required.");
  const hash = await sha256Hex(
    canonicalJson({
      listId,
      rowId,
      title: body.title,
      assigneeId: body.assigneeId,
      status: body.status,
      dueDate: body.dueDate,
      archived: body.archived,
    }),
  );
  const replay = await env.DB.prepare(
    "SELECT * FROM task_mutation_receipts WHERE workspace_id=? AND actor_id=? AND operation_id=?",
  )
    .bind(member.workspace.id, member.user.id, operationId)
    .first<{ request_hash: string; row_id: string; detail_page_id: string; revision: number }>();
  if (replay) {
    if (replay.request_hash !== hash)
      throw new HttpError(409, "idempotency_key_reused", "That operation ID describes a different change.");
    return { rowId: replay.row_id, detailPageId: replay.detail_page_id, revision: replay.revision, replayed: true };
  }
  const previous = rowId
    ? (await listTasks(env, member, { listId, rowId, includeArchived: body.archived === false })).tasks[0]
    : undefined;
  if (rowId && !previous) throw new HttpError(404, "task_not_found", "The task no longer exists.");
  const next = fields(body, previous);
  if (next.assigneeId && !(await taskAssignees(env, member, listId)).some((u) => u.id === next.assigneeId))
    throw new HttpError(422, "invalid_assignee", "The assignee must have access to this task list.");
  const expectedRevision = Number(body.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw new HttpError(422, "invalid_revision", "A current table revision is required.");
  const id = rowId ?? crypto.randomUUID();
  const detailId = previous?.detailPageId ?? crypto.randomUUID();
  const now = Date.now();
  const token = typeof body.leaseToken === "string" ? body.leaseToken : crypto.randomUUID();
  const tokenHash = await sha256(token);
  const shortLease = typeof body.leaseToken !== "string";
  // A unique session identity prevents one Slack action from replacing another's lease.
  const sessionId = shortLease ? `task:${member.user.id}:${operationId}` : member.session.id;
  if (shortLease) {
    const acquired =
      await env.DB.prepare(`INSERT INTO table_leases(page_id,token_hash,holder_user_id,holder_session_id,expires_at)
      VALUES (?,?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET token_hash=excluded.token_hash,holder_user_id=excluded.holder_user_id,holder_session_id=excluded.holder_session_id,expires_at=excluded.expires_at
      WHERE table_leases.expires_at<=?`)
        .bind(listId, tokenHash, member.user.id, sessionId, now + 60_000, now)
        .run();
    if (!acquired.meta.changes)
      throw new HttpError(
        409,
        "lease_conflict",
        "Someone is editing this table. Finish that editing session, then retry this change.",
      );
  }
  try {
    const guard = `EXISTS(SELECT 1 FROM table_state st JOIN table_leases l ON l.page_id=st.page_id JOIN pages p ON p.id=st.page_id
      WHERE st.page_id=? AND st.revision=? AND l.token_hash=? AND l.holder_session_id=? AND l.expires_at>? AND p.archived_at IS NULL
        AND EXISTS(SELECT 1 FROM workspace_members wm JOIN spaces s ON s.id=p.space_id
          LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=wm.user_id
          WHERE wm.workspace_id=p.workspace_id AND wm.user_id=? AND wm.role<>'viewer'
          AND (wm.role='owner' OR (s.visibility='workspace' AND coalesce(sm.role,'editor')='editor') OR sm.role='editor')))
      AND NOT EXISTS(SELECT 1 FROM task_mutation_receipts WHERE workspace_id=? AND actor_id=? AND operation_id=?) ${authorization ? `AND ${authorization.sql}` : ""}`;
    const guards = [
      listId,
      expectedRevision,
      tokenHash,
      sessionId,
      now,
      member.user.id,
      member.workspace.id,
      member.user.id,
      operationId,
      ...(authorization?.binds ?? []),
    ];
    const statements: D1PreparedStatement[] = [];
    const c = taskColumns(listId);
    if (!previous) {
      const last = await env.DB.prepare("SELECT position FROM pages WHERE parent_id=? ORDER BY position DESC LIMIT 1")
        .bind(listId)
        .first<{ position: string }>();
      const detailPosition = generateJitteredKeyBetween(last?.position ?? null, null);
      const count = await env.DB.prepare("SELECT count(*) count FROM table_rows WHERE page_id=?")
        .bind(listId)
        .first<{ count: number }>();
      if ((count?.count ?? 0) >= TABLE_MAX_ROWS)
        throw new HttpError(422, "table_row_limit", "This task list has reached its row limit.");
      statements.push(
        env.DB.prepare(`INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at)
        SELECT ?,?,(SELECT coalesce(max(position)+1,0) FROM table_rows WHERE page_id=?),?,?,? WHERE ${guard}`).bind(
          id,
          listId,
          listId,
          member.user.id,
          now,
          now,
          ...guards,
        ),
      );
      statements.push(
        env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,created_by,updated_by,created_at,updated_at)
        SELECT ?,?,?,?,'document',?,?,?,?,?,? WHERE ${guard}`).bind(
          detailId,
          member.workspace.id,
          page.space_id,
          listId,
          detailPosition,
          next.title,
          member.user.id,
          member.user.id,
          now,
          now,
          ...guards,
        ),
      );
      statements.push(
        env.DB.prepare(`INSERT INTO table_row_pages(row_id,page_id,created_at) SELECT ?,?,? WHERE ${guard}`).bind(
          id,
          detailId,
          now,
          ...guards,
        ),
      );
    }
    for (const [column, text, date, select] of [
      [c.title, next.title, null, null],
      [c.assignee, next.assigneeId, null, null],
      [c.status, null, null, `${listId}-${next.status}`],
      [c.due, null, next.dueDate, null],
    ]) {
      statements.push(
        env.DB.prepare(`INSERT INTO table_cells(row_id,column_id,text_value,date_value,select_value,updated_at)
        SELECT ?,?,?,?,?,? WHERE ${guard} ON CONFLICT(row_id,column_id) DO UPDATE SET text_value=excluded.text_value,date_value=excluded.date_value,select_value=excluded.select_value,updated_at=excluded.updated_at`).bind(
          id,
          column,
          text,
          date,
          select,
          now,
          ...guards,
        ),
      );
    }
    statements.push(
      env.DB.prepare(
        `UPDATE pages SET title=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=? AND ${guard}`,
      ).bind(next.title, member.user.id, now, detailId, ...guards),
    );
    statements.push(
      env.DB.prepare(`UPDATE table_rows SET updated_at=? WHERE id=? AND ${guard}`).bind(now, id, ...guards),
    );
    if (body.archived === true) {
      const subtree =
        "WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id=s.id) SELECT id FROM subtree";
      statements.push(
        env.DB.prepare(`INSERT INTO archive_disconnect_targets(page_id,workspace_id,content_epoch,room,next_attempt_at,created_at,updated_at)
        SELECT id,workspace_id,content_epoch,id||'~'||content_epoch,?,?,? FROM pages WHERE id IN (${subtree}) AND archived_at IS NULL AND kind IN ('document','diagram') AND ${guard}
        ON CONFLICT(page_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at`).bind(
          now,
          now,
          now,
          detailId,
          ...guards,
        ),
      );
      statements.push(
        env.DB.prepare(
          `UPDATE pages SET archived_at=?,archived_by=?,archive_operation_id=? WHERE id IN (${subtree}) AND archived_at IS NULL AND ${guard}`,
        ).bind(now, member.user.id, operationId, detailId, ...guards),
      );
      statements.push(
        env.DB.prepare(`DELETE FROM page_search WHERE page_id IN (${subtree}) AND ${guard}`).bind(detailId, ...guards),
      );
    } else {
      if (body.archived === false) {
        const archived = await env.DB.prepare("SELECT archive_operation_id,archived_at FROM pages WHERE id=?")
          .bind(detailId)
          .first<{ archive_operation_id: string | null; archived_at: number | null }>();
        const subtree =
          "WITH RECURSIVE subtree(id) AS (SELECT ? UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id=s.id) SELECT id FROM subtree";
        const ownership = "archive_operation_id IS ? AND archived_at IS ?";
        statements.push(
          env.DB.prepare(
            `DELETE FROM archive_disconnect_targets WHERE page_id IN (SELECT id FROM pages WHERE id IN (${subtree}) AND ${ownership}) AND ${guard}`,
          ).bind(detailId, archived?.archive_operation_id ?? null, archived?.archived_at ?? null, ...guards),
        );
        statements.push(
          env.DB.prepare(
            `UPDATE pages SET archived_at=NULL,archived_by=NULL,archive_operation_id=NULL,revision=revision+1,updated_by=?,updated_at=? WHERE id IN (${subtree}) AND ${ownership} AND ${guard}`,
          ).bind(
            member.user.id,
            now,
            detailId,
            archived?.archive_operation_id ?? null,
            archived?.archived_at ?? null,
            ...guards,
          ),
        );
        statements.push(
          env.DB.prepare(`DELETE FROM page_search WHERE page_id IN (${subtree}) AND ${guard}`).bind(
            detailId,
            ...guards,
          ),
        );
        statements.push(
          env.DB.prepare(
            `INSERT INTO page_search(page_id,workspace_id,title,body)
             SELECT id,workspace_id,title,coalesce(plain_text,'') FROM pages
              WHERE id IN (${subtree}) AND archived_at IS NULL AND import_job_id IS NULL AND ${guard}`,
          ).bind(detailId, ...guards),
        );
      } else {
        statements.push(
          env.DB.prepare(`DELETE FROM page_search WHERE page_id=? AND ${guard}`).bind(detailId, ...guards),
        );
        statements.push(
          env.DB.prepare(
            `INSERT INTO page_search(page_id,workspace_id,title,body)
             SELECT id,workspace_id,title,coalesce(plain_text,'') FROM pages
              WHERE id=? AND archived_at IS NULL AND import_job_id IS NULL AND ${guard}`,
          ).bind(detailId, ...guards),
        );
      }
    }
    statements.push(
      env.DB.prepare(`INSERT INTO task_mutation_receipts(workspace_id,actor_id,operation_id,request_hash,row_id,detail_page_id,revision,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`).bind(
        member.workspace.id,
        member.user.id,
        operationId,
        hash,
        id,
        detailId,
        expectedRevision + 1,
        now,
        ...guards,
      ),
    );
    statements.push(
      env.DB.prepare(
        `UPDATE table_state SET revision=revision+1 WHERE page_id=? AND revision=? AND EXISTS(SELECT 1 FROM task_mutation_receipts WHERE workspace_id=? AND actor_id=? AND operation_id=? AND request_hash=?)`,
      ).bind(listId, expectedRevision, member.workspace.id, member.user.id, operationId, hash),
    );
    if (next.assigneeId && next.assigneeId !== previous?.assigneeId && body.archived !== true)
      statements.push(
        ...notificationFanoutStatements(env.DB, {
          workspaceId: member.workspace.id,
          spaceId: page.space_id!,
          pageId: detailId,
          threadId: null,
          actorId: member.user.id,
          eventType: "task_assigned",
          sourceId: `task:${operationId}`,
          recipientIds: [next.assigneeId],
          emitSlackChannel: false,
          createdAt: now,
          taskOperationId: operationId,
        }),
      );
    await env.DB.batch(statements);
    const receipt = await env.DB.prepare(
      "SELECT request_hash,revision FROM task_mutation_receipts WHERE workspace_id=? AND actor_id=? AND operation_id=?",
    )
      .bind(member.workspace.id, member.user.id, operationId)
      .first<{ request_hash: string; revision: number }>();
    if (!receipt)
      throw new HttpError(
        409,
        "task_conflict",
        "The table changed or its edit lock expired. Refresh and retry your change.",
      );
    if (receipt.request_hash !== hash)
      throw new HttpError(409, "idempotency_key_reused", "That operation ID describes another change.");
    await env.DB.batch(
      typeof body.archived === "boolean"
        ? refreshPageSearchV2SubtreeStatements(env.DB, detailId)
        : refreshPageSearchV2Statements(env.DB, detailId),
    );
    return { rowId: id, detailPageId: detailId, revision: receipt.revision, replayed: false };
  } finally {
    if (shortLease)
      await env.DB.prepare("DELETE FROM table_leases WHERE page_id=? AND token_hash=? AND holder_session_id=?")
        .bind(listId, tokenHash, sessionId)
        .run();
  }
}
