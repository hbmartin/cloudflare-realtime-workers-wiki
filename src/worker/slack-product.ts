import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import { canonicalJson, sha256Hex } from "../shared/import-integrity";
import { TASK_STATUSES, TASK_STATUS_LABELS, type Task, type TaskFields } from "../shared/tasks";
import { effectiveSpaceRole, pageForMember } from "./page-access";
import { listTasks, mutateTask, taskAssignees, taskListStatements } from "./tasks";
import { identityFor, verifiedMember, validateChannel, requireChannelMember } from "./slack-threads";
import { slackApi, type SlackInstallation, type SlackInteractionPayload, type SlackHistoryMessage } from "./slack";
import { safeSlackText, slackLabel } from "./slack-blocks";
import { refreshPageSearchV2Statements } from "./search-index";
import { broadcastWorkspaceEvent } from "./workspace-events";
import type { ProseMirrorJson } from "../shared/document-projection";
import { PAGE_TITLE_MAX } from "../shared/validation";
import { logger } from "./observability";

const plain = (text: string) => ({ type: "plain_text", text: text.slice(0, 150) });

const option = (text: string, value: string) => ({ text: plain(slackLabel(text)), value });
const button = (text: string, action_id: string, value: string) => ({
  type: "button",
  text: plain(slackLabel(text)),
  action_id,
  value,
});
const ID = /^[A-Za-z0-9:_-]{1,200}$/;
const TS = /^\d{1,16}\.\d{1,16}$/;
const CALLBACK = "noteflare_compose";
const truncateTitle = (value: string) => Array.from(value).slice(0, PAGE_TITLE_MAX).join("");
type Source = { channelId: string; ts: string; thread: boolean; text: string; author: string };
type State = {
  kind: "document" | "task" | "task-list";
  source?: Source;
  task?: Task;
  cursor?: string;
  body?: string;
  copied?: boolean;
  conflicts?: Array<keyof TaskFields>;
};
type Session = {
  id: string;
  installation_id: string;
  generation: number;
  slack_user_id: string;
  identity_json: string;
  state_json: string;
  view_id: string | null;
  request_hash: string | null;
  result_page_id: string | null;
  created_at: number;
};
type Identity = Awaited<ReturnType<typeof identityFor>>;

