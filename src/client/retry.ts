import { jitteredBackoff } from "../shared/retry";

export function connectionRetryDelay(attempt: number) {
  return jitteredBackoff(attempt, 1_000, 30_000);
}

export function reconciliationRetryDelay() {
  return jitteredBackoff(0, 1_000, 1_000);
}

export function waitForReconciliationRetry() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, reconciliationRetryDelay()));
}
