import { jitteredBackoff, jitteredInterval } from "../shared/retry";

export function connectionRetryDelay(attempt: number) {
  return jitteredBackoff(attempt, 1_000, 30_000);
}

export function reconciliationRetryDelay() {
  return jitteredInterval(750, 250);
}

export function waitForReconciliationRetry(signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const timeout = window.setTimeout(finish, reconciliationRetryDelay());
    const cancel = () => {
      window.clearTimeout(timeout);
      finish();
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
