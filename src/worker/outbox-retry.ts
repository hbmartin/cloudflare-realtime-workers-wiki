import type { Env } from "./env";
import { logger, recordMetric } from "./observability";

export function outboxEnqueueRetryAt(attempts: number) {
  return Date.now() + Math.min(60 * 60_000, 10_000 * 2 ** Math.min(Math.max(0, attempts - 1), 9));
}

export function reportPersistentEnqueueFailure(env: Env, outboxId: string, attempts: number, error: string | null) {
  if (attempts !== 10 && attempts % 24 !== 0) return;
  logger.error(
    "outbox.enqueue.persistent_failure",
    "outbox",
    "Outbox row has persistent enqueue failures.",
    { outboxId, attempts },
    error,
  );
  recordMetric(env, {
    event: "outbox.delivery",
    component: "outbox",
    operation: "enqueue",
    outcome: "failure",
    attempts,
  });
}
