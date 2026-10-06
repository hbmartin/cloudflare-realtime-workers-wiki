import { logger } from "./observability";
import { mappingDeliveryPauseSql } from "./slack-delivery-contracts";
import type { Env } from "./env";
import { sha256Hex } from "../shared/import-integrity";
import { DeliveryInProgressError } from "./notifications";
import { round2Installation, validateMappingEvidence, StaleSlackValidationError } from "./slack-channels";
import { reconcileBotPost } from "./slack-digests";
import {
  SlackDispatchSkippedError,
  definiteSlackRejection,
  invalidSlackDestination,
  recordDeliveryError,
  recordPermanentDeliveryFailure,
  retireObsoleteReceipt,
} from "./slack-delivery";
import { slackApi, SlackApiError, SlackRateLimitError, slackBulkCandidateSql } from "./slack";

type Summary = {
  id: string;
  installation_id: string;
  installation_generation: number;
  channel_id: string;
  event_type: string;
  state: string;
  event_ids_json: string;
  attempted_at: number | null;
};
// Maintenance may retire denied events, but never claims or reconciles a post.
export async function cleanupPendingBulkEvents(env: Env) {
  const stale = Date.now() - 60_000;
  const cursor = await env.DB.prepare(
    "SELECT bulk_cleanup_created_at,bulk_cleanup_event_id FROM round2_runtime WHERE id=1",
  ).first<{ bulk_cleanup_created_at: number; bulk_cleanup_event_id: string }>();
  const examined =
    await env.DB.prepare(`SELECT e.id,r.id receipt_id,e.created_at,r.claim_token,r.claimed_at,r.installation_generation,r.channel_id,r.event_type,
      r.state='pending' AND (r.claimed_at IS NULL OR r.claimed_at<=?) AND NOT coalesce((${slackBulkCandidateSql}),0) cleanable
    FROM slack_channel_events e INDEXED BY slack_bulk_pending_cleanup LEFT JOIN slack_bulk_receipts r ON r.id=e.summary_id
    LEFT JOIN slack_channel_subscriptions m ON m.id=e.subscription_id LEFT JOIN pages page ON page.id=e.page_id
    LEFT JOIN slack_installations installation ON installation.id=m.installation_id
    WHERE e.summary_id IS NOT NULL AND e.round2_state='pending' AND e.delivered_at IS NULL AND e.suppressed_at IS NULL
      AND (e.created_at,e.id)>(?,?) ORDER BY e.created_at,e.id LIMIT 200`)
      .bind(stale, cursor?.bulk_cleanup_created_at ?? 0, cursor?.bulk_cleanup_event_id ?? "")
      .all<{
        id: string;
        receipt_id: string | null;
        created_at: number;
        claim_token: string | null;
        claimed_at: number | null;
        installation_generation: number | null;
        channel_id: string | null;
        event_type: string | null;
        cleanable: number | null;
      }>();
  const captured = JSON.stringify(examined.results.filter((row) => row.cleanable === 1));
  const result = await env.DB.prepare(`UPDATE slack_channel_events SET round2_state='retired',suppressed_at=?
    WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?))
      AND round2_state='pending' AND delivered_at IS NULL AND suppressed_at IS NULL
      AND EXISTS(SELECT 1 FROM json_each(?) captured JOIN slack_bulk_receipts r ON r.id=json_extract(captured.value,'$.receipt_id')
        WHERE json_extract(captured.value,'$.id')=slack_channel_events.id AND slack_channel_events.summary_id=r.id AND r.state='pending'
          AND r.claim_token IS json_extract(captured.value,'$.claim_token') AND r.claimed_at IS json_extract(captured.value,'$.claimed_at')
          AND (r.claimed_at IS NULL OR r.claimed_at<=?)
          AND r.installation_generation=json_extract(captured.value,'$.installation_generation')
          AND r.channel_id=json_extract(captured.value,'$.channel_id') AND r.event_type=json_extract(captured.value,'$.event_type'))
      AND NOT EXISTS(SELECT 1 FROM slack_channel_events e JOIN slack_bulk_receipts r ON r.id=e.summary_id
        JOIN slack_channel_subscriptions m ON m.id=e.subscription_id JOIN pages page ON page.id=e.page_id
        JOIN slack_installations installation ON installation.id=m.installation_id
        WHERE e.id=slack_channel_events.id AND ${slackBulkCandidateSql})`)
    .bind(Date.now(), captured, captured, stale)
    .run();
  const last = examined.results.at(-1);
  await env.DB.prepare(`UPDATE round2_runtime SET bulk_cleanup_created_at=?,bulk_cleanup_event_id=?
    WHERE id=1 AND bulk_cleanup_created_at=? AND bulk_cleanup_event_id=?`)
    .bind(
      last?.created_at ?? 0,
      last?.id ?? "",
      cursor?.bulk_cleanup_created_at ?? 0,
      cursor?.bulk_cleanup_event_id ?? "",
    )
    .run();
  logger.info("slack.bulk.cleanup", "slack", "Examined pending bulk events.", {
    examined: examined.results.length,
    retired: result.meta.changes,
    cursor: last?.id ?? "",
  });
}

