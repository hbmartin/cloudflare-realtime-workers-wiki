import type { Context } from "hono";
import { errorLogFields } from "../shared/error-log";
import { normalizeFilename } from "../shared/filename";
import { ValidationError } from "../shared/validation";

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

// An error whose message was written for the client. Anything else is an
// internal failure: callers log it and answer with a generic message.
export function isExpectedError(error: unknown): error is HttpError | ValidationError {
  return error instanceof HttpError || error instanceof ValidationError;
}

// The status and JSON envelope for any error, independent of the framework
// that produces the response, so the Hono error handler and the raw party
// request path cannot drift apart.
export function errorPayload(error: unknown) {
  if (error instanceof ValidationError) {
    return { status: 422 as const, body: { error: { code: "invalid_input", message: error.message } } };
  }
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: error.details } },
    };
  }
  return { status: 500 as const, body: { error: { code: "internal_error", message: "Something went wrong." } } };
}

export function errorResponse(c: Context, error: unknown) {
  if (!isExpectedError(error)) {
    console.error("Unhandled request error", {
      requestMethod: c.req.method,
      requestPath: new URL(c.req.url).pathname,
      requestRayId: c.req.header("cf-ray") ?? null,
      ...errorLogFields(error),
    });
  }
  const { status, body } = errorPayload(error);
  return c.json(body, status);
}

export async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function now() {
  return Date.now();
}

// Pinned to the configured origin rather than the one the request arrived on,
// so a route left attached to the Worker on another hostname cannot authorize
// itself. A request with no Origin header is not a browser form post and is
// left to the session check; browsers always send one on the cross-origin
// requests this exists to reject.
export function assertSameOrigin(request: Request, baseUrl: string) {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  if (origin !== new URL(baseUrl).origin) {
    throw new HttpError(403, "invalid_origin", "This request is not from the application origin.");
  }
}

export { normalizeFilename };

export function attachmentDisposition(name: string, inline: boolean) {
  const safe = normalizeFilename(name).replace(/[^\x20-\x7e]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(normalizeFilename(name))}`;
}

export function locationHint(value: string | undefined): DurableObjectLocationHint | undefined {
  const allowed: DurableObjectLocationHint[] = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"];
  return allowed.includes(value as DurableObjectLocationHint) ? (value as DurableObjectLocationHint) : undefined;
}
