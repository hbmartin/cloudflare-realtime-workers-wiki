export type AbortSignalCapabilities = {
  any?: unknown;
  timeout?: unknown;
  prototype?: { throwIfAborted?: unknown };
};

export function browserSupportsRequiredFeatures(
  capabilities: AbortSignalCapabilities | null | undefined = globalThis.AbortSignal,
) {
  return (
    typeof capabilities?.any === "function" &&
    typeof capabilities?.timeout === "function" &&
    typeof capabilities.prototype?.throwIfAborted === "function"
  );
}
