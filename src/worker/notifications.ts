import type {
  Notification,
  NotificationChannelMode,
  NotificationEventType,
  NotificationPreference,
  Subscription,
  WatchState,
} from "../shared/types";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import { sendPersonalSlackNotification, SlackRateLimitError, slackChannelFanoutStatements } from "./slack";

export const NOTIFICATION_EVENT_TYPES = [
  "mention",
  "reply",
  "thread_resolved",
  "thread_reopened",
  "page_edit",
] as const satisfies readonly NotificationEventType[];

export type NotificationFanout = {
  workspaceId: string;
  spaceId: string;
  pageId: string;
  threadId: string | null;
  actorId: string;
  eventType: NotificationEventType;
  sourceId: string;
  recipientIds: string[];
  emitSlackChannel: boolean;
  data?: Record<string, unknown>;
  createdAt: number;
};

type NotificationRow = {
  id: string;
  event_type: NotificationEventType;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  space_id: string;
  space_name: string;
  page_id: string;
  page_title: string;
  page_icon: string | null;
  thread_id: string | null;
  data_json: string;
  read_at: number | null;
  archived_at: number | null;
  created_at: number;
};

type DeliveryRow = NotificationRow & {
  workspace_id: string;
  user_id: string;
  recipient_name: string;
  recipient_email: string;
  preference_in_app: number | null;
  preference_email: NotificationChannelMode | null;
  preference_slack: NotificationChannelMode | null;
  preference_timezone: string | null;
};

function uniqueIds(ids: string[]) {
  return [...new Set(ids.filter(Boolean))];
}

// Continuous editing compacts every ~30s; edits by the same actor on the same page within this window,
// or while the previous edit notification is still unread, collapse into one notification.
const PAGE_EDIT_COALESCE_MS = 60 * 60 * 1000;
// A pending delivery claim older than this belongs to a consumer that died mid-send and may be reclaimed.
const DELIVERY_CLAIM_STALE_MS = 60_000;

export class DeliveryInProgressError extends Error {
  readonly retryAfter = Math.ceil(DELIVERY_CLAIM_STALE_MS / 1000);
  constructor() {
    super("Delivery is already in progress.");
  }
}

export function notificationFanoutStatements(database: D1Database, fanout: NotificationFanout) {
  const recipients = uniqueIds(fanout.recipientIds);
  const coalesceAfter = fanout.eventType === "page_edit" ? fanout.createdAt - PAGE_EDIT_COALESCE_MS : null;
  const prefix = `${fanout.eventType}:${fanout.sourceId}`;
  const idPrefix = `${prefix}:`;
  const recipientJson = JSON.stringify(recipients);
  const dataJson = JSON.stringify(fanout.data ?? {});
  return [
    database
      .prepare(
        `INSERT OR IGNORE INTO notifications
          (id, workspace_id, user_id, event_type, actor_id, space_id, page_id, thread_id,
           data_json, dedupe_key, created_at)
         SELECT ? || ':' || recipient.value,
                ?, recipient.value, ?, ?, ?, ?, ?, ?, ? || ':' || recipient.value, ?
           FROM json_each(?) recipient
           JOIN workspace_members wm ON wm.workspace_id = ? AND wm.user_id = recipient.value
           JOIN pages p ON p.id = ? AND p.workspace_id = wm.workspace_id
           JOIN spaces s ON s.id = p.space_id
           LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = recipient.value
          WHERE recipient.value <> ? AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template = 0
            AND (wm.role = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
            AND NOT EXISTS (
              SELECT 1 FROM notifications recent
               WHERE ? IS NOT NULL AND recent.user_id = recipient.value AND recent.page_id = ?
                 AND recent.event_type = ? AND recent.actor_id = ?
                 AND ((recent.read_at IS NULL AND recent.archived_at IS NULL) OR recent.created_at > ?))`,
      )
      .bind(
        prefix,
        fanout.workspaceId,
        fanout.eventType,
        fanout.actorId,
        fanout.spaceId,
        fanout.pageId,
        fanout.threadId,
        dataJson,
        prefix,
        fanout.createdAt,
        recipientJson,
        fanout.workspaceId,
        fanout.pageId,
        fanout.actorId,
        coalesceAfter,
        fanout.pageId,
        fanout.eventType,
        fanout.actorId,
        coalesceAfter ?? 0,
      ),
    database
      .prepare(
        `INSERT OR IGNORE INTO outbox
          (id, workspace_id, topic, payload_json, available_at, created_at)
         SELECT 'outbox:' || id, workspace_id, 'notification', json_object('notificationId', id), ?, ?
           FROM notifications
          WHERE id >= ? AND id < ?`,
      )
      .bind(fanout.createdAt, fanout.createdAt, idPrefix, `${prefix};`),
    ...(fanout.emitSlackChannel ? slackChannelFanoutStatements(database, { ...fanout, coalesceAfter }) : []),
  ];
}

