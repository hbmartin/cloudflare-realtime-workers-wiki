import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ baseURL: window.location.origin });

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly messageFromFallback = false,
  ) {
    super(message);
  }
}

export class SuccessfulApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestPath: string,
    readonly contentType: string | null,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}

export class InvalidApiResponseError extends SuccessfulApiResponseError {
  constructor(status: number, requestPath: string, contentType: string | null, cause: unknown) {
    super("The server returned malformed JSON in a successful response.", status, requestPath, contentType, cause);
    this.name = "InvalidApiResponseError";
  }
}

export class UnreadableApiResponseError extends SuccessfulApiResponseError {
  constructor(status: number, requestPath: string, contentType: string | null, cause: unknown) {
    super("The successful response body could not be read.", status, requestPath, contentType, cause);
    this.name = "UnreadableApiResponseError";
  }
}

export type UnauthorizedHandler = (error: ApiClientError) => void;

const unauthorizedHandlers = new Set<UnauthorizedHandler>();

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
  if (!response.ok) {
    const fallback = { code: "request_failed", message: `Request failed (${response.status}).` };
    const payload = (await response.json().catch(() => null)) as {
      code?: unknown;
      message?: unknown;
      error?: { code?: unknown; message?: unknown };
    } | null;
    const error = payload?.error ?? payload;
    const normalizedCode = typeof error?.code === "string" ? error.code.trim() : "";
    const normalizedMessage = typeof error?.message === "string" ? error.message.trim() : "";
    const code = normalizedCode || fallback.code;
    const message = normalizedMessage || fallback.message;
    const clientError = new ApiClientError(response.status, code, message, !normalizedMessage);
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
  const contentType = response.headers.get("content-type");
  let payload: string;
  try {
    payload = await response.text();
  } catch (cause) {
    throw new UnreadableApiResponseError(response.status, path, contentType, cause);
  }
  try {
    return JSON.parse(payload) as T;
  } catch (cause) {
    throw new InvalidApiResponseError(response.status, path, contentType, cause);
  }
}

export function json(value: unknown) {
  return JSON.stringify(value);
}
