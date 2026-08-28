import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ baseURL: window.location.origin });

export type ApiResponseBodyFailure = "empty" | "read" | "parse";

export interface ApiClientErrorDiagnostics {
  requestPath?: string;
  responseUrl?: string | null;
  contentType?: string | null;
  responseBodyFailure?: ApiResponseBodyFailure;
  cause?: unknown;
}

export interface EmptyApiResponseDiagnostics {
  requestPath: string;
  responseUrl: string | null;
  contentType: string | null;
}

export interface SuccessfulApiResponseDiagnostics extends EmptyApiResponseDiagnostics {
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
    this.name = "ApiClientError";
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

/** A 2xx response whose body could not be decoded into the API contract. */
// fallow-ignore-next-line unused-export -- public base of exported response errors and classifier
export abstract class SuccessfulApiResponseError extends Error {
  readonly hasJsonContentType: boolean;
  readonly requestPath: string;
  readonly responseUrl: string | null;
  readonly contentType: string | null;

  constructor(
    readonly status: number,
    diagnostics: EmptyApiResponseDiagnostics & { cause?: unknown },
    readonly responseBodyFailure: ApiResponseBodyFailure,
  ) {
    const hasJsonContentType = isJsonContentType(diagnostics.contentType);
    const message =
      responseBodyFailure === "empty"
        ? "The successful response body was empty."
        : responseBodyFailure === "read"
          ? "The successful response body could not be read."
          : hasJsonContentType
            ? "The server returned malformed JSON in a successful response."
            : "The server returned an unexpected non-JSON response.";
    super(message, diagnostics.cause === undefined ? undefined : { cause: diagnostics.cause });
    this.requestPath = diagnostics.requestPath;
    this.responseUrl = diagnostics.responseUrl;
    this.contentType = diagnostics.contentType;
    this.hasJsonContentType = hasJsonContentType;
  }
}

export class InvalidApiResponseError extends SuccessfulApiResponseError {
  constructor(status: number, diagnostics: SuccessfulApiResponseDiagnostics) {
    super(status, diagnostics, "parse");
    this.name = "InvalidApiResponseError";
  }
}

export class UnreadableApiResponseError extends SuccessfulApiResponseError {
  constructor(status: number, diagnostics: SuccessfulApiResponseDiagnostics) {
    super(status, diagnostics, "read");
    this.name = "UnreadableApiResponseError";
  }
}

export class EmptyApiResponseError extends SuccessfulApiResponseError {
  constructor(status: number, diagnostics: EmptyApiResponseDiagnostics) {
    super(status, diagnostics, "empty");
    this.name = "EmptyApiResponseError";
  }
}

export function isSuccessfulJsonResponseBodyError(cause: unknown): cause is SuccessfulApiResponseError {
  return cause instanceof SuccessfulApiResponseError && cause.hasJsonContentType;
}

export type UnauthorizedHandler = (error: ApiClientError) => void;

const unauthorizedHandlers = new Set<UnauthorizedHandler>();

function apiResponseFailureCause(cause: unknown) {
  if (cause === undefined) return { causeName: null, causeType: null };
  if (cause === null) return { causeName: null, causeType: "null" };
  if (typeof cause === "object" && "name" in cause && typeof cause.name === "string") {
    return { causeName: cause.name, causeType: "object" };
  }
  return { causeName: null, causeType: typeof cause };
}

function reportApiResponseFailure(error: ApiClientError | SuccessfulApiResponseError) {
  const cause = error.cause;
  const { causeName, causeType } = apiResponseFailureCause(cause);
  console.error("API response could not be processed", {
    name: error.name,
    message: error.message,
    stack: error.stack ?? null,
    status: error.status,
    code: error instanceof ApiClientError ? error.code : null,
    requestPath: error.requestPath,
    responseUrl: error.responseUrl,
    contentType: error.contentType,
    responseBodyFailure: error.responseBodyFailure,
    causeName,
    causeType,
  });
}

function errorChainIncludesTimeout(cause: unknown) {
  const seen = new Set<object>();
  let current = cause;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    if ("name" in current && current.name === "TimeoutError") return true;
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export function apiErrorMessage(cause: unknown, fallback: string) {
  if (!(cause instanceof ApiClientError) || cause.messageFromFallback || errorChainIncludesTimeout(cause)) {
    return fallback;
  }
  return cause.message.trim() || fallback;
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
  if (!payload.trim()) {
    const error = new EmptyApiResponseError(response.status, {
      requestPath: path,
      responseUrl,
      contentType,
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
