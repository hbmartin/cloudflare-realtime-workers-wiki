// Equal jitter over a capped exponential ceiling: the delay lands in
// [ceiling / 2, ceiling], so a retry never fires immediately and a fleet of
// callers that failed together does not retry in lockstep. Whole milliseconds,
// since alarm and timer APIs truncate anything finer.
export function jitteredBackoff(attempt: number, baseMs: number, capMs: number) {
  const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}
