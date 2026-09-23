import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import { mentionsInbox, type MentionCursor } from "./mentions-inbox";
import { pageForMember } from "./page-access";
import { parseSearchRequest, searchPages } from "./search";
import { createShare, getShare } from "./shares";
import { homeView, searchModal, type SearchModalFilters } from "./slack-blocks";
import {
  identityFor,
  installationFor,
  currentInput,
  requireChannelMember,
  validateChannel,
  verifiedMember,
} from "./slack-threads";
import {
  slackApi,
  recordSlackInstallationError,
  slackInstallationError,
  SlackApiError,
  SlackRateLimitError,
  usableBotToken,
  type SlackInstallation,
  type SlackInteractionPayload,
} from "./slack";

const DENIED = "This NoteFlare resource is unavailable or you no longer have permission to use it.";
const ID = /^[A-Za-z0-9:_-]{1,200}$/;
const TS = /^\d{1,16}\.\d{1,16}$/;
const SEARCH_SESSION_TTL_MS = 24 * 3_600_000;
const SEARCH_ACTIONS = new Set(["noteflare_search_run", "noteflare_search_next", "noteflare_search_previous"]);
const HOME_ACTIONS = new Set(["noteflare_home_next", "noteflare_home_previous", "noteflare_home_read"]);
const ROOT_ACTIONS = new Set([
  "noteflare_page_watch",
  "noteflare_page_unwatch",
  "noteflare_mapping_mute",
  "noteflare_mapping_unmute",
  "noteflare_mapping_snooze",
  "noteflare_share_create",
  "noteflare_share_view",
]);
const UNFURL_ACTIONS = new Set(["noteflare_unfurl_share_create", "noteflare_unfurl_share_view"]);

type Session = {
  id: string;
  installation_id: string;
  installation_generation: number;
  slack_user_id: string;
  kind: "search" | "home";
  view_id: string | null;
  view_hash: string | null;
  state_json: string;
  revision: number;
  pending_state_json: string | null;
  pending_revision: number | null;
  pending_token: string | null;
};
type HomeState = { asOf: number; cursors: Array<MentionCursor | null>; page: number };
type SearchState = SearchModalFilters;
type ActionInput = {
  actionId: string;
  installationId: string;
  generation: number;
  slackUserId: string;
  identity: { userId: string; accountId: string; verifiedAt: number; slackUserId: string } | null;
  channelId?: string;
  messageTs?: string;
  linkId?: string;
  referenceId?: string;
  unfurlUrl?: string;
  sessionId?: string;
  viewId?: string;
  viewHash?: string;
  initialLoading?: boolean;
  search?: SearchState;
};

const origin = (env: Env) => new URL(env.BETTER_AUTH_URL).origin;
function unavailable(): never {
  throw new HttpError(403, "slack_workspace_unavailable", DENIED);
}

function parseSession(row: Session): unknown {
  try {
    return JSON.parse(row.state_json) as unknown;
  } catch {
    return unavailable();
  }
}

async function sessionFor(
  env: Env,
  id: string,
  kind: Session["kind"],
  installation: SlackInstallation,
  userId: string,
) {
  const row = await env.DB.prepare(
    `SELECT * FROM slack_view_sessions WHERE id = ? AND kind = ? AND installation_id = ?
      AND installation_generation = ? AND slack_user_id = ? AND (? = 'home' OR updated_at >= ?)`,
  )
    .bind(id, kind, installation.id, installation.generation, userId, kind, Date.now() - SEARCH_SESSION_TTL_MS)
    .first<Session>();
  if (!row) unavailable();
  return row;
}

