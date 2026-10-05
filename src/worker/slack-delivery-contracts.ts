import type { Env } from "./env";

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
export const ROUND2_OUTBOX_SQL = `(topic IN (${ROUND2_NON_CHANNEL_TOPICS_SQL})
 OR (topic='slack_channel' AND slack_round2_receipt_id LIKE 'activity:%'))`;

export function thumbnailDeliveryEnabled(env: Env) {
  return (
    env.SLACK_RICH_DIGESTS_ENABLED === "true" &&
    env.SLACK_CHANNEL_VALIDATION_ENABLED === "true" &&
    env.WORKSPACE_ACTIVITY_ENABLED === "true"
  );
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

// Validate the entire stored format before falling back for older/corrupt rows.
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
  .map((topic) => `WHEN '${topic}' THEN '${JSON.stringify(slackDeliveryScopes(topic))}'`)
  .join(" ")}
 ELSE '[["chat:write"]]' END`;
const storedScopesSql = `CASE WHEN json_type(${validStored})='array' AND json_array_length(${validStored})>0
 AND (SELECT count(DISTINCT type) FROM json_each(${validStored}))=1
 AND NOT EXISTS(SELECT 1 FROM json_each(${validStored}) item WHERE
   item.type NOT IN ('text','array') OR (item.type='text' AND length(item.value)=0) OR
   (item.type='array' AND (json_array_length(item.value)=0 OR EXISTS(SELECT 1 FROM json_each(item.value) child WHERE child.type<>'text' OR length(child.value)=0))))
 THEN ${validStored} ELSE ${fallbackSql} END`;

// Convert legacy flat conversation families to clauses without broadening a
// single explicitly reported channel scope. New nested clauses pass through.
function clauseSql(value: string, type: string, requirements: string) {
  return `CASE WHEN ${type}='array' THEN ${value} ${scopeFamilies
    .map((family) => {
      const all = family.map((scope) => `'${scope}'`).join(",");
      const supported = family
        .slice(0, 2)
        .map((scope) => `'${scope}'`)
        .join(",");
      return `WHEN ${value} IN (${all}) AND EXISTS(SELECT 1 FROM json_each(${requirements}) member WHERE member.type='text' AND member.value IN (${supported}))
      THEN (SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(${requirements}) WHERE type='text' AND value IN (${supported}) ORDER BY value))`;
    })
    .join(" ")} ELSE json_array(${value}) END`;
}
export const SLACK_OUTBOX_CHANNEL_TYPE_SQL = `CASE outbox.topic
 WHEN 'slack_channel' THEN (SELECT m.channel_type FROM slack_channel_events r JOIN slack_channel_subscriptions m ON m.id=r.subscription_id WHERE r.id=outbox.slack_round2_receipt_id)
 WHEN 'slack_digest' THEN (SELECT m.channel_type FROM slack_digest_receipts r JOIN slack_channel_subscriptions m ON m.id=r.subscription_id WHERE r.id=outbox.slack_round2_receipt_id)
 WHEN 'slack_bulk' THEN (SELECT m.channel_type FROM slack_bulk_receipts r JOIN slack_channel_subscriptions m ON m.installation_id=r.installation_id AND m.channel_id=r.channel_id WHERE r.id=outbox.slack_round2_receipt_id LIMIT 1)
 WHEN 'slack_share_refresh' THEN (SELECT m.channel_type FROM slack_share_refreshes r JOIN slack_channel_subscriptions m ON m.installation_id=r.installation_id AND m.channel_id=r.channel_id WHERE r.id=outbox.slack_round2_receipt_id LIMIT 1)
 END`;
const pausedClausesSql = `SELECT ${clauseSql("required.value", "required.type", storedScopesSql)} clause FROM json_each(${storedScopesSql}) required
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
      (topic='slack_digest' AND (outbox.id='outbox:'||slack_round2_receipt_id OR enqueued_at IS NULL OR slack_redrive_due_at IS NOT NULL OR slack_claim_recheck_at IS NOT NULL) AND EXISTS(SELECT 1 FROM slack_digest_receipts r WHERE r.id=slack_round2_receipt_id AND r.subscription_id=m.id AND r.state='pending' AND coalesce(r.claimed_at,0)<? AND NOT EXISTS(SELECT 1 FROM slack_digest_messages child WHERE child.receipt_id=r.id AND child.state IN ('sending','blocked')))) OR
      (topic='slack_bulk' AND EXISTS(SELECT 1 FROM slack_bulk_receipts r WHERE r.id=slack_round2_receipt_id AND r.installation_id=i.id AND r.channel_id=m.channel_id AND r.state='pending' AND coalesce(r.claimed_at,0)<?)) OR
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