function data(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function notificationJson(row: NotificationRow): Notification {
  return {
    id: row.id,
    eventType: row.event_type,
    actor: row.actor_id
      ? { id: row.actor_id, name: row.actor_name ?? "Former collaborator", email: row.actor_email ?? "" }
      : null,
    space: { id: row.space_id, name: row.space_name },
    page: { id: row.page_id, title: row.page_title, icon: row.page_icon },
    threadId: row.thread_id,
    data: data(row.data_json),
    readAt: row.read_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  };
}

const ACCESSIBLE_NOTIFICATION_SQL = `
  FROM notifications n
  JOIN workspace_members wm ON wm.workspace_id = n.workspace_id AND wm.user_id = n.user_id
  JOIN user recipient ON recipient.id = n.user_id
  JOIN pages p ON p.id = n.page_id AND p.workspace_id = n.workspace_id
  JOIN spaces s ON s.id = p.space_id
  LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = n.user_id
  LEFT JOIN user actor ON actor.id = n.actor_id
  LEFT JOIN notification_preferences preference
    ON preference.user_id = n.user_id AND preference.event_type = n.event_type
 WHERE n.user_id = ? AND n.workspace_id = ? AND p.archived_at IS NULL AND p.import_job_id IS NULL
   AND p.is_template = 0
   AND (wm.role = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)`;

const NOTIFICATION_COLUMNS = `
  n.id, n.event_type, n.actor_id, actor.name actor_name, actor.email actor_email,
  s.id space_id, s.name space_name, p.id page_id, p.title page_title, p.icon page_icon,
  n.thread_id, n.data_json, n.read_at, n.archived_at, n.created_at`;

export async function listNotifications(
  env: Env,
  member: MemberContext,
  options: { unreadOnly: boolean; limit: number; offset: number },
) {
  const visibility = `AND n.archived_at IS NULL AND COALESCE(preference.in_app, 1) = 1${
    options.unreadOnly ? " AND n.read_at IS NULL" : ""
  }`;
  const rows = await env.DB.prepare(
    `SELECT ${NOTIFICATION_COLUMNS} ${ACCESSIBLE_NOTIFICATION_SQL} ${visibility}
      ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`,
  )
    .bind(member.user.id, member.workspace.id, options.limit + 1, options.offset)
    .all<NotificationRow>();
  const unread = await env.DB.prepare(
    `SELECT COUNT(*) count ${ACCESSIBLE_NOTIFICATION_SQL}
      AND n.archived_at IS NULL AND n.read_at IS NULL AND COALESCE(preference.in_app, 1) = 1`,
  )
    .bind(member.user.id, member.workspace.id)
    .first<{ count: number }>();
  return {
    notifications: rows.results.slice(0, options.limit).map(notificationJson),
    unreadCount: unread?.count ?? 0,
    hasMore: rows.results.length > options.limit,
  };
}

export async function markNotifications(
  env: Env,
  member: MemberContext,
  action: "read" | "archive",
  ids: string[] | null,
) {
  const timestamp = Date.now();
  const column = action === "read" ? "read_at" : "archived_at";
  const access = `AND EXISTS (
    SELECT 1 FROM pages p
    JOIN spaces s ON s.id = p.space_id AND s.workspace_id = p.workspace_id
    LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
    WHERE p.id = notifications.page_id AND p.workspace_id = notifications.workspace_id
      AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template = 0
      AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
  )`;
  // An explicit selection, even an empty one, never widens into the mark-all branch.
  if (ids !== null) {
    await env.DB.prepare(
      `UPDATE notifications SET ${column} = COALESCE(${column}, ?)
        WHERE user_id = ? AND workspace_id = ? AND id IN (SELECT value FROM json_each(?)) ${access}`,
    )
      .bind(timestamp, member.user.id, member.workspace.id, JSON.stringify(uniqueIds(ids)), member.user.id, member.role)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE notifications SET ${column} = COALESCE(${column}, ?)
        WHERE user_id = ? AND workspace_id = ? AND archived_at IS NULL ${access}`,
    )
      .bind(timestamp, member.user.id, member.workspace.id, member.user.id, member.role)
      .run();
  }
}

function defaultPreference(eventType: NotificationEventType, timezone: string): NotificationPreference {
  return {
    eventType,
    inApp: true,
    email: eventType === "page_edit" ? "digest" : "immediate",
    slack: "off",
    timezone,
  };
}

export async function notificationPreferences(env: Env, member: MemberContext) {
  const rows = await env.DB.prepare(
    `SELECT event_type, in_app, email, slack, timezone FROM notification_preferences WHERE user_id = ?`,
  )
    .bind(member.user.id)
    .all<{
      event_type: NotificationEventType;
      in_app: number;
      email: NotificationChannelMode;
      slack: NotificationChannelMode;
      timezone: string;
    }>();
  const byEvent = new Map(rows.results.map((row) => [row.event_type, row]));
  const browserTimezone = rows.results[0]?.timezone ?? "UTC";
  return NOTIFICATION_EVENT_TYPES.map((eventType) => {
    const row = byEvent.get(eventType);
    return row
      ? { eventType, inApp: Boolean(row.in_app), email: row.email, slack: row.slack, timezone: row.timezone }
      : defaultPreference(eventType, browserTimezone);
  });
}

export async function notificationPreferencesConfigured(env: Env, member: MemberContext) {
  return Boolean(
    await env.DB.prepare(`SELECT 1 FROM notification_preferences WHERE user_id = ? LIMIT 1`)
      .bind(member.user.id)
      .first(),
  );
}

function validTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export async function setNotificationPreference(env: Env, member: MemberContext, value: NotificationPreference) {
  if (!NOTIFICATION_EVENT_TYPES.includes(value.eventType)) {
    throw new HttpError(422, "invalid_notification_event", "That notification event is not supported.");
  }
  if (!["off", "immediate", "digest"].includes(value.email) || !["off", "immediate", "digest"].includes(value.slack)) {
    throw new HttpError(422, "invalid_notification_channel", "That notification delivery mode is not supported.");
  }
  if (!value.timezone || value.timezone.length > 100 || !validTimezone(value.timezone)) {
    throw new HttpError(422, "invalid_timezone", "Choose a valid IANA timezone.");
  }
  await env.DB.prepare(
    `INSERT INTO notification_preferences (user_id, event_type, in_app, email, slack, timezone)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, event_type) DO UPDATE SET
       in_app = excluded.in_app, email = excluded.email, slack = excluded.slack, timezone = excluded.timezone`,
  )
    .bind(member.user.id, value.eventType, value.inApp ? 1 : 0, value.email, value.slack, value.timezone)
    .run();
}

export async function setSubscription(
  env: Env,
  member: MemberContext,
  resourceType: "page" | "space",
  resourceId: string,
  state: WatchState["state"],
) {
  if (!(["watching", "muted", "none"] as const).includes(state)) {
    throw new HttpError(422, "invalid_watch_state", "Choose watching, muted, or none.");
  }
  if (state === "none") {
    await env.DB.prepare(`DELETE FROM subscriptions WHERE user_id = ? AND resource_type = ? AND resource_id = ?`)
      .bind(member.user.id, resourceType, resourceId)
      .run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO subscriptions
      (id, workspace_id, user_id, resource_type, resource_id, created_by, muted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, resource_type, resource_id) DO UPDATE SET muted_at = excluded.muted_at`,
  )
    .bind(
      `${resourceType}:${resourceId}:${member.user.id}`,
      member.workspace.id,
      member.user.id,
      resourceType,
      resourceId,
      member.user.id,
      state === "muted" ? Date.now() : null,
      Date.now(),
    )
    .run();
}