function queue(env: Env, id: string, workspaceId: string, topic: string, payload: Record<string, unknown>) {
  const now = Date.now();
  return env.DB.prepare(
    `INSERT OR IGNORE INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, workspaceId, topic, JSON.stringify(payload), now, now);
}

function receiptKey(input: {
  teamId: string;
  userId: string;
  actionId: string;
  actionTs: string;
  containerId: string;
}) {
  return `${input.teamId}:${input.userId}:${input.containerId}:${input.actionTs}:${input.actionId}`;
}

async function acceptAction(env: Env, installation: SlackInstallation, interactionId: string, input: ActionInput) {
  const receiptId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO slack_interaction_receipts
        (id, installation_id, interaction_id, callback_id, payload_json, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(receiptId, installation.id, interactionId, input.actionId, JSON.stringify(input), Date.now()),
    env.DB.prepare(
      `INSERT OR IGNORE INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
       SELECT 'outbox:slack-workspace:' || id, ?, 'slack_workspace_action', json_object('receiptId', id), ?, ?
         FROM slack_interaction_receipts WHERE interaction_id = ? AND processed_at IS NULL`,
    ).bind(installation.workspace_id, Date.now(), Date.now(), interactionId),
  ]);
}

function searchFromValues(value: unknown, fallback: SearchState): SearchState {
  const values = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const field = (name: string) => {
    const block = values[name];
    const state = block && typeof block === "object" ? (block as Record<string, unknown>).value : null;
    return state && typeof state === "object" ? (state as Record<string, unknown>) : {};
  };
  const queryValue = field("query").value;
  const query = typeof queryValue === "string" ? queryValue : queryValue === null ? "" : fallback.query;
  const option = (name: string) => {
    const selected = field(name).selected_option;
    return selected && typeof selected === "object" && typeof (selected as Record<string, unknown>).value === "string"
      ? String((selected as Record<string, unknown>).value)
      : undefined;
  };
  const selectedTags = field("tags").selected_options;
  const tagIds = Array.isArray(selectedTags)
    ? selectedTags
        .map((item: unknown) => (item && typeof item === "object" ? (item as Record<string, unknown>).value : null))
        .filter((item: unknown): item is string => typeof item === "string")
    : [];
  const url = new URL("https://notes.invalid/api/search");
  url.searchParams.set("q", query);
  if (option("space")) url.searchParams.set("space", option("space")!);
  for (const tagId of tagIds) url.searchParams.append("tag", tagId);
  if (option("kind")) url.searchParams.set("kind", option("kind")!);
  if (option("archive")) url.searchParams.set("archive", option("archive")!);
  url.searchParams.set("limit", "10");
  const parsed = parseSearchRequest(url.href);
  return { query: parsed.query, ...parsed.filters, offset: 0 };
}

function searchRequest(state: SearchState) {
  const url = new URL("https://notes.invalid/api/search");
  url.searchParams.set("q", state.query);
  if (state.spaceId) url.searchParams.set("space", state.spaceId);
  for (const tag of state.tagIds ?? []) url.searchParams.append("tag", tag);
  if (state.kind) url.searchParams.set("kind", state.kind);
  if (state.archive) url.searchParams.set("archive", state.archive);
  url.searchParams.set("limit", "10");
  url.searchParams.set("offset", String(state.offset));
  return parseSearchRequest(url.href);
}

export async function openSlackSearch(
  env: Env,
  installation: SlackInstallation,
  userId: string,
  triggerId: string,
  query: string,
  deadlineAt = Date.now() + 2_400,
  defer?: (work: Promise<void>) => void,
) {
  if (!triggerId || !ID.test(userId))
    return { response_type: "ephemeral", text: "Search is unavailable. Try `/notes <query>` again." };
  const id = crypto.randomUUID();
  const state: SearchState = { query: query.slice(0, 200), offset: 0 };
  await env.DB.prepare(
    `INSERT INTO slack_view_sessions
      (id, installation_id, installation_generation, slack_user_id, kind, state_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'search', ?, ?, ?)`,
  )
    .bind(id, installation.id, installation.generation, userId, JSON.stringify(state), Date.now(), Date.now())
    .run();
  const controller = new AbortController();
  // Reserve time for the slash-command HTTP acknowledgment after a failed open.
  const remaining = Math.max(0, deadlineAt - Date.now() - 150);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (remaining <= 0) throw new Error("Slack modal trigger expired.");
    const result = await Promise.race([
      slackApi(
        env,
        installation,
        "views.open",
        {
          trigger_id: triggerId,
          view: searchModal(id, state, origin(env)),
        },
        Math.min(1_800, remaining),
        controller.signal,
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("Slack modal trigger expired."));
          reject(new Error("Slack modal trigger expired."));
        }, remaining);
      }),
    ]);
    if (!result.view?.id) throw new Error("Slack did not return a modal ID.");
    const finishOpen = () =>
      env.DB.batch([
        env.DB.prepare(
          `UPDATE slack_view_sessions SET view_id = ?, view_hash = ?, updated_at = ? WHERE id = ? AND view_id IS NULL`,
        ).bind(result.view.id, result.view.hash ?? null, Date.now(), id),
        queue(env, `outbox:slack-search:${id}:open`, installation.workspace_id, "slack_search_update", {
          sessionId: id,
          revision: 0,
        }),
      ]);
    if (defer) defer(finishOpen().then(() => undefined));
    else await finishOpen();
    return { response_type: "ephemeral", text: "" };
  } catch {
    await env.DB.prepare(`DELETE FROM slack_view_sessions WHERE id = ?`).bind(id).run();
    return { response_type: "ephemeral", text: "Search could not open. Try `/notes <query>` again." };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function reconcileOpenedSearchView(
  env: Env,
  session: Session,
  view: NonNullable<SlackInteractionPayload["view"]>,
) {
  if (session.view_id || typeof view.id !== "string" || typeof view.hash !== "string") return session;
  const updated = await env.DB.prepare(
    `UPDATE slack_view_sessions SET view_id = ?, view_hash = ?, updated_at = ?
      WHERE id = ? AND view_id IS NULL AND revision = 0`,
  )
    .bind(view.id, view.hash, Date.now(), session.id)
    .run();
  if (updated.meta.changes) return { ...session, view_id: view.id, view_hash: view.hash };
  const current = await env.DB.prepare(`SELECT * FROM slack_view_sessions WHERE id = ?`)
    .bind(session.id)
    .first<Session>();
  return current ?? session;
}

async function currentInstallation(env: Env, teamId: string) {
  return env.DB.prepare(`SELECT * FROM slack_installations WHERE team_id = ? AND disconnected_at IS NULL`)
    .bind(teamId)
    .first<SlackInstallation>();
}

async function suggestions(env: Env, payload: SlackInteractionPayload) {
  if (typeof payload.team?.id !== "string" || typeof payload.user?.id !== "string") return { options: [] };
  const installation = await currentInstallation(env, payload.team.id);
  if (!installation) return { options: [] };
  const identity = await identityFor(env, installation, payload.user.id);
  if (!identity) return { options: [] };
  const member = await memberForCurrent(env, installation, identity.userId);
  if (!member) return { options: [] };
  const term = typeof payload.value === "string" ? payload.value.slice(0, 100).toLowerCase() : "";
  if (payload.action_id === "value" && payload.view?.callback_id === "noteflare_search") {
    // Slack identifies both external inputs as `value`; block_id disambiguates them.
    const blockId = (payload as SlackInteractionPayload & { block_id?: unknown }).block_id;
    if (blockId === "space") {
      const rows = await env.DB.prepare(
        `SELECT s.id, s.name FROM spaces s LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
          WHERE s.workspace_id = ? AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
            AND lower(s.name) LIKE ? ORDER BY lower(s.name), s.id LIMIT 100`,
      )
        .bind(member.user.id, member.workspace.id, member.role, `%${term}%`)
        .all<{ id: string; name: string }>();
      return {
        options: rows.results.map((row) => ({
          text: { type: "plain_text", text: row.name.slice(0, 75) },
          value: row.id,
        })),
      };
    }
    if (blockId === "tags") {
      const rows = await env.DB.prepare(
        `SELECT DISTINCT t.id, t.name FROM tags t JOIN page_tags pt ON pt.tag_id = t.id
          JOIN pages p ON p.id = pt.page_id AND p.workspace_id = t.workspace_id
          JOIN spaces s ON s.id = p.space_id
          LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
          WHERE t.workspace_id = ? AND p.import_job_id IS NULL AND p.is_template = 0
            AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
            AND lower(t.name) LIKE ? ORDER BY lower(t.name), t.id LIMIT 100`,
      )
        .bind(member.user.id, member.workspace.id, member.role, `%${term}%`)
        .all<{ id: string; name: string }>();
      return {
        options: rows.results.map((row) => ({
          text: { type: "plain_text", text: row.name.slice(0, 75) },
          value: row.id,
        })),
      };
    }
  }
  return { options: [] };
}

async function memberForCurrent(
  env: Env,
  installation: SlackInstallation,
  userId: string,
): Promise<MemberContext | null> {
  const row = await env.DB.prepare(
    `SELECT u.name, u.email, wm.role, w.name workspace_name, w.location_hint
       FROM workspace_members wm JOIN user u ON u.id = wm.user_id JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.workspace_id = ? AND wm.user_id = ?`,
  )
    .bind(installation.workspace_id, userId)
    .first<{
      name: string;
      email: string;
      role: MemberContext["role"];
      workspace_name: string;
      location_hint: string | null;
    }>();
  if (!row) return null;
  return {
    user: { id: userId, name: row.name, email: row.email },
    role: row.role,
    workspace: { id: installation.workspace_id, name: row.workspace_name, locationHint: row.location_hint },
    session: { id: "slack-workspace", expiresAt: new Date(Date.now() + 60_000) },
  };
}

export async function acceptSlackWorkspaceInteraction(env: Env, payload: SlackInteractionPayload) {
  if (payload.type === "block_suggestion") {
    try {
      return { handled: true, response: await suggestions(env, payload) };
    } catch {
      return { handled: true, response: { options: [] } };
    }
  }
  if (payload.type === "view_submission" && payload.view?.callback_id === "noteflare_search") {
    if (typeof payload.team?.id !== "string" || typeof payload.user?.id !== "string")
      return { handled: true, response: { ok: true } };
    const installation = await currentInstallation(env, payload.team.id);
    if (!installation) return { handled: true, response: { ok: true } };
    const sessionId = payload.view.private_metadata;
    if (typeof sessionId !== "string" || !ID.test(sessionId) || typeof payload.view.id !== "string")
      return { handled: true, response: { ok: true } };
    const session = await reconcileOpenedSearchView(
      env,
      await sessionFor(env, sessionId, "search", installation, payload.user.id),
      payload.view,
    );
    if (session.view_id !== payload.view.id || session.view_hash !== payload.view.hash) unavailable();
    const identity = await identityFor(env, installation, payload.user.id);
    if (!identity || !(await memberForCurrent(env, installation, identity.userId))) unavailable();
    const interactionId = receiptKey({
      teamId: payload.team.id,
      userId: payload.user.id,
      actionId: "noteflare_search_done",
      actionTs: session.view_hash ?? "",
      containerId: session.id,
    });
    await env.DB.prepare(
      `INSERT OR IGNORE INTO slack_interaction_receipts
        (id, installation_id, interaction_id, callback_id, received_at, processed_at, outcome)
       VALUES (?, ?, ?, 'noteflare_search_done', ?, ?, 'accepted')`,
    )
      .bind(crypto.randomUUID(), installation.id, interactionId, Date.now(), Date.now())
      .run();
    return { handled: true, response: {} };
  }
  if (
    payload.type !== "block_actions" ||
    payload.actions?.length !== 1 ||
    typeof payload.team?.id !== "string" ||
    typeof payload.user?.id !== "string"
  )
    return { handled: false };
  const action = payload.actions[0]!;
  const actionId = action.action_id;
  if (typeof actionId !== "string" || typeof action.action_ts !== "string" || !TS.test(action.action_ts))
    return { handled: false };
  if (
    !SEARCH_ACTIONS.has(actionId) &&
    !HOME_ACTIONS.has(actionId) &&
    !ROOT_ACTIONS.has(actionId) &&
    !UNFURL_ACTIONS.has(actionId)
  )
    return { handled: false };
  const installation = await currentInstallation(env, payload.team.id);
  if (!installation) return { handled: true, response: { ok: true } };
  const identity = await identityFor(env, installation, payload.user.id);
  const input: ActionInput = {
    actionId,
    installationId: installation.id,
    generation: installation.generation,
    slackUserId: payload.user.id,
    identity,
  };
  let containerId: string;
  if (SEARCH_ACTIONS.has(actionId)) {
    const sessionId = typeof action.value === "string" ? action.value : payload.view?.private_metadata;
    if (typeof sessionId !== "string" || !ID.test(sessionId) || typeof payload.view?.id !== "string")
      return { handled: true, response: { ok: true } };
    const session = await reconcileOpenedSearchView(
      env,
      await sessionFor(env, sessionId, "search", installation, payload.user.id),
      payload.view,
    );
    const current = parseSession(session) as SearchState;
    const chosen = searchFromValues(payload.view?.state?.values, current);
    const sameFilters = JSON.stringify({ ...current, offset: 0 }) === JSON.stringify(chosen);
    const offset =
      actionId === "noteflare_search_next" && sameFilters
        ? Math.min(1000, current.offset + 10)
        : actionId === "noteflare_search_previous" && sameFilters
          ? Math.max(0, current.offset - 10)
          : 0;
    input.sessionId = sessionId;
    input.initialLoading =
      actionId === "noteflare_search_run" && session.revision === 0 && session.view_hash === payload.view.hash;
    input.viewId = payload.view.id;
    if (typeof payload.view.hash === "string") input.viewHash = payload.view.hash;
    input.search = { ...chosen, offset };
    containerId = payload.view.id;
  } else if (HOME_ACTIONS.has(actionId)) {
    const sessionId = typeof action.value === "string" ? action.value : payload.view?.private_metadata;
    if (typeof sessionId !== "string" || !ID.test(sessionId) || typeof payload.view?.id !== "string")
      return { handled: true, response: { ok: true } };
    input.sessionId = sessionId;
    input.viewId = payload.view.id;
    if (typeof payload.view.hash === "string") input.viewHash = payload.view.hash;
    containerId = payload.view.id;
  } else if (ROOT_ACTIONS.has(actionId)) {
    const raw = actionId === "noteflare_mapping_snooze" ? action.selected_option?.value : action.value;
    if (
      typeof raw !== "string" ||
      typeof payload.channel?.id !== "string" ||
      typeof payload.message?.ts !== "string" ||
      !TS.test(payload.message.ts)
    )
      return { handled: true, response: { ok: true } };
    const [linkId, hours] = actionId === "noteflare_mapping_snooze" ? raw.split(":") : [raw];
    if (!linkId || !ID.test(linkId) || (hours && !["1", "8", "24"].includes(hours)))
      return { handled: true, response: { ok: true } };
    input.linkId = actionId === "noteflare_mapping_snooze" ? `${linkId}:${hours}` : linkId;
    input.channelId = payload.channel.id;
    input.messageTs = payload.message.ts;
    containerId = `${payload.channel.id}:${payload.message.ts}`;
  } else {
    const refId = action.value;
    const channelId = payload.container?.channel_id ?? payload.channel?.id;
    const messageTs = payload.container?.message_ts;
    if (
      typeof refId !== "string" ||
      !ID.test(refId) ||
      typeof channelId !== "string" ||
      typeof messageTs !== "string" ||
      !TS.test(messageTs)
    )
      return { handled: true, response: { ok: true } };
    input.referenceId = refId;
    input.channelId = channelId;
    input.messageTs = messageTs;
    if (
      typeof payload.container?.app_unfurl_url !== "string" ||
      payload.container.app_unfurl_url !== payload.app_unfurl?.app_unfurl_url
    )
      return { handled: true, response: { ok: true } };
    input.unfurlUrl = payload.container.app_unfurl_url;
    containerId = `${channelId}:${messageTs}:${refId}`;
  }
  const key = receiptKey({
    teamId: payload.team.id,
    userId: payload.user.id,
    actionId,
    actionTs: action.action_ts,
    containerId,
  });
  await acceptAction(env, installation, key, input);
  return { handled: true, response: { ok: true } };
}

async function deliverSearch(env: Env, input: ActionInput | null, sessionId: string, revision: number) {
  const row = await env.DB.prepare(
    `SELECT * FROM slack_view_sessions WHERE id = ? AND kind = 'search' AND updated_at >= ?`,
  )
    .bind(sessionId, Date.now() - SEARCH_SESSION_TTL_MS)
    .first<Session>();
  if (!row || !row.view_id || row.revision !== revision) return;
  const installation = await env.DB.prepare(
    `SELECT * FROM slack_installations WHERE id = ? AND generation = ? AND disconnected_at IS NULL`,
  )
    .bind(row.installation_id, row.installation_generation)
    .first<SlackInstallation>();
  if (!installation) return;
  if (
    input &&
    (input.viewId !== row.view_id ||
      !input.viewHash ||
      (input.viewHash !== row.view_hash &&
        row.pending_state_json === null &&
        !(input.initialLoading && row.revision === 1)) ||
      input.slackUserId !== row.slack_user_id ||
      input.generation !== row.installation_generation)
  )
    unavailable();
  const state = input?.search ?? (parseSession(row) as SearchState);
  const expectedHash = input?.initialLoading && row.revision === 1 ? row.view_hash : (input?.viewHash ?? row.view_hash);
  let view: Record<string, unknown>;
  try {
    const { member } = await verifiedMember(env, installation, row.slack_user_id, input?.identity);
    const result = await searchPages(env.DB, member, searchRequest(state));
    view = searchModal(row.id, state, origin(env), result);
  } catch (error) {
    if (error instanceof HttpError && error.code === "slack_identity_required") {
      view = searchModal(
        row.id,
        state,
        origin(env),
        undefined,
        "Verify your Slack identity in NoteFlare Settings to search.",
      );
    } else if (deniedError(error)) {
      view = searchModal(row.id, state, origin(env), undefined, DENIED);
    } else throw error;
  }
  const pendingToken = crypto.randomUUID();
  const intent = await env.DB.prepare(
    `UPDATE slack_view_sessions SET pending_state_json = ?, pending_revision = ?, pending_token = ?
      WHERE id = ? AND revision = ?`,
  )
    .bind(JSON.stringify(state), row.revision + 1, pendingToken, row.id, row.revision)
    .run();
  if (!intent.meta.changes) throw new Error("Slack search state changed during publication.");
  const updated = await slackApi(env, installation, "views.update", {
    view_id: row.view_id,
    view,
    ...(expectedHash ? { hash: expectedHash } : {}),
  });
  if (!updated.view?.hash) throw new Error("Slack did not return the updated modal hash.");
  const finalized = await env.DB.prepare(
    `UPDATE slack_view_sessions SET state_json = ?, view_hash = ?, revision = revision + 1,
      pending_state_json = NULL, pending_revision = NULL, pending_token = NULL, updated_at = ?
      WHERE id = ? AND revision = ? AND view_hash IS ? AND pending_token = ?`,
  )
    .bind(JSON.stringify(state), updated.view.hash, Date.now(), row.id, row.revision, row.view_hash, pendingToken)
    .run();
  if (!finalized.meta.changes) throw new Error("Slack search update could not be finalized.");
}

export async function deliverSlackSearchUpdate(env: Env, sessionId: string, revision: number) {
  try {
    await deliverSearch(env, null, sessionId, revision);
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "not_found") {
      await env.DB.prepare(`DELETE FROM slack_view_sessions WHERE id = ? AND kind = 'search'`).bind(sessionId).run();
      return;
    }
    if (error instanceof SlackApiError && error.code === "hash_conflict") return;
    throw error;
  }
}

export async function purgeExpiredSlackSearchSessions(env: Env) {
  await env.DB.prepare(`DELETE FROM slack_view_sessions WHERE kind = 'search' AND updated_at < ?`)
    .bind(Date.now() - SEARCH_SESSION_TTL_MS)
    .run();
}

export async function deliverSlackHome(
  env: Env,
  installationId: string,
  userId: string,
  generation?: number,
  reset = false,
) {
  if (generation !== undefined) {
    const current = await env.DB.prepare(
      `SELECT generation FROM slack_installations WHERE id = ? AND disconnected_at IS NULL`,
    )
      .bind(installationId)
      .first<{ generation: number }>();
    if (!current || current.generation !== generation) return;
  }
  await publishSlackHome(env, installationId, userId, reset);
}

export async function publishSlackHome(env: Env, installationId: string, userId: string, reset = false) {
  const installation = await env.DB.prepare(
    `SELECT * FROM slack_installations WHERE id = ? AND disconnected_at IS NULL`,
  )
    .bind(installationId)
    .first<SlackInstallation>();
  if (!installation) return;
  const id = `home:${installation.id}:${userId}`;
  const old = await env.DB.prepare(`SELECT * FROM slack_view_sessions WHERE id = ?`).bind(id).first<Session>();
  const state: HomeState =
    !reset && old?.installation_generation === installation.generation
      ? (parseSession(old) as HomeState)
      : { asOf: Date.now() - 1, cursors: [null], page: 0 };
  if (!old) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO slack_view_sessions
        (id, installation_id, installation_generation, slack_user_id, kind, state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'home', ?, ?, ?)`,
    )
      .bind(id, installation.id, installation.generation, userId, JSON.stringify(state), Date.now(), Date.now())
      .run();
  }
  let view: Record<string, unknown>;
  try {
    const { member } = await verifiedMember(env, installation, userId);
    const result = await mentionsInbox(env, member, state.asOf, state.cursors[state.page] ?? null, 10);
    view = homeView({
      sessionId: id,
      mentions: result.mentions,
      firstPage: state.page === 0,
      nextCursor: result.nextCursor,
      origin: origin(env),
    });
  } catch (error) {
    if (!deniedError(error)) throw error;
    view = homeView({
      sessionId: id,
      mentions: [],
      firstPage: true,
      nextCursor: null,
      origin: origin(env),
      unavailable: true,
    });
  }
  try {
    const pendingToken = crypto.randomUUID();
    const intent = await env.DB.prepare(
      `UPDATE slack_view_sessions SET pending_state_json = ?, pending_revision = revision + 1,
        pending_token = ? WHERE id = ? AND revision = ? AND view_hash IS ?`,
    )
      .bind(JSON.stringify(state), pendingToken, id, old?.revision ?? 0, old?.view_hash ?? null)
      .run();
    if (!intent.meta.changes) return;
    const published = await slackApi(env, installation, "views.publish", {
      user_id: userId,
      view,
      ...(!reset && old?.view_hash ? { hash: old.view_hash } : {}),
    });
    await env.DB.prepare(
      `UPDATE slack_view_sessions SET installation_generation = ?, state_json = ?, view_id = ?, view_hash = ?,
        pending_state_json = NULL, pending_revision = NULL, pending_token = NULL,
        revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND pending_token = ?`,
    )
      .bind(
        installation.generation,
        JSON.stringify(state),
        published.view.id,
        published.view.hash ?? null,
        Date.now(),
        id,
        old?.revision ?? 0,
        pendingToken,
      )
      .run();
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "hash_conflict") return;
    throw error;
  }
}

