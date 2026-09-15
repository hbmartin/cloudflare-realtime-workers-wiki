const CLIENT_ERROR_EVENTS = [
  "client.global_error",
  "client.unhandled_rejection",
  "client.bundle_load_failed",
  "client.api_response_invalid",
  "client.api_response_unreadable",
  "client.api_response_empty",
  "client.api_unauthorized_handler_failed",
  "client.mutation_uncertain",
  "client.offline_storage_failed",
  "client.realtime_connection_failed",
] as const;

export type ClientErrorEvent = (typeof CLIENT_ERROR_EVENTS)[number];

interface FirstPartySource {
  path: string;
  line: number;
  column: number;
}

const DEDUPLICATION_MS = 60_000;
const WINDOW_MS = 60_000;
const MAX_REPORTS_PER_WINDOW = 5;
const sentFingerprints = new Map<string, number>();
let reportTimes: number[] = [];
let installed = false;
let pendingReports = 0;
let reportQueue: Promise<void> = Promise.resolve();
let latestRequestId: string | null = null;
let latestRelease: string | null = null;

function opaqueIdentifier(value: string | null | undefined) {
  return value && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : null;
}

function safeErrorName(value: unknown) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(value) ? value : "UnknownError";
}

function property(value: unknown, name: string) {
  try {
    return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
  } catch {
    return undefined;
  }
}

function errorIdentity(error: unknown) {
  const name = property(error, "name");
  const message = property(error, "message");
  const stack = property(error, "stack");
  return {
    name:
      typeof name === "string" && name
        ? safeErrorName(name)
        : typeof error === "string"
          ? "ThrownString"
          : "UnknownError",
    message: typeof message === "string" ? message : typeof error === "string" ? error : "",
    stack: typeof stack === "string" ? stack : "",
  };
}

async function sha256Hex(value: string) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is unavailable.");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function firstPartySource(stack: string): FirstPartySource | undefined {
  for (const match of stack.matchAll(/https?:\/\/[^\s)]+?:(\d+):(\d+)/g)) {
    try {
      const source = new URL(match[0].replace(/:(\d+):(\d+)$/, ""));
      if (source.origin !== window.location.origin) continue;
      return {
        path: source.pathname.slice(0, 200),
        line: Number(match[1]),
        column: Number(match[2]),
      };
    } catch {
      // Ignore browser-specific stack frames that are not valid URLs.
    }
  }
  return undefined;
}

export function observeWorkerResponse(headers: Headers) {
  latestRequestId = opaqueIdentifier(headers.get("x-request-id")) ?? latestRequestId;
  latestRelease = opaqueIdentifier(headers.get("x-worker-version")) ?? latestRelease;
}

export async function reportClientError(
  event: ClientErrorEvent,
  error: unknown,
  context: { requestId?: string | null } = {},
) {
  if (!installed) return;
  const timestamp = Date.now();
  reportTimes = reportTimes.filter((sentAt) => sentAt > timestamp - WINDOW_MS);
  if (reportTimes.length + pendingReports >= MAX_REPORTS_PER_WINDOW) return;
  pendingReports += 1;

  const identity = errorIdentity(error);
  const queued = reportQueue.then(async () => {
    try {
      const fingerprint = await sha256Hex(`${event}\n${identity.name}\n${identity.message}\n${identity.stack}`);
      const sentAt = Date.now();
      const key = `${event}:${fingerprint}`;
      if ((sentFingerprints.get(key) ?? 0) > sentAt - DEDUPLICATION_MS) return;
      reportTimes = reportTimes.filter((time) => time > sentAt - WINDOW_MS);
      if (reportTimes.length >= MAX_REPORTS_PER_WINDOW) return;

      const source = firstPartySource(identity.stack);
      const requestId = opaqueIdentifier(context.requestId ?? latestRequestId);
      const payload = {
        event,
        errorName: identity.name,
        fingerprint,
        ...(source ? { source } : {}),
        ...(requestId ? { requestId } : {}),
        ...(latestRelease ? { release: latestRelease } : {}),
        online: navigator.onLine,
        visibility: document.visibilityState,
      };
      const response = await fetch("/api/telemetry/client-errors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "same-origin",
        keepalive: true,
      });
      if (!response.ok) return;
      const acceptedAt = Date.now();
      sentFingerprints.set(key, acceptedAt);
      reportTimes.push(acceptedAt);
    } catch {
      // Telemetry must never interfere with the user flow or recursively report itself.
    } finally {
      pendingReports -= 1;
    }
  });
  reportQueue = queued;
  await queued;
}

export function installClientTelemetry() {
  if (installed) return () => undefined;
  installed = true;
  const error = (event: ErrorEvent) => void reportClientError("client.global_error", event.error ?? event.message);
  const rejection = (event: PromiseRejectionEvent) =>
    void reportClientError("client.unhandled_rejection", event.reason);
  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  return () => {
    window.removeEventListener("error", error);
    window.removeEventListener("unhandledrejection", rejection);
    installed = false;
  };
}

export function resetClientTelemetryForTests() {
  installed = false;
  pendingReports = 0;
  reportQueue = Promise.resolve();
  latestRequestId = null;
  latestRelease = null;
  reportTimes = [];
  sentFingerprints.clear();
}
