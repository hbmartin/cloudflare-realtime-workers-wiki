import { jitteredBackoff } from "../shared/retry";

export function connectionRetryDelay(attempt: number) {
  return jitteredBackoff(attempt, 1_000, 30_000);
}