function rootGuard(env: Env, receiptId: string, input: ActionInput, linkId: string, owner: boolean) {
  return env.DB.prepare(
    `INSERT INTO slack_action_commits (receipt_id, authorized) VALUES (?, EXISTS (
      SELECT 1 FROM slack_interaction_receipts receipt
      JOIN slack_installations i ON i.id = receipt.installation_id AND i.disconnected_at IS NULL
      JOIN slack_thread_links l ON l.installation_id = i.id AND l.installation_generation = i.generation
      JOIN slack_channel_subscriptions mapping ON mapping.id = l.subscription_id AND mapping.installation_id = i.id
        AND mapping.channel_id = l.channel_id AND mapping.mirror_enabled = 1 AND mapping.validation_state = 'valid'
      JOIN pages p ON p.id = l.page_id AND p.workspace_id = i.workspace_id AND p.space_id = mapping.space_id
      JOIN spaces space ON space.id = p.space_id
      JOIN slack_user_links link ON link.installation_id = i.id AND link.installation_generation = i.generation
      JOIN account account ON account.id = link.better_auth_account_id AND account.userId = link.user_id
      JOIN workspace_members wm ON wm.workspace_id = i.workspace_id AND wm.user_id = link.user_id
      LEFT JOIN space_members sm ON sm.space_id = space.id AND sm.user_id = wm.user_id
      WHERE receipt.id = ? AND receipt.processed_at IS NULL
        AND receipt.received_at > unixepoch('subsec') * 1000 - 600000 AND i.id = ? AND i.generation = ?
        AND l.id = ? AND l.state = 'active' AND l.channel_id = ? AND l.root_message_ts = ?
        AND (mapping.page_id IS NULL OR mapping.page_id = p.id)
        AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template = 0
        AND (wm.role = 'owner' OR space.visibility = 'workspace' OR sm.user_id IS NOT NULL)
        AND (? = 0 OR wm.role = 'owner')
        AND link.slack_user_id = ? AND link.migration_state = 'verified'
        AND link.verification_method = 'slack_openid' AND link.verified_at = ?
        AND link.user_id = ? AND account.id = ? AND account.providerId = 'slack'
        AND account.accountId = i.team_id || ':' || link.slack_user_id
    ))`,
  ).bind(
    receiptId,
    receiptId,
    input.installationId,
    input.generation,
    linkId,
    input.channelId,
    input.messageTs,
    owner ? 1 : 0,
    input.slackUserId,
    input.identity?.verifiedAt ?? -1,
    input.identity?.userId ?? "",
    input.identity?.accountId ?? "",
  );
}

