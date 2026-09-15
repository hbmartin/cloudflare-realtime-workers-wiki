import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Production resource identifiers intentionally remain stable through the NoteFlare rebrand.
export const ANALYTICS_DATASET = "cloudflare_realtime_notes_production";
export const WORKER_SCRIPT = "cloudflare-realtime-notes";
export const WORKFLOW_NAME = "cloudflare-realtime-notes-jobs";
export const DELIVERY_QUEUE_NAME = "cloudflare-realtime-notes-delivery";
export const DLQ_NAME = "cloudflare-realtime-notes-delivery-dlq";
export const D1_NAME = "cloudflare-realtime-notes";

const READINESS_ATTEMPTS = 3;
const READINESS_DELAY_MS = 45_000;
const WORKFLOW_LOOKBACK_MS = 2 * 60 * 60_000;
const WORKFLOW_QUEUED_MS = 30 * 60_000;

function requiredEnvironment(environment) {
  const values = {
    accountId: environment.CLOUDFLARE_ACCOUNT_ID,
    token: environment.CLOUDFLARE_OBSERVABILITY_TOKEN,
    baseUrl: environment.PRODUCTION_BASE_URL,
    probeToken: environment.OBSERVABILITY_PROBE_TOKEN,
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) throw new Error(`Missing observability configuration: ${missing.join(", ")}`);
  return values;
}

async function fetchJson(url, init, fetcher = fetch) {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Observability API returned HTTP ${response.status}.`);
  return body;
}

export async function probeReadiness(baseUrl, probeToken, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = [];
  for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
    if (attempt) await delay(READINESS_DELAY_MS);
    try {
      const response = await fetcher(new URL("/api/health/ready", baseUrl), {
        headers: { "x-observability-token": probeToken },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json().catch(() => null);
      attempts.push({ ok: response.ok && body?.ok === true, status: response.status, body });
    } catch {
      attempts.push({ ok: false, status: 0, body: null });
    }
  }
  return attempts;
}

async function analyticsSql(accountId, token, minutes, fetcher = fetch) {
  const sql = analyticsQuery(minutes);
  const response = await fetchJson(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
      body: sql,
    },
    fetcher,
  );
  return Array.isArray(response?.data) ? response.data : [];
}

export function analyticsQuery(minutes) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 3 * 31 * 24 * 60) {
    throw new Error("Analytics query window is invalid.");
  }
  return `SELECT index1 AS event, blob2 AS component, blob3 AS operation, blob4 AS outcome,
    blob5 AS code, blob6 AS subtype, SUM(_sample_interval) AS count,
    MAX(double3) AS max_attempts, MAX(double4) AS max_lag_ms, MAX(double5) AS max_backlog
    FROM ${ANALYTICS_DATASET}
    WHERE timestamp > NOW() - INTERVAL '${minutes}' MINUTE
    GROUP BY event, component, operation, outcome, code, subtype
    ORDER BY count DESC LIMIT 1000`;
}

async function queueMetadata(accountId, token, fetcher = fetch) {
  const response = await fetchJson(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues?per_page=100`,
    { headers: { authorization: `Bearer ${token}` } },
    fetcher,
  );
  const queues = Array.isArray(response?.result) ? response.result : [];
  const find = (name) => queues.find((queue) => queue.queue_name === name || queue.name === name);
  return { delivery: find(DELIVERY_QUEUE_NAME), dlq: find(DLQ_NAME) };
}