export async function pageWatchState(env: Env, member: MemberContext, pageId: string, spaceId: string) {
  const rows = await env.DB.prepare(
    `SELECT resource_type, muted_at FROM subscriptions
      WHERE user_id = ? AND ((resource_type = 'page' AND resource_id = ?)
        OR (resource_type = 'space' AND resource_id = ?))
      ORDER BY CASE resource_type WHEN 'page' THEN 0 ELSE 1 END`,
  )
    .bind(member.user.id, pageId, spaceId)
    .all<{ resource_type: "page" | "space"; muted_at: number | null }>();
  const row = rows.results[0];
  return {
    state: row ? (row.muted_at ? "muted" : "watching") : "none",
    source: row?.resource_type ?? null,
  } satisfies WatchState;
}

export async function spaceWatchState(env: Env, member: MemberContext, spaceId: string) {
  const row = await env.DB.prepare(
    `SELECT muted_at FROM subscriptions WHERE user_id = ? AND resource_type = 'space' AND resource_id = ?`,
  )
    .bind(member.user.id, spaceId)
    .first<{ muted_at: number | null }>();
  return {
    state: row ? (row.muted_at ? "muted" : "watching") : "none",
    source: row ? "space" : null,
  } satisfies WatchState;
}

export async function listSubscriptions(env: Env, member: MemberContext) {
  const rows = await env.DB.prepare(
    `SELECT subscription.id, subscription.resource_type, subscription.resource_id,
            subscription.muted_at, subscription.created_at
       FROM subscriptions subscription
       LEFT JOIN pages p
         ON subscription.resource_type = 'page' AND p.id = subscription.resource_id
       JOIN spaces s
         ON s.id = CASE WHEN subscription.resource_type = 'page' THEN p.space_id ELSE subscription.resource_id END
       LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = subscription.user_id
      WHERE subscription.user_id = ? AND subscription.workspace_id = ? AND s.workspace_id = ?
        AND (subscription.resource_type = 'space'
          OR (p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template = 0))
        AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
      ORDER BY subscription.created_at DESC, subscription.id`,
  )
    .bind(member.user.id, member.workspace.id, member.workspace.id, member.role)
    .all<{
      id: string;
      resource_type: "page" | "space";
      resource_id: string;
      muted_at: number | null;
      created_at: number;
    }>();
  return rows.results.map((row): Subscription => ({
    id: row.id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    state: row.muted_at ? "muted" : "watching",
    createdAt: row.created_at,
  }));
}

function emailMode(row: DeliveryRow) {
  return row.preference_email ?? (row.event_type === "page_edit" ? "digest" : "immediate");
}

function slackMode(row: DeliveryRow) {
  return row.preference_slack ?? "off";
}