function homeGuard(env: Env, receiptId: string, input: ActionInput, sessionId: string) {
  return env.DB.prepare(
    `INSERT INTO slack_action_commits (receipt_id, authorized) VALUES (?, EXISTS (
      SELECT 1 FROM slack_interaction_receipts receipt
      JOIN slack_installations i ON i.id = receipt.installation_id AND i.disconnected_at IS NULL
      JOIN slack_view_sessions session ON session.installation_id = i.id AND session.installation_generation = i.generation
      JOIN slack_user_links link ON link.installation_id = i.id AND link.installation_generation = i.generation
      JOIN account account ON account.id = link.better_auth_account_id AND account.userId = link.user_id
      JOIN workspace_members wm ON wm.workspace_id = i.workspace_id AND wm.user_id = link.user_id
      WHERE receipt.id = ? AND receipt.processed_at IS NULL
        AND receipt.received_at > unixepoch('subsec') * 1000 - 600000 AND i.id = ? AND i.generation = ?
        AND session.id = ? AND session.kind = 'home' AND session.slack_user_id = ?
        AND link.slack_user_id = ? AND link.migration_state = 'verified'
        AND link.verification_method = 'slack_openid' AND link.verified_at = ?
        AND link.user_id = ? AND account.id = ? AND account.providerId = 'slack'
        AND account.accountId = i.team_id || ':' || link.slack_user_id
    ))`,
  ).bind(
    receiptId,
    receiptId,
    input.installationId,
    input.generation,
    sessionId,
    input.slackUserId,
    input.slackUserId,
    input.identity?.verifiedAt ?? -1,
    input.identity?.userId ?? "",
    input.identity?.accountId ?? "",
  );
}

