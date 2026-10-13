// Adapted from Docmost c1305f002e47ece4d40f0aebba75d8d0f762d8ea, packages/base-formula/src/number.ts; AGPL-3.0.
function snapNumber(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Number(n.toPrecision(15));
}

export function valueToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(snapNumber(v));
  return String(v);
}
