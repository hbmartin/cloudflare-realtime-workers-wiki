import type { Env } from "./env";
import { safeErrorMessage } from "../shared/error-log";
import { correlationHeaders } from "./observability";

const CHECK_TIMEOUT_MS = 2_000;
const CRON_STALE_MS = 35 * 60_000;
const WORK_OVERDUE_MS = 2 * 60 * 60_000;
const OUTBOX_DUE_MS = 15 * 60_000;
const WORKFLOW_QUEUED_MS = 30 * 60_000;

interface ReadinessCheck {
  name: "d1" | "r2" | "durable_object" | "cron" | "durable_queues";
  ok: boolean;
  durationMs: number;
  code: string;
  value?: number;
}

interface CountRow {
  total: number;
}

function timedCheck(name: ReadinessCheck["name"], check: () => Promise<Omit<ReadinessCheck, "name" | "durationMs">>) {
  const startedAt = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("health_check_timeout")), CHECK_TIMEOUT_MS);
  });
  return Promise.race([check(), timeout])
    .then((result) => ({ name, durationMs: Date.now() - startedAt, ...result }))
    .catch((error: unknown) => ({
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      code:
        safeErrorMessage(error, `${name}_unavailable`) === "health_check_timeout"
          ? "check_timeout"
          : `${name}_unavailable`,
    }))
    .finally(() => clearTimeout(timeoutHandle));
}

async function checkD1(env: Env) {
  const row = await env.DB.prepare(`SELECT 1 ok`).first<{ ok: number }>();
  return row?.ok === 1 ? { ok: true, code: "ok" } : { ok: false, code: "d1_invalid_response" };
}

async function checkR2(env: Env) {
  // The sentinel is deliberately absent. A successful metadata lookup proves
  // the binding is reachable without writing or exposing customer data.
  await env.BUCKET.head("__observability__/healthcheck");
  return { ok: true, code: "ok" };
}

async function checkDurableObject(env: Env) {
  const response = await env.WORKSPACE_EVENTS.getByName("__observability_health__").fetch(
    new Request("https://workspace-events.internal/health", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, ...correlationHeaders() },
    }),
  );
  return response.status === 204
    ? { ok: true, code: "ok" }
    : { ok: false, code: "durable_object_invalid_response", value: response.status };
}

async function checkCron(env: Env, timestamp: number) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) total FROM observability_task_runs
      WHERE last_succeeded_at IS NULL OR last_succeeded_at < ?`,
  )
    .bind(timestamp - CRON_STALE_MS)
    .first<CountRow>();
  const stale = row?.total ?? 1;
  return stale === 0 ? { ok: true, code: "ok", value: 0 } : { ok: false, code: "cron_success_stale", value: stale };
}

async function checkDurableQueues(env: Env, timestamp: number) {
  const results = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) total FROM deletion_jobs WHERE attempts > 5 OR created_at < ?`).bind(
      timestamp - WORK_OVERDUE_MS,
    ),
    env.DB.prepare(`SELECT COUNT(*) total FROM archive_disconnect_targets WHERE attempts > 9 OR created_at < ?`).bind(
      timestamp - WORK_OVERDUE_MS,
    ),
    env.DB.prepare(`SELECT COUNT(*) total FROM attachment_uploads WHERE attempts > 5 OR created_at < ?`).bind(
      timestamp - WORK_OVERDUE_MS,
    ),
    env.DB.prepare(`SELECT COUNT(*) total FROM outbox WHERE enqueued_at IS NULL AND available_at < ?`).bind(
      timestamp - OUTBOX_DUE_MS,
    ),
    env.DB.prepare(`SELECT COUNT(*) total FROM jobs WHERE status = 'queued' AND created_at < ?`).bind(
      timestamp - WORKFLOW_QUEUED_MS,
    ),
  ]);
  const counts = results.map((result) => Number((result.results[0] as CountRow | undefined)?.total ?? 0));
  const [deletions, archives, uploads, outbox, workflows] = counts;
  const failure = [
    deletions ? "deletion_work_overdue" : "",
    archives ? "archive_work_overdue" : "",
    uploads ? "upload_work_overdue" : "",
    outbox ? "outbox_delivery_overdue" : "",
    workflows ? "workflow_queued_overdue" : "",
  ].find(Boolean);
  const affected = counts.reduce((total, value) => total + value, 0);
  return failure ? { ok: false, code: failure, value: affected } : { ok: true, code: "ok", value: 0 };
}

export function deploymentMetadata(env: Env) {
  return {
    id: env.CF_VERSION_METADATA?.id ?? "local",
    ...(env.CF_VERSION_METADATA?.tag ? { tag: env.CF_VERSION_METADATA.tag } : {}),
    ...(env.CF_VERSION_METADATA?.timestamp
      ? { timestamp: new Date(env.CF_VERSION_METADATA.timestamp).toISOString() }
      : {}),
  };
}

export async function readiness(env: Env, timestamp = Date.now()) {
  const checks = await Promise.all([
    timedCheck("d1", () => checkD1(env)),
    timedCheck("r2", () => checkR2(env)),
    timedCheck("durable_object", () => checkDurableObject(env)),
    timedCheck("cron", () => checkCron(env, timestamp)),
    timedCheck("durable_queues", () => checkDurableQueues(env, timestamp)),
  ]);
  return { ok: checks.every((check) => check.ok), checks };
}
