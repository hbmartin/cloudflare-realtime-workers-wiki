import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ baseURL: window.location.origin });

export class ApiClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const fallback = { code: "request_failed", message: `Request failed (${response.status}).` };
    const payload = await response.json().catch(() => null) as {
      code?: unknown;
      message?: unknown;
      error?: { code?: unknown; message?: unknown };
    } | null;
    const error = payload?.error ?? payload;
    const code = typeof error?.code === "string" ? error.code : fallback.code;
    const message = typeof error?.message === "string" ? error.message : fallback.message;
    throw new ApiClientError(response.status, code, message);
  }
  return response.json() as Promise<T>;
}

export function json(value: unknown) {
  return JSON.stringify(value);
}
