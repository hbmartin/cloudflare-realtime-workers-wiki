import type { Env } from "./env";

export type DeliveryOutcome = "completed" | "paused" | "competing" | "retryable" | "uncertain";

// Scheduling ownership includes payload identity. Deadline-only maintenance can
// rebase an operation, but a new attempt or payload always belongs to a successor.
export type SlackOutboxSnapshot = {
  id: string;
  attempts: number;
  payload_json: string;
  enqueued_at: number | null;
  available_at: number;
  last_error: string | null;
  slack_redrive_due_at: number | null;
  slack_claim_recheck_at: number | null;
  slack_redrive_count: number;
  slack_scope_paused_at: number | null;
  slack_enqueue_redrive_pending: number;
  slack_enqueue_failure_count: number;
};
export const slackOutboxSnapshotFields = [
  "id",
  "attempts",
  "payload_json",
  "enqueued_at",
  "available_at",
  "last_error",
  "slack_redrive_due_at",
  "slack_claim_recheck_at",
  "slack_redrive_count",
  "slack_scope_paused_at",
  "slack_enqueue_redrive_pending",
  "slack_enqueue_failure_count",
] as const satisfies readonly (keyof SlackOutboxSnapshot)[];
export const slackOutboxSnapshotSql = `${slackOutboxSnapshotFields.map((field) => `${field} IS ?`).join(" AND ")} AND slack_scope_paused_at IS NULL`;
export function slackOutboxSnapshotBinds(snapshot: SlackOutboxSnapshot) {
  return slackOutboxSnapshotFields.map((field) => snapshot[field]);
}
export function slackOutboxFence(snapshot: SlackOutboxSnapshot) {
  return { sql: slackOutboxSnapshotSql, binds: slackOutboxSnapshotBinds(snapshot) };
}
// Progress writes and producer budget accounting do not replace a queue attempt.
// A successor or enqueue rollback changes this identity; a scope pause always wins.
const slackConsumerIdentityFields = [
  "id",
  "attempts",
  "payload_json",
  "enqueued_at",
  "available_at",
  "slack_enqueue_failure_count",
] as const satisfies readonly (keyof SlackOutboxSnapshot)[];
export function slackConsumerOutboxFence(snapshot: SlackOutboxSnapshot) {
  return {
    sql: `${slackConsumerIdentityFields.map((field) => `${field} IS ?`).join(" AND ")} AND slack_scope_paused_at IS NULL`,
    binds: slackConsumerIdentityFields.map((field) => snapshot[field]),
  };
}

export function sameSlackOperation(before: SlackOutboxSnapshot, after: SlackOutboxSnapshot) {
  return slackConsumerIdentityFields.every((field) => before[field] === after[field]);
}

export const RETRYABLE_SHARE_RECEIPT_SQL = `EXISTS(SELECT 1 FROM slack_interaction_receipts receipt
  WHERE receipt.id=json_extract(outbox.payload_json,'$.receiptId') AND receipt.outcome='accepted'
    AND receipt.denial_sent_at IS NULL AND (receipt.response_delivery_state='pending'
      OR (receipt.response_delivery_state IS NULL AND receipt.response_delivery_attempted_at IS NULL)))`;