function modal(id: string, blocks: unknown[], submitLabel?: string) {
  return {
    type: "modal",
    callback_id: CALLBACK,
    private_metadata: id,
    title: plain("NoteFlare"),
    close: plain("Close"),
    ...(submitLabel ? { submit: plain(submitLabel) } : {}),
    blocks,
  };
}
function input(id: string, label: string, element: Record<string, unknown>, optional = false) {
  return { type: "input", block_id: id, label: plain(label), element: { action_id: "value", ...element }, optional };
}
function stateField(payload: SlackInteractionPayload, id: string): Record<string, unknown> {
  const values = payload.view?.state?.values as Record<string, Record<string, Record<string, unknown>>> | undefined;
  const actions = values?.[id];
  return actions?.value ?? Object.values(actions ?? {})[0] ?? {};
}
function selection(payload: SlackInteractionPayload, id: string) {
  const selected = stateField(payload, id).selected_option as { value?: unknown } | undefined;
  return typeof selected?.value === "string" ? selected.value : null;
}
function textValue(payload: SlackInteractionPayload, id: string) {
  const value = stateField(payload, id).value;
  return typeof value === "string" ? value : "";
}
function errorText(error: unknown) {
  return error instanceof HttpError
    ? error.message
    : "This action could not be completed. Try again; repeated submissions are safe.";
}
function submissionErrorText(error: unknown) {
  const message = errorText(error);
  return error instanceof HttpError && error.code === "slack_unavailable"
    ? `${message} Then reopen this form from /notes.`
    : message;
}
function logInteractionFailure(payload: SlackInteractionPayload, error: unknown) {
  logger.warn("slack.interaction.failed", "slack", "Slack product interaction failed.", {
    interactionType: typeof payload.type === "string" ? payload.type : "unknown",
    code: error instanceof HttpError ? error.code : "unexpected",
  });
}
async function installationForTeam(env: Env, team: unknown) {
  if (typeof team !== "string")
    throw new HttpError(403, "slack_unavailable", "Connect your Slack account in NoteFlare Settings.");
  const installation = await env.DB.prepare(
    "SELECT * FROM slack_installations WHERE team_id=? AND disconnected_at IS NULL",
  )
    .bind(team)
    .first<SlackInstallation>();
  if (!installation) throw new HttpError(403, "slack_unavailable", "Reconnect NoteFlare to this Slack workspace.");
  return installation;
}
async function sessionFor(env: Env, payload: SlackInteractionPayload) {
  const installation = await installationForTeam(env, payload.team?.id);
  const id = payload.view?.private_metadata;
  if (typeof id !== "string" || !ID.test(id) || typeof payload.user?.id !== "string")
    throw new HttpError(403, "slack_form_expired", "Reopen this form from /notes.");
  const session = await env.DB.prepare(
    "SELECT * FROM slack_product_sessions WHERE id=? AND installation_id=? AND generation=? AND slack_user_id=? AND created_at>?",
  )
    .bind(id, installation.id, installation.generation, payload.user.id, Date.now() - 86_400_000)
    .first<Session>();
  if (!session || (session.view_id && session.view_id !== payload.view?.id))
    throw new HttpError(403, "slack_form_expired", "Reopen this form from /notes.");
  const { member } = await verifiedMember(
    env,
    installation,
    payload.user.id,
    JSON.parse(session.identity_json) as Identity,
  );
  return { session, installation, member, state: JSON.parse(session.state_json) as State };
}
async function newSession(env: Env, installation: SlackInstallation, userId: string, state: State, openingKey: string) {
  const { identity, member } = await verifiedMember(env, installation, userId);
  const id = (await sha256Hex(`${installation.id}:${installation.generation}:${userId}:${openingKey}`)).slice(0, 32);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO slack_product_sessions(id,installation_id,generation,slack_user_id,identity_json,state_json,created_at) VALUES(?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      installation.id,
      installation.generation,
      userId,
      JSON.stringify(identity),
      JSON.stringify(state),
      Date.now(),
    )
    .run();
  return { id, member };
}
function composeView(id: string, state: State) {
  const task = state.task;
  const blocks: unknown[] = [];
  if (state.conflicts?.length)
    blocks.push({
      type: "context",
      elements: [
        {
          type: "plain_text",
          text: `Another editor changed ${state.conflicts.join(", ")}. Their values are shown; your other changes are preserved. Review and save again.`,
        },
      ],
    });
  if (state.source)
    blocks.push({
      type: "section",
      text: {
        type: "plain_text",
        text: `Capture ${state.source.thread ? "this thread" : "this message"} with attribution and a link to Slack. Choose who can access the destination.`,
      },
    });
  if (!task)
    blocks.push(
      input("kind", "Create", {
        type: "static_select",
        initial_option: option(
          state.kind === "task-list" ? "Task List" : state.kind === "task" ? "Task" : "Document",
          state.kind,
        ),
        options: [option("Document", "document"), option("Task", "task"), option("Task List", "task-list")],
      }),
    );
  if (!task)
    blocks.push(
      input("destination", "Destination · choose a task list for a task", {
        type: "external_select",
        action_id: "noteflare_destination",
        min_query_length: 0,
        placeholder: plain("Search spaces, pages, and task lists"),
      }),
    );
  blocks.push(
    input("title", "Title", {
      type: "plain_text_input",
      max_length: PAGE_TITLE_MAX,
      ...(task?.title || state.source?.text
        ? {
            initial_value: truncateTitle(task?.title ?? state.source!.text),
          }
        : {}),
    }),
  );
  if (!task)
    blocks.push(
      input("body", "Description (optional)", { type: "plain_text_input", multiline: true, max_length: 3000 }, true),
    );
  blocks.push(
    input(
      "status",
      "Task status",
      {
        type: "static_select",
        initial_option: option(TASK_STATUS_LABELS[task?.status ?? "todo"], task?.status ?? "todo"),
        options: TASK_STATUSES.map((s) => option(TASK_STATUS_LABELS[s], s)),
      },
      true,
    ),
  );
  blocks.push(
    input(
      "due",
      "Task due date",
      { type: "datepicker", ...(task?.dueDate ? { initial_date: task.dueDate } : {}) },
      true,
    ),
  );
  blocks.push(
    input(
      "assignee",
      "Task assignee",
      {
        type: "external_select",
        action_id: "noteflare_assignee",
        min_query_length: 0,
        placeholder: plain("Search NoteFlare members"),
        ...(task?.assigneeId ? { initial_option: option(task.assigneeName ?? "Member", task.assigneeId) } : {}),
      },
      true,
    ),
  );
  if (task)
    blocks.push({
      type: "context",
      elements: [
        {
          type: "plain_text",
          text: "Changes respect the table’s edit lock. If someone is editing, keep this form open and retry after they finish. Open NoteFlare for descriptions and comments.",
        },
      ],
    });
  return modal(id, blocks, task ? "Save task" : "Create");
}
async function tasksView(env: Env, id: string, member: MemberContext, cursor?: string) {
  const result = await listTasks(env, member, { mine: true, limit: 12, ...(cursor ? { cursor } : {}) });
  const blocks: unknown[] = [
    { type: "header", text: plain("My Tasks") },
    {
      type: "actions",
      elements: [
        button("Create task", "noteflare_compose_task", id),
        button("Create page", "noteflare_compose_page", id),
      ],
    },
  ];
  for (const task of result.tasks)
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        verbatim: true,
        text: `*${safeSlackText(task.title, 160)}*\n${safeSlackText(task.listTitle, 100)} · ${TASK_STATUS_LABELS[task.status]}${task.dueDate ? ` · Due ${task.dueDate}` : ""}\n<${new URL(env.BETTER_AUTH_URL).origin}/?page=${task.detailPageId}|Details & comments>`,
      },
      ...(task.editable ? { accessory: button("Edit task", "noteflare_edit_task", task.id) } : {}),
    });
  if (!result.tasks.length)
    blocks.push({ type: "section", text: { type: "plain_text", text: "No tasks assigned to you on this page." } });
  blocks.push({
    type: "actions",
    elements: [
      button("Refresh", "noteflare_my_tasks", "first"),
      ...(result.nextCursor ? [button("More tasks", "noteflare_my_tasks", result.nextCursor)] : []),
    ],
  });
  return modal(id, blocks);
}
export async function openSlackProduct(
  env: Env,
  installation: SlackInstallation,
  userId: string,
  triggerId: string,
  query: string,
  deadlineAt = Date.now() + 2400,
) {
  const command = query.trim().toLowerCase();
  if (!["new", "task", "tasks", "task-list"].includes(command)) return null;
  try {
    const state: State = { kind: command === "task" ? "task" : command === "task-list" ? "task-list" : "document" };
    const { id, member } = await newSession(env, installation, userId, state, triggerId);
    const view = command === "tasks" ? await tasksView(env, id, member) : composeView(id, state);
    const result = await slackApi(
      env,
      installation,
      "views.open",
      { trigger_id: triggerId, view },
      Math.max(1, deadlineAt - Date.now() - 150),
    );
    await env.DB.prepare("UPDATE slack_product_sessions SET view_id=? WHERE id=?").bind(result.view.id, id).run();
    return { response_type: "ephemeral", text: "" };
  } catch (error) {
    return { response_type: "ephemeral", text: errorText(error) };
  }
}
async function destinationOptions(env: Env, member: MemberContext, query: string) {
  const rows = await env.DB.prepare(`SELECT 'space:'||s.id value,s.name title,'Space' kind FROM spaces s
    LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=? WHERE s.workspace_id=?
    AND (?='owner' OR ((s.visibility='workspace' OR sm.user_id IS NOT NULL) AND ?<>'viewer' AND coalesce(sm.role,'editor')='editor')) AND instr(lower(s.name),lower(?))>0
    UNION ALL SELECT 'page:'||p.id,p.title,CASE WHEN p.is_task_list=1 THEN 'Task List' ELSE 'Page' END FROM pages p JOIN spaces s ON s.id=p.space_id
    LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=? WHERE p.workspace_id=? AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template=0
    AND NOT EXISTS(SELECT 1 FROM table_row_pages WHERE page_id=p.id)
    AND (?='owner' OR ((s.visibility='workspace' OR sm.user_id IS NOT NULL) AND ?<>'viewer' AND coalesce(sm.role,'editor')='editor')) AND instr(lower(p.title),lower(?))>0 ORDER BY title LIMIT 100`)
    .bind(
      member.user.id,
      member.workspace.id,
      member.role,
      member.role,
      query,
      member.user.id,
      member.workspace.id,
      member.role,
      member.role,
      query,
    )
    .all<{ value: string; title: string; kind: string }>();
  return { options: rows.results.map((r) => option(`${r.title} · ${r.kind}`, r.value)) };
}
async function destination(env: Env, member: MemberContext, value: string | null) {
  if (!value) throw new HttpError(422, "destination_required", "Choose a destination.");
  if (value.startsWith("page:")) {
    const page = await pageForMember(env, member, value.slice(5));
    if (page.effective_role === "viewer")
      throw new HttpError(403, "editor_required", "You need editing access to the destination.");
    return { spaceId: page.space_id!, parentId: page.id, taskList: !!page.is_task_list };
  }
  const space = await env.DB.prepare(
    "SELECT s.*,sm.role space_role FROM spaces s LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=? WHERE s.id=? AND s.workspace_id=?",
  )
    .bind(member.user.id, value.slice(6), member.workspace.id)
    .first<{ id: string; visibility: "workspace" | "private"; space_role: "editor" | "viewer" | null }>();
  const role = space ? effectiveSpaceRole(member.role, space.visibility, space.space_role) : null;
  if (!value.startsWith("space:") || !space || !role || role === "viewer")
    throw new HttpError(403, "destination_unavailable", "This destination is unavailable.");
  return { spaceId: space.id, parentId: null, taskList: false };
}
// Recheck the linked identity and installation generation in the committing transaction.
function authorization(session: Session) {
  const identity = JSON.parse(session.identity_json) as NonNullable<Identity>;
  return {
    sql: `EXISTS(SELECT 1 FROM slack_installations i JOIN slack_user_links l ON l.installation_id=i.id AND l.installation_generation=i.generation JOIN account a ON a.id=l.better_auth_account_id AND a.userId=l.user_id
    WHERE i.id=? AND i.generation=? AND i.disconnected_at IS NULL AND l.slack_user_id=? AND l.user_id=? AND l.better_auth_account_id=? AND l.verified_at=? AND l.migration_state='verified' AND l.verification_method='slack_openid' AND a.providerId='slack' AND a.accountId=i.team_id||':'||l.slack_user_id)`,
    binds: [
      session.installation_id,
      session.generation,
      session.slack_user_id,
      identity.userId,
      identity.accountId,
      identity.verifiedAt,
    ],
  };
}
function resultView(env: Env, id: string, pageId: string, pending: boolean) {
  return modal(id, [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${pending ? "Created. Copying the description and Slack source…" : "Saved."}\n<${new URL(env.BETTER_AUTH_URL).origin}/?page=${pageId}|Open in NoteFlare>`,
      },
    },
    ...(pending ? [{ type: "actions", elements: [button("Check / retry copy", "noteflare_copy_retry", id)] }] : []),
  ]);
}
async function submit(env: Env, payload: SlackInteractionPayload) {
  const { session, member, state } = await sessionFor(env, payload);
  const enteredTitle = textValue(payload, "title").trim();
  const title = state.task?.title && enteredTitle === truncateTitle(state.task.title) ? state.task.title : enteredTitle;
  if (!title || (title.length > PAGE_TITLE_MAX && title !== state.task?.title))
    throw new HttpError(422, "invalid_title", `Enter a title of up to ${PAGE_TITLE_MAX} characters.`);
  const kind = state.task ? "task" : selection(payload, "kind");
  if (kind !== "task" && kind !== "document" && kind !== "task-list")
    throw new HttpError(422, "invalid_kind", "Choose Document, Task, or Task List.");
  const dest = state.task
    ? await destination(env, member, `page:${state.task.listId}`)
    : await destination(env, member, selection(payload, "destination"));
  const taskFields: TaskFields = {
    title,
    status: (selection(payload, "status") ?? "todo") as TaskFields["status"],
    assigneeId: selection(payload, "assignee"),
    dueDate: (stateField(payload, "due").selected_date as string | undefined) ?? null,
  };
  const body = textValue(payload, "body");
  if (kind === "task-list" && (state.source || body))
    throw new HttpError(
      422,
      "task_list_description",
      "Choose Document or Task to capture a message or description. Task Lists contain tasks.",
    );
  const hash = await sha256Hex(canonicalJson({ kind, dest, taskFields, body }));
  if (session.request_hash && session.request_hash !== hash)
    throw new HttpError(
      409,
      "already_saved",
      "This form was already saved with different values. Open a new form to make another change.",
    );
  if (session.result_page_id) {
    await pageForMember(env, member, session.result_page_id);
    // Recover a lost enqueue after the page/task transaction committed.
    if ((state.source || state.body) && !state.copied) await queueCopy(env, session, member.workspace.id);
    return {
      response_action: "update",
      view: resultView(env, session.id, session.result_page_id, !!(state.source || state.body) && !state.copied),
    };
  }
  const auth = authorization(session);
  let pageId = session.id;
  if (kind === "task") {
    if (!dest.taskList || !dest.parentId)
      throw new HttpError(422, "task_destination", "Select a Task List as the destination for a task.");
    const table = await env.DB.prepare("SELECT revision FROM table_state WHERE page_id=?")
      .bind(dest.parentId)
      .first<{ revision: number }>();
    const mutationFields: Partial<TaskFields> = { ...taskFields };
    if (state.task && state.task.title.length > PAGE_TITLE_MAX && taskFields.title === state.task.title)
      delete mutationFields.title;
    const result = await mutateTask(
      env,
      member,
      dest.parentId,
      state.task?.id ?? null,
      {
        ...mutationFields,
        operationId: `slack-${session.id}`,
        expectedRevision: state.task?.revision ?? table?.revision,
      },
      auth,
    );
    pageId = result.detailPageId;
    await env.DB.prepare("UPDATE slack_product_sessions SET result_page_id=?,request_hash=?,state_json=? WHERE id=?")
      .bind(pageId, hash, JSON.stringify({ ...state, body }), session.id)
      .run();
  } else {
    if (body.length > 3000) throw new HttpError(422, "invalid_body", "Keep the description under 3000 characters.");
    const last = await env.DB.prepare(
      "SELECT position FROM pages WHERE space_id=? AND parent_id IS ? ORDER BY position DESC LIMIT 1",
    )
      .bind(dest.spaceId, dest.parentId)
      .first<{ position: string }>();
    const now = Date.now();
    const permission = `EXISTS(SELECT 1 FROM workspace_members wm JOIN spaces s ON s.workspace_id=wm.workspace_id LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=wm.user_id WHERE s.id=? AND wm.user_id=? AND (wm.role='owner' OR (wm.role='editor' AND (s.visibility='workspace' OR sm.user_id IS NOT NULL) AND coalesce(sm.role,'editor')='editor')))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM pages WHERE id=? AND space_id=? AND archived_at IS NULL AND import_job_id IS NULL)) AND ${auth.sql}`;
    const guardBinds = [dest.spaceId, member.user.id, dest.parentId, dest.parentId, dest.spaceId, ...auth.binds];
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,is_task_list,created_by,updated_by,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${permission}`,
        ).bind(
          pageId,
          member.workspace.id,
          dest.spaceId,
          dest.parentId,
          kind === "task-list" ? "table" : "document",
          generateJitteredKeyBetween(last?.position ?? null, null),
          title,
          Number(kind === "task-list"),
          member.user.id,
          member.user.id,
          now,
          now,
          ...guardBinds,
        ),
        ...(kind === "task-list"
          ? [
              env.DB.prepare("INSERT INTO table_state(page_id) VALUES(?)").bind(pageId),
              ...taskListStatements(env.DB, pageId),
            ]
          : []),
        env.DB.prepare(
          "UPDATE slack_product_sessions SET result_page_id=?,request_hash=?,state_json=? WHERE id=? AND EXISTS(SELECT 1 FROM pages WHERE id=?)",
        ).bind(pageId, hash, JSON.stringify({ ...state, body }), session.id, pageId),
        env.DB.prepare(
          "INSERT INTO page_search(page_id,workspace_id,title,body) SELECT id,workspace_id,title,'' FROM pages WHERE id=?",
        ).bind(pageId),
        ...refreshPageSearchV2Statements(env.DB, pageId),
        env.DB.prepare(`INSERT INTO subscriptions
          (id,workspace_id,user_id,resource_type,resource_id,created_by,created_at)
          SELECT ?,?,?,'page',?,?,? WHERE EXISTS(SELECT 1 FROM pages WHERE id=?)
          ON CONFLICT(user_id,resource_type,resource_id) DO UPDATE SET muted_at=NULL`).bind(
          `page:${pageId}:${member.user.id}`,
          member.workspace.id,
          member.user.id,
          pageId,
          member.user.id,
          now,
          pageId,
        ),
      ]);
    } catch (error) {
      const saved = await env.DB.prepare(
        "SELECT request_hash FROM slack_product_sessions WHERE id=? AND result_page_id=?",
      )
        .bind(session.id, pageId)
        .first<{ request_hash: string }>();
      if (!saved || saved.request_hash !== hash) throw error;
    }
    await pageForMember(env, member, pageId);
  }
  const pending = kind !== "task-list" && !!(state.source || body);
  if (pending) await queueCopy(env, session, member.workspace.id);
  await broadcastWorkspaceEvent(
    env,
    member.workspace.id,
    kind === "task" && dest.parentId
      ? { type: "task-list-invalidated", pageId: dest.parentId }
      : { type: "workspace-invalidated" },
  );
  return { response_action: "update", view: resultView(env, session.id, pageId, pending) };
}

