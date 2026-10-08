import type { SlackVerificationSummary } from "../shared/types";
import { base64UrlToBytes, bytesToBase64Url } from "../shared/security";
import type { Env } from "./env";
import { HttpError } from "./http";
import { DeliveryInProgressError } from "./delivery-claim";
import { SlackRateLimitError, slackInstallationError, slackMissingScope } from "./slack";
import { SlackMirrorScopeError, deliverSlackThread } from "./slack-threads";
import { deliverDigest } from "./slack-digests";
import { deliverBulkSummary } from "./slack-bulk";
import { deliverShareRefresh } from "./slack-shares";
import { reconcileSlackChannelOutbox, round2DeliveryStatus } from "./slack-recovery";
import { recordSecondarySlackError } from "./slack-delivery";
import {
  prepareSlackScopePause,
  slackOutboxSnapshotFields,
  slackOutboxSnapshotSql,
  slackOutboxSnapshotBinds,
  slackDeliveryRecheck,
  type SlackOutboxSnapshot,
  type round2Receipts,
} from "./slack-delivery-contracts";
import type { VerificationBudget } from "./slack-history";
import { logger } from "./observability";

type Candidate = {
  id: string;
  topic: keyof typeof round2Receipts | "slack_thread_reply";
  created_at: number;
  installation_generation: number;
};
type Cursor = {
  mapping: string;
  generation: number;
  boundary: [number, string, string];
  after: [number, string, string] | null;
};
const tuple = (c: Candidate): [number, string, string] => [c.created_at, c.topic, c.id];
const encode = (c: Cursor) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(c)));
const validCursorTuple = (v: unknown) =>
  Array.isArray(v) &&
  v.length === 3 &&
  typeof v[0] === "number" &&
  Number.isFinite(v[0]) &&
  typeof v[1] === "string" &&
  typeof v[2] === "string";

function decode(value: string, mapping: string, generation: number): Cursor {
  try {
    const c = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as Cursor;
    if (
      c.mapping !== mapping ||
      c.generation !== generation ||
      !validCursorTuple(c.boundary) ||
      (c.after !== null && !validCursorTuple(c.after))
    )
      throw new Error();
    return c;
  } catch {
    throw new HttpError(422, "invalid_verification_cursor", "Restart verification for this mapping.");
  }
}
// Each stream keeps its destination and generation; the channel stream uses the mapping recovery index.
const candidatesSql = `SELECT id,'slack_channel' topic,created_at,installation_generation FROM slack_channel_events WHERE subscription_id=?1
  AND delivered_at IS NULL AND (round2_state IN ('sending','blocked') OR (round2_state='pending' AND attempted_at IS NOT NULL))
 UNION ALL SELECT id,'slack_digest',created_at,installation_generation FROM slack_digest_receipts WHERE subscription_id=?1
  AND (state IN ('sending','blocked') OR EXISTS(SELECT 1 FROM slack_digest_messages child WHERE child.receipt_id=slack_digest_receipts.id AND child.state='sending'))
 UNION ALL SELECT r.id,'slack_bulk',r.created_at,r.installation_generation FROM slack_bulk_receipts r JOIN slack_channel_subscriptions m
  ON m.installation_id=r.installation_id AND m.channel_id=r.channel_id WHERE m.id=?1 AND r.state IN ('sending','blocked') AND r.attempted_at IS NOT NULL
 UNION ALL SELECT r.id,'slack_share_refresh',r.created_at,r.installation_generation FROM slack_share_refreshes r JOIN slack_channel_subscriptions m
  ON m.installation_id=r.installation_id AND m.channel_id=r.channel_id WHERE m.id=?1 AND r.state IN ('sending','blocked') AND r.attempted_at IS NOT NULL
 UNION ALL SELECT d.id,'slack_thread_reply',d.created_at,l.installation_generation FROM slack_thread_deliveries d JOIN slack_thread_links l ON l.id=d.link_id
  WHERE l.subscription_id=?1 AND d.operation<>'refresh' AND (d.state='sending' OR (d.state='blocked' AND d.failure_reason LIKE 'reconciliation_%'))`;