function slackOutboxInstallationMatchSql() {
  const receipts = [
    ["slack_digest", "slack_digest_receipts"],
    ["slack_bulk", "slack_bulk_receipts"],
    ["slack_share_refresh", "slack_share_refreshes"],
    ["slack_file_upload", "slack_file_artifacts"],
  ];
  return `(i.id=json_extract(outbox.payload_json,'$.installationId') AND i.generation=json_extract(outbox.payload_json,'$.generation'))
    OR (topic='slack_channel' AND EXISTS(SELECT 1 FROM slack_channel_events r JOIN slack_channel_subscriptions m ON m.id=r.subscription_id
      WHERE r.id=slack_round2_receipt_id AND m.installation_id=i.id AND r.installation_generation=i.generation))
    OR ${receipts.map(([topic, table]) => `(topic='${topic}' AND EXISTS(SELECT 1 FROM ${table} r WHERE r.id=slack_round2_receipt_id AND r.installation_id=i.id AND r.installation_generation=i.generation))`).join(" OR ")}
    OR (topic='slack_unfurl' AND EXISTS(SELECT 1 FROM slack_unfurls r WHERE r.id=json_extract(outbox.payload_json,'$.unfurlId') AND r.installation_id=i.id AND r.installation_generation=i.generation))
    OR (topic='slack_thread_reply' AND EXISTS(SELECT 1 FROM slack_thread_deliveries d JOIN slack_thread_links r ON r.id=d.link_id
      WHERE d.id=json_extract(outbox.payload_json,'$.deliveryId') AND r.installation_id=i.id AND r.installation_generation=i.generation))
    OR (topic='slack_inbound_reply' AND EXISTS(SELECT 1 FROM slack_inbound_receipts r
      WHERE r.id=json_extract(outbox.payload_json,'$.receiptId') AND r.installation_id=i.id
        AND json_extract(r.payload_json,'$.generation')=i.generation))
    OR (topic='slack_thread_action' AND EXISTS(SELECT 1 FROM slack_interaction_receipts r
      WHERE r.id=json_extract(outbox.payload_json,'$.receiptId') AND r.installation_id=i.id
        AND json_extract(r.payload_json,'$.generation')=i.generation))`;
}

export function slackScopePauseStatement(
  env: Env,
  fence: { sql: string; binds: unknown[] },
  scopes: SlackScopeRequirements,
  credentialRevision: number,
  extraGuard = "1",
  now = Date.now(),
) {
  return env.DB.prepare(`UPDATE outbox SET slack_scope_paused_at=coalesce(slack_scope_paused_at,?),slack_scope_required_json=?,
    enqueued_at=coalesce(enqueued_at,?),slack_claim_recheck_at=NULL,
    slack_redrive_due_at=CASE WHEN ${ROUND2_OUTBOX_SQL} THEN coalesce(slack_redrive_due_at,?+1800000) ELSE NULL END,
    last_error=CASE WHEN ${ROUND2_OUTBOX_SQL} AND last_error='slack_validation_stale' THEN last_error ELSE 'slack_scope_missing' END
    WHERE ${fence.sql} AND ${extraGuard} AND EXISTS(SELECT 1 FROM slack_installations i
      WHERE i.workspace_id=outbox.workspace_id AND i.disconnected_at IS NULL AND i.credential_revision=?
        AND (${slackOutboxInstallationMatchSql()}))`).bind(
    now,
    JSON.stringify(scopes),
    now,
    now,
    ...fence.binds,
    credentialRevision,
  );
}

export const PERMANENT_SLACK_VALIDATION_ERRORS = [
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "shared_channel",
  "unsupported_channel_type",
];

export const SLACK_MIRROR_SCOPES = [
  "chat:write",
  "channels:read",
  "groups:read",
  "channels:history",
  "groups:history",
  "users:read",
] as const;

export const round2Receipts = {
  slack_bulk: { table: "slack_bulk_receipts", key: "summaryId", state: "state" },
  slack_channel: { table: "slack_channel_events", key: "eventId", state: "round2_state" },
  slack_digest: { table: "slack_digest_receipts", key: "digestId", state: "state" },
  slack_share_refresh: { table: "slack_share_refreshes", key: "refreshId", state: "state" },
  slack_file_upload: { table: "slack_file_artifacts", key: "artifactId", state: "state" },
} as const;
export const ROUND2_TOPICS_SQL = Object.keys(round2Receipts)
  .map((topic) => `'${topic}'`)
  .join(",");
export const ROUND2_NON_CHANNEL_TOPICS_SQL = Object.keys(round2Receipts)
  .filter((topic) => topic !== "slack_channel")
  .map((topic) => `'${topic}'`)
  .join(",");
export const ROUND2_OUTBOX_SQL = `topic IN (${ROUND2_TOPICS_SQL})`;

export function slackDeliveryFeatures(env: Env) {
  const validation = env.SLACK_CHANNEL_VALIDATION_ENABLED === "true";
  const rich = env.SLACK_RICH_DIGESTS_ENABLED === "true";
  const activity = env.WORKSPACE_ACTIVITY_ENABLED === "true";
  return {
    slack_channel: validation,
    slack_bulk: validation,
    slack_digest: validation && (!rich || activity),
    slack_share_refresh: env.SLACK_SHARE_REFRESH_ENABLED === "true",
    slack_file_upload: validation && rich && activity,
  } satisfies Record<keyof typeof round2Receipts, boolean>;
}