async function supersedeHomeAction(env: Env, receiptId: string) {
  await env.DB.prepare(
    `UPDATE slack_interaction_receipts SET processed_at = ?, outcome = 'superseded', payload_json = NULL
      WHERE id = ? AND processed_at IS NULL`,
  )
    .bind(Date.now(), receiptId)
    .run();
}

async function deliverHomeAction(env: Env, receiptId: string, input: ActionInput) {
  if (!input.sessionId) unavailable();
  const installation = await installationFor(env, input.installationId, input.generation);
  const session = await sessionFor(env, input.sessionId, "home", installation, input.slackUserId);
  const { member } = await verifiedMember(env, installation, input.slackUserId, input.identity);
  if (session.view_id !== input.viewId || session.view_hash !== input.viewHash) {
    await supersedeHomeAction(env, receiptId);
    return;
  }
  const state = parseSession(session) as HomeState;
  if (input.actionId === "noteflare_home_read") {
    await env.DB.batch([
      homeGuard(env, receiptId, input, session.id),
      env.DB.prepare(
        `INSERT INTO mention_reads (workspace_id, user_id, read_at) VALUES (?, ?, ?)
          ON CONFLICT(workspace_id, user_id) DO UPDATE SET read_at = MAX(read_at, excluded.read_at)`,
      ).bind(member.workspace.id, member.user.id, state.asOf),
      env.DB.prepare(
        `UPDATE slack_interaction_receipts SET processed_at = ?, outcome = 'accepted', payload_json = NULL WHERE id = ? AND processed_at IS NULL`,
      ).bind(Date.now(), receiptId),
      queue(env, `outbox:slack-home:read:${receiptId}`, installation.workspace_id, "slack_home_publish", {
        installationId: installation.id,
        generation: installation.generation,
        userId: input.slackUserId,
      }),
    ]);
    return;
  }
  const next: HomeState = { asOf: state.asOf, cursors: [...state.cursors], page: state.page };
  if (input.actionId === "noteflare_home_next") {
    const current = await mentionsInbox(env, member, state.asOf, state.cursors[state.page] ?? null, 10);
    if (!current.nextCursor) {
      await supersedeHomeAction(env, receiptId);
      return;
    }
    next.cursors = [...state.cursors.slice(0, state.page + 1), current.nextCursor];
    next.page += 1;
  } else if (input.actionId === "noteflare_home_previous") {
    if (!state.page) {
      await supersedeHomeAction(env, receiptId);
      return;
    }
    next.page -= 1;
    next.cursors = next.cursors.slice(0, next.page + 1);
  } else unavailable();
  const result = await mentionsInbox(env, member, next.asOf, next.cursors[next.page] ?? null, 10);
  const view = homeView({
    sessionId: session.id,
    mentions: result.mentions,
    firstPage: next.page === 0,
    nextCursor: result.nextCursor,
    origin: origin(env),
  });
  const pendingToken = receiptId;
  const intent = await env.DB.prepare(
    `UPDATE slack_view_sessions SET pending_state_json = ?, pending_revision = ?, pending_token = ?
      WHERE id = ? AND revision = ? AND view_hash IS ?
        AND (pending_token IS NULL OR pending_token = ?)`,
  )
    .bind(
      JSON.stringify(next),
      session.revision + 1,
      pendingToken,
      session.id,
      session.revision,
      session.view_hash,
      pendingToken,
    )
    .run();
  if (!intent.meta.changes) {
    await supersedeHomeAction(env, receiptId);
    return;
  }
  let published: { view: { id: string; hash?: string } };
  try {
    published = await slackApi(env, installation, "views.publish", {
      user_id: input.slackUserId,
      view,
      ...(session.view_hash ? { hash: session.view_hash } : {}),
    });
  } catch (error) {
    if (!(error instanceof SlackApiError && error.code === "hash_conflict")) throw error;
    const current = await env.DB.prepare(`SELECT pending_token FROM slack_view_sessions WHERE id = ?`)
      .bind(session.id)
      .first<{ pending_token: string | null }>();
    if (current?.pending_token !== pendingToken) {
      await supersedeHomeAction(env, receiptId);
      return;
    }
    published = await slackApi(env, installation, "views.publish", {
      user_id: input.slackUserId,
      view,
    });
  }
  if (!published.view.hash) throw new Error("Slack did not return the published Home hash.");
  await env.DB.batch([
    env.DB.prepare(`UPDATE slack_view_sessions SET state_json = ?, view_id = ?, view_hash = ?,
      pending_state_json = NULL, pending_revision = NULL, pending_token = NULL,
      revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND view_hash IS ? AND pending_token = ?`).bind(
      JSON.stringify(next),
      published.view.id,
      published.view.hash ?? null,
      Date.now(),
      session.id,
      session.revision,
      session.view_hash,
      pendingToken,
    ),
    env.DB.prepare(
      `UPDATE slack_interaction_receipts SET processed_at = ?, outcome = 'accepted', payload_json = NULL
        WHERE id = ? AND processed_at IS NULL AND EXISTS
        (SELECT 1 FROM slack_view_sessions WHERE id = ? AND revision = ? AND view_hash IS ? AND pending_token IS NULL)`,
    ).bind(Date.now(), receiptId, session.id, session.revision + 1, published.view.hash ?? null),
  ]);
  const committed = await env.DB.prepare(`SELECT processed_at FROM slack_interaction_receipts WHERE id = ?`)
    .bind(receiptId)
    .first<{ processed_at: number | null }>();
  if (!committed?.processed_at) {
    const current = await env.DB.prepare(`SELECT revision, pending_token FROM slack_view_sessions WHERE id = ?`)
      .bind(session.id)
      .first<{ revision: number; pending_token: string | null }>();
    if (current && (current.revision > session.revision || current.pending_token !== pendingToken)) {
      await supersedeHomeAction(env, receiptId);
      return;
    }
    throw new Error("Slack Home navigation could not be finalized.");
  }
}