async function notificationForDelivery(env: Env, notificationId: string) {
  const locator = await env.DB.prepare(`SELECT user_id, workspace_id FROM notifications WHERE id = ?`)
    .bind(notificationId)
    .first<{ user_id: string; workspace_id: string }>();
  if (!locator) return null;
  return env.DB.prepare(
    `SELECT ${NOTIFICATION_COLUMNS}, n.workspace_id, n.user_id,
            recipient.name recipient_name, recipient.email recipient_email,
            preference.in_app preference_in_app, preference.email preference_email, preference.slack preference_slack,
            preference.timezone preference_timezone
       ${ACCESSIBLE_NOTIFICATION_SQL} AND n.id = ?`,
  )
    .bind(locator.user_id, locator.workspace_id, notificationId)
    .first<DeliveryRow>();
}

async function recordDelivery(
  env: Env,
  outboxId: string,
  channel: "in_app" | "email" | "slack",
  status: "sent" | "failed",
  error: string | null = null,
) {
  const timestamp = Date.now();
  await env.DB.prepare(
    `INSERT INTO deliveries
      (idempotency_key, outbox_id, channel, status, attempts, last_error, delivered_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO UPDATE SET
       status = excluded.status, attempts = deliveries.attempts + 1, last_error = excluded.last_error,
       delivered_at = COALESCE(deliveries.delivered_at, excluded.delivered_at), updated_at = excluded.updated_at`,
  )
    .bind(`${outboxId}:${channel}`, outboxId, channel, status, error, status === "sent" ? timestamp : null, timestamp)
    .run();
}

async function claimDelivery(env: Env, outboxId: string, channel: "email" | "slack") {
  const key = `${outboxId}:${channel}`;
  const timestamp = Date.now();
  const token = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO deliveries
      (idempotency_key, outbox_id, channel, status, attempts, updated_at, claim_token)
     VALUES (?, ?, ?, 'pending', 1, ?, ?)`,
  )
    .bind(key, outboxId, channel, timestamp, token)
    .run();
  if (inserted.meta.changes) return { state: "claimed" as const, token };
  // A failed attempt is retried; a pending claim whose consumer died mid-send is reclaimed once stale.
  const retry = await env.DB.prepare(
    `UPDATE deliveries SET status = 'pending', attempts = attempts + 1, last_error = NULL,
       updated_at = ?, claim_token = ?
      WHERE idempotency_key = ? AND (status = 'failed' OR (status = 'pending' AND updated_at <= ?))`,
  )
    .bind(timestamp, token, key, timestamp - DELIVERY_CLAIM_STALE_MS)
    .run();
  if (retry.meta.changes) return { state: "claimed" as const, token };
  const current = await env.DB.prepare(`SELECT status FROM deliveries WHERE idempotency_key = ?`)
    .bind(key)
    .first<{ status: "pending" | "sent" | "failed" }>();
  return { state: current?.status === "pending" ? ("in_progress" as const) : ("settled" as const) };
}

async function finishClaimedDelivery(
  env: Env,
  outboxId: string,
  channel: "email" | "slack",
  token: string,
  status: "sent" | "failed",
  error: string | null = null,
) {
  const timestamp = Date.now();
  return env.DB.prepare(
    `UPDATE deliveries SET status = ?, last_error = ?, delivered_at = ?, updated_at = ?
      WHERE idempotency_key = ? AND status = 'pending' AND claim_token = ?`,
  )
    .bind(status, error, status === "sent" ? timestamp : null, timestamp, `${outboxId}:${channel}`, token)
    .run();
}

async function claimDeliveries(env: Env, outboxIds: readonly string[], channel: "email" | "slack") {
  if (!outboxIds.length) return { token: "", outboxIds: [] as string[] };
  const ids = JSON.stringify(uniqueIds([...outboxIds]));
  const timestamp = Date.now();
  const token = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO deliveries
      (idempotency_key, outbox_id, channel, status, attempts, updated_at, claim_token)
     SELECT value || ':' || ?, value, ?, 'pending', 1, ?, ? FROM json_each(?)`,
  )
    .bind(channel, channel, timestamp, token, ids)
    .run();
  await env.DB.prepare(
    `UPDATE deliveries SET status = 'pending', attempts = attempts + 1, last_error = NULL,
       updated_at = ?, claim_token = ?
      WHERE outbox_id IN (SELECT value FROM json_each(?)) AND channel = ?
        AND (status = 'failed' OR (status = 'pending' AND updated_at <= ?))`,
  )
    .bind(timestamp, token, ids, channel, timestamp - DELIVERY_CLAIM_STALE_MS)
    .run();
  const claimed = await env.DB.prepare(
    `SELECT outbox_id FROM deliveries
      WHERE outbox_id IN (SELECT value FROM json_each(?)) AND channel = ?
        AND status = 'pending' AND claim_token = ?`,
  )
    .bind(ids, channel, token)
    .all<{ outbox_id: string }>();
  return { token, outboxIds: claimed.results.map((row) => row.outbox_id) };
}

