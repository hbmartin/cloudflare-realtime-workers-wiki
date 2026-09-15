export const CLIENT_ERROR_EVENTS = [
  "client.global_error",
  "client.unhandled_rejection",
  "client.bundle_load_failed",
  "client.api_response_invalid",
  "client.api_response_unreadable",
  "client.api_response_empty",
  "client.api_unauthorized_handler_failed",
  "client.offline_storage_failed",
  "client.realtime_connection_failed",
] as const;

export type ClientErrorEvent = (typeof CLIENT_ERROR_EVENTS)[number];

export function isTelemetryIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
}

export function isClientErrorName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(value);
}
