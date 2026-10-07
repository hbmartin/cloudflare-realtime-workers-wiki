import {
  slackOutboxSnapshotFields,
  slackOutboxSnapshotSql,
  slackOutboxSnapshotBinds,
  slackOutboxFence,
  startSlackShareEligibleClockStatement,
  type SlackOutboxSnapshot,
} from "./slack-delivery-contracts";
import { outboxEnqueueRetryAt, reportPersistentEnqueueFailure } from "./outbox-retry";
import { safeTelemetryErrorMessage } from "./observability";
import type { Env } from "./env";

export const SLACK_REDRIVE_STALE_MS = 30 * 60_000;

// Both direct producers and the sweeper publish only after committing the schedule.
export async function publishSlackOutbox(
  env: Env,
  row: SlackOutboxSnapshot & { topic: string },
  correlationId?: string,
) {
  const now = Date.now();
  const staged = await env.DB.prepare(`UPDATE outbox SET attempts=attempts+1,enqueued_at=?,last_error=NULL,
    slack_redrive_due_at=max(coalesce(slack_redrive_due_at,0),?),slack_claim_recheck_at=NULL,slack_enqueue_failure_count=0
    WHERE ${slackOutboxSnapshotSql} RETURNING ${slackOutboxSnapshotFields.join(",")}`)
    .bind(now, now + SLACK_REDRIVE_STALE_MS, ...slackOutboxSnapshotBinds(row))
    .first<SlackOutboxSnapshot>();
  if (!staged) return;
  const fence = slackOutboxFence(staged);
  try {
    if (row.topic === "slack_share_response")
      await startSlackShareEligibleClockStatement(env, row.id, now, fence).run();
    await env.DELIVERY_QUEUE.send({ outboxId: row.id, ...(correlationId ? { correlationId } : {}) });
  } catch (error) {
    const failures = row.slack_enqueue_failure_count + 1;
    const failed = await env.DB.prepare(`UPDATE outbox SET enqueued_at=NULL,slack_redrive_due_at=NULL,
      available_at=?,last_error=?,slack_enqueue_failure_count=?
      WHERE ${fence.sql} RETURNING last_error`)
      .bind(
        outboxEnqueueRetryAt(failures),
        safeTelemetryErrorMessage(error, "Queue enqueue failed."),
        failures,
        ...fence.binds,
      )
      .first<{ last_error: string | null }>();
    if (failed) reportPersistentEnqueueFailure(env, row.id, failures, failed.last_error);
    throw error;
  }
}