export function thumbnailDeliveryEnabled(env: Env) {
  return slackDeliveryFeatures(env).slack_file_upload;
}

export function slackDeliveryRecheck(
  status: { outcome: DeliveryOutcome; claimed_at?: number | null },
  now = Date.now(),
) {
  return status.outcome === "completed"
    ? null
    : status.outcome === "competing"
      ? Math.max(now + 1_000, (status.claimed_at ?? now) + 60_000)
      : now + (status.outcome === "paused" || status.outcome === "uncertain" ? 30 * 60_000 : 60_000);
}

// Keep health and enqueue selection aligned during deliberate feature pauses.
export function runnableOutboxSql(env: Env) {
  const features = slackDeliveryFeatures(env);
  return `slack_scope_paused_at IS NULL
    ${Object.entries(features)
      .map(([topic, enabled]) => `AND (topic<>'${topic}' OR ${enabled ? 1 : 0}=1)`)
      .join("\n")}
    AND (topic<>'slack_channel' OR NOT EXISTS(
      SELECT 1 FROM slack_channel_events blocked WHERE blocked.id=outbox.slack_round2_receipt_id AND blocked.round2_state='blocked'))`;
}

export function mappingDeliveryPauseSql(alias: string, now: string | number) {
  return `(${alias}.muted_at IS NOT NULL OR coalesce(${alias}.snoozed_until,0)>${now}
    OR (${alias}.notification_blocked_at IS NOT NULL AND NOT coalesce(
      ${alias}.notification_error=${alias}.validation_error AND ${alias}.validation_error IN (${PERMANENT_SLACK_VALIDATION_ERRORS.map((error) => `'${error}'`).join(",")}),0)))`;
}

// Pauses preserve only a current artifact with an otherwise usable destination.
// Use the same evidence in delivery and recovery, including mixed mappings.
export function thumbnailEligibilitySql(artifact = "r", now = Date.now()) {
  const destination = `SELECT 1 FROM pages p JOIN diagram_projections d ON d.page_id=p.id AND d.content_epoch=p.content_epoch
    JOIN slack_channel_subscriptions m ON m.space_id=p.space_id AND (m.page_id IS NULL OR m.page_id=p.id)
    JOIN slack_installations installation ON installation.id=m.installation_id
    WHERE p.id=${artifact}.page_id AND p.content_epoch=${artifact}.content_epoch AND d.thumbnail_hash=${artifact}.content_sha256
      AND d.thumbnail_r2_key=${artifact}.thumbnail_r2_key AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template=0
      AND installation.id=${artifact}.installation_id AND installation.generation=${artifact}.installation_generation
      AND installation.disconnected_at IS NULL AND m.cadence='digest'
      AND (m.validation_state='valid' OR ${mappingDeliveryPauseSql("m", now)})
      AND EXISTS(SELECT 1 FROM workspace_members owner WHERE owner.workspace_id=p.workspace_id AND owner.user_id=m.created_by AND owner.role='owner')`;
  return `CASE WHEN NOT EXISTS(${destination}) THEN 'obsolete'
    WHEN EXISTS(${destination} AND installation.auth_error IS NULL AND m.validation_state='valid' AND m.notification_blocked_at IS NULL
      AND NOT ${mappingDeliveryPauseSql("m", now)}) THEN 'ready' ELSE 'paused' END`;
}

function slackDeliveryScopes(topic: string, method?: string): readonly string[] {
  if (["slack_thread_reply", "slack_inbound_reply", "slack_thread_action"].includes(topic)) return SLACK_MIRROR_SCOPES;
  if (method?.startsWith("files.") || topic === "slack_file_upload") return ["files:write"];
  if (method === "chat.unfurl" || topic === "slack_unfurl") return ["links:write"];
  if (method === "conversations.info") return ["channels:read", "groups:read"];
  if (method === "conversations.history" || method === "conversations.replies")
    return ["channels:history", "groups:history"];
  if (method === "users.info") return ["users:read"];
  if (method?.startsWith("chat.")) return ["chat:write"];
  if (topic === "slack_digest" || topic === "slack_bulk")
    return ["chat:write", "channels:read", "groups:read", "channels:history", "groups:history"];
  if (topic === "slack_share_refresh")
    return ["links:write", "chat:write", "channels:read", "groups:read", "channels:history", "groups:history"];
  return ["chat:write"];
}

