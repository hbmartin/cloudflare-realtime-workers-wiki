import type { Env } from "./env";
import { sha256Hex } from "../shared/import-integrity";
import { DeliveryInProgressError } from "./notifications";
import { round2Installation, validateMapping } from "./slack-channels";
import { reconcileBotPost } from "./slack-digests";
import {
  SlackDispatchSkippedError,
  definiteSlackRejection,
  invalidSlackDestination,
  recordDeliveryError,
  recordPermanentDeliveryFailure,
  retireObsoleteReceipt,
} from "./slack-delivery";
import { slackApi, SlackApiError, SlackRateLimitError, channelActivityActorAccessSql } from "./slack";

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
    const pauseSql = `installation.auth_error IS NOT NULL OR m.notification_blocked_at IS NOT NULL
      OR m.muted_at IS NOT NULL OR coalesce(m.snoozed_until,0)>?`;
    const candidateSql = `FROM slack_channel_events e
      JOIN slack_channel_subscriptions m ON m.id=e.subscription_id JOIN pages page ON page.id=e.page_id
      JOIN slack_installations installation ON installation.id=m.installation_id
      WHERE e.summary_id=? AND EXISTS(SELECT 1 FROM slack_bulk_receipts receipt WHERE receipt.id=e.summary_id AND receipt.claim_token=? AND receipt.state=? AND receipt.installation_generation=? AND receipt.installation_id=installation.id AND receipt.channel_id=? AND receipt.event_type=?) AND e.delivered_at IS NULL AND e.suppressed_at IS NULL
      AND installation.generation=? AND installation.disconnected_at IS NULL
      AND m.installation_id=? AND m.channel_id=? AND page.import_job_id IS NULL AND page.is_template=0
      AND EXISTS(SELECT 1 FROM workspace_members w WHERE w.workspace_id=? AND w.user_id=m.created_by AND w.role='owner')
      AND (${channelActivityActorAccessSql.replaceAll("event.", "e.")} OR page.archived_at IS NOT NULL OR page.space_id<>m.space_id)
      AND EXISTS(SELECT 1 FROM json_each(m.event_types_json) WHERE value=e.event_type)`;
    const candidateBinds = (expectedState: string) => [
      id,
      token,
      expectedState,
      installation.generation,
      row!.channel_id,
      row!.event_type,
      installation.generation,
      installation.id,
      row!.channel_id,
      installation.workspace_id,
    ];
    const loadCandidates = (expectedState: string) =>
      env.DB.prepare(
        `SELECT e.id,e.page_id,m.id mapping_id,m.validation_state,(${pauseSql}) paused ${candidateSql} ORDER BY e.id`,
      )
        .bind(Date.now(), ...candidateBinds(expectedState))
        .all<{ id: string; page_id: string; mapping_id: string; validation_state: string; paused: number }>();
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
    const candidates = await loadCandidates("pending");
    for (const mappingId of new Set(
      candidates.results.filter((event) => !event.paused).map((event) => event.mapping_id),
    ))
      await validateMapping(env, installation, mappingId, row.channel_id);
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
            events = await loadEvents();
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
