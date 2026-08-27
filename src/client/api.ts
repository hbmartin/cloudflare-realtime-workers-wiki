import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ baseURL: window.location.origin });

export type ApiResponseBodyFailure = "read" | "parse";

export interface ApiClientErrorDiagnostics {
  requestPath?: string;
  responseUrl?: string | null;
  contentType?: string | null;
  responseBodyFailure?: ApiResponseBodyFailure;
  cause?: unknown;
}

export interface SuccessfulApiResponseDiagnostics {
  requestPath: string;
  responseUrl: string | null;
  contentType: string | null;
  cause: unknown;
}

type ApiErrorPayload = {
  code?: unknown;
  message?: unknown;
  error?: { code?: unknown; message?: unknown };
};

export class ApiClientError extends Error {
  readonly requestPath: string | null;
  readonly responseUrl: string | null;
  readonly contentType: string | null;
  readonly responseBodyFailure: ApiResponseBodyFailure | null;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly messageFromFallback = false,
    diagnostics: ApiClientErrorDiagnostics = {},
  ) {
    super(message, diagnostics.cause === undefined ? undefined : { cause: diagnostics.cause });
    this.requestPath = diagnostics.requestPath ?? null;
    this.responseUrl = diagnostics.responseUrl ?? null;
    this.contentType = diagnostics.contentType ?? null;
    this.responseBodyFailure = diagnostics.responseBodyFailure ?? null;
  }
}

function isJsonContentType(contentType: string | null) {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

export abstract class SuccessfulApiResponseError extends Error {
  readonly hasJsonContentType: boolean;
  readonly requestPath: string;
  readonly responseUrl: string | null;
  readonly contentType: string | null;

  constructor(
    message: string,
    readonly status: number,
    diagnostics: SuccessfulApiResponseDiagnostics,
    hasJsonContentType: boolean,
  ) {
    super(message, { cause: diagnostics.cause });
    this.requestPath = diagnostics.requestPath;
    this.responseUrl = diagnostics.responseUrl;
    this.contentType = diagnostics.contentType;
    this.hasJsonContentType = hasJsonContentType;
  }
}

export class InvalidApiResponseError extends SuccessfulApiResponseError {
  constructor(status: number, diagnostics: SuccessfulApiResponseDiagnostics) {
    const hasJsonContentType = isJsonContentType(diagnostics.contentType);
    super(
      hasJsonContentType
        ? "The server returned malformed JSON in a successful response."
        : "The server returned an unexpected non-JSON response.",
      status,
      diagnostics,
      hasJsonContentType,
    );
    this.name = "InvalidApiResponseError";
  }
}

export class UnreadableApiResponseError extends SuccessfulApiResponseError {
  constructor(status: number, diagnostics: SuccessfulApiResponseDiagnostics) {
    super(
      "The successful response body could not be read.",
      status,
      diagnostics,
      isJsonContentType(diagnostics.contentType),
    );
    this.name = "UnreadableApiResponseError";
  }
}

export type UnauthorizedHandler = (error: ApiClientError) => void;

const unauthorizedHandlers = new Set<UnauthorizedHandler>();

function reportApiResponseFailure(error: ApiClientError | SuccessfulApiResponseError) {
  const cause = error.cause;
  const causeName =
    typeof cause === "object" && cause !== null && "name" in cause && typeof cause.name === "string"
      ? cause.name
      : cause === undefined
        ? null
        : typeof cause;
  console.error("API response could not be processed", {
    name: error.name,
    message: error.message,
    status: error.status,
    code: error instanceof ApiClientError ? error.code : null,
    requestPath: error.requestPath,
    responseUrl: error.responseUrl,
    contentType: error.contentType,
    responseBodyFailure:
      error instanceof ApiClientError
        ? error.responseBodyFailure
        : error instanceof InvalidApiResponseError
          ? "parse"
          : "read",
    causeName,
  });
}

export function onApiUnauthorized(handler: UnauthorizedHandler) {
  unauthorizedHandlers.add(handler);
  return () => {
    unauthorizedHandlers.delete(handler);
  };
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const responseUrl = response.url || null;
  const contentType = response.headers.get("content-type");
  if (!response.ok) {
    const fallback = { code: "request_failed", message: `Request failed (${response.status}).` };
    let payload: ApiErrorPayload | null = null;
    let responseBodyFailure: ApiResponseBodyFailure | undefined;
    let responseBodyCause: unknown;
    try {
      const body = await response.text();
      if (body.trim()) {
        try {
          payload = JSON.parse(body) as ApiErrorPayload | null;
        } catch (cause) {
          responseBodyFailure = "parse";
          responseBodyCause = cause;
        }
      }
    } catch (cause) {
      responseBodyFailure = "read";
      responseBodyCause = cause;
    }
    const error = payload?.error ?? payload;
    const normalizedCode = typeof error?.code === "string" ? error.code.trim() : "";
    const normalizedMessage = typeof error?.message === "string" ? error.message.trim() : "";
    const code = normalizedCode || fallback.code;
    const message = normalizedMessage || fallback.message;
    const clientError = new ApiClientError(response.status, code, message, !normalizedMessage, {
      requestPath: path,
      responseUrl,
      contentType,
      responseBodyFailure,
      cause: responseBodyCause,
    });
    if (responseBodyFailure) reportApiResponseFailure(clientError);
    if (response.status === 401) {
      for (const handler of unauthorizedHandlers) {
        try {
          handler(clientError);
        } catch (handlerError) {
          console.error("API unauthorized handler failed", handlerError);
        }
      }
    }
    throw clientError;
  }
  let payload: string;
  try {
    payload = await response.text();
  } catch (cause) {
    const error = new UnreadableApiResponseError(response.status, {
      requestPath: path,
      responseUrl,
      contentType,
      cause,
    });
    reportApiResponseFailure(error);
    throw error;
  }
  try {
    return JSON.parse(payload) as T;
  } catch (cause) {
    const error = new InvalidApiResponseError(response.status, {
      requestPath: path,
      responseUrl,
      contentType,
      cause,
    });
    reportApiResponseFailure(error);
    throw error;
  }
}

export function json(value: unknown) {
  return JSON.stringify(value);
}
