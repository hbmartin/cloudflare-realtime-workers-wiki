import { jitteredBackoff, jitteredInterval } from "../shared/retry";

export function connectionRetryDelay(attempt: number) {
  return jitteredBackoff(attempt, 1_000, 30_000);
}

export function reconciliationRetryDelay() {
  return jitteredInterval(750, 250);
}

export function observeUntilAborted<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject<T>(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
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
