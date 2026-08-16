export function connectionRetryDelay(attempt: number) {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  return ceiling / 2 + Math.random() * (ceiling / 2);
}