async function deliverRootAction(env: Env, receiptId: string, input: ActionInput) {
  if (!input.linkId || !input.channelId || !input.messageTs) unavailable();
  const [linkId, hoursText] = input.actionId === "noteflare_mapping_snooze" ? input.linkId.split(":") : [input.linkId];
  if (!linkId) unavailable();
  const { installation, link, member, page } = await currentInput(env, {
    installationId: input.installationId,
    generation: input.generation,
    linkId,
    channelId: input.channelId,
    threadTs: input.messageTs,
    slackUserId: input.slackUserId,
    identity: input.identity,
  });
  const owner = input.actionId.startsWith("noteflare_mapping_") || input.actionId.startsWith("noteflare_share_");
  if (owner && member.role !== "owner") unavailable();
  if (input.actionId === "noteflare_page_watch" || input.actionId === "noteflare_page_unwatch") {
    // A muted page override also suppresses an inherited space watch.
    const muted = input.actionId === "noteflare_page_unwatch";
    await env.DB.batch([
      rootGuard(env, receiptId, input, linkId, false),
      env.DB.prepare(
        `INSERT INTO subscriptions (id, workspace_id, user_id, resource_type, resource_id, created_by, muted_at, created_at)
         VALUES (?, ?, ?, 'page', ?, ?, ?, ?)
         ON CONFLICT(user_id, resource_type, resource_id) DO UPDATE SET muted_at = excluded.muted_at`,
      ).bind(
        `page:${page.id}:${member.user.id}`,
        member.workspace.id,
        member.user.id,
        page.id,
        member.user.id,
        muted ? Date.now() : null,
        Date.now(),
      ),
      env.DB.prepare(
        `UPDATE slack_interaction_receipts SET processed_at = ?, outcome = 'accepted', payload_json = NULL WHERE id = ? AND processed_at IS NULL`,
      ).bind(Date.now(), receiptId),
      queue(env, `outbox:slack-home:watch:${receiptId}`, installation.workspace_id, "slack_home_publish", {
        installationId: installation.id,
        generation: installation.generation,
        userId: input.slackUserId,
      }),
    ]);
    return;
  }
  if (input.actionId.startsWith("noteflare_mapping_")) {
    const hours = Number(hoursText);
    if (input.actionId === "noteflare_mapping_snooze" && ![1, 8, 24].includes(hours)) unavailable();
    const mutedAt = input.actionId === "noteflare_mapping_mute" ? Date.now() : null;
    const snoozedUntil = input.actionId === "noteflare_mapping_snooze" ? Date.now() + hours * 3_600_000 : null;
    const refreshId = `${link.id}:refresh:${receiptId}`;
    await env.DB.batch([
      rootGuard(env, receiptId, input, linkId, true),
      env.DB.prepare(
        `UPDATE slack_channel_subscriptions SET muted_at = ?, snoozed_until = ?, updated_at = ? WHERE id = ?`,
      ).bind(mutedAt, snoozedUntil, Date.now(), link.subscription_id),
      ...(input.actionId === "noteflare_mapping_unmute"
        ? []
        : [
            env.DB.prepare(
              `UPDATE slack_channel_events SET suppressed_at = ?
          WHERE subscription_id = ? AND delivered_at IS NULL AND suppressed_at IS NULL`,
            ).bind(Date.now(), link.subscription_id),
          ]),
      env.DB.prepare(`INSERT OR IGNORE INTO slack_thread_deliveries
        (id, link_id, operation, source_id, actor_id, created_at, updated_at)
        VALUES (?, ?, 'refresh', ?, ?, ?, ?)`).bind(
        refreshId,
        link.id,
        receiptId,
        member.user.id,
        Date.now(),
        Date.now(),
      ),
      queue(env, `outbox:${refreshId}`, installation.workspace_id, "slack_thread_reply", { deliveryId: refreshId }),
      env.DB.prepare(
        `UPDATE slack_interaction_receipts SET processed_at = ?, outcome = 'accepted', payload_json = NULL WHERE id = ? AND processed_at IS NULL`,
      ).bind(Date.now(), receiptId),
    ]);
    return;
  }
  await deliverShareAction(env, receiptId, input, {
    installation,
    member,
    pageId: page.id,
    channelId: link.channel_id,
    messageTs: link.root_message_ts!,
    linkId: link.id,
  });
}

function unfurlGuard(env: Env, receiptId: string, input: ActionInput, referenceId: string) {
  return env.DB.prepare(
    `INSERT INTO slack_action_commits (receipt_id, authorized) VALUES (?, EXISTS (
      SELECT 1 FROM slack_interaction_receipts receipt
      JOIN slack_installations i ON i.id = receipt.installation_id AND i.disconnected_at IS NULL
      JOIN slack_share_references ref ON ref.installation_id = i.id AND ref.installation_generation = i.generation
      JOIN pages p ON p.id = ref.page_id AND p.workspace_id = i.workspace_id
      JOIN slack_channel_subscriptions mapping ON mapping.installation_id = i.id AND mapping.channel_id = ref.channel_id
        AND mapping.space_id = p.space_id AND mapping.validation_state = 'valid'
        AND (mapping.page_id IS NULL OR mapping.page_id = p.id)
      JOIN slack_user_links link ON link.installation_id = i.id AND link.installation_generation = i.generation
      JOIN account account ON account.id = link.better_auth_account_id AND account.userId = link.user_id
      JOIN workspace_members wm ON wm.workspace_id = i.workspace_id AND wm.user_id = link.user_id AND wm.role = 'owner'
      WHERE receipt.id = ? AND receipt.processed_at IS NULL
        AND receipt.received_at > unixepoch('subsec') * 1000 - 600000 AND i.id = ? AND i.generation = ?
        AND ref.id = ? AND ref.channel_id = ? AND ref.message_ts = ? AND ref.state <> 'retired'
        AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template = 0
        AND link.slack_user_id = ? AND link.migration_state = 'verified'
        AND link.verification_method = 'slack_openid' AND link.verified_at = ?
        AND link.user_id = ? AND account.id = ? AND account.providerId = 'slack'
        AND account.accountId = i.team_id || ':' || link.slack_user_id
    ))`,
  ).bind(
    receiptId,
    receiptId,
    input.installationId,
    input.generation,
    referenceId,
    input.channelId,
    input.messageTs,
    input.slackUserId,
    input.identity?.verifiedAt ?? -1,
    input.identity?.userId ?? "",
    input.identity?.accountId ?? "",
  );
}