async function verifyReceipt(env: Env, candidate: Candidate, budget: VerificationBudget) {
  if (candidate.topic === "slack_channel") return reconcileSlackChannelOutbox(env, candidate.id, { budget });
  const siblings = (
    await env.DB.prepare(`SELECT ${slackOutboxSnapshotFields.join(",")} FROM outbox
    WHERE topic=? AND ${candidate.topic === "slack_thread_reply" ? "json_extract(payload_json,'$.deliveryId')" : "slack_round2_receipt_id"}=?`)
      .bind(candidate.topic, candidate.id)
      .all<SlackOutboxSnapshot>()
  ).results;
  if (siblings.some((s) => s.slack_scope_paused_at !== null)) return "paused";
  let primary: unknown;
  try {
    if (candidate.topic === "slack_digest") await deliverDigest(env, candidate.id, true, { budget });
    else if (candidate.topic === "slack_bulk") await deliverBulkSummary(env, candidate.id, true, { budget });
    else if (candidate.topic === "slack_share_refresh") await deliverShareRefresh(env, candidate.id, true, { budget });
    else await deliverSlackThread(env, candidate.id, true, { budget });
  } catch (error) {
    primary = error;
    if (slackMissingScope(error) || error instanceof SlackMirrorScopeError)
      await recordSecondarySlackError("scope_pause", { id: candidate.id }, async () => {
        for (const s of siblings)
          await prepareSlackScopePause(env, s.id, candidate.topic, error, {
            sql: slackOutboxSnapshotSql,
            binds: slackOutboxSnapshotBinds(s),
          });
      });
  }
  try {
    const current =
      candidate.topic === "slack_thread_reply"
        ? await env.DB.prepare(`SELECT state,CASE WHEN state IN ('sent','retired') THEN 'completed'
        WHEN state='blocked' THEN 'uncertain' WHEN state='sending' THEN 'uncertain' ELSE 'retryable' END outcome
        FROM slack_thread_deliveries WHERE id=?`)
            .bind(candidate.id)
            .first<{ state: string; outcome: "completed" | "uncertain" | "retryable" }>()
        : await round2DeliveryStatus(env, candidate.topic, candidate.id);
    const due =
      !current || current.state === "blocked" || current.outcome === "completed"
        ? null
        : primary instanceof SlackRateLimitError
          ? primary.retryAt
          : slackDeliveryRecheck(current);
    if (siblings.length)
      await env.DB.batch(
        siblings.map((s) =>
          env.DB.prepare(`UPDATE outbox SET slack_redrive_due_at=?,
      slack_claim_recheck_at=NULL WHERE ${slackOutboxSnapshotSql}`).bind(due, ...slackOutboxSnapshotBinds(s)),
        ),
      );
    if (primary) throw primary;
    return current && "paused" in current && current.paused && !budget.lastResult
      ? "paused"
      : (current?.outcome ?? "completed");
  } catch (error) {
    if (primary && error !== primary)
      logger.error(
        "slack.verification.secondary_failed",
        "slack",
        "Could not refresh verification state.",
        { id: candidate.id },
        error,
      );
    throw primary ?? error;
  }
}

