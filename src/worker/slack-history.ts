import { withSlackPrimaryError } from "./slack-delivery";
import type { Env } from "./env";
import { DeliveryInProgressError } from "./delivery-claim";
import {
  slackApi,
  SlackRateLimitError,
  slackInstallationError,
  definiteSlackRejection,
  type SlackInstallation,
} from "./slack";

export type HistoryVerification =
  | { status: "confirmed"; ts: string }
  | { status: "missing" | "ambiguous"; reason?: string }
  | { status: "incomplete" };
export type VerificationBudget = {
  remaining: number;
  deadline: number;
  lastResult?: HistoryVerification;
  cooldowns?: Record<string, number>;
};
export type HistoryVerificationOptions = {
  budget?: VerificationBudget;
  eventType?: string;
  fence?: { sql: string; binds: unknown[] };
};
type Progress = {
  oldest: string;
  latest: string;
  boundary: string | null;
  candidate_ts: string | null;
  status: HistoryVerification["status"];
  blocked_reason: string | null;
  revision: string;
};
const timestamp = /^\d+\.\d+$/;
// Slack timestamps are decimal strings. Avoid float rounding at microsecond boundaries.
function compare(a: string, b: string) {
  const [as, af = ""] = a.split(".");
  const [bs, bf = ""] = b.split(".");
  const aSeconds = BigInt(as!),
    bSeconds = BigInt(bs!);
  return aSeconds < bSeconds ? -1 : aSeconds > bSeconds ? 1 : af.padEnd(6, "0").localeCompare(bf.padEnd(6, "0"));
}
async function searchHistoryPage(
  env: Env,
  installation: SlackInstallation,
  channel: string,
  deliveryId: string,
  attemptedAt: number,
  threadTs?: string,
  options: HistoryVerificationOptions = {},
): Promise<HistoryVerification> {
  const budget = options.budget ?? { remaining: 1, deadline: Date.now() + 20_000 };
  if (budget.remaining <= 0 || Date.now() >= budget.deadline) return { status: "incomplete" };
  const key = [installation.id, installation.generation, deliveryId];
  const fence = options.fence ?? { sql: "1", binds: [] };
  let progress = await env.DB.prepare(`SELECT oldest,latest,boundary,candidate_ts,status,blocked_reason,revision
    FROM slack_history_verifications WHERE installation_id=? AND installation_generation=? AND delivery_id=?
      AND channel_id=? AND thread_ts IS ? AND attempted_at=?`)
    .bind(...key, channel, threadTs ?? null, attemptedAt)
    .first<Progress>();
  if (progress?.status === "confirmed" && progress.candidate_ts)
    return { status: "confirmed", ts: progress.candidate_ts };
  if (!progress || progress.status !== "incomplete") {
    progress = {
      oldest: ((attemptedAt - 5000) / 1000).toFixed(6),
      latest: (Date.now() / 1000).toFixed(6),
      boundary: null,
      candidate_ts: null,
      status: "incomplete",
      blocked_reason: null,
      revision: crypto.randomUUID(),
    };
    const saved = await env.DB.prepare(`INSERT INTO slack_history_verifications
      (installation_id,installation_generation,delivery_id,channel_id,thread_ts,attempted_at,oldest,latest,status,revision,updated_at)
      SELECT ?,?,?,?,?,?,?,?,'incomplete',?,? WHERE ${fence.sql}
      ON CONFLICT(installation_id,installation_generation,delivery_id) DO UPDATE SET
        channel_id=excluded.channel_id,thread_ts=excluded.thread_ts,attempted_at=excluded.attempted_at,
        oldest=excluded.oldest,latest=excluded.latest,boundary=NULL,candidate_ts=NULL,status='incomplete',blocked_reason=NULL,
        revision=excluded.revision,updated_at=excluded.updated_at`)
      .bind(
        ...key,
        channel,
        threadTs ?? null,
        attemptedAt,
        progress.oldest,
        progress.latest,
        progress.revision,
        Date.now(),
        ...fence.binds,
      )
      .run();
    if (!saved.meta.changes) throw new DeliveryInProgressError();
  }
  const save = async (
    status: Progress["status"],
    boundary: string | null,
    candidate: string | null,
    reason: string | null = null,
  ) => {
    const saved =
      await env.DB.prepare(`UPDATE slack_history_verifications SET status=?,boundary=?,candidate_ts=?,blocked_reason=?,updated_at=?
      WHERE installation_id=? AND installation_generation=? AND delivery_id=? AND revision=? AND ${fence.sql}`)
        .bind(status, boundary, candidate, reason, Date.now(), ...key, progress!.revision, ...fence.binds)
        .run();
    if (!saved.meta.changes) throw new DeliveryInProgressError();
  };
  const input = {
    channel,
    oldest: threadTs ? (progress.boundary ?? progress.oldest) : progress.oldest,
    latest: threadTs ? progress.latest : (progress.boundary ?? progress.latest),
    inclusive: false,
    limit: 100,
    include_all_metadata: true,
  };
  let result;
  const method = threadTs ? "conversations.replies" : "conversations.history";
  const cooldownKey = JSON.stringify([installation.id, installation.generation, method]);
  try {
    // Count attempted remote calls, including failures; cached cooldowns make no remote call.
    const localRetryAt = budget.cooldowns?.[cooldownKey] ?? 0;
    if (localRetryAt > Date.now())
      throw new SlackRateLimitError(Math.ceil((localRetryAt - Date.now()) / 1000), method, localRetryAt);
    const cooldown = await env.DB.prepare(`SELECT retry_at FROM slack_method_cooldowns
      WHERE installation_id=? AND installation_generation=? AND method=? AND retry_at>?`)
      .bind(installation.id, installation.generation, method, Date.now())
      .first<{ retry_at: number }>();
    if (cooldown) {
      throw new SlackRateLimitError(Math.ceil((cooldown.retry_at - Date.now()) / 1000), method, cooldown.retry_at);
    }
    if (Date.now() >= budget.deadline) return { status: "incomplete" };
    budget.remaining--;
    const apiOptions = {
      timeoutMs: Math.max(1, Math.min(10_000, budget.deadline - Date.now())),
      signal: AbortSignal.timeout(Math.max(1, budget.deadline - Date.now())),
    };
    result = threadTs
      ? await slackApi(env, installation, "conversations.replies", { ...input, ts: threadTs }, apiOptions)
      : await slackApi(env, installation, "conversations.history", input, apiOptions);
  } catch (error) {
    if (error instanceof SlackRateLimitError) {
      budget.cooldowns ??= {};
      budget.cooldowns[cooldownKey] = error.retryAt;
    }
    if (
      definiteSlackRejection(error) &&
      !slackInstallationError(error) &&
      (error.code !== "missing_scope" ||
        (error.neededScopes.length > 0 &&
          !error.neededScopes.some((s) => ["channels:history", "groups:history"].includes(s)))) &&
      !["ratelimited", "network_error", "timeout"].includes(error.code)
    ) {
      await withSlackPrimaryError(error, "handle_error", { deliveryId }, () =>
        save("missing", progress.boundary, progress.candidate_ts, error.code),
      );
      return { status: "missing", reason: error.code };
    }
    throw error;
  }
  const messages = result.messages.filter(
    (m) => timestamp.test(m.ts) && compare(m.ts, input.oldest) > 0 && compare(m.ts, input.latest) < 0,
  );
  let candidate = progress.candidate_ts;
  for (const m of messages) {
    if (
      m.user !== installation.bot_user_id ||
      m.metadata?.event_payload?.delivery_id !== deliveryId ||
      (options.eventType && m.metadata.event_type !== options.eventType) ||
      (threadTs ? m.ts === threadTs || m.thread_ts !== threadTs : m.thread_ts && m.thread_ts !== m.ts)
    )
      continue;
    if (candidate && candidate !== m.ts) {
      await save("ambiguous", progress.boundary, candidate);
      return { status: "ambiguous" };
    }
    candidate = m.ts;
  }
  const more = result.has_more || Boolean(result.response_metadata?.next_cursor);
  if (more) {
    const ordered = messages.map((m) => m.ts).sort(compare);
    const boundary = threadTs ? ordered.at(-1) : ordered[0];
    // No timestamp progress is insufficient evidence of a finished search.
    await save("incomplete", boundary ?? progress.boundary, candidate);
    return { status: "incomplete" };
  }
  await save(candidate ? "confirmed" : "missing", progress.boundary, candidate);
  return candidate ? { status: "confirmed", ts: candidate } : { status: "missing" };
}

export async function verifyHistoryPage(...args: Parameters<typeof searchHistoryPage>): Promise<HistoryVerification> {
  const result = await searchHistoryPage(...args);
  if (args[6]?.budget) args[6].budget.lastResult = result;
  return result;
}