async function deliverUnfurlAction(env: Env, receiptId: string, input: ActionInput) {
  if (!input.referenceId || !input.channelId || !input.messageTs) unavailable();
  const installation = await installationFor(env, input.installationId, input.generation);
  const reference = await env.DB.prepare(
    `SELECT * FROM slack_share_references WHERE id = ? AND installation_id = ?
       AND installation_generation = ? AND channel_id = ? AND message_ts = ? AND state <> 'retired'`,
  )
    .bind(input.referenceId, installation.id, installation.generation, input.channelId, input.messageTs)
    .first<{
      id: string;
      page_id: string;
      channel_id: string;
      message_ts: string;
      url: string;
    }>();
  if (!reference) unavailable();
  if (reference.url !== input.unfurlUrl) unavailable();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(reference.url);
  } catch {
    unavailable();
  }
  if (parsedUrl.origin !== origin(env) || parsedUrl.searchParams.get("page") !== reference.page_id) unavailable();
  const { member } = await verifiedMember(env, installation, input.slackUserId, input.identity);
  if (member.role !== "owner") unavailable();
  await validateChannel(env, installation, reference.channel_id);
  await requireChannelMember(env, installation, reference.channel_id, input.slackUserId);
  const page = await pageForMember(env, member, reference.page_id);
  const mapping = await env.DB.prepare(
    `SELECT id FROM slack_channel_subscriptions WHERE installation_id = ? AND channel_id = ?
       AND space_id = ? AND (page_id IS NULL OR page_id = ?) AND validation_state = 'valid' LIMIT 1`,
  )
    .bind(installation.id, reference.channel_id, page.space_id, page.id)
    .first();
  if (!mapping) unavailable();
  await deliverShareAction(env, receiptId, input, {
    installation,
    member,
    pageId: page.id,
    channelId: reference.channel_id,
    messageTs: reference.message_ts,
    referenceId: reference.id,
  });
}

async function deliverShareAction(
  env: Env,
  receiptId: string,
  input: ActionInput,
  context: {
    installation: SlackInstallation;
    member: MemberContext;
    pageId: string;
    channelId: string;
    messageTs: string;
    linkId?: string;
    referenceId?: string;
  },
) {
  const isCreate = input.actionId.endsWith("_create");
  const guard = context.linkId
    ? rootGuard(env, receiptId, input, context.linkId, true)
    : unfurlGuard(env, receiptId, input, context.referenceId!);
  const afterCreate = (shareId: string): D1PreparedStatement[] => {
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(`UPDATE slack_interaction_receipts SET processed_at = ?, outcome = 'accepted', payload_json = NULL,
        response_delivery_state = 'pending', response_delivery_error = NULL
        WHERE id = ? AND processed_at IS NULL`).bind(Date.now(), receiptId),
      queue(
        env,
        `outbox:slack-share-response:${receiptId}`,
        context.installation.workspace_id,
        "slack_share_response",
        {
          receiptId,
          installationId: context.installation.id,
          generation: context.installation.generation,
          userId: input.slackUserId,
          channelId: context.channelId,
          messageTs: context.messageTs,
          pageId: context.pageId,
          shareId,
          ...(context.linkId ? { linkId: context.linkId } : { referenceId: context.referenceId }),
        },
      ),
    ];
    if (context.referenceId)
      statements.push(
        env.DB.prepare(`UPDATE slack_share_references SET share_link_id = ?, updated_at = ? WHERE id = ?`).bind(
          shareId,
          Date.now(),
          context.referenceId,
        ),
      );
    if (context.linkId && isCreate) {
      const refreshId = `${context.linkId}:refresh:${receiptId}`;
      statements.push(
        env.DB.prepare(`INSERT OR IGNORE INTO slack_thread_deliveries
        (id, link_id, operation, source_id, actor_id, created_at, updated_at)
        VALUES (?, ?, 'refresh', ?, ?, ?, ?)`).bind(
          refreshId,
          context.linkId,
          receiptId,
          context.member.user.id,
          Date.now(),
          Date.now(),
        ),
      );
      statements.push(
        queue(env, `outbox:${refreshId}`, context.installation.workspace_id, "slack_thread_reply", {
          deliveryId: refreshId,
        }),
      );
    }
    return statements;
  };
  const share = isCreate
    ? await createShare(env, context.member, context.pageId, origin(env), {}, { guard, afterCreate })
    : await getShare(env, context.member, context.pageId, origin(env));
  if (!share) unavailable();
  const committed = await env.DB.prepare(`SELECT processed_at FROM slack_interaction_receipts WHERE id = ?`)
    .bind(receiptId)
    .first<{ processed_at: number | null }>();
  if (committed?.processed_at !== null && committed?.processed_at !== undefined) return;
  await env.DB.batch([guard, ...afterCreate(share.id)]);
}

function deniedError(error: unknown) {
  return (
    (error instanceof HttpError && error.status < 500) ||
    (error instanceof SlackApiError &&
      [
        "channel_not_found",
        "not_in_channel",
        "user_not_found",
        "account_inactive",
        "token_revoked",
        "invalid_auth",
        "missing_scope",
        "no_permission",
        "hash_conflict",
        "not_found",
      ].includes(error.code)) ||
    String(error).includes("CHECK constraint failed: authorized = 1") ||
    String(error).includes("UNIQUE constraint failed: slack_action_commits.receipt_id")
  );
}