// Clauses are cumulative; scopes within each clause are alternatives. Slack's
// conversations API reports channel-type alternatives, including unsupported DMs.
export type SlackScopeRequirements = readonly (readonly string[])[];
const scopeFamilies = [
  ["channels:read", "groups:read", "im:read", "mpim:read"],
  ["channels:history", "groups:history", "im:history", "mpim:history"],
] as const;

export function slackScopeRequirements(
  topic: string,
  method?: string,
  needed: readonly string[] = [],
  channelType?: string | null,
): SlackScopeRequirements {
  const scopes = needed.length ? needed : slackDeliveryScopes(topic, method);
  const clauses: string[][] = [];
  for (const scope of new Set(scopes)) {
    const family = scopeFamilies.find((candidate) => candidate.some((value) => value === scope));
    const supported = family?.slice(0, 2).filter((value) => scopes.includes(value));
    const selected =
      supported && supported.length > 1
        ? channelType === "public_channel"
          ? [supported[0]!]
          : channelType === "private_channel"
            ? [supported[1]!]
            : supported
        : supported?.length
          ? supported
          : [scope];
    for (const required of selected) {
      if (!clauses.some((prior) => prior.length === 1 && prior[0] === required)) clauses.push([required]);
    }
  }
  if (["slack_thread_reply", "slack_inbound_reply", "slack_thread_action", "slack_unfurl"].includes(topic))
    for (const scope of slackDeliveryScopes(topic))
      if (!clauses.some((clause) => clause.length === 1 && clause[0] === scope)) clauses.push([scope]);
  return clauses;
}

// Validate the nested scope clauses before using the current topic requirements.
const validStored = `CASE WHEN json_valid(slack_scope_required_json) THEN slack_scope_required_json ELSE '[]' END`;
const fallbackSql = `CASE topic ${[
  "slack_thread_reply",
  "slack_inbound_reply",
  "slack_thread_action",
  "slack_file_upload",
  "slack_unfurl",
  "slack_digest",
  "slack_bulk",
  "slack_share_refresh",
]
  .map((topic) => `WHEN '${topic}' THEN '${JSON.stringify(slackScopeRequirements(topic))}'`)
  .join(" ")}
 ELSE '[["chat:write"]]' END`;
const storedScopesSql = `CASE WHEN json_type(${validStored})='array' AND json_array_length(${validStored})>0
 AND NOT EXISTS(SELECT 1 FROM json_each(${validStored}) item WHERE item.type<>'array'
   OR json_array_length(item.value)=0 OR EXISTS(SELECT 1 FROM json_each(item.value) child WHERE child.type<>'text' OR length(child.value)=0))
 THEN ${validStored} ELSE ${fallbackSql} END`;
const SLACK_OUTBOX_CHANNEL_TYPE_SQL = `CASE outbox.topic
 WHEN 'slack_channel' THEN (SELECT m.channel_type FROM slack_channel_events r JOIN slack_channel_subscriptions m ON m.id=r.subscription_id WHERE r.id=outbox.slack_round2_receipt_id)
 WHEN 'slack_digest' THEN (SELECT m.channel_type FROM slack_digest_receipts r JOIN slack_channel_subscriptions m ON m.id=r.subscription_id WHERE r.id=outbox.slack_round2_receipt_id)
 WHEN 'slack_bulk' THEN (SELECT m.channel_type FROM slack_bulk_receipts r JOIN slack_channel_subscriptions m ON m.installation_id=r.installation_id AND m.channel_id=r.channel_id WHERE r.id=outbox.slack_round2_receipt_id LIMIT 1)
 WHEN 'slack_share_refresh' THEN (SELECT m.channel_type FROM slack_share_refreshes r JOIN slack_channel_subscriptions m ON m.installation_id=r.installation_id AND m.channel_id=r.channel_id WHERE r.id=outbox.slack_round2_receipt_id LIMIT 1)
 END`;