async function finishClaimedDeliveries(
  env: Env,
  outboxIds: readonly string[],
  channel: "email" | "slack",
  token: string,
  status: "sent" | "failed",
  error: string | null = null,
) {
  if (!outboxIds.length) return [] as string[];
  const timestamp = Date.now();
  const finished = await env.DB.prepare(
    `UPDATE deliveries SET status = ?, last_error = ?, delivered_at = ?, updated_at = ?
      WHERE outbox_id IN (SELECT value FROM json_each(?)) AND channel = ?
        AND status = 'pending' AND claim_token = ?
      RETURNING outbox_id`,
  )
    .bind(
      status,
      error,
      status === "sent" ? timestamp : null,
      timestamp,
      JSON.stringify([...outboxIds]),
      channel,
      token,
    )
    .all<{ outbox_id: string }>();
  return finished.results.map((row) => row.outbox_id);
}

async function accessibleNotifications(
  env: Env,
  userId: string,
  workspaceId: string,
  notificationIds: readonly string[],
) {
  if (!notificationIds.length) return { rows: [] as DeliveryRow[], suppressed: [] as string[] };
  const rows = await env.DB.prepare(
    `SELECT ${NOTIFICATION_COLUMNS}, n.workspace_id, n.user_id,
            recipient.name recipient_name, recipient.email recipient_email,
            preference.in_app preference_in_app, preference.email preference_email, preference.slack preference_slack,
            preference.timezone preference_timezone
       ${ACCESSIBLE_NOTIFICATION_SQL} AND n.id IN (SELECT value FROM json_each(?))`,
  )
    .bind(userId, workspaceId, JSON.stringify([...notificationIds]))
    .all<DeliveryRow>();
  const accessible = new Set(rows.results.map((row) => row.id));
  return { rows: rows.results, suppressed: notificationIds.filter((id) => !accessible.has(id)) };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const escaped: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return escaped[character]!;
  });
}

function notificationCopy(row: DeliveryRow) {
  const actor = row.actor_name ?? "A collaborator";
  if (row.event_type === "mention") return `${actor} mentioned you on ${row.page_title}`;
  if (row.event_type === "reply") return `${actor} replied on ${row.page_title}`;
  if (row.event_type === "thread_resolved") return `${actor} resolved a thread on ${row.page_title}`;
  if (row.event_type === "thread_reopened") return `${actor} reopened a thread on ${row.page_title}`;
  return `${actor} edited ${row.page_title}`;
}

async function sendNotificationEmail(env: Env, row: DeliveryRow, subject: string, text: string) {
  if (!env.SEND_EMAIL || !env.EMAIL_FROM) return false;
  const href = `${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(row.page_id)}`;
  await env.SEND_EMAIL.send({
    from: env.EMAIL_FROM,
    to: row.recipient_email,
    subject,
    text: `${text}\n\nOpen ${row.page_title}: ${href}`,
    html: `<p>${escapeHtml(text)}</p><p><a href="${escapeHtml(href)}">Open ${escapeHtml(row.page_title)}</a></p>`,
  });
  return true;
}

export async function deliverNotification(env: Env, notificationId: string, outboxId = `outbox:${notificationId}`) {
  const row = await notificationForDelivery(env, notificationId);
  if (!row) {
    await recordDelivery(env, outboxId, "in_app", "failed", "access_revoked");
    return;
  }
  await recordDelivery(
    env,
    outboxId,
    "in_app",
    row.preference_in_app === 0 ? "failed" : "sent",
    row.preference_in_app === 0 ? "disabled" : null,
  );
  const copy = notificationCopy(row);
  let deferred = false;
  const emailClaim =
    emailMode(row) === "immediate" ? await claimDelivery(env, outboxId, "email") : { state: "settled" as const };
  if (emailClaim.state === "in_progress") deferred = true;
  if (emailClaim.state === "claimed") {
    try {
      if (!(await sendNotificationEmail(env, row, copy, copy))) {
        await finishClaimedDelivery(env, outboxId, "email", emailClaim.token, "failed", "unavailable");
      } else {
        const finished = await finishClaimedDelivery(env, outboxId, "email", emailClaim.token, "sent");
        if (finished.meta.changes) {
          await env.DB.prepare(`UPDATE notifications SET emailed_at = COALESCE(emailed_at, ?) WHERE id = ?`)
            .bind(Date.now(), notificationId)
            .run();
        }
      }
    } catch (error) {
      await finishClaimedDelivery(
        env,
        outboxId,
        "email",
        emailClaim.token,
        "failed",
        error instanceof Error ? error.message.slice(0, 500) : "Email delivery failed.",
      );
      throw error;
    }
  }
  const slackClaim =
    slackMode(row) === "immediate" ? await claimDelivery(env, outboxId, "slack") : { state: "settled" as const };
  if (slackClaim.state === "in_progress") deferred = true;
  if (slackClaim.state === "claimed") {
    try {
      if (!(await sendPersonalSlackNotification(env, row.user_id, row.workspace_id, copy, row.page_id))) {
        await finishClaimedDelivery(env, outboxId, "slack", slackClaim.token, "failed", "unavailable");
      } else {
        const finished = await finishClaimedDelivery(env, outboxId, "slack", slackClaim.token, "sent");
        if (finished.meta.changes) {
          await env.DB.prepare(`UPDATE notifications SET slack_at = COALESCE(slack_at, ?) WHERE id = ?`)
            .bind(Date.now(), notificationId)
            .run();
        }
      }
    } catch (error) {
      await finishClaimedDelivery(
        env,
        outboxId,
        "slack",
        slackClaim.token,
        "failed",
        error instanceof Error ? error.message.slice(0, 500) : "Slack delivery failed.",
      );
      throw error;
    }
  }
  // Another consumer holds a live claim; let the queue redeliver once it settles or goes stale.
  if (deferred) throw new DeliveryInProgressError();
}