async function queueMetrics(accountId, token, queueId, fetcher = fetch) {
  if (!queueId) return null;
  const response = await fetchJson(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${queueId}/metrics`,
    { headers: { authorization: `Bearer ${token}` } },
    fetcher,
  );
  return response?.result ?? null;
}

async function d1Metadata(accountId, token, fetcher = fetch) {
  const listed = await fetchJson(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?name=${encodeURIComponent(D1_NAME)}`,
    { headers: { authorization: `Bearer ${token}` } },
    fetcher,
  );
  const database = Array.isArray(listed?.result) ? listed.result.find((item) => item.name === D1_NAME) : null;
  const id = database?.uuid ?? database?.id;
  if (!id) return null;
  const details = await fetchJson(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${id}?fields=file_size`,
    { headers: { authorization: `Bearer ${token}` } },
    fetcher,
  );
  return details?.result ?? null;
}

async function staleQueuedWorkflows(accountId, token, timestamp, fetcher = fetch) {
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workflows/${encodeURIComponent(WORKFLOW_NAME)}/instances`,
  );
  url.searchParams.set("status", "queued");
  url.searchParams.set("date_end", new Date(timestamp - WORKFLOW_QUEUED_MS - 1).toISOString());
  url.searchParams.set("per_page", "1");
  const response = await fetchJson(url, { headers: { authorization: `Bearer ${token}` } }, fetcher);
  if (response?.success !== true || !Array.isArray(response.result)) {
    throw new Error("Cloudflare Workflow instance query returned an invalid response.");
  }
  return response.result;
}

async function graphqlMetrics(accountId, token, queueId, startedAt, fetcher = fetch) {
  const query = `query Observability($account: string!, $start: Time!, $workflowStart: Time!, $end: Time!, $script: string!, $workflow: string!, $queue: string!) {
    viewer { accounts(filter: { accountTag: $account }) {
      worker: workersInvocationsAdaptive(limit: 1000, filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }) {
        sum { requests errors } dimensions { status }
      }
      workflow: workflowsAdaptive(limit: 10000, filter: { workflowName: $workflow, datetime_geq: $workflowStart, datetime_leq: $end }, orderBy: [datetime_DESC]) {
        datetime eventType instanceId
      }
      queue: queueBacklogAdaptiveGroups(limit: 1000, filter: { queueId: $queue, datetime_geq: $start, datetime_leq: $end }) {
        avg { messages bytes }
      }
    } }
  }`;
  const body = await fetchJson(
    "https://api.cloudflare.com/client/v4/graphql",
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query,
        variables: {
          account: accountId,
          start: startedAt.toISOString(),
          workflowStart: new Date(Math.min(startedAt.getTime(), Date.now() - WORKFLOW_LOOKBACK_MS)).toISOString(),
          end: new Date().toISOString(),
          script: WORKER_SCRIPT,
          workflow: WORKFLOW_NAME,
          queue: queueId ?? "missing",
        },
      }),
    },
    fetcher,
  );
  if (Array.isArray(body?.errors) && body.errors.length) throw new Error("Cloudflare GraphQL metrics query failed.");
  const account = body?.data?.viewer?.accounts?.[0] ?? {};
  return { worker: account.worker ?? [], workflow: account.workflow ?? [], queue: account.queue ?? [] };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function evaluateThresholds(snapshot) {
  const failures = [];
  if (snapshot.readiness?.length === READINESS_ATTEMPTS && snapshot.readiness.every((attempt) => !attempt.ok)) {
    failures.push("readiness_failed");
  }
  const requests = snapshot.worker.reduce((total, row) => total + number(row.sum?.requests), 0);
  const exceptions = snapshot.worker.reduce((total, row) => total + number(row.sum?.errors), 0);
  if (exceptions >= 3) failures.push("worker_exceptions_high");

  const serverErrors = snapshot.analytics
    .filter((row) => row.event === "http.request" && Number.parseInt(row.code, 10) >= 500)
    .reduce((total, row) => total + number(row.count), 0);
  const analyticsRequests = snapshot.analytics
    .filter((row) => row.event === "http.request")
    .reduce((total, row) => total + number(row.count), 0);
  const denominator = analyticsRequests || requests;
  if (denominator >= 50 && serverErrors / denominator > 0.02) failures.push("worker_5xx_rate_high");

  if (snapshot.analytics.some((row) => row.event === "client.error" && row.subtype && number(row.count) >= 5)) {
    failures.push("client_error_fingerprint_repeated");
  }
  if (
    snapshot.analytics.some(
      (row) => row.event === "document.compaction" && row.outcome === "failure" && number(row.count) >= 2,
    )
  ) {
    failures.push("document_compaction_repeated_failure");
  }
  if (
    snapshot.analytics.some(
      (row) => row.event === "document.restore" && row.outcome === "failure" && number(row.count) >= 2,
    )
  ) {
    failures.push("document_restore_repeated_failure");
  }
  if (snapshot.analytics.some((row) => String(row.event).includes("invariant") && number(row.count) > 0)) {
    failures.push("invariant_corruption");
  }

  const dlqBacklog = snapshot.dlq?.backlog_count;
  if (dlqBacklog === null || dlqBacklog === undefined) failures.push("delivery_dlq_metadata_missing");
  else if (number(dlqBacklog) > 0) failures.push("delivery_dlq_nonempty");
  const databaseSize = snapshot.database?.file_size;
  if (databaseSize === null || databaseSize === undefined) failures.push("d1_metadata_missing");
  else if (number(databaseSize) > 8_000_000_000) failures.push("d1_size_high");
  const deliveryBacklog = snapshot.delivery?.backlog_count;
  if (deliveryBacklog === null || deliveryBacklog === undefined) failures.push("delivery_queue_metadata_missing");
  const backlog = number(deliveryBacklog);
  const averageBacklog = Math.max(0, ...snapshot.queue.map((row) => number(row.avg?.messages)));
  if (deliveryBacklog !== null && deliveryBacklog !== undefined && backlog > 100 && averageBacklog > 100) {
    failures.push("queue_backlog_sustained");
  }

  const latestWorkflowEvents = new Map();
  for (const row of snapshot.workflow) {
    const eventType = row.eventType ?? row.dimensions?.eventType;
    const instanceId = row.instanceId ?? row.dimensions?.instanceId;
    const datetime = Date.parse(row.datetime ?? row.dimensions?.datetime ?? "");
    if (!instanceId || !eventType || !Number.isFinite(datetime)) continue;
    const previous = latestWorkflowEvents.get(instanceId);
    if (!previous || datetime >= previous.datetime) latestWorkflowEvents.set(instanceId, { eventType, datetime });
  }
  if (snapshot.staleQueuedWorkflows?.length) failures.push("workflow_queued_stale");
  if (
    [...latestWorkflowEvents.values()].some((event) =>
      ["WORKFLOW_INTERNAL_ERROR", "ROLLBACK_FAILED", "ROLLBACK_ATTEMPT_FAILURE"].includes(event.eventType),
    )
  ) {
    failures.push("workflow_infrastructure_failure");
  }
  return [...new Set(failures)];
}