export async function deliverSlackWorkspaceAction(env: Env, receiptId: string) {
  const receipt = await env.DB.prepare(
    `SELECT payload_json, processed_at, received_at FROM slack_interaction_receipts WHERE id = ?`,
  )
    .bind(receiptId)
    .first<{ payload_json: string | null; processed_at: number | null; received_at: number }>();
  if (!receipt || receipt.processed_at !== null || !receipt.payload_json) return;
  const input = JSON.parse(receipt.payload_json) as ActionInput;
  try {
    if (receipt.received_at <= Date.now() - 10 * 60_000)
      throw new HttpError(403, "slack_action_expired", "This Slack action expired.");
    if (SEARCH_ACTIONS.has(input.actionId)) {
      if (!input.sessionId) unavailable();
      const session = await env.DB.prepare(`SELECT revision FROM slack_view_sessions WHERE id = ?`)
        .bind(input.sessionId)
        .first<{ revision: number }>();
      if (!session) unavailable();
      try {
        await deliverSearch(env, input, input.sessionId, session.revision);
      } catch (error) {
        if (!(input.initialLoading && error instanceof SlackApiError && error.code === "hash_conflict")) throw error;
        const current = await env.DB.prepare(`SELECT revision FROM slack_view_sessions WHERE id = ?`)
          .bind(input.sessionId)
          .first<{ revision: number }>();
        if (!current || current.revision !== 1)
          throw new Error("Initial Slack search update is still in progress.", { cause: error });
        await deliverSearch(env, input, input.sessionId, current.revision);
      }
      await env.DB.prepare(`UPDATE slack_interaction_receipts SET processed_at = ?, outcome = 'accepted', payload_json = NULL
        WHERE id = ? AND processed_at IS NULL`)
        .bind(Date.now(), receiptId)
        .run();
    } else if (HOME_ACTIONS.has(input.actionId)) {
      await deliverHomeAction(env, receiptId, input);
    } else if (ROOT_ACTIONS.has(input.actionId)) {
      await deliverRootAction(env, receiptId, input);
    } else if (UNFURL_ACTIONS.has(input.actionId)) {
      await deliverUnfurlAction(env, receiptId, input);
    } else unavailable();
  } catch (error) {
    const done = await env.DB.prepare(`SELECT processed_at FROM slack_interaction_receipts WHERE id = ?`)
      .bind(receiptId)
      .first<{ processed_at: number | null }>();
    if (done?.processed_at !== null && done?.processed_at !== undefined) return;
    if (error instanceof SlackApiError && slackInstallationError(error))
      await recordSlackInstallationError(env, input.installationId, error);
    if (!deniedError(error)) throw error;
    const connect = error instanceof HttpError && error.code === "slack_identity_required";
    const installed = await env.DB.prepare(`SELECT workspace_id FROM slack_installations WHERE id = ?`)
      .bind(input.installationId)
      .first<{ workspace_id: string }>();
    await env.DB.batch([
      env.DB.prepare(`UPDATE slack_interaction_receipts SET processed_at = ?, outcome = ?, payload_json = NULL
        WHERE id = ? AND processed_at IS NULL`).bind(
        Date.now(),
        error instanceof HttpError && error.code === "slack_action_expired" ? "expired" : "denied",
        receiptId,
      ),
      ...(installed && input.channelId && input.messageTs
        ? [
            queue(env, `outbox:slack-denial:${receiptId}`, installed.workspace_id, "slack_interaction_response", {
              receiptId,
              action: true,
              installationId: input.installationId,
              generation: input.generation,
              channelId: input.channelId,
              slackUserId: input.slackUserId,
              threadTs: input.messageTs,
              reason: connect ? "connect" : "unavailable",
            }),
          ]
        : []),
      ...(installed && HOME_ACTIONS.has(input.actionId)
        ? [
            queue(env, `outbox:slack-home:unavailable:${receiptId}`, installed.workspace_id, "slack_home_publish", {
              installationId: input.installationId,
              generation: input.generation,
              userId: input.slackUserId,
              reset: true,
            }),
          ]
        : []),
    ]);
  }
}

export async function deliverSlackShareResponse(env: Env, payload: Record<string, unknown>) {
  if (
    typeof payload.receiptId !== "string" ||
    typeof payload.installationId !== "string" ||
    typeof payload.generation !== "number" ||
    typeof payload.userId !== "string" ||
    typeof payload.channelId !== "string" ||
    typeof payload.messageTs !== "string" ||
    typeof payload.pageId !== "string" ||
    typeof payload.shareId !== "string"
  )
    return;
  let claimed = false;
  try {
    const installation = await installationFor(env, payload.installationId, payload.generation);
    const { member } = await verifiedMember(env, installation, payload.userId);
    if (member.role !== "owner") unavailable();
    await validateChannel(env, installation, payload.channelId);
    await requireChannelMember(env, installation, payload.channelId, payload.userId);
    const page = await pageForMember(env, member, payload.pageId);
    const mapping = await env.DB.prepare(
      `SELECT id FROM slack_channel_subscriptions WHERE installation_id = ? AND channel_id = ?
        AND space_id = ? AND (page_id IS NULL OR page_id = ?) AND validation_state = 'valid' LIMIT 1`,
    )
      .bind(installation.id, payload.channelId, page.space_id, page.id)
      .first();
    if (!mapping) unavailable();
    if (typeof payload.linkId === "string") {
      const link = await env.DB.prepare(
        `SELECT 1 FROM slack_thread_links WHERE id = ? AND installation_id = ? AND installation_generation = ?
          AND page_id = ? AND channel_id = ? AND root_message_ts = ? AND state = 'active'`,
      )
        .bind(payload.linkId, installation.id, installation.generation, page.id, payload.channelId, payload.messageTs)
        .first();
      if (!link) unavailable();
    } else if (typeof payload.referenceId === "string") {
      const reference = await env.DB.prepare(
        `SELECT 1 FROM slack_share_references WHERE id = ? AND installation_id = ? AND installation_generation = ?
          AND page_id = ? AND channel_id = ? AND message_ts = ? AND state <> 'retired'`,
      )
        .bind(
          payload.referenceId,
          installation.id,
          installation.generation,
          page.id,
          payload.channelId,
          payload.messageTs,
        )
        .first();
      if (!reference) unavailable();
    } else unavailable();
    const share = await getShare(env, member, payload.pageId, origin(env));
    if (!share || share.id !== payload.shareId) unavailable();
    // Token refresh happens before the attempt claim, so its failures remain safe to retry.
    await usableBotToken(env, installation);
    // A second consumer cannot repost an uncertain ephemeral send.
    const receipt = await env.DB.prepare(
      `UPDATE slack_interaction_receipts SET response_delivery_state = 'sending',
         response_delivery_attempted_at = ?, response_delivery_error = NULL WHERE id = ? AND outcome = 'accepted'
         AND denial_sent_at IS NULL AND (response_delivery_state IS NULL OR response_delivery_state = 'pending')`,
    )
      .bind(Date.now(), payload.receiptId)
      .run();
    if (!receipt.meta.changes) return;
    claimed = true;
    await slackApi(env, installation, "chat.postEphemeral", {
      channel: payload.channelId,
      user: payload.userId,
      text: `Public share: ${share.url}`,
    });
    await env.DB.prepare(
      `UPDATE slack_interaction_receipts SET response_delivery_state = 'sent', denial_sent_at = ?
        WHERE id = ? AND response_delivery_state = 'sending'`,
    )
      .bind(Date.now(), payload.receiptId)
      .run();
  } catch (error) {
    if (!claimed && error instanceof SlackApiError && slackInstallationError(error)) {
      await recordSlackInstallationError(env, payload.installationId, error);
      throw error;
    }
    if (error instanceof SlackRateLimitError) {
      await env.DB.prepare(
        `UPDATE slack_interaction_receipts SET response_delivery_state = 'pending' WHERE id = ? AND response_delivery_state = 'sending'`,
      )
        .bind(payload.receiptId)
        .run();
      throw error;
    }
    if (claimed || deniedError(error)) {
      await env.DB.prepare(
        `UPDATE slack_interaction_receipts SET response_delivery_state = 'blocked', response_delivery_error = ?
          WHERE id = ? AND (response_delivery_state = 'sending' OR response_delivery_state = 'pending')`,
      )
        .bind(
          error instanceof SlackApiError
            ? error.code
            : deniedError(error)
              ? "permission_unavailable"
              : "send_unconfirmed",
          payload.receiptId,
        )
        .run();
      return;
    }
    throw error;
  }
}