// A worst-case Slack candidate uses eleven D1 statements: ids, access,
// suppression, three claim statements, installation lookup, token-refresh CAS
// and reread, finalization, and the notification timestamp. Reserve five more
// per channel for timezone/cursor paging and cap both channels together at 240,
// leaving most of the paid invocation budget to the other cron tasks running
// beside this one. The persisted cursor carries the remainder to later ticks.
const DIGEST_STATEMENT_BUDGET = 240;
const DIGEST_CHANNEL_COUNT = 2;
const DIGEST_CHANNEL_OVERHEAD = 5;
const DIGEST_STATEMENTS_PER_CANDIDATE = 11;
const DIGEST_CANDIDATE_MAX = Math.floor(
  (DIGEST_STATEMENT_BUDGET - DIGEST_CHANNEL_COUNT * DIGEST_CHANNEL_OVERHEAD) /
    (DIGEST_CHANNEL_COUNT * DIGEST_STATEMENTS_PER_CANDIDATE),
);
const DIGEST_CANDIDATE_PAGE = DIGEST_CANDIDATE_MAX;

// Timezone is part of the key: preferences are per event type, so one user can hold
// two timezones and appear as two groups that a coarser cursor would skip past.
type DigestCursor = { userId: string; workspaceId: string; timezone: string };

function digestWindow(timezone: string, timestamp: number) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(timestamp);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const hour = Number(values.hour);
    if (hour < 9) return null;
    const elapsed =
      ((hour - 9) * 60 * 60 + Number(values.minute) * 60 + Number(values.second)) * 1000 + (timestamp % 1000);
    return { timezone, cutoff: timestamp - elapsed };
  } catch {
    return null;
  }
}

type DigestChannel = "email" | "slack";

function digestModeSql(channel: DigestChannel) {
  return channel === "email"
    ? `COALESCE(preference.email, CASE WHEN n.event_type = 'page_edit' THEN 'digest' ELSE 'immediate' END) = 'digest'`
    : `COALESCE(preference.slack, 'off') = 'digest'`;
}

async function dueDigestTimezones(env: Env, channel: DigestChannel, timestamp: number) {
  const deliveredColumn = channel === "email" ? "emailed_at" : "slack_at";
  const rows = await env.DB.prepare(
    `SELECT COALESCE(preference.timezone, 'UTC') timezone,
            COALESCE(cursor.updated_at, 0) cursor_updated_at
       FROM notifications n
       LEFT JOIN notification_preferences preference
         ON preference.user_id = n.user_id AND preference.event_type = n.event_type
       LEFT JOIN digest_delivery_cursors cursor
         ON cursor.channel = ? AND cursor.timezone = COALESCE(preference.timezone, 'UTC')
      WHERE n.${deliveredColumn} IS NULL AND ${digestModeSql(channel)}
      GROUP BY COALESCE(preference.timezone, 'UTC'), COALESCE(cursor.updated_at, 0)
      ORDER BY 2, 1`,
  )
    .bind(channel)
    .all<{ timezone: string; cursor_updated_at: number }>();
  return rows.results
    .map((row) => digestWindow(row.timezone, timestamp))
    .filter((window): window is { timezone: string; cutoff: number } => Boolean(window));
}

function digestCursor(row: { user_id: string; workspace_id: string; timezone: string }): DigestCursor {
  return { userId: row.user_id, workspaceId: row.workspace_id, timezone: row.timezone };
}

function digestCursorKey(cursor: DigestCursor) {
  return `${cursor.userId}\u0000${cursor.workspaceId}\u0000${cursor.timezone}`;
}