const pausedClausesSql = `SELECT required.value clause FROM json_each(${storedScopesSql}) required
 UNION SELECT json_array(value) FROM json_each(CASE
   WHEN topic IN ('slack_thread_reply','slack_inbound_reply','slack_thread_action') THEN '${JSON.stringify(SLACK_MIRROR_SCOPES)}'
   WHEN topic='slack_unfurl' THEN '["links:write"]' ELSE '[]' END)`;
// A public/private alternative is narrowed using the actual destination. Unknown
// destinations retain both requirements rather than resuming with the wrong family.
export const SLACK_PAUSED_SCOPES_SQL = `(WITH clauses AS (${pausedClausesSql}),
 context AS (SELECT ${SLACK_OUTBOX_CHANNEL_TYPE_SQL} channel_type), expanded AS (
 SELECT CASE WHEN json_array_length(clause)>1 AND alternative.value IN
 ('channels:read','groups:read','channels:history','groups:history') THEN json_array(alternative.value) ELSE clause END clause
 FROM clauses,json_each(clauses.clause) alternative,context
 WHERE json_array_length(clauses.clause)=1 OR alternative.value NOT IN ('channels:read','groups:read','channels:history','groups:history')
   OR context.channel_type IS NULL OR context.channel_type NOT IN ('public_channel','private_channel')
   OR (context.channel_type='public_channel' AND alternative.value LIKE 'channels:%')
   OR (context.channel_type='private_channel' AND alternative.value LIKE 'groups:%'))
 SELECT json_group_array(json(clause)) FROM (SELECT DISTINCT clause FROM expanded))`;

export function slackScopesGrantedSql(requirements: string, granted: string) {
  return `NOT EXISTS(SELECT 1 FROM json_each(${requirements}) clause WHERE NOT EXISTS(
    SELECT 1 FROM json_each(clause.value) alternative WHERE alternative.value IN (SELECT value FROM json_each(${granted}))))`;
}

export function round2WakeStatement(
  env: Env,
  mappingId: string | null,
  installationId: string | null = null,
  generation: number | null = null,
) {
  const now = Date.now();
  return env.DB.prepare(`UPDATE outbox SET attempts=attempts+1,enqueued_at=NULL,available_at=?,slack_redrive_due_at=NULL,slack_claim_recheck_at=NULL
    WHERE slack_scope_paused_at IS NULL AND EXISTS(SELECT 1 FROM slack_channel_subscriptions m
      JOIN slack_installations i ON i.id=m.installation_id WHERE (? IS NULL OR m.id=?) AND (? IS NULL OR i.id=?)
      AND (? IS NULL OR i.generation=?) AND m.notification_blocked_at IS NULL
      AND m.muted_at IS NULL AND coalesce(m.snoozed_until,0)<=? AND i.disconnected_at IS NULL AND i.auth_error IS NULL AND (
      (topic='slack_channel' AND EXISTS(SELECT 1 FROM slack_channel_events r WHERE r.id=slack_round2_receipt_id AND r.subscription_id=m.id AND r.round2_state='pending' AND r.suppressed_at IS NULL AND r.delivered_at IS NULL AND coalesce(r.claimed_at,0)<?)) OR
      (topic='slack_digest' AND (outbox.id='outbox:'||slack_round2_receipt_id OR enqueued_at IS NULL OR slack_redrive_due_at IS NOT NULL OR slack_claim_recheck_at IS NOT NULL) AND EXISTS(SELECT 1 FROM slack_digest_receipts r WHERE r.id=slack_round2_receipt_id AND r.subscription_id=m.id AND r.state='pending' AND coalesce(r.claimed_at,0)<? AND NOT EXISTS(SELECT 1 FROM slack_digest_messages child WHERE child.receipt_id=r.id AND child.state='sending'))) OR
      (topic='slack_bulk' AND EXISTS(SELECT 1 FROM slack_bulk_receipts r WHERE r.id=slack_round2_receipt_id AND r.installation_id=i.id AND r.channel_id=m.channel_id AND r.state='pending' AND coalesce(r.claimed_at,0)<?
        AND EXISTS(SELECT 1 FROM slack_channel_events event WHERE event.summary_id=r.id AND event.subscription_id=m.id
          AND event.round2_state='pending' AND event.delivered_at IS NULL AND event.suppressed_at IS NULL))) OR
      (topic='slack_share_refresh' AND EXISTS(SELECT 1 FROM slack_share_refreshes r WHERE r.id=slack_round2_receipt_id AND r.installation_id=i.id AND r.channel_id=m.channel_id AND r.state='pending' AND coalesce(r.claimed_at,0)<?)) OR
      (topic='slack_file_upload' AND EXISTS(SELECT 1 FROM slack_file_artifacts r JOIN pages p ON p.id=r.page_id WHERE r.id=slack_round2_receipt_id AND r.installation_id=i.id AND p.space_id=m.space_id AND (m.page_id IS NULL OR m.page_id=p.id) AND r.state='pending' AND coalesce(r.claimed_at,0)<?))))`).bind(
    now,
    mappingId,
    mappingId,
    installationId,
    installationId,
    generation,
    generation,
    now,
    ...Array(5).fill(now - 60_000),
  );
}

