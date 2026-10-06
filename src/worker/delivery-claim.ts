// A pending delivery claim older than this may be reclaimed after its consumer dies.
export const DELIVERY_CLAIM_STALE_MS = 60_000;

export class DeliveryInProgressError extends Error {
  readonly retryAfter = Math.ceil(DELIVERY_CLAIM_STALE_MS / 1000);
  constructor() {
    super("Delivery is already in progress.");
  }
}