async function digestCandidates<T extends { user_id: string; workspace_id: string; timezone: string }>(
  env: Env,
  channel: DigestChannel,
  timezone: string,
  limit: number,
  read: (cursor: DigestCursor, pageSize: number) => Promise<{ results: T[] }>,
) {
  const stored = await env.DB.prepare(
    `SELECT user_id, workspace_id, timezone FROM digest_delivery_cursors WHERE channel = ? AND timezone = ?`,
  )
    .bind(channel, timezone)
    .first<{ user_id: string; workspace_id: string; timezone: string }>();
  let cursor = stored ? digestCursor(stored) : { userId: "", workspaceId: "", timezone };
  let wrapped = !stored;
  const candidates: T[] = [];
  const seen = new Set<string>();
  while (candidates.length < limit) {
    const pageSize = Math.min(DIGEST_CANDIDATE_PAGE, limit - candidates.length);
    const page = await read(cursor, pageSize);
    if (!page.results.length) {
      if (wrapped) break;
      cursor = { userId: "", workspaceId: "", timezone };
      wrapped = true;
      continue;
    }
    for (const row of page.results) {
      const next = digestCursor(row);
      const key = digestCursorKey(next);
      cursor = next;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(row);
      if (candidates.length >= limit) break;
    }
    if (candidates.length >= limit) break;
    if (page.results.length < pageSize) {
      if (wrapped) break;
      cursor = { userId: "", workspaceId: "", timezone };
      wrapped = true;
    }
  }
  if (candidates.length) {
    const last = digestCursor(candidates.at(-1)!);
    await env.DB.prepare(
      `INSERT INTO digest_delivery_cursors (channel, user_id, workspace_id, timezone, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel, timezone) DO UPDATE SET user_id = excluded.user_id,
         workspace_id = excluded.workspace_id, updated_at = excluded.updated_at`,
    )
      .bind(channel, last.userId, last.workspaceId, last.timezone, Date.now())
      .run();
  } else {
    await env.DB.prepare(`DELETE FROM digest_delivery_cursors WHERE channel = ? AND timezone = ?`)
      .bind(channel, timezone)
      .run();
  }
  return candidates;
}

async function sendDueEmailDigests(env: Env, timestamp: number) {
  if (!env.SEND_EMAIL || !env.EMAIL_FROM) return;
  const dueTimezones = await dueDigestTimezones(env, "email", timestamp);
  if (!dueTimezones.length) return;
  let remaining = DIGEST_CANDIDATE_MAX;
  for (const window of dueTimezones) {
    if (!remaining) break;
    const readCandidates = (cursor: DigestCursor, pageSize: number) =>
      env.DB.prepare(
        `SELECT n.user_id, n.workspace_id, recipient.name, recipient.email,
              COALESCE(preference.timezone, 'UTC') timezone
         FROM notifications n
         JOIN user recipient ON recipient.id = n.user_id
         LEFT JOIN notification_preferences preference
           ON preference.user_id = n.user_id AND preference.event_type = n.event_type
        WHERE n.emailed_at IS NULL AND ${digestModeSql("email")}
          AND COALESCE(preference.timezone, 'UTC') = ? AND n.created_at < ?
          AND (n.user_id > ? OR (n.user_id = ? AND n.workspace_id > ?))
        GROUP BY n.user_id, n.workspace_id, recipient.name, recipient.email, timezone
        ORDER BY n.user_id, n.workspace_id
        LIMIT ?`,
      )
        .bind(window.timezone, window.cutoff, cursor.userId, cursor.userId, cursor.workspaceId, pageSize)
        .all<{ user_id: string; workspace_id: string; name: string; email: string; timezone: string }>();
    const candidates = await digestCandidates(env, "email", window.timezone, remaining, readCandidates);
    remaining -= candidates.length;
    for (const candidate of candidates) {
      const ids = await env.DB.prepare(
        `SELECT n.id FROM notifications n
        LEFT JOIN notification_preferences preference
          ON preference.user_id = n.user_id AND preference.event_type = n.event_type
        WHERE n.user_id = ? AND n.workspace_id = ? AND n.emailed_at IS NULL
          AND ${digestModeSql("email")} AND COALESCE(preference.timezone, 'UTC') = ? AND n.created_at < ?
        ORDER BY n.created_at, n.id LIMIT 40`,
      )
        .bind(candidate.user_id, candidate.workspace_id, candidate.timezone, window.cutoff)
        .all<{ id: string }>();
      const { rows, suppressed } = await accessibleNotifications(
        env,
        candidate.user_id,
        candidate.workspace_id,
        ids.results.map((row) => row.id),
      );
      if (suppressed.length) {
        await env.DB.prepare(`UPDATE notifications SET emailed_at = ? WHERE id IN (SELECT value FROM json_each(?))`)
          .bind(timestamp, JSON.stringify(suppressed))
          .run();
      }
      const claim = await claimDeliveries(
        env,
        rows.map((row) => `outbox:${row.id}`),
        "email",
      );
      const claimedIds = new Set(claim.outboxIds);
      const claimed = rows.filter((row) => claimedIds.has(`outbox:${row.id}`));
      if (!claimed.length) continue;
      const lines = claimed.map((row) => `• ${notificationCopy(row)}`);
      try {
        await env.SEND_EMAIL.send({
          from: env.EMAIL_FROM,
          to: candidate.email,
          subject: `${claimed.length} Notes update${claimed.length === 1 ? "" : "s"}`,
          text: `Your daily Notes digest:\n\n${lines.join("\n")}`,
          html: `<p>Your daily Notes digest:</p><ul>${claimed
            .map((row) => `<li>${escapeHtml(notificationCopy(row))}</li>`)
            .join("")}</ul>`,
        });
        const finished = await finishClaimedDeliveries(env, claim.outboxIds, "email", claim.token, "sent");
        const deliveredIds = finished.map((outboxId) => outboxId.slice("outbox:".length));
        if (deliveredIds.length) {
          await env.DB.prepare(`UPDATE notifications SET emailed_at = ? WHERE id IN (SELECT value FROM json_each(?))`)
            .bind(Date.now(), JSON.stringify(deliveredIds))
            .run();
        }
      } catch (error) {
        await finishClaimedDeliveries(
          env,
          claim.outboxIds,
          "email",
          claim.token,
          "failed",
          error instanceof Error ? error.message.slice(0, 500) : "Digest delivery failed.",
        );
        console.error("Notification digest email failed", { userId: candidate.user_id, error });
      }
    }
  }
}