function markdown(snapshot, failures, windows, title = "Cloudflare observability monitor") {
  const latest = snapshot.readiness.at(-1);
  const deliveryBacklog = snapshot.delivery?.backlog_count;
  const dlqBacklog = snapshot.dlq?.backlog_count;
  const databaseSize = snapshot.database?.file_size;
  const oldestMessageValue = snapshot.delivery?.oldest_message_timestamp_ms;
  const oldestMessage = number(oldestMessageValue);
  const oldestMessageAge =
    oldestMessageValue === null || oldestMessageValue === undefined
      ? "unavailable"
      : oldestMessage > 0
        ? Math.max(0, Date.now() - oldestMessage)
        : 0;
  const availableNumber = (value) => (value === null || value === undefined ? "unavailable" : number(value));
  return [
    `## ${title}`,
    "",
    `- Readiness: ${latest?.ok ? "ready" : "failed"} (${snapshot.readiness.map((item) => item.status).join(", ")})`,
    `- Worker requests (${windows.graphqlMinutes}m): ${snapshot.worker.reduce((total, row) => total + number(row.sum?.requests), 0)}`,
    `- Analytics events (${windows.analyticsMinutes}m, sampling-adjusted): ${snapshot.analytics.reduce((total, row) => total + number(row.count), 0)}`,
    `- Delivery backlog / DLQ / oldest age: ${availableNumber(deliveryBacklog)} / ${availableNumber(dlqBacklog)} / ${oldestMessageAge}${oldestMessageAge === "unavailable" ? "" : " ms"}`,
    `- D1 size: ${availableNumber(databaseSize)}${databaseSize === null || databaseSize === undefined ? "" : " bytes"}`,
    `- Stale queued Workflows: ${snapshot.staleQueuedWorkflows?.length ?? 0}`,
    `- Alert codes: ${failures === null ? "not evaluated (run observability:check)" : failures.length ? failures.join(", ") : "none"}`,
    "",
  ].join("\n");
}

