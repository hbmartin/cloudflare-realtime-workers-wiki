export function browserSupportsRequiredFeatures(
  capabilities:
    | {
        any?: unknown;
        timeout?: unknown;
        prototype?: { throwIfAborted?: unknown };
      }
    | null
    | undefined = globalThis.AbortSignal,
) {
  return (
    typeof capabilities?.any === "function" &&
    typeof capabilities?.timeout === "function" &&
    typeof capabilities?.prototype?.throwIfAborted === "function"
  );
}
