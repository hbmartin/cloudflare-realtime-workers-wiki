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

export function slackDeliveryScopes(topic: string, method?: string): readonly string[] {
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

// Legacy paused rows have no saved rejection scopes. Keep their topic contract as the fallback.
const storedScopesSql = `CASE WHEN json_valid(slack_scope_required_json)
 AND json_type(CASE WHEN json_valid(slack_scope_required_json) THEN slack_scope_required_json ELSE '[]' END)='array'
 AND json_array_length(CASE WHEN json_valid(slack_scope_required_json) THEN slack_scope_required_json ELSE '[]' END)>0
 THEN slack_scope_required_json ELSE CASE topic ${[
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
 ELSE '["chat:write"]' END END`;

export const SLACK_PAUSED_SCOPES_SQL = `(SELECT json_group_array(value) FROM (
 SELECT value FROM json_each(${storedScopesSql})
 UNION SELECT value FROM json_each(CASE
   WHEN topic IN ('slack_thread_reply','slack_inbound_reply','slack_thread_action') THEN '${JSON.stringify(SLACK_MIRROR_SCOPES)}'
   WHEN topic='slack_unfurl' THEN '["links:write"]' ELSE '[]' END)))`;