export async function deliverBulkSummary(env: Env, id: string, reconcileOnly = false) {
  let row = await env.DB.prepare("SELECT * FROM slack_bulk_receipts WHERE id=?").bind(id).first<Summary>();
  if (!row || ["sent", "retired"].includes(row.state) || (row.state === "blocked" && !reconcileOnly)) return;
  if (reconcileOnly && !["sending", "blocked"].includes(row.state)) return;
  const installation = await round2Installation(env, row.installation_id, row.installation_generation);
  if (!installation) {
    await retireObsoleteReceipt(env, "slack_bulk_receipts", id, row.installation_id, row.installation_generation);
    return;
  }
  const token = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE slack_bulk_receipts SET claim_token=?,claimed_at=? WHERE id=? AND state IN ('pending','sending'${reconcileOnly ? ",'blocked'" : ""}) AND (claimed_at IS NULL OR claimed_at<?)`,
  )
    .bind(token, Date.now(), id, Date.now() - 60_000)
    .run();
  if (!claimed.meta.changes) throw new DeliveryInProgressError();
  const finish = async (state: string, ts: string | null = null) =>
    env.DB.batch([
      env.DB.prepare(
        `UPDATE slack_channel_events SET delivered_at=CASE WHEN ?='sent' THEN ? ELSE delivered_at END,
          round2_state=?,suppressed_at=CASE WHEN ?='retired' THEN coalesce(suppressed_at,?) ELSE suppressed_at END
          WHERE summary_id=? AND delivered_at IS NULL AND (?='sent' OR suppressed_at IS NULL)
            AND (?='retired' OR id IN (SELECT value FROM json_each((SELECT event_ids_json FROM slack_bulk_receipts WHERE id=? AND claim_token=?))))
            AND EXISTS(SELECT 1 FROM slack_bulk_receipts WHERE id=? AND claim_token=?)`,
      ).bind(state, Date.now(), state, state, Date.now(), id, state, state, id, token, id, token),
      env.DB.prepare(`UPDATE slack_bulk_receipts SET state=?,message_ts=? WHERE id=? AND claim_token=?`).bind(
        state,
        ts,
        id,
        token,
      ),
    ]);
  try {
    row = await env.DB.prepare("SELECT * FROM slack_bulk_receipts WHERE id=? AND claim_token=?")
      .bind(id, token)
      .first<Summary>();
    if (!row) throw new DeliveryInProgressError();
    if (row.state === "sending" || reconcileOnly) {
      if (!row.attempted_at) return;
      const ts = await reconcileBotPost(env, installation, row.channel_id, id, row.attempted_at);
      if (ts) await finish("sent", ts);
      else
        await env.DB.prepare(
          "UPDATE slack_bulk_receipts SET state='blocked',last_error='post_unconfirmed' WHERE id=? AND claim_token=?",
        )
          .bind(id, token)
          .run();
      return;
    }
    const pauseSql = `installation.auth_error IS NOT NULL OR ${mappingDeliveryPauseSql("m", "?")}`;
    const candidateSql = `FROM slack_channel_events e
      JOIN slack_channel_subscriptions m ON m.id=e.subscription_id JOIN pages page ON page.id=e.page_id
      JOIN slack_installations installation ON installation.id=m.installation_id
      JOIN slack_bulk_receipts r ON r.id=e.summary_id
      WHERE e.summary_id=? AND r.claim_token=? AND r.state=? AND ${slackBulkCandidateSql}`;
    const candidateBinds = (expectedState: string) => [id, token, expectedState];
    const retireDenied = (expectedState: string) =>
      env.DB.prepare(`UPDATE slack_channel_events
      SET round2_state='retired',suppressed_at=coalesce(suppressed_at,?)
      WHERE summary_id=? AND round2_state='pending' AND delivered_at IS NULL AND suppressed_at IS NULL
        AND id NOT IN (SELECT e.id ${candidateSql})
        AND EXISTS(SELECT 1 FROM slack_bulk_receipts WHERE id=? AND claim_token=? AND state=?)`)
        .bind(Date.now(), id, ...candidateBinds(expectedState), id, token, expectedState)
        .run();
    const revisions = new Map<string, number>();
    const loadCandidates = (expectedState: string) =>
      env.DB.prepare(
        `SELECT e.id,e.page_id,m.id mapping_id,m.validation_state,m.validation_revision,(${pauseSql}) paused ${candidateSql} ORDER BY e.id`,
      )
        .bind(Date.now(), ...candidateBinds(expectedState))
        .all<{
          id: string;
          page_id: string;
          mapping_id: string;
          validation_state: string;
          validation_revision: number;
          paused: number;
        }>();
    const loadEvents = async (expectedState = "pending", pausedOnly = false) => {
      const candidates = await loadCandidates(expectedState);
      return {
        ...candidates,
        results: candidates.results.filter((event) =>
          pausedOnly
            ? Boolean(event.paused) || event.validation_state !== "valid"
            : !event.paused && event.validation_state === "valid",
        ),
      };
    };
    const paused = async () => (await loadEvents("pending", true)).results.length > 0;
    await retireDenied("pending");
    const candidates = await loadCandidates("pending");
    for (const mappingId of new Set(
      candidates.results.filter((event) => !event.paused).map((event) => event.mapping_id),
    )) {
      const validation = await validateMappingEvidence(env, installation, mappingId, row.channel_id);
      if (validation.outcome === "valid") revisions.set(mappingId, validation.revision);
      else if (validation.outcome === "permanent") {
        const retired =
          await env.DB.prepare(`UPDATE slack_channel_events SET round2_state='retired',suppressed_at=coalesce(suppressed_at,?)
          WHERE summary_id=? AND subscription_id=? AND round2_state='pending' AND delivered_at IS NULL AND suppressed_at IS NULL
          AND EXISTS(SELECT 1 FROM slack_bulk_receipts WHERE id=? AND claim_token=? AND state='pending')
          AND EXISTS(SELECT 1 FROM slack_channel_subscriptions m JOIN slack_installations i ON i.id=m.installation_id
            WHERE m.id=? AND m.validation_revision=? AND m.muted_at IS NULL AND coalesce(m.snoozed_until,0)<=${Date.now()}
              AND i.auth_error IS NULL AND i.disconnected_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.topic='slack_bulk' AND o.slack_round2_receipt_id=summary_id AND o.slack_scope_paused_at IS NOT NULL)`)
            .bind(Date.now(), id, mappingId, id, token, mappingId, validation.revision)
            .run();
        if (!retired.meta.changes) throw new StaleSlackValidationError();
      }
    }
    let events = await loadEvents();
    if (!events.results.length) {
      if (!(await paused())) await finish("retired");
      return;
    }
    let dispatched = false;
    try {
      const posted = await slackApi(
        env,
        installation,
        "chat.postMessage",
        { channel: row.channel_id, text: "" },
        {
          onDispatch: () => {
            dispatched = true;
          },
          beforeDispatch: async () => {
            await retireDenied("pending");
            events = await loadEvents();
            if (events.results.some((event) => revisions.get(event.mapping_id) !== event.validation_revision))
              throw new StaleSlackValidationError();
            if (!events.results.length) {
              if (!(await paused())) await finish("retired");
              throw new SlackDispatchSkippedError();
            }
            const ids = JSON.stringify(events.results.map((e) => e.id));
            const pausedIds = JSON.stringify((await loadEvents("pending", true)).results.map((e) => e.id));
            // Persist a separate delivery ID before posting the eligible subset.
            const deferredId = pausedIds === "[]" ? null : `${id}:deferred:${await sha256Hex(pausedIds)}`;
            const [checkpoint] = await env.DB.batch([
              env.DB.prepare(`UPDATE slack_bulk_receipts SET state='sending',attempted_at=?,event_ids_json=?
                WHERE id=? AND state='pending' AND claim_token=?`).bind(Date.now(), ids, id, token),
              ...(deferredId
                ? [
                    env.DB.prepare(`INSERT OR IGNORE INTO slack_bulk_receipts
                  (id,installation_id,installation_generation,channel_id,operation_id,event_type,event_ids_json,created_at)
                  SELECT ?,installation_id,installation_generation,channel_id,operation_id,event_type,?,created_at
                  FROM slack_bulk_receipts WHERE id=? AND claim_token=? AND state='sending'`).bind(
                      deferredId,
                      pausedIds,
                      id,
                      token,
                    ),
                    env.DB.prepare(`UPDATE slack_channel_events SET summary_id=?
                  WHERE summary_id=? AND delivered_at IS NULL AND suppressed_at IS NULL AND id IN (SELECT value FROM json_each(?))
                    AND EXISTS(SELECT 1 FROM slack_bulk_receipts WHERE id=? AND claim_token=? AND state='sending')
                    AND EXISTS(SELECT 1 FROM slack_bulk_receipts WHERE id=? AND state='pending')`).bind(
                      deferredId,
                      id,
                      pausedIds,
                      id,
                      token,
                      deferredId,
                    ),
                    env.DB.prepare(`INSERT OR IGNORE INTO outbox(id,workspace_id,topic,payload_json,available_at,created_at)
                  SELECT ?,?,'slack_bulk',json_object('summaryId',?),?,?
                  WHERE EXISTS(SELECT 1 FROM slack_bulk_receipts WHERE id=? AND claim_token=? AND state='sending')
                    AND EXISTS(SELECT 1 FROM slack_channel_events WHERE summary_id=? AND delivered_at IS NULL AND suppressed_at IS NULL)`).bind(
                      `outbox:${deferredId}`,
                      installation.workspace_id,
                      deferredId,
                      Date.now(),
                      Date.now(),
                      id,
                      token,
                      deferredId,
                    ),
                  ]
                : []),
              env.DB.prepare(`UPDATE slack_channel_events SET round2_state='retired',suppressed_at=coalesce(suppressed_at,?)
                WHERE summary_id=? AND delivered_at IS NULL AND suppressed_at IS NULL
                  AND id NOT IN (SELECT e.id ${candidateSql})
                  AND EXISTS(SELECT 1 FROM slack_bulk_receipts WHERE id=? AND claim_token=? AND state='sending')`).bind(
                Date.now(),
                id,
                ...candidateBinds("sending"),
                id,
                token,
              ),
            ]);
            if (!checkpoint!.meta.changes) throw new DeliveryInProgressError();
            const finalEvents = await loadCandidates("sending");
            if (finalEvents.results.some((event) => revisions.get(event.mapping_id) !== event.validation_revision))
              throw new StaleSlackValidationError();
            if (
              finalEvents.results.some((event) => event.paused || event.validation_state !== "valid") ||
              JSON.stringify(finalEvents.results.map((e) => e.id)) !== ids
            )
              throw new DeliveryInProgressError();
            const count = new Set(finalEvents.results.map((e) => e.page_id)).size;
            const text = `${count} pages ${row!.event_type === "page_archived" ? "archived" : "moved"}`;
            return {
              channel: row!.channel_id,
              text,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    verbatim: true,
                    text: `${text}\n<${new URL(env.BETTER_AUTH_URL).origin}/?view=activity|View Activity>`,
                  },
                },
              ],
              metadata: { event_type: "noteflare_bulk", event_payload: { delivery_id: id } },
              unfurl_links: false,
              unfurl_media: false,
            };
          },
        },
      );
      await finish("sent", posted.ts);
    } catch (error) {
      if (!dispatched)
        await env.DB.prepare(`UPDATE slack_bulk_receipts SET state='pending',attempted_at=NULL
        WHERE id=? AND claim_token=? AND state='sending'`)
          .bind(id, token)
          .run();
      if (error instanceof SlackDispatchSkippedError) return;
      await recordDeliveryError(env, installation, error, events.results[0]?.mapping_id, row.channel_id);
      if (error instanceof SlackApiError && error.code === "msg_too_long") {
        await recordPermanentDeliveryFailure(
          env,
          installation,
          id,
          events.results[0]!.mapping_id,
          row.channel_id,
          error.code,
        );
        await finish("retired");
        return;
      }
      if (invalidSlackDestination(error)) {
        await finish("retired");
        return;
      }
      if (error instanceof SlackRateLimitError || definiteSlackRejection(error)) {
        await env.DB.prepare(
          `UPDATE slack_bulk_receipts SET state='pending',attempted_at=NULL WHERE id=? AND claim_token=?`,
        )
          .bind(id, token)
          .run();
      }
      throw error;
    }
  } catch (error) {
    await recordDeliveryError(env, installation, error);
    throw error;
  } finally {
    await env.DB.prepare("UPDATE slack_bulk_receipts SET claim_token=NULL,claimed_at=NULL WHERE id=? AND claim_token=?")
      .bind(id, token)
      .run();
  }
}