async function sendDuePersonalSlackDigests(env: Env, timestamp: number) {
  const dueTimezones = await dueDigestTimezones(env, "slack", timestamp);
  if (!dueTimezones.length) return;
  let remaining = DIGEST_CANDIDATE_MAX;
  const rateLimitedWorkspaces = new Set<string>();
  for (const window of dueTimezones) {
    if (!remaining) break;
    const readCandidates = (cursor: DigestCursor, pageSize: number) =>
      env.DB.prepare(
        `SELECT n.user_id, n.workspace_id, COALESCE(preference.timezone, 'UTC') timezone
         FROM notifications n
         JOIN slack_installations installation
           ON installation.workspace_id = n.workspace_id AND installation.disconnected_at IS NULL
         JOIN slack_user_links link
           ON link.installation_id = installation.id AND link.user_id = n.user_id
         LEFT JOIN notification_preferences preference
           ON preference.user_id = n.user_id AND preference.event_type = n.event_type
        WHERE n.slack_at IS NULL AND ${digestModeSql("slack")}
          AND COALESCE(preference.timezone, 'UTC') = ? AND n.created_at < ?
          AND (n.user_id > ? OR (n.user_id = ? AND n.workspace_id > ?))
        GROUP BY n.user_id, n.workspace_id, timezone
        ORDER BY n.user_id, n.workspace_id
        LIMIT ?`,
      )
        .bind(window.timezone, window.cutoff, cursor.userId, cursor.userId, cursor.workspaceId, pageSize)
        .all<{ user_id: string; workspace_id: string; timezone: string }>();
    const candidates = await digestCandidates(env, "slack", window.timezone, remaining, readCandidates);
    remaining -= candidates.length;
    for (const candidate of candidates) {
      if (rateLimitedWorkspaces.has(candidate.workspace_id)) continue;
      const ids = await env.DB.prepare(
        `SELECT n.id FROM notifications n
        LEFT JOIN notification_preferences preference
          ON preference.user_id = n.user_id AND preference.event_type = n.event_type
        WHERE n.user_id = ? AND n.workspace_id = ? AND n.slack_at IS NULL
          AND ${digestModeSql("slack")} AND COALESCE(preference.timezone, 'UTC') = ? AND n.created_at < ?
        ORDER BY n.created_at, n.id LIMIT 40`,
      )
        .bind(candidate.user_id, candidate.workspace_id, candidate.timezone, window.cutoff)
        .all<{ id: string }>();
      const { rows, suppressed } = await accessibleNotifications(
        env,
        candidate.user_id,
        candidate.workspace_id,
        ids.results.map((row) => row.id),
      );
      if (suppressed.length) {
        await env.DB.prepare(`UPDATE notifications SET slack_at = ? WHERE id IN (SELECT value FROM json_each(?))`)
          .bind(timestamp, JSON.stringify(suppressed))
          .run();
      }
      if (!rows.length) continue;
      const claim = await claimDeliveries(
        env,
        rows.map((row) => `outbox:${row.id}`),
        "slack",
      );
      const claimedIds = new Set(claim.outboxIds);
      const claimed = rows.filter((row) => claimedIds.has(`outbox:${row.id}`));
      if (!claimed.length) continue;
      try {
        const sent = await sendPersonalSlackNotification(
          env,
          candidate.user_id,
          candidate.workspace_id,
          `Your daily Notes digest:\n${claimed.map((row) => `• ${notificationCopy(row)}`).join("\n")}`,
          claimed[0]!.page_id,
        );
        const finished = await finishClaimedDeliveries(
          env,
          claim.outboxIds,
          "slack",
          claim.token,
          sent ? "sent" : "failed",
          sent ? null : "unavailable",
        );
        if (sent) {
          await env.DB.prepare(`UPDATE notifications SET slack_at = ? WHERE id IN (SELECT value FROM json_each(?))`)
            .bind(Date.now(), JSON.stringify(finished.map((outboxId) => outboxId.slice("outbox:".length))))
            .run();
        }
      } catch (error) {
        await finishClaimedDeliveries(
          env,
          claim.outboxIds,
          "slack",
          claim.token,
          "failed",
          error instanceof Error ? error.message.slice(0, 500) : "Slack digest failed.",
        );
        if (error instanceof SlackRateLimitError) rateLimitedWorkspaces.add(candidate.workspace_id);
        // One unreachable recipient must not starve the digests queued behind it.
        console.error("Notification digest Slack message failed", { userId: candidate.user_id, error });
      }
    }
  }
}

export async function sendDueNotificationDigests(env: Env, timestamp = Date.now()) {
  await sendDueEmailDigests(env, timestamp);
  await sendDuePersonalSlackDigests(env, timestamp);
}
