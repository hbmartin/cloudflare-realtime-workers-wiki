// Equal jitter over a capped exponential ceiling: the delay lands in
// [ceiling / 2, ceiling], so a retry never fires immediately and a fleet of
// callers that failed together does not retry in lockstep. Whole milliseconds,
// since alarm and timer APIs truncate anything finer.
export function jitteredBackoff(attempt: number, baseMs: number, capMs: number) {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

// Uniform jitter around a steady interval. Unlike difference-of-uniforms
// jitter, this does not concentrate callers around the unjittered midpoint.
export function jitteredInterval(intervalMs: number, spreadMs: number) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("intervalMs must be a positive finite number.");
  }
  if (!Number.isFinite(spreadMs) || spreadMs < 0 || spreadMs >= intervalMs) {
    throw new RangeError("spreadMs must be finite, non-negative, and smaller than intervalMs.");
  }
  return Math.round(intervalMs - spreadMs + Math.random() * spreadMs * 2);
}
