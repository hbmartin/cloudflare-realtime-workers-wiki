import { escapeHtml } from "./html";
import { composePersonalDigest } from "./personal-diff-digest";
import type {
  Notification,
  NotificationChannelMode,
  NotificationEventType,
  NotificationPreference,
  Subscription,
  WatchState,
} from "../shared/types";
import { tracing } from "cloudflare:workers";
import { DELIVERY_CLAIM_STALE_MS, DeliveryInProgressError } from "./delivery-claim";
export { DeliveryInProgressError } from "./delivery-claim";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import {
  preparePersonalSlackNotification,
  sendPersonalSlackNotification,
  slackInstallationError,
  slackTokenPreparationFailure,
  SlackInstallationAuthError,
  SlackApiError,
  SlackInstallationChangedError,
  SlackInstallationHealthPersistenceError,
  personalSlackInstallationSql,
  SlackRateLimitError,
  SlackTokenRefreshInProgressError,
  slackChannelFanoutStatements,
} from "./slack";
import { currentObservabilityContext, logger, recordMetric, safeTelemetryErrorMessage, traced } from "./observability";

export const NOTIFICATION_EVENT_TYPES = [
  "mention",
  "reply",
  "thread_resolved",
  "thread_reopened",
  "page_edit",
  "reminder",
  "task_assigned",
] as const satisfies readonly NotificationEventType[];