function submittedTaskFields(payload: SlackInteractionPayload, base?: Task): TaskFields {
  const enteredTitle = textValue(payload, "title").trim();
  return {
    title: base && enteredTitle === truncateTitle(base.title) ? base.title : enteredTitle,
    status: (selection(payload, "status") ?? "todo") as TaskFields["status"],
    assigneeId: selection(payload, "assignee"),
    dueDate: (stateField(payload, "due").selected_date as string | undefined) ?? null,
  };
}

function mergeConflictedTask(base: Task, current: Task, submitted: TaskFields) {
  const fields: Array<keyof TaskFields> = ["title", "status", "assigneeId", "dueDate"];
  const conflicts: Array<keyof TaskFields> = [];
  const merged = { ...current };
  for (const field of fields) {
    const localChanged = submitted[field] !== base[field];
    const remoteChanged = current[field] !== base[field];
    if (localChanged && remoteChanged && submitted[field] !== current[field]) conflicts.push(field);
    else if (localChanged && !remoteChanged) Object.assign(merged, { [field]: submitted[field] });
  }
  return { task: merged, conflicts };
}
async function queueCopy(env: Env, session: Session, workspaceId: string) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at) VALUES(?,?,'slack_product_copy',?,?,?) ON CONFLICT(id) DO UPDATE SET available_at=excluded.available_at,enqueued_at=NULL,last_error=NULL`,
  )
    .bind(`slack-copy:${session.id}`, workspaceId, JSON.stringify({ sessionId: session.id }), now, now)
    .run();
}

async function acceptProductInteraction(env: Env, payload: SlackInteractionPayload, deadlineAt: number) {
  const action = payload.actions?.[0];
  if (
    payload.type === "block_suggestion" &&
    ["noteflare_destination", "noteflare_assignee"].includes(String(payload.action_id))
  ) {
    try {
      const { member, state } = await sessionFor(env, payload);
      const q = typeof payload.value === "string" ? payload.value.slice(0, 200) : "";
      if (payload.action_id === "noteflare_destination")
        return { handled: true, response: await destinationOptions(env, member, q) };
      const people = state.task
        ? await taskAssignees(env, member, state.task.listId)
        : (
            await env.DB.prepare(
              "SELECT u.id,u.name FROM user u JOIN workspace_members wm ON wm.user_id=u.id WHERE wm.workspace_id=? AND instr(lower(u.name),lower(?))>0 ORDER BY u.name LIMIT 100",
            )
              .bind(member.workspace.id, q)
              .all<{ id: string; name: string }>()
          ).results;
      return {
        handled: true,
        response: {
          options: people
            .filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
            .slice(0, 100)
            .map((p) => option(p.name, p.id)),
        },
      };
    } catch {
      return { handled: true, response: { options: [] } };
    }
  }
  if (payload.type === "view_submission" && payload.view?.callback_id === CALLBACK) {
    try {
      return { handled: true, response: await submit(env, payload) };
    } catch (error) {
      if (error instanceof HttpError && error.code === "task_conflict") {
        const current = await sessionFor(env, payload);
        if (current.state.task) {
          const task = (await listTasks(env, current.member, { rowId: current.state.task.id })).tasks[0];
          if (task) {
            const merged = mergeConflictedTask(
              current.state.task,
              task,
              submittedTaskFields(payload, current.state.task),
            );
            const nextState = { ...current.state, ...merged };
            await env.DB.prepare("UPDATE slack_product_sessions SET state_json=? WHERE id=?")
              .bind(JSON.stringify(nextState), current.session.id)
              .run();
            return {
              handled: true,
              response: {
                response_action: "update",
                view: composeView(current.session.id, nextState),
              },
            };
          }
        }
      }
      logInteractionFailure(payload, error);
      return { handled: true, response: { response_action: "errors", errors: { title: submissionErrorText(error) } } };
    }
  }
  const shortcut =
    payload.type === "message_action" &&
    ["noteflare_save_to_notes", "noteflare_new_page_from_thread"].includes(String(payload.callback_id));
  const productAction =
    payload.type === "block_actions" &&
    [
      "noteflare_my_tasks",
      "noteflare_compose_task",
      "noteflare_compose_page",
      "noteflare_edit_task",
      "noteflare_copy_retry",
    ].includes(String(action?.action_id));
  if (!shortcut && !productAction) return { handled: false };
  const installation = await installationForTeam(env, payload.team?.id);
  if (typeof payload.user?.id !== "string" || typeof payload.trigger_id !== "string")
    return { handled: true, response: {} };
  const { member } = await verifiedMember(env, installation, payload.user.id);
  let state: State = { kind: action?.action_id === "noteflare_compose_task" ? "task" : "document" };
  if (shortcut) {
    if (
      typeof payload.channel?.id !== "string" ||
      typeof payload.message?.ts !== "string" ||
      !TS.test(payload.message.ts)
    )
      throw new HttpError(422, "slack_source", "Choose a channel message to capture.");
    state.source = {
      channelId: payload.channel.id,
      ts:
        payload.callback_id === "noteflare_new_page_from_thread" && typeof payload.message.thread_ts === "string"
          ? payload.message.thread_ts
          : payload.message.ts,
      thread: payload.callback_id === "noteflare_new_page_from_thread",
      text: typeof payload.message.text === "string" ? payload.message.text.slice(0, 40_000) : "",
      author: typeof payload.message.user === "string" ? payload.message.user : "Slack member",
    };
    await validateChannel(env, installation, state.source.channelId);
    await requireChannelMember(env, installation, state.source.channelId, payload.user.id);
  }
  if (action?.action_id === "noteflare_edit_task") {
    if (typeof action.value !== "string" || !ID.test(action.value)) return { handled: true, response: {} };
    const task = (await listTasks(env, member, { rowId: action.value })).tasks[0];
    if (!task || !task.editable) throw new HttpError(403, "task_unavailable", "This task is unavailable or read-only.");
    state = { kind: "task", task };
  }
  if (action?.action_id === "noteflare_copy_retry") {
    const current = await sessionFor(env, payload);
    if (!current.state.copied) await queueCopy(env, current.session, member.workspace.id);
    return { handled: true, response: {} };
  }
  const { id } = await newSession(env, installation, payload.user.id, state, payload.trigger_id);
  const view =
    action?.action_id === "noteflare_my_tasks"
      ? await tasksView(
          env,
          id,
          member,
          typeof action.value === "string" && action.value !== "first" ? action.value : undefined,
        )
      : composeView(id, state);
  const remaining = Math.max(1, deadlineAt - Date.now() - 150);
  const opened =
    payload.view?.id && payload.view.callback_id === CALLBACK && !shortcut
      ? await slackApi(
          env,
          installation,
          "views.update",
          {
            view_id: String(payload.view.id),
            view,
            ...(typeof payload.view.hash === "string" ? { hash: payload.view.hash } : {}),
          },
          remaining,
        )
      : await slackApi(env, installation, "views.open", { trigger_id: payload.trigger_id, view }, remaining);
  await env.DB.prepare("UPDATE slack_product_sessions SET view_id=? WHERE id=?").bind(opened.view.id, id).run();
  return { handled: true, response: {} };
}

async function copySlackProductContent(env: Env, sessionId: string) {
  const session = await env.DB.prepare("SELECT * FROM slack_product_sessions WHERE id=?")
    .bind(sessionId)
    .first<Session>();
  if (!session?.result_page_id) return;
  const state = JSON.parse(session.state_json) as State;
  if (state.copied) return;
  const installation = await env.DB.prepare(
    "SELECT * FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL",
  )
    .bind(session.installation_id, session.generation)
    .first<SlackInstallation>();
  if (!installation) return;
  const { member } = await verifiedMember(
    env,
    installation,
    session.slack_user_id,
    JSON.parse(session.identity_json) as Identity,
  );
  const page = await pageForMember(env, member, session.result_page_id);
  if (page.effective_role === "viewer")
    throw new HttpError(403, "editor_required", "Editing access to the destination is required.");
  const blocks: ProseMirrorJson[] = [];
  const paragraph = (text: string) =>
    ({
      type: "blockContainer",
      attrs: { id: `slack-${sessionId}-${blocks.length}` },
      content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }],
    }) satisfies ProseMirrorJson;
  if (state.body) blocks.push(paragraph(state.body));
  if (state.source) {
    const source = state.source;
    await validateChannel(env, installation, source.channelId);
    await requireChannelMember(env, installation, source.channelId, session.slack_user_id);
    const link = await slackApi(env, installation, "chat.getPermalink", {
      channel: source.channelId,
      message_ts: source.ts,
    });
    if (!/^https:\/\/[a-z0-9.-]+\.slack\.com\//i.test(link.permalink))
      throw new Error("Slack returned an invalid source link.");
    let messages: SlackHistoryMessage[] = [{ ts: source.ts, text: source.text, user: source.author }];
    if (source.thread) {
      messages = [];
      let cursor: string | undefined;
      do {
        const result = await slackApi(env, installation, "conversations.replies", {
          channel: source.channelId,
          ts: source.ts,
          oldest: "0",
          limit: 100,
          include_all_metadata: false,
          ...(cursor ? { cursor } : {}),
        });
        messages.push(...result.messages);
        cursor = result.response_metadata?.next_cursor || undefined;
        if (messages.length > 2000)
          throw new HttpError(
            422,
            "thread_too_large",
            "This thread exceeds 2,000 messages. Capture a smaller selection.",
          );
        if (result.has_more && !cursor) throw new Error("Slack did not return the next thread cursor.");
      } while (cursor);
      // Freeze the source before touching the collaborative document, so a retry has identical content.
      state.source = {
        ...source,
        thread: false,
        text: messages.map((m) => `${m.user ?? m.bot_id ?? "Slack member"} · ${m.ts}\n${m.text ?? ""}`).join("\n\n"),
        author: "Slack thread",
      };
      const frozen = await env.DB.prepare(
        "UPDATE slack_product_sessions SET state_json=? WHERE id=? AND state_json=? RETURNING state_json",
      )
        .bind(JSON.stringify(state), session.id, session.state_json)
        .first<{ state_json: string }>();
      if (!frozen) {
        const winner = await env.DB.prepare("SELECT state_json FROM slack_product_sessions WHERE id=?")
          .bind(session.id)
          .first<{ state_json: string }>();
        if (!winner) return;
        const winnerState = JSON.parse(winner.state_json) as State;
        if (winnerState.copied) return;
        if (!winnerState.source || winnerState.source.thread) throw new Error("Retry the thread capture.");
        state.source = winnerState.source;
      }
      messages = [{ ts: source.ts, user: state.source.author, text: state.source.text }];
    }
    blocks.push({
      type: "blockContainer",
      attrs: { id: `slack-${sessionId}-source` },
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Captured from Slack · " },
            { type: "text", text: "View source", marks: [{ type: "link", attrs: { href: link.permalink } }] },
          ],
        },
      ],
    });
    for (const message of messages)
      blocks.push(paragraph(`${message.user ?? "Slack member"} · ${message.ts}\n${message.text ?? ""}`));
  }
  const response = await env.DOCUMENT.getByName(`${page.id}~${page.content_epoch}`).fetch(
    new Request("https://document.internal/api-mutate", {
      method: "POST",
      headers: { "content-type": "application/json", "x-notes-internal": env.BETTER_AUTH_SECRET },
      body: JSON.stringify({
        actorId: member.user.id,
        operationId: `slack-${session.id}`,
        operations: [{ type: "append_children", children: blocks, position: { type: "end" } }],
      }),
    }),
  );
  if (!response.ok) throw new Error("Slack content could not be copied. Retry this capture.");
  await env.DB.prepare("UPDATE slack_product_sessions SET state_json=? WHERE id=?")
    .bind(JSON.stringify({ ...state, copied: true }), session.id)
    .run();
  if (session.view_id)
    await slackApi(env, installation, "views.update", {
      view_id: session.view_id,
      view: resultView(env, session.id, page.id, false),
    }).catch(() => undefined);
}

export async function acceptSlackProductInteraction(env: Env, payload: SlackInteractionPayload, deadlineAt: number) {
  try {
    return await acceptProductInteraction(env, payload, deadlineAt);
  } catch (error) {
    logInteractionFailure(payload, error);
    if (payload.type === "view_submission" && payload.view?.callback_id === CALLBACK)
      return {
        handled: true,
        response: {
          response_action: "errors",
          errors: { title: submissionErrorText(error) },
        },
      };
    if (typeof payload.trigger_id === "string") {
      const installation = await installationForTeam(env, payload.team?.id).catch(() => null);
      if (installation)
        await slackApi(
          env,
          installation,
          "views.open",
          {
            trigger_id: payload.trigger_id,
            view: modal("", [{ type: "section", text: { type: "plain_text", text: errorText(error) } }]),
          },
          Math.max(1, deadlineAt - Date.now() - 150),
        ).catch(() => undefined);
    }
    return { handled: true, response: {} };
  }
}

export async function deliverSlackProductCopy(env: Env, sessionId: string) {
  try {
    await copySlackProductContent(env, sessionId);
  } catch (error) {
    const session = await env.DB.prepare("SELECT * FROM slack_product_sessions WHERE id=?")
      .bind(sessionId)
      .first<Session>();
    if (session?.view_id && !(JSON.parse(session.state_json) as State).copied) {
      const installation = await env.DB.prepare(
        "SELECT * FROM slack_installations WHERE id=? AND generation=? AND disconnected_at IS NULL",
      )
        .bind(session.installation_id, session.generation)
        .first<SlackInstallation>();
      if (installation)
        await slackApi(env, installation, "views.update", {
          view_id: session.view_id,
          view: modal(session.id, [
            {
              type: "section",
              text: { type: "plain_text", text: `The source could not be copied. ${errorText(error)}` },
            },
            { type: "actions", elements: [button("Retry copy", "noteflare_copy_retry", session.id)] },
          ]),
        }).catch(() => undefined);
    }
    throw error;
  }
}