export async function verifySlackMapping(
  env: Env,
  mappingId: string,
  continuation?: string,
  deadline = Date.now() + 20_000,
): Promise<SlackVerificationSummary> {
  const mapping =
    await env.DB.prepare(`SELECT i.generation FROM slack_channel_subscriptions m JOIN slack_installations i
    ON i.id=m.installation_id WHERE m.id=?`)
      .bind(mappingId)
      .first<{ generation: number }>();
  if (!mapping) throw new HttpError(404, "mapping_unavailable", "This mapping is unavailable.");
  let cursor = continuation ? decode(continuation, mappingId, mapping.generation) : null;
  if (!cursor) {
    const last = await env.DB.prepare(
      `SELECT * FROM (${candidatesSql}) ORDER BY created_at DESC,topic DESC,id DESC LIMIT 1`,
    )
      .bind(mappingId)
      .first<Candidate>();
    if (!last)
      return {
        status: "complete",
        checked: 0,
        confirmed: 0,
        blocked: 0,
        pending: 0,
        paused: 0,
        nextCursor: null,
        retryAt: null,
      };
    cursor = { mapping: mappingId, generation: mapping.generation, boundary: tuple(last), after: null };
  }
  const after = cursor.after ?? [-1, "", ""];
  const rows = (
    await env.DB.prepare(`SELECT * FROM (${candidatesSql})
    WHERE (created_at,topic,id)>(?2,?3,?4) AND (created_at,topic,id)<=(?5,?6,?7)
    ORDER BY created_at,topic,id LIMIT 6`)
      .bind(mappingId, ...after, ...cursor.boundary)
      .all<Candidate>()
  ).results;
  const summary: SlackVerificationSummary = {
    status: "complete",
    checked: 0,
    confirmed: 0,
    blocked: 0,
    pending: 0,
    paused: 0,
    nextCursor: null,
    retryAt: null,
  };
  const budget: VerificationBudget = { remaining: 5, deadline };
  let lastChecked = after;
  for (const c of rows.slice(0, 5)) {
    if (Date.now() >= budget.deadline || budget.remaining <= 0) break;
    delete budget.lastResult;
    summary.checked++;
    lastChecked = tuple(c);
    // Obsolete attempts remain historical evidence, but cannot be verified with current credentials.
    if (c.installation_generation !== mapping.generation) {
      summary.blocked++;
      continue;
    }
    try {
      const outcome = await verifyReceipt(env, c, budget);
      const historyResult = (budget as VerificationBudget).lastResult;
      if (outcome === "completed" || outcome === "retryable" || historyResult?.status === "confirmed")
        summary.confirmed++;
      else if (historyResult?.status === "missing" || historyResult?.status === "ambiguous") summary.blocked++;
      else if (historyResult?.status === "incomplete") summary.pending++;
      else if (outcome === "paused") summary.paused++;
      else if (outcome === "competing") summary.pending++;
      else summary.blocked++;
    } catch (error) {
      if (error instanceof SlackRateLimitError) {
        summary.paused++;
        summary.retryAt = summary.retryAt === null ? error.retryAt : Math.min(summary.retryAt, error.retryAt);
      } else if (slackInstallationError(error) || slackMissingScope(error) || error instanceof SlackMirrorScopeError)
        summary.paused++;
      else {
        summary.pending++;
        if (!(error instanceof DeliveryInProgressError))
          logger.warn(
            "slack.verification.pending",
            "slack",
            "History verification remains pending.",
            { id: c.id },
            error,
          );
      }
    }
  }
  const remaining = await env.DB.prepare(`SELECT count(*) count FROM (${candidatesSql})
    WHERE (created_at,topic,id)>(?2,?3,?4) AND (created_at,topic,id)<=(?5,?6,?7)`)
    .bind(mappingId, ...lastChecked, ...cursor.boundary)
    .first<{ count: number }>();
  const pausedSql = `EXISTS(SELECT 1 FROM outbox o WHERE o.topic=candidate.topic
    AND (CASE WHEN o.topic='slack_thread_reply' THEN json_extract(o.payload_json,'$.deliveryId')
      ELSE o.slack_round2_receipt_id END)=candidate.id AND o.slack_scope_paused_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM slack_channel_subscriptions m JOIN slack_installations i ON i.id=m.installation_id
      WHERE m.id=?1 AND i.auth_error IS NOT NULL)`;
  const unfinished = await env.DB.prepare(`SELECT count(*) count,coalesce(sum(paused),0) paused FROM (
    SELECT candidate.*,(${pausedSql}) paused FROM (${candidatesSql}) candidate
    WHERE (created_at,topic,id)<=(?2,?3,?4) AND candidate.installation_generation=?5
      AND ((${pausedSql}) OR EXISTS(SELECT 1 FROM slack_history_verifications h
      JOIN slack_channel_subscriptions m ON m.installation_id=h.installation_id WHERE m.id=?1
      AND h.installation_generation=?5 AND h.status='incomplete' AND
      (h.delivery_id=CASE WHEN candidate.topic='slack_channel' THEN 'channel:'||candidate.id ELSE candidate.id END
        OR (candidate.topic='slack_digest' AND EXISTS(SELECT 1 FROM slack_digest_messages child
          WHERE child.receipt_id=candidate.id AND child.id=h.delivery_id))))
      OR (candidate.topic='slack_channel' AND EXISTS(SELECT 1 FROM slack_channel_events e WHERE e.id=candidate.id AND e.round2_state<>'blocked'))
      OR (candidate.topic='slack_digest' AND EXISTS(SELECT 1 FROM slack_digest_receipts r WHERE r.id=candidate.id AND r.state<>'blocked'))
      OR (candidate.topic='slack_bulk' AND EXISTS(SELECT 1 FROM slack_bulk_receipts r WHERE r.id=candidate.id AND r.state<>'blocked'))
      OR (candidate.topic='slack_share_refresh' AND EXISTS(SELECT 1 FROM slack_share_refreshes r WHERE r.id=candidate.id AND r.state<>'blocked'))
      OR (candidate.topic='slack_thread_reply' AND EXISTS(SELECT 1 FROM slack_thread_deliveries d WHERE d.id=candidate.id AND d.state='sending'))))`)
    .bind(mappingId, ...cursor.boundary, mapping.generation)
    .first<{ count: number; paused: number }>();
  summary.paused = Math.max(summary.paused, unfinished?.paused ?? 0);
  summary.pending = Math.max(
    summary.pending,
    (unfinished?.count ?? 0) - (unfinished?.paused ?? 0),
    remaining?.count ?? 0,
  );
  if (remaining?.count) summary.nextCursor = encode({ ...cursor, after: lastChecked });
  else if (summary.pending || summary.paused) summary.nextCursor = encode({ ...cursor, after: null });
  summary.status = summary.nextCursor
    ? summary.paused && !summary.confirmed && !summary.pending
      ? "paused"
      : "partial"
    : "complete";
  return summary;
}