export type NotificationFanout = {
  workspaceId: string;
  spaceId: string;
  pageId: string;
  contentEpoch?: number;
  threadId: string | null;
  actorId: string | null;
  eventType: NotificationEventType;
  sourceId: string;
  retainDigestChanges?: boolean;
  taskOperationId?: string;
  taskRowId?: string;
  recipientIds: string[];
  emitSlackChannel: boolean;
  data?: Record<string, unknown>;
  reminderGuard?: { id: string; generation: number; receiptId: string };
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
          WHERE (? IS NULL OR recipient.value <> ?) AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template = 0
            AND (? IS NULL OR p.content_epoch = ?)
            AND (? IS NULL OR EXISTS(SELECT 1 FROM task_mutation_receipts tr WHERE tr.workspace_id=p.workspace_id AND tr.actor_id=? AND tr.operation_id=? AND tr.detail_page_id=p.id))
            AND (? IS NULL OR EXISTS(SELECT 1 FROM table_row_pages link WHERE link.row_id=? AND link.page_id=p.id))
            AND (wm.role = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
            AND (? IS NULL OR EXISTS (SELECT 1 FROM date_reminders reminder
              WHERE reminder.id=? AND reminder.generation=? AND reminder.state='delivered'
                AND reminder.delivery_receipt_id=?))
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
        fanout.actorId,
        fanout.contentEpoch ?? null,
        fanout.contentEpoch ?? null,
        fanout.taskOperationId ?? null,
        fanout.actorId,
        fanout.taskOperationId ?? null,
        fanout.taskRowId ?? null,
        fanout.taskRowId ?? null,
        fanout.reminderGuard?.id ?? null,
        fanout.reminderGuard?.id ?? null,
        fanout.reminderGuard?.generation ?? null,
        fanout.reminderGuard?.receiptId ?? null,
        coalesceAfter,
        fanout.pageId,
        fanout.eventType,
        fanout.actorId,
        coalesceAfter ?? 0,
      ),
    database
      .prepare(
        `INSERT OR IGNORE INTO outbox
          (id, workspace_id, topic, payload_json, available_at, created_at, correlation_id)
         SELECT 'outbox:' || id, workspace_id, 'notification', json_object('notificationId', id), ?, ?, ?
           FROM notifications
          WHERE id >= ? AND id < ?`,
      )
      .bind(
        fanout.createdAt,
        fanout.createdAt,
        currentObservabilityContext()?.correlationId ?? null,
        idPrefix,
        `${prefix};`,
      ),
    database
      .prepare(`INSERT OR IGNORE INTO workspace_activity(id,workspace_id,page_id,space_id,actor_id,thread_id,event_type,created_at,slack_eligible)
      SELECT ?,p.workspace_id,p.id,p.space_id,nullif(?,''),?,?,?,? FROM pages p WHERE p.id=? AND p.workspace_id=?
        AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template=0
        AND (? IS NULL OR p.content_epoch=?)
        AND ? IN ('mention','reply','thread_resolved','thread_reopened','page_edit')
        AND (SELECT activity_enabled FROM round2_runtime WHERE id=1)=1`)
      .bind(
        prefix,
        fanout.actorId,
        fanout.threadId,
        fanout.eventType,
        fanout.createdAt,
        fanout.emitSlackChannel && (fanout.eventType !== "mention" || recipients.length > 0) ? 1 : 0,
        fanout.pageId,
        fanout.workspaceId,
        fanout.contentEpoch ?? null,
        fanout.contentEpoch ?? null,
        fanout.eventType,
      ),
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

type DigestClaim = { token: string; outboxIds: string[] };

async function claimDeliveries(env: Env, outboxIds: readonly string[], channel: "email" | "slack", token: string) {
  if (!outboxIds.length) return [] as string[];
  const ids = JSON.stringify(uniqueIds([...outboxIds]));
  const timestamp = Date.now();
  const insert = env.DB.prepare(
    `INSERT OR IGNORE INTO deliveries
      (idempotency_key, outbox_id, channel, status, attempts, updated_at, claim_token)
     SELECT value || ':' || ?, value, ?, 'pending', 1, ?, ? FROM json_each(?)`,
  ).bind(channel, channel, timestamp, token, ids);
  const reclaim = env.DB.prepare(
    `UPDATE deliveries SET status = 'pending', attempts = attempts + 1, last_error = NULL,
       updated_at = ?, claim_token = ?
      WHERE outbox_id IN (SELECT value FROM json_each(?)) AND channel = ?
        AND (status = 'failed' OR (status = 'pending' AND updated_at <= ?))`,
  ).bind(timestamp, token, ids, channel, timestamp - DELIVERY_CLAIM_STALE_MS);
  const select = env.DB.prepare(
    `SELECT outbox_id FROM deliveries
      WHERE outbox_id IN (SELECT value FROM json_each(?)) AND channel = ?
        AND status = 'pending' AND claim_token = ?`,
  ).bind(ids, channel, token);
  const [, , claimed] = await env.DB.batch<{ outbox_id: string }>([insert, reclaim, select]);
  return claimed!.results.map((row) => row.outbox_id);
}

async function cleanupDigestClaim(
  env: Env,
  channel: "email" | "slack",
  claim: DigestClaim | undefined,
  error: unknown,
  context: { userId: string; workspaceId: string; timezone: string },
) {
  if (!claim) return [];
  try {
    await finishClaimedDeliveries(
      env,
      claim.outboxIds,
      channel,
      claim.token,
      "failed",
      safeTelemetryErrorMessage(error, "Digest delivery failed."),
    );
    return [];
  } catch (secondary) {
    logDigestInfrastructure(channel, "cleanup", secondary, context);
    return [secondary];
  }
}

async function finishClaimedDeliveries(
  env: Env,
  outboxIds: readonly string[],
  channel: "email" | "slack",
  token: string,
  status: "sent" | "failed",
  error: string | null = null,
  notificationTimestampColumn: "emailed_at" | "slack_at" | null = null,
) {
  if (!outboxIds.length) return [] as string[];
  const timestamp = Date.now();
  const uniqueOutboxIds = uniqueIds([...outboxIds]);
  const ids = JSON.stringify(uniqueOutboxIds);
  const finish = env.DB.prepare(
    `UPDATE deliveries SET status = ?, last_error = ?, delivered_at = ?, updated_at = ?
      WHERE outbox_id IN (SELECT value FROM json_each(?)) AND channel = ?
        AND status = 'pending' AND claim_token = ?
      RETURNING outbox_id`,
  ).bind(status, error, status === "sent" ? timestamp : null, timestamp, ids, channel, token);
  if (status !== "sent" || !notificationTimestampColumn) {
    const finished = await finish.all<{ outbox_id: string }>();
    return finished.results.map((row) => row.outbox_id);
  }
  // Start with the claimed delivery primary keys. Both target tables are updated
  // by explicit IDs; unrelated notification/checkpoint history is never scanned.
  const claimed = `SELECT delivery.* FROM json_each(?) requested
    JOIN deliveries delivery ON delivery.idempotency_key=requested.value||':'||?
    WHERE delivery.status='sent' AND delivery.claim_token=?`;
  const covered = `WITH claimed AS (${claimed}), bounds AS (
    SELECT anchor.user_id,first.page_id,first.created_at first_at,first.content_epoch first_epoch,first.sequence first_sequence,
      last.created_at last_at,last.content_epoch last_epoch,last.sequence last_sequence
    FROM claimed delivery
    JOIN page_change_recipients anchor ON anchor.id=substr(delivery.outbox_id,8)
    JOIN page_change_checkpoints anchor_checkpoint ON anchor_checkpoint.id=anchor.checkpoint_id
    JOIN page_change_checkpoints first ON first.id=json_extract(CASE WHEN json_valid(delivery.comparison_json) THEN delivery.comparison_json ELSE '{}' END,'$.first')
    JOIN page_change_checkpoints last ON last.id=json_extract(CASE WHEN json_valid(delivery.comparison_json) THEN delivery.comparison_json ELSE '{}' END,'$.last')
    WHERE first.page_id=anchor_checkpoint.page_id AND last.page_id=first.page_id
  ), covered AS (
    SELECT c.id,range.user_id FROM bounds range JOIN page_change_checkpoints c
      ON c.page_id=range.page_id AND c.created_at>=range.first_at AND c.created_at<=range.last_at
    WHERE (c.created_at,c.content_epoch,c.sequence)>=(range.first_at,range.first_epoch,range.first_sequence)
      AND (c.created_at,c.content_epoch,c.sequence)<=(range.last_at,range.last_epoch,range.last_sequence)
  )`;
  const statements = [finish];
  if (env.DIFF_DIGESTS_ENABLED === "true") {
    statements.push(
      env.DB.prepare(`${covered} UPDATE notifications
        SET ${notificationTimestampColumn}=COALESCE(${notificationTimestampColumn},?)
        WHERE id IN (SELECT substr(outbox_id,8) FROM claimed
          UNION ALL SELECT 'page_edit:'||id||':'||user_id FROM covered)`).bind(ids, channel, token, timestamp),
      env.DB.prepare(`${covered} UPDATE page_change_recipients
        SET ${notificationTimestampColumn}=COALESCE(${notificationTimestampColumn},?)
        WHERE id IN (SELECT substr(outbox_id,8) FROM claimed
          UNION ALL SELECT r.id FROM covered c JOIN page_change_recipients r
            ON r.checkpoint_id=c.id AND r.user_id=c.user_id)`).bind(ids, channel, token, timestamp),
    );
  } else {
    statements.push(
      env.DB.prepare(`UPDATE notifications SET ${notificationTimestampColumn}=COALESCE(${notificationTimestampColumn},?)
      WHERE id IN (SELECT substr(outbox_id,8) FROM (${claimed}))`).bind(timestamp, ids, channel, token),
    );
  }
  const [finished] = await env.DB.batch<{ outbox_id: string }>(statements);
  return (finished?.results ?? []).map((row) => row.outbox_id);
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
       ${env.DIFF_DIGESTS_ENABLED === "true" ? ACCESSIBLE_NOTIFICATION_SQL.replace("FROM notifications n", "FROM digest_notifications n") : ACCESSIBLE_NOTIFICATION_SQL} AND n.id IN (SELECT value FROM json_each(?))`,
  )
    .bind(userId, workspaceId, JSON.stringify([...notificationIds]))
    .all<DeliveryRow>();
  const accessible = new Set(rows.results.map((row) => row.id));
  return { rows: rows.results, suppressed: notificationIds.filter((id) => !accessible.has(id)) };
}

function notificationCopy(row: DeliveryRow) {
  const actor = row.actor_name ?? "A collaborator";
  if (row.event_type === "reminder") return `Reminder: ${row.page_title}`;
  if (row.event_type === "task_assigned") return `${actor} assigned you a task: ${row.page_title}`;
  if (row.event_type === "mention") return `${actor} mentioned you on ${row.page_title}`;
  if (row.event_type === "reply") return `${actor} replied on ${row.page_title}`;
  if (row.event_type === "thread_resolved") return `${actor} resolved a thread on ${row.page_title}`;
  if (row.event_type === "thread_reopened") return `${actor} reopened a thread on ${row.page_title}`;
  return `${actor} edited ${row.page_title}`;
}

async function sendNotificationEmail(env: Env, row: DeliveryRow, subject: string, text: string) {
  if (!env.SEND_EMAIL || !env.EMAIL_FROM) return false;
  const href = `${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(row.page_id)}`;
  await traced(tracing, "notes.integration.email", { "notes.operation": "notification" }, () =>
    env.SEND_EMAIL!.send({
      from: env.EMAIL_FROM!,
      to: row.recipient_email,
      subject,
      text: `${text}\n\nOpen ${row.page_title}: ${href}`,
      html: `<p>${escapeHtml(text)}</p><p><a href="${escapeHtml(href)}">Open ${escapeHtml(row.page_title)}</a></p>`,
    }),
  );
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
        safeTelemetryErrorMessage(error, "Email delivery failed."),
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
        safeTelemetryErrorMessage(error, "Slack delivery failed."),
      );
      throw error;
    }
  }
  // Another consumer holds a live claim; let the queue redeliver once it settles or goes stale.
  if (deferred) throw new DeliveryInProgressError();
}

// Reserve refresh, recovery, finalization and cleanup costs before dispatch.
// Each channel keeps half of the combined budget for healthy recipients.
const DIGEST_STATEMENT_BUDGET = 240;
const DIGEST_CHANNEL_COUNT = 2;
const DIGEST_STATEMENTS_PER_CANDIDATE = 11;
const DIGEST_REFRESH_STATEMENTS = 7;
class DigestBudgetExhaustedError extends Error {}
const DIFF_DIGEST_PAGE_LIMIT = 10;
function digestCandidateCost(env: Env, pages: number) {
  return (
    DIGEST_STATEMENTS_PER_CANDIDATE +
    (env.DIFF_DIGESTS_ENABLED === "true" ? 5 + 4 * Math.min(DIFF_DIGEST_PAGE_LIMIT, pages) : 0)
  );
}
function digestClaimAllowance(env: Env, channel: DigestChannel) {
  // Three claim statements, finalization, and cleanup; Slack also needs two
  // dispatch reads and one possible installation-health/cooldown write.
  return 3 + (env.DIFF_DIGESTS_ENABLED === "true" ? 3 : 2) + 1 + (channel === "slack" ? 3 : 0);
}
const DIGEST_STATEMENTS_PER_WINDOW = 4;
const DIGEST_DISCOVERY_STATEMENTS = 1;
const DIGEST_CHANNEL_STATEMENT_BUDGET = Math.floor(DIGEST_STATEMENT_BUDGET / DIGEST_CHANNEL_COUNT);

// Scope accounting to one channel; count attempted executions, including batch members.
function digestAccounting(env: Env) {
  const budget = {
    used: 0,
    reserved: 0,
    get remaining() {
      return DIGEST_CHANNEL_STATEMENT_BUDGET - this.used - this.reserved;
    },
    require(count: number) {
      if (this.remaining < 0 || Math.max(0, count) > this.remaining) throw new DigestBudgetExhaustedError();
    },
    charge(count: number) {
      // Admission happens before side effects; mandatory completion cannot be vetoed here.
      this.used += count;
    },
  };
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        const value: unknown = Reflect.get(target, property, target);
        if (["run", "all", "first", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            budget.charge(1);
            return Reflect.apply(value as (...args: unknown[]) => unknown, target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (property === "batch")
        return (statements: D1PreparedStatement[]) => {
          budget.charge(statements.length);
          return target.batch(statements.map((statement) => originals.get(statement) ?? statement));
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    budget,
    env: new Proxy(env, {
      get: (target, property, receiver) => (property === "DB" ? database : Reflect.get(target, property, receiver)),
    }),
  };
}
const DIGEST_CANDIDATE_PAGE = Math.floor(
  (DIGEST_CHANNEL_STATEMENT_BUDGET - DIGEST_DISCOVERY_STATEMENTS - DIGEST_STATEMENTS_PER_WINDOW) /
    DIGEST_STATEMENTS_PER_CANDIDATE,
);
function digestWindowLimit() {
  return Math.floor(
    (DIGEST_CHANNEL_STATEMENT_BUDGET - DIGEST_DISCOVERY_STATEMENTS - DIGEST_STATEMENTS_PER_CANDIDATE) /
      DIGEST_STATEMENTS_PER_WINDOW,
  );
}

function logDigestInfrastructure(
  channel: DigestChannel,
  stage:
    | "discovery"
    | "candidates"
    | "cursor"
    | "window"
    | "token"
    | "preparation"
    | "finalization"
    | "provider"
    | "cleanup"
    | "budget",
  error: unknown,
  context: { timezone?: string; userId?: string; workspaceId?: string; statements?: number; limit?: number } = {},
) {
  const messages = {
    budget: "Digest statement estimate exceeded; mandatory persistence completed before stopping.",
    discovery: "Digest discovery failed.",
    candidates: "Digest candidate loading failed.",
    cursor: "Digest cursor save failed.",
    window: "Digest window processing failed.",
    token: "Digest token preparation failed.",
    preparation: "Digest preparation failed.",
    finalization: "Digest finalization failed.",
    provider: "Digest dispatch infrastructure failed.",
    cleanup: "Digest failure recording failed.",
  };
  logger.error(
    `notification.digest_${channel}.${stage === "cursor" || stage === "cleanup" ? "secondary_failed" : "infrastructure_failed"}`,
    "notifications",
    messages[stage],
    { channel, stage, phase: stage, ...context },
    error,
  );
}

async function discoverDigestWindows(env: Env, channel: DigestChannel, timestamp: number, staleClaimCutoff: number) {
  try {
    return await dueDigestTimezones(env, channel, timestamp, digestWindowLimit(), staleClaimCutoff);
  } catch (error) {
    logDigestInfrastructure(channel, "discovery", error);
    throw error;
  }
}

// Timezone is part of the key: preferences are per event type, so one user can hold
// two timezones and appear as two groups that a coarser cursor would skip past.
export type DigestCursor = { userId: string; workspaceId: string; timezone: string };

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

export type DigestChannel = "email" | "slack";

function digestModeSql(channel: DigestChannel) {
  return channel === "email"
    ? `COALESCE(preference.email, CASE WHEN n.event_type = 'page_edit' THEN 'digest' ELSE 'immediate' END) = 'digest'`
    : `COALESCE(preference.slack, 'off') = 'digest'`;
}

function digestDeliveryEligibleSql(channel: DigestChannel) {
  return `NOT EXISTS(SELECT 1 FROM deliveries delivery WHERE delivery.outbox_id='outbox:'||n.id AND delivery.channel='${channel}'
    AND (delivery.status='sent' OR (delivery.status='pending' AND delivery.updated_at>?)))`;
}

// A busy page still occupies one digest slot. Its receipt freezes the whole
// qualifying checkpoint range rather than splitting a day into forty edits.
function digestIdsSql(env: Env, channel: DigestChannel) {
  const source = env.DIFF_DIGESTS_ENABLED === "true" ? "digest_notifications" : "notifications";
  const eligible = `SELECT n.id,n.created_at,
      CASE WHEN n.id LIKE 'change:%' THEN 'page:'||n.page_id ELSE n.id END digest_group
    FROM ${source} n LEFT JOIN notification_preferences preference
      ON preference.user_id=n.user_id AND preference.event_type=n.event_type
    WHERE n.user_id=? AND n.workspace_id=? AND n.${channel === "email" ? "emailed_at" : "slack_at"} IS NULL
      AND ${digestModeSql(channel)} AND COALESCE(preference.timezone,'UTC')=? AND n.created_at<?
      AND ${digestDeliveryEligibleSql(channel)}`;
  return `WITH eligible AS (${eligible}), ranked AS (
    SELECT id,created_at,digest_group,row_number() OVER(PARTITION BY digest_group ORDER BY created_at,id) rank FROM eligible
  ), groups AS (SELECT *,sum(CASE WHEN digest_group LIKE 'page:%' THEN 1 ELSE 0 END)
    OVER(ORDER BY created_at,id) comparison_rank FROM ranked WHERE rank=1)
  SELECT id FROM groups WHERE digest_group NOT LIKE 'page:%' OR comparison_rank<=${DIFF_DIGEST_PAGE_LIMIT}
  ORDER BY created_at,id LIMIT 40`;
}

function digestRecipientSql(channel: DigestChannel) {
  const currentMember = `AND EXISTS (
    SELECT 1 FROM workspace_members membership
    JOIN user recipient ON recipient.id = membership.user_id
    WHERE membership.workspace_id = n.workspace_id AND membership.user_id = n.user_id
  )`;
  return channel === "email"
    ? currentMember
    : `${currentMember} AND EXISTS (
         SELECT 1 FROM slack_installations installation
         JOIN slack_authorized_user_links link
           ON link.installation_id = installation.id AND link.user_id = n.user_id
        WHERE installation.workspace_id = n.workspace_id AND installation.disconnected_at IS NULL AND ${personalSlackInstallationSql}
       )`;
}

async function dueDigestTimezones(
  env: Env,
  channel: DigestChannel,
  timestamp: number,
  limit: number,
  staleClaimCutoff: number,
) {
  const deliveredColumn = channel === "email" ? "emailed_at" : "slack_at";
  const rows = await env.DB.prepare(
    `SELECT COALESCE(preference.timezone, 'UTC') timezone,
            COALESCE(cursor.updated_at, 0) cursor_updated_at,
            MIN(n.created_at) oldest_created_at
       FROM ${env.DIFF_DIGESTS_ENABLED === "true" ? "digest_notifications" : "notifications"} n
       LEFT JOIN notification_preferences preference
         ON preference.user_id = n.user_id AND preference.event_type = n.event_type
       LEFT JOIN digest_delivery_cursors cursor
         ON cursor.channel = ? AND cursor.timezone = COALESCE(preference.timezone, 'UTC')
      WHERE n.${deliveredColumn} IS NULL AND ${digestModeSql(channel)} ${digestRecipientSql(channel)} AND ${digestDeliveryEligibleSql(channel)}
      GROUP BY COALESCE(preference.timezone, 'UTC'), COALESCE(cursor.updated_at, 0)
      ORDER BY 2, 1`,
  )
    .bind(channel, staleClaimCutoff)
    .all<{ timezone: string; cursor_updated_at: number; oldest_created_at: number }>();
  return rows.results
    .map((row) => {
      const window = digestWindow(row.timezone, timestamp);
      return window && row.oldest_created_at < window.cutoff ? window : null;
    })
    .filter((window): window is { timezone: string; cutoff: number } => Boolean(window))
    .slice(0, limit);
}

function digestCursor(row: { user_id: string; workspace_id: string; timezone: string }): DigestCursor {
  return { userId: row.user_id, workspaceId: row.workspace_id, timezone: row.timezone };
}

function digestCursorKey(cursor: DigestCursor) {
  return `${cursor.userId}\u0000${cursor.workspaceId}\u0000${cursor.timezone}`;
}

export async function digestCandidates<T extends { user_id: string; workspace_id: string; timezone: string }>(
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
  let wrapped = !stored || (!stored.user_id && !stored.workspace_id);
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
    if (wrapped) break;
    if (page.results.length < pageSize) {
      cursor = { userId: "", workspaceId: "", timezone };
      wrapped = true;
    }
  }
  return candidates;
}

export async function saveDigestCursor(env: Env, channel: DigestChannel, timezone: string, row?: DigestCursor) {
  // An empty window still advances its timestamp without moving its saved position.
  await env.DB.prepare(`INSERT INTO digest_delivery_cursors(channel,user_id,workspace_id,timezone,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(channel,timezone) DO UPDATE SET
    user_id=CASE WHEN ? THEN excluded.user_id ELSE digest_delivery_cursors.user_id END,
    workspace_id=CASE WHEN ? THEN excluded.workspace_id ELSE digest_delivery_cursors.workspace_id END,
    updated_at=MAX(digest_delivery_cursors.updated_at+1,excluded.updated_at)`)
    .bind(channel, row?.userId ?? "", row?.workspaceId ?? "", timezone, Date.now(), Boolean(row), Boolean(row))
    .run();
}

function digestSuppressionStatements(
  env: Env,
  channel: DigestChannel,
  ids: string[],
  candidate: {
    user_id: string;
    workspace_id: string;
  },
  timestamp: number,
  cutoff: number,
) {
  if (!ids.length) return [];
  const column = channel === "email" ? "emailed_at" : "slack_at";
  const inaccessible = `NOT EXISTS(SELECT 1 FROM pages p JOIN spaces s ON s.id=p.space_id
    JOIN workspace_members m ON m.workspace_id=p.workspace_id AND m.user_id=?
    LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=m.user_id
    WHERE p.id=c.page_id AND p.workspace_id=? AND p.archived_at IS NULL
      AND p.import_job_id IS NULL AND p.is_template=0
      AND (m.role='owner' OR s.visibility='workspace' OR sm.user_id IS NOT NULL))`;
  const covered = `WITH covered AS (
    SELECT c.id,r.id recipient_id,r.user_id FROM json_each(?) selected
    JOIN page_change_recipients anchor ON anchor.id=selected.value
    JOIN page_change_checkpoints first ON first.id=anchor.checkpoint_id
    JOIN page_change_checkpoints c ON c.page_id=first.page_id AND c.created_at<?
    JOIN page_change_recipients r ON r.checkpoint_id=c.id AND r.user_id=anchor.user_id
    WHERE r.user_id=? AND r.${column} IS NULL AND ${inaccessible}
  )`;
  const binds = [JSON.stringify(ids), cutoff, candidate.user_id, candidate.user_id, candidate.workspace_id];
  const statements = [
    env.DB.prepare(`UPDATE notifications SET ${column}=? WHERE id IN (SELECT value FROM json_each(?))`).bind(
      timestamp,
      JSON.stringify(ids),
    ),
  ];
  if (env.DIFF_DIGESTS_ENABLED === "true" && ids.some((id) => id.startsWith("change:")))
    statements.push(
      // Recipient timestamps must stay NULL until both queries have selected the covered rows.
      env.DB.prepare(`${covered} UPDATE notifications SET ${column}=?
      WHERE id IN (SELECT 'page_edit:'||id||':'||user_id FROM covered)`).bind(...binds, timestamp),
      env.DB.prepare(`${covered} UPDATE page_change_recipients SET ${column}=?
      WHERE id IN (SELECT recipient_id FROM covered)`).bind(...binds, timestamp),
    );
  return statements;
}

function reportDigestBudget(channel: DigestChannel, used: number, failures: unknown[]) {
  if (used <= DIGEST_CHANNEL_STATEMENT_BUDGET) return;
  const error = new Error("Digest statement estimate exceeded.");
  logDigestInfrastructure(channel, "budget", error, { statements: used, limit: DIGEST_CHANNEL_STATEMENT_BUDGET });
  failures.push(error);
}

async function sendDueEmailDigests(env: Env, timestamp: number, staleClaimCutoff: number) {
  if (!env.SEND_EMAIL || !env.EMAIL_FROM) return;
  const sender = env.SEND_EMAIL,
    from = env.EMAIL_FROM;
  const accounting = digestAccounting(env);
  env = accounting.env;
  const { budget } = accounting;
  const dueTimezones = await discoverDigestWindows(env, "email", timestamp, staleClaimCutoff);
  if (!dueTimezones.length) return;
  const failures: unknown[] = [];
  for (const window of dueTimezones) {
    if (budget.remaining < DIGEST_STATEMENTS_PER_WINDOW + DIGEST_STATEMENTS_PER_CANDIDATE) break;
    budget.reserved = 1; // Keep the cursor write available even after failures.
    const readCandidates = (cursor: DigestCursor, pageSize: number) =>
      env.DB.prepare(
        `SELECT n.user_id, n.workspace_id, recipient.name, recipient.email,
              COALESCE(preference.timezone, 'UTC') timezone,
              COUNT(DISTINCT CASE WHEN n.id LIKE 'change:%' THEN n.page_id END) comparison_pages
         FROM ${env.DIFF_DIGESTS_ENABLED === "true" ? "digest_notifications" : "notifications"} n
         JOIN workspace_members membership
           ON membership.workspace_id = n.workspace_id AND membership.user_id = n.user_id
         JOIN user recipient ON recipient.id = n.user_id
         LEFT JOIN notification_preferences preference
           ON preference.user_id = n.user_id AND preference.event_type = n.event_type
        WHERE n.emailed_at IS NULL AND ${digestModeSql("email")}
          AND COALESCE(preference.timezone, 'UTC') = ? AND n.created_at < ?
          AND ${digestDeliveryEligibleSql("email")}
          AND (n.user_id > ? OR (n.user_id = ? AND n.workspace_id > ?))
        GROUP BY n.user_id, n.workspace_id, recipient.name, recipient.email, timezone
        ORDER BY n.user_id, n.workspace_id
        LIMIT ?`,
      )
        .bind(
          window.timezone,
          window.cutoff,
          staleClaimCutoff,
          cursor.userId,
          cursor.userId,
          cursor.workspaceId,
          pageSize,
        )
        .all<{
          user_id: string;
          workspace_id: string;
          name: string;
          email: string;
          timezone: string;
          comparison_pages: number;
        }>();
    const candidateLimit = Math.min(
      DIGEST_CANDIDATE_PAGE,
      Math.floor(budget.remaining / DIGEST_STATEMENTS_PER_CANDIDATE),
    );
    let lastAttempted: DigestCursor | undefined;
    let windowBudgetBlocked = false;
    try {
      const candidates = await digestCandidates(env, "email", window.timezone, candidateLimit, readCandidates).catch(
        (error: unknown) => {
          logDigestInfrastructure("email", "candidates", error, { timezone: window.timezone });
          failures.push(error);
          return [];
        },
      );
      for (const candidate of candidates) {
        const candidateCost = digestCandidateCost(env, candidate.comparison_pages);
        if (budget.remaining < candidateCost + 1) {
          windowBudgetBlocked = true;
          break;
        }
        const candidateStarted = budget.used;
        let allowance = candidateCost;
        let cleanupReserved = false;
        let claim: DigestClaim | undefined;
        let phase: "preparation" | "provider" | "finalization" = "preparation";
        let budgetExhausted = false;
        try {
          const ids = await env.DB.prepare(digestIdsSql(env, "email"))
            .bind(candidate.user_id, candidate.workspace_id, candidate.timezone, window.cutoff, staleClaimCutoff)
            .all<{ id: string }>();
          const { rows, suppressed } = await accessibleNotifications(
            env,
            candidate.user_id,
            candidate.workspace_id,
            ids.results.map((row) => row.id),
          );
          const suppression = digestSuppressionStatements(
            env,
            "email",
            suppressed,
            candidate,
            timestamp,
            window.cutoff,
          );
          allowance += suppression.length;
          budget.require(allowance + 1 - (budget.used - candidateStarted));
          if (suppression.length) await env.DB.batch(suppression);
          budget.require(
            Math.max(allowance + 1 - (budget.used - candidateStarted), digestClaimAllowance(env, "email")),
          );
          budget.reserved++;
          cleanupReserved = true;
          claim = { token: crypto.randomUUID(), outboxIds: rows.map((row) => `outbox:${row.id}`) };
          // Retain the token and requested IDs if D1 commits but its response fails.
          claim.outboxIds = await claimDeliveries(env, claim.outboxIds, "email", claim.token);
          const claimedIds = new Set(claim.outboxIds);
          const claimed = rows.filter((row) => claimedIds.has(`outbox:${row.id}`));
          if (!claimed.length) continue;
          const lines = claimed.map((row) => `• ${notificationCopy(row)}`);
          const composed =
            env.DIFF_DIGESTS_ENABLED === "true"
              ? await composePersonalDigest(
                  env,
                  claimed,
                  "email",
                  claim.token,
                  (row) => notificationCopy(claimed.find((item) => item.id === row.id)!),
                  window.cutoff,
                )
              : null;
          if (composed?.empty) {
            phase = "finalization";
            await finishClaimedDeliveries(env, claim.outboxIds, "email", claim.token, "sent", null, "emailed_at");
            continue;
          }
          const message = {
            from,
            to: candidate.email,
            subject: `${claimed.length} NoteFlare update${claimed.length === 1 ? "" : "s"}`,
            text: composed?.text ?? `Your daily NoteFlare digest:\n\n${lines.join("\n")}`,
            html:
              composed?.html ??
              `<p>Your daily NoteFlare digest:</p><ul>${claimed
                .map((row) => `<li>${escapeHtml(notificationCopy(row))}</li>`)
                .join("")}</ul>`,
          };
          budget.require((env.DIFF_DIGESTS_ENABLED === "true" ? 3 : 2) + 0 + 1);
          phase = "provider";
          await sender.send(message);
          phase = "finalization";
          await finishClaimedDeliveries(env, claim.outboxIds, "email", claim.token, "sent", null, "emailed_at");
        } catch (error) {
          if (error instanceof DigestBudgetExhaustedError) {
            budgetExhausted = true;
            windowBudgetBlocked = true;
            if (cleanupReserved) {
              budget.reserved--;
              cleanupReserved = false;
            }
            failures.push(
              ...(await cleanupDigestClaim(env, "email", claim, error, {
                timezone: candidate.timezone,
                userId: candidate.user_id,
                workspaceId: candidate.workspace_id,
              })),
            );
            break;
          }
          const providerFailure = phase === "provider";
          const context = {
            userId: candidate.user_id,
            workspaceId: candidate.workspace_id,
            timezone: candidate.timezone,
          };
          if (providerFailure)
            logger.error(
              "notification.digest_email.failed",
              "notifications",
              "Notification digest email failed.",
              { channel: "email", stage: phase, phase, ...context },
              error,
            );
          else logDigestInfrastructure("email", phase, error, context);
          if (cleanupReserved) {
            budget.reserved--;
            cleanupReserved = false;
          }
          failures.push(...(await cleanupDigestClaim(env, "email", claim, error, context)));
          if (!providerFailure) failures.push(error);
          if (providerFailure)
            recordMetric(env, {
              event: "integration.call",
              component: "notifications",
              operation: "email",
              outcome: "failure",
            });
        } finally {
          if (cleanupReserved) budget.reserved--;
          if (!budgetExhausted) lastAttempted = digestCursor(candidate);
        }
      }
    } catch (error) {
      logDigestInfrastructure("email", "window", error, {
        timezone: window.timezone,
        ...(lastAttempted ? { userId: lastAttempted.userId, workspaceId: lastAttempted.workspaceId } : {}),
      });
      failures.push(error);
    }
    budget.reserved = 0;
    try {
      if (lastAttempted || !windowBudgetBlocked) await saveDigestCursor(env, "email", window.timezone, lastAttempted);
    } catch (error) {
      logDigestInfrastructure("email", "cursor", error, { timezone: window.timezone });
      failures.push(error);
    }
  }
  reportDigestBudget("email", budget.used, failures);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Email digest infrastructure failed.");
}

async function sendDuePersonalSlackDigests(env: Env, timestamp: number, staleClaimCutoff: number) {
  const accounting = digestAccounting(env);
  env = accounting.env;
  const { budget } = accounting;
  const dueTimezones = await discoverDigestWindows(env, "slack", timestamp, staleClaimCutoff);
  if (!dueTimezones.length) return;
  const failures: unknown[] = [];
  const deferredWorkspaces = new Set<string>();
  for (const window of dueTimezones) {
    if (budget.remaining < DIGEST_STATEMENTS_PER_WINDOW + DIGEST_STATEMENTS_PER_CANDIDATE) break;
    budget.reserved = 1; // Keep the cursor write available even after failures.
    const readCandidates = (cursor: DigestCursor, pageSize: number) =>
      env.DB.prepare(
        `SELECT n.user_id, n.workspace_id, COALESCE(preference.timezone, 'UTC') timezone,
              COUNT(DISTINCT CASE WHEN n.id LIKE 'change:%' THEN n.page_id END) comparison_pages
         FROM ${env.DIFF_DIGESTS_ENABLED === "true" ? "digest_notifications" : "notifications"} n
         JOIN workspace_members membership
           ON membership.workspace_id = n.workspace_id AND membership.user_id = n.user_id
         JOIN slack_installations installation
           ON installation.workspace_id = n.workspace_id AND installation.disconnected_at IS NULL AND ${personalSlackInstallationSql}
         JOIN slack_authorized_user_links link
           ON link.installation_id = installation.id AND link.user_id = n.user_id
         LEFT JOIN notification_preferences preference
           ON preference.user_id = n.user_id AND preference.event_type = n.event_type
        WHERE n.slack_at IS NULL AND ${digestModeSql("slack")}
          AND COALESCE(preference.timezone, 'UTC') = ? AND n.created_at < ?
          AND ${digestDeliveryEligibleSql("slack")}
          AND (n.user_id > ? OR (n.user_id = ? AND n.workspace_id > ?))
        GROUP BY n.user_id, n.workspace_id, timezone
        ORDER BY n.user_id, n.workspace_id
        LIMIT ?`,
      )
        .bind(
          window.timezone,
          window.cutoff,
          staleClaimCutoff,
          cursor.userId,
          cursor.userId,
          cursor.workspaceId,
          pageSize,
        )
        .all<{ user_id: string; workspace_id: string; timezone: string; comparison_pages: number }>();
    const candidateLimit = Math.min(
      DIGEST_CANDIDATE_PAGE,
      Math.floor(budget.remaining / DIGEST_STATEMENTS_PER_CANDIDATE),
    );
    let lastAttempted: DigestCursor | undefined;
    let windowBudgetBlocked = false;
    try {
      const candidates = await digestCandidates(env, "slack", window.timezone, candidateLimit, readCandidates).catch(
        (error: unknown) => {
          logDigestInfrastructure("slack", "candidates", error, { timezone: window.timezone });
          failures.push(error);
          return [];
        },
      );
      for (const candidate of candidates) {
        if (deferredWorkspaces.has(candidate.workspace_id)) {
          lastAttempted = digestCursor(candidate);
          continue;
        }
        const candidateCost = digestCandidateCost(env, candidate.comparison_pages);
        if (budget.remaining < candidateCost + 1) {
          windowBudgetBlocked = true;
          break;
        }
        const candidateStarted = budget.used;
        let allowance = candidateCost;
        let cleanupReserved = false;
        let claim: DigestClaim | undefined;
        let phase: "token" | "preparation" | "provider" | "finalization" = "preparation";
        let budgetExhausted = false;
        const context = {
          userId: candidate.user_id,
          workspaceId: candidate.workspace_id,
          timezone: candidate.timezone,
        };
        try {
          const ids = await env.DB.prepare(digestIdsSql(env, "slack"))
            .bind(candidate.user_id, candidate.workspace_id, candidate.timezone, window.cutoff, staleClaimCutoff)
            .all<{ id: string }>();
          const { rows, suppressed } = await accessibleNotifications(
            env,
            candidate.user_id,
            candidate.workspace_id,
            ids.results.map((row) => row.id),
          );
          const suppression = digestSuppressionStatements(
            env,
            "slack",
            suppressed,
            candidate,
            timestamp,
            window.cutoff,
          );
          allowance += suppression.length;
          budget.require(allowance + 1 - (budget.used - candidateStarted));
          if (suppression.length) await env.DB.batch(suppression);
          if (!rows.length) continue;
          phase = "token";
          const prepared = await preparePersonalSlackNotification(env, candidate.user_id, candidate.workspace_id, {
            tokenRefreshMode: "defer",
            beforeRefresh: (recovery) => {
              const refreshCost = DIGEST_REFRESH_STATEMENTS + (recovery ? 2 : 0);
              budget.require(
                Math.max(
                  allowance + refreshCost + 1 - (budget.used - candidateStarted),
                  refreshCost + digestClaimAllowance(env, "slack"),
                ),
              );
              allowance += refreshCost;
            },
          });
          if (!prepared) throw new HttpError(403, "slack_identity_required", "Slack identity is no longer available.");
          phase = "preparation";
          budget.require(
            Math.max(allowance + 1 - (budget.used - candidateStarted), digestClaimAllowance(env, "slack")),
          );
          budget.reserved++;
          cleanupReserved = true;
          claim = { token: crypto.randomUUID(), outboxIds: rows.map((row) => `outbox:${row.id}`) };
          claim.outboxIds = await claimDeliveries(env, claim.outboxIds, "slack", claim.token);
          const claimedIds = new Set(claim.outboxIds);
          const claimed = rows.filter((row) => claimedIds.has(`outbox:${row.id}`));
          if (!claimed.length) continue;
          const composed =
            env.DIFF_DIGESTS_ENABLED === "true"
              ? await composePersonalDigest(
                  env,
                  claimed,
                  "slack",
                  claim.token,
                  (row) => notificationCopy(claimed.find((item) => item.id === row.id)!),
                  window.cutoff,
                )
              : null;
          if (composed?.empty) {
            phase = "finalization";
            await finishClaimedDeliveries(env, claim.outboxIds, "slack", claim.token, "sent", null, "slack_at");
            continue;
          }
          budget.require((env.DIFF_DIGESTS_ENABLED === "true" ? 3 : 2) + 2 + 1);
          phase = "provider";
          const sent = await sendPersonalSlackNotification(
            env,
            candidate.user_id,
            candidate.workspace_id,
            composed?.text ??
              `Your daily NoteFlare digest:\n${claimed.map((row) => `• ${notificationCopy(row)}`).join("\n")}`,
            composed?.pageId ?? claimed[0]!.page_id,
            composed
              ? { escaped: true, ...(composed.slackSections ? { sections: composed.slackSections } : {}) }
              : undefined,
            { prepared },
          );
          if (!sent) throw new HttpError(403, "slack_identity_required", "Slack identity is no longer available.");
          phase = "finalization";
          await finishClaimedDeliveries(env, claim.outboxIds, "slack", claim.token, "sent", null, "slack_at");
        } catch (error) {
          if (error instanceof DigestBudgetExhaustedError) {
            budgetExhausted = true;
            windowBudgetBlocked = true;
            if (cleanupReserved) {
              budget.reserved--;
              cleanupReserved = false;
            }
            failures.push(
              ...(await cleanupDigestClaim(env, "slack", claim, error, {
                timezone: candidate.timezone,
                userId: candidate.user_id,
                workspaceId: candidate.workspace_id,
              })),
            );
            break;
          }
          if (error instanceof SlackInstallationHealthPersistenceError) deferredWorkspaces.add(candidate.workspace_id);
          const skipReason =
            error instanceof SlackTokenRefreshInProgressError
              ? "refresh_in_progress"
              : error instanceof SlackInstallationChangedError
                ? "installation_changed"
                : error instanceof HttpError && error.status === 403 && error.code === "slack_identity_required"
                  ? "slack_identity_required"
                  : error instanceof SlackInstallationAuthError
                    ? "installation_auth_required"
                    : undefined;
          const providerFailure =
            (phase === "provider" || phase === "token") &&
            (skipReason !== undefined || error instanceof SlackApiError || error instanceof SlackRateLimitError);
          if (
            providerFailure &&
            (slackTokenPreparationFailure(error) ||
              error instanceof SlackInstallationAuthError ||
              error instanceof SlackRateLimitError ||
              slackInstallationError(error))
          )
            deferredWorkspaces.add(candidate.workspace_id);
          if (providerFailure && skipReason)
            logger.info(
              "notification.digest_slack.skipped",
              "notifications",
              "Notification digest Slack message deferred.",
              { channel: "slack", stage: phase, phase, code: skipReason, ...context },
            );
          else if (providerFailure)
            logger.error(
              "notification.digest_slack.failed",
              "notifications",
              "Notification digest Slack message failed.",
              { channel: "slack", stage: phase, phase, ...context },
              error,
            );
          else logDigestInfrastructure("slack", phase, error, context);
          if (cleanupReserved) {
            budget.reserved--;
            cleanupReserved = false;
          }
          failures.push(...(await cleanupDigestClaim(env, "slack", claim, error, context)));
          if (!providerFailure) failures.push(error);
          if (providerFailure)
            recordMetric(env, {
              event: "integration.call",
              component: "notifications",
              operation: "slack",
              outcome: skipReason ? "skipped" : "failure",
              ...(skipReason ? { code: skipReason } : {}),
            });
        } finally {
          if (cleanupReserved) budget.reserved--;
          if (!budgetExhausted) lastAttempted = digestCursor(candidate);
        }
      }
    } catch (error) {
      logDigestInfrastructure("slack", "window", error, {
        timezone: window.timezone,
        ...(lastAttempted ? { userId: lastAttempted.userId, workspaceId: lastAttempted.workspaceId } : {}),
      });
      failures.push(error);
    }
    budget.reserved = 0;
    try {
      if (lastAttempted || !windowBudgetBlocked) await saveDigestCursor(env, "slack", window.timezone, lastAttempted);
    } catch (error) {
      logDigestInfrastructure("slack", "cursor", error, { timezone: window.timezone });
      failures.push(error);
    }
  }
  reportDigestBudget("slack", budget.used, failures);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Slack digest infrastructure failed.");
}

export async function sendDueNotificationDigests(env: Env, timestamp = Date.now()) {
  const staleClaimCutoff = Date.now() - DELIVERY_CLAIM_STALE_MS;
  const failures: unknown[] = [];
  for (const send of [sendDueEmailDigests, sendDuePersonalSlackDigests]) {
    try {
      await send(env, timestamp, staleClaimCutoff);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Notification digest channels failed.");
}