export async function collectSnapshot(config, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const graphqlMinutes = options.graphqlMinutes ?? 5;
  const analyticsMinutes = options.analyticsMinutes ?? 15;
  const timestamp = options.timestamp ?? Date.now();
  const [readiness, queues, analytics, database, staleWorkflows] = await Promise.all([
    probeReadiness(config.baseUrl, config.probeToken, options),
    queueMetadata(config.accountId, config.token, fetcher),
    analyticsSql(config.accountId, config.token, analyticsMinutes, fetcher),
    d1Metadata(config.accountId, config.token, fetcher),
    staleQueuedWorkflows(config.accountId, config.token, timestamp, fetcher),
  ]);
  const [delivery, dlq, graphql] = await Promise.all([
    queueMetrics(config.accountId, config.token, queues.delivery?.queue_id ?? queues.delivery?.id, fetcher),
    queueMetrics(config.accountId, config.token, queues.dlq?.queue_id ?? queues.dlq?.id, fetcher),
    graphqlMetrics(
      config.accountId,
      config.token,
      queues.delivery?.queue_id ?? queues.delivery?.id,
      new Date(Date.now() - graphqlMinutes * 60_000),
      fetcher,
    ),
  ]);
  return {
    readiness,
    analytics,
    delivery,
    dlq,
    database,
    staleQueuedWorkflows: staleWorkflows,
    deliveryQueueId: queues.delivery?.queue_id ?? queues.delivery?.id,
    ...graphql,
  };
}

export async function main(arguments_, environment = process.env) {
  const mode = arguments_[0] ?? "report";
  if (mode !== "report" && mode !== "check") throw new Error("Use observability.mjs report or check.");
  const config = requiredEnvironment(environment);
  const windows =
    mode === "check" ? { analyticsMinutes: 15, graphqlMinutes: 5 } : { analyticsMinutes: 15, graphqlMinutes: 15 };
  const snapshot = await collectSnapshot(config, windows);
  const failures = mode === "check" ? evaluateThresholds(snapshot) : [];
  let summary = markdown(snapshot, mode === "check" ? failures : null, windows);
  if (mode === "report") {
    const dailyWindows = { analyticsMinutes: 24 * 60, graphqlMinutes: 24 * 60 };
    const [analytics, graphql] = await Promise.all([
      analyticsSql(config.accountId, config.token, dailyWindows.analyticsMinutes),
      graphqlMetrics(
        config.accountId,
        config.token,
        snapshot.deliveryQueueId,
        new Date(Date.now() - dailyWindows.graphqlMinutes * 60_000),
      ),
    ]);
    summary = `${markdown(snapshot, null, windows, "Cloudflare observability — 15 minutes")}\n${markdown(
      { ...snapshot, analytics, ...graphql },
      null,
      dailyWindows,
      "Cloudflare observability — 24 hours",
    )}`;
  }
  process.stdout.write(summary);
  if (environment.GITHUB_STEP_SUMMARY) await appendFile(environment.GITHUB_STEP_SUMMARY, summary);
  if (mode === "check" && failures.length) process.exitCode = 1;
  return { snapshot, failures };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
