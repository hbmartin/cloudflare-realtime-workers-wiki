import { currentObservabilityContext } from "./observability";

// Called in the same D1 transaction as the comment mutation, before legacy fanout.
export function slackThreadFanoutStatements(
  db: D1Database,
  event: {
    workspaceId: string;
    pageId: string;
    threadId: string;
    actorId: string;
    commentId?: string;
    sourceId: string;
    refresh?: boolean;
    createdAt: number;
  },
) {
  const { workspaceId, pageId, threadId, actorId, sourceId, createdAt } = event;
  return [
    db
      .prepare(`UPDATE slack_thread_links SET state = 'retired', updated_at = ? WHERE thread_id = ? AND state IN ('pending', 'active')
      AND NOT EXISTS (SELECT 1 FROM slack_channel_subscriptions s JOIN slack_installations i ON i.id = s.installation_id
        JOIN pages p ON p.id = slack_thread_links.page_id AND p.space_id = s.space_id AND p.workspace_id = i.workspace_id
        WHERE s.id = slack_thread_links.subscription_id AND s.mirror_enabled = 1 AND s.validation_state = 'valid' AND s.channel_id = slack_thread_links.channel_id
          AND (s.page_id IS NULL OR s.page_id = p.id) AND i.disconnected_at IS NULL AND i.generation = slack_thread_links.installation_generation
          AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template = 0)`)
      .bind(createdAt, threadId),
    db
      .prepare(`INSERT OR IGNORE INTO slack_thread_links
      (id, installation_id, installation_generation, subscription_id, workspace_id, page_id, thread_id, channel_id, created_at, updated_at)
      SELECT ?, i.id, i.generation, s.id, i.workspace_id, p.id, ?, s.channel_id, ?, ?
      FROM pages p JOIN slack_installations i ON i.workspace_id = p.workspace_id AND i.disconnected_at IS NULL
      JOIN slack_channel_subscriptions s ON s.id = (
        SELECT candidate.id FROM slack_channel_subscriptions candidate
        WHERE candidate.installation_id = i.id AND candidate.space_id = p.space_id
          AND (candidate.page_id = p.id OR candidate.page_id IS NULL) AND candidate.mirror_enabled = 1
        ORDER BY candidate.page_id IS NULL, candidate.id LIMIT 1)
      WHERE p.id = ? AND p.workspace_id = ? AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template = 0
        AND s.validation_state = 'valid'
        AND s.muted_at IS NULL AND (s.snoozed_until IS NULL OR s.snoozed_until <= ?)
        AND NOT EXISTS (SELECT 1 FROM comments WHERE id = ? AND slack_source_receipt_id IS NOT NULL)`)
      .bind(
        crypto.randomUUID(),
        threadId,
        createdAt,
        createdAt,
        pageId,
        workspaceId,
        createdAt,
        event.commentId ?? null,
      ),
    db
      .prepare(`INSERT OR IGNORE INTO slack_thread_deliveries
      (id, link_id, operation, source_id, actor_id, comment_id, created_at, updated_at)
      SELECT l.id || ':root', l.id, 'root', l.thread_id, ?,
        COALESCE(?, (SELECT id FROM comments WHERE thread_id = l.thread_id AND parent_id IS NULL AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1)), ?, ?
      FROM slack_thread_links l WHERE l.thread_id = ? AND l.state = 'pending'`)
      .bind(actorId, event.commentId ?? null, createdAt, createdAt, threadId),
    db
      .prepare(`INSERT OR IGNORE INTO slack_thread_deliveries
      (id, link_id, operation, source_id, actor_id, comment_id, created_at, updated_at)
      SELECT l.id || ':' || ? || ':' || ?, l.id, ?, ?, ?, ?, ?, ? FROM slack_thread_links l
      WHERE l.thread_id = ? AND l.state IN ('pending', 'active')
        AND (? = 1 OR NOT EXISTS (SELECT 1 FROM slack_thread_deliveries root WHERE root.link_id = l.id AND root.operation = 'root' AND root.comment_id = ?))
        AND NOT EXISTS (SELECT 1 FROM comments WHERE id = ? AND slack_source_receipt_id IS NOT NULL)`)
      .bind(
        event.refresh ? "refresh" : "reply",
        sourceId,
        event.refresh ? "refresh" : "reply",
        sourceId,
        actorId,
        event.commentId ?? null,
        createdAt,
        createdAt,
        threadId,
        event.refresh ? 1 : 0,
        event.commentId ?? null,
        event.commentId ?? null,
      ),
    db
      .prepare(`INSERT OR IGNORE INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at, correlation_id)
      SELECT 'outbox:' || d.id, l.workspace_id, 'slack_thread_reply', json_object('deliveryId', d.id), ?, ?, ?
      FROM slack_thread_deliveries d JOIN slack_thread_links l ON l.id = d.link_id
      WHERE l.thread_id = ? AND d.state = 'pending'`)
      .bind(createdAt, createdAt, currentObservabilityContext()?.correlationId ?? null, threadId),
  ];
}
