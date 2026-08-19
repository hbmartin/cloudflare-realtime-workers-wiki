import type { Context } from "hono";
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
  if (!isExpectedError(error)) console.error(error);
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

export function assertSameOrigin(request: Request, _baseUrl: string) {
  const origin = request.headers.get("Origin");
  const expected = new URL(request.url).origin;
  if (origin && origin !== expected) {
    throw new HttpError(403, "invalid_origin", "This request is not from the application origin.");
  }
}

export function normalizeFilename(name: string) {
  return (
    name
      .replace(/[\r\n"\\/]/g, "_")
      .trim()
      .slice(0, 180) || "download"
  );
}

export function attachmentDisposition(name: string, inline: boolean) {
  const safe = normalizeFilename(name).replace(/[^\x20-\x7e]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(normalizeFilename(name))}`;
}

export function locationHint(value: string | undefined): DurableObjectLocationHint | undefined {
  const allowed: DurableObjectLocationHint[] = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"];
  return allowed.includes(value as DurableObjectLocationHint) ? (value as DurableObjectLocationHint) : undefined;
}