export async function resumeSlackFileCleanup(env: Env, workspaceId: string) {
  await env.DB.prepare(`UPDATE slack_file_cleanup_jobs SET state='pending',next_attempt_at=?,updated_at=?
    WHERE workspace_id=? AND state='paused' AND attempt_count<2 AND EXISTS(
      SELECT 1 FROM slack_installations i WHERE i.workspace_id=slack_file_cleanup_jobs.workspace_id
      AND i.team_id=slack_file_cleanup_jobs.team_id AND i.bot_user_id=slack_file_cleanup_jobs.bot_user_id
      AND i.disconnected_at IS NULL AND i.auth_error IS NULL AND i.file_scope_error_revision IS NULL AND instr(','||i.scopes||',',',files:write,')>0)`)
    .bind(Date.now(), Date.now(), workspaceId)
    .run();
}

export const PENDING_SHARE_RESPONSE_SQL = `EXISTS(SELECT 1 FROM slack_installations i JOIN slack_interaction_receipts receipt ON receipt.installation_id=i.id
  WHERE json_valid(outbox.payload_json) AND i.id=json_extract(outbox.payload_json,'$.installationId')
    AND i.generation=json_extract(outbox.payload_json,'$.generation') AND i.workspace_id=outbox.workspace_id
    AND i.disconnected_at IS NULL AND i.auth_error IS NULL AND instr(','||i.scopes||',',',chat:write,')>0
    AND receipt.id=json_extract(outbox.payload_json,'$.receiptId') AND receipt.outcome='accepted' AND receipt.denial_sent_at IS NULL
    AND (receipt.response_delivery_state='pending' OR (receipt.response_delivery_state IS NULL AND receipt.response_delivery_attempted_at IS NULL)))`;

export function startSlackShareEligibleClockStatement(
  env: Env,
  id: string,
  now: number,
  fence: { sql: string; binds: unknown[] },
) {
  return env.DB.prepare(`UPDATE outbox SET slack_eligible_started_at=?,slack_scope_paused_ms=0,
    slack_auth_pause_baseline_ms=(SELECT i.auth_paused_ms FROM slack_installations i WHERE i.workspace_id=outbox.workspace_id AND i.disconnected_at IS NULL)
    WHERE id=? AND topic='slack_share_response' AND json_valid(payload_json) AND slack_eligible_started_at IS NULL AND slack_scope_paused_at IS NULL
      AND ${PENDING_SHARE_RESPONSE_SQL} AND (${fence.sql})`).bind(now, id, ...fence.binds);
}

export async function prepareSlackScopePause(
  env: Env,
  outboxId: string,
  topic: string,
  error: { method?: string; neededScopes?: readonly string[]; credentialRevision: number | null },
  fence: { sql: string; binds: unknown[] },
  extraGuard = "1",
) {
  if (error.credentialRevision === null) return undefined;
  const destination = await env.DB.prepare(
    `SELECT ${SLACK_OUTBOX_CHANNEL_TYPE_SQL} channel_type FROM outbox WHERE id=?`,
  )
    .bind(outboxId)
    .first<{ channel_type: string | null }>();
  return slackScopePauseStatement(
    env,
    fence,
    slackScopeRequirements(topic, error.method, error.neededScopes ?? [], destination?.channel_type),
    error.credentialRevision,
    extraGuard,
  ).run();
}
