import type { AiGenerate, AiStreamEvent } from "../shared/ai";
import { readSse } from "../shared/sse";
import { ApiClientError, apiErrorMessage, apiRequestEpoch, notifyApiUnauthorized } from "./api";

export async function streamWriting(input: AiGenerate, signal: AbortSignal, onEvent: (event: AiStreamEvent) => void) {
  const requestEpoch = apiRequestEpoch();
  const response = await fetch("/api/ai/generate", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    const error = new ApiClientError(
      response.status,
      body?.error?.code ?? "ai_unavailable",
      body?.error?.message ?? `Writing is unavailable (${response.status}).`,
    );
    notifyApiUnauthorized(error, requestEpoch);
    throw error;
  }
  if (!response.body) throw new Error("The writing stream is unavailable.");
  let completed = false,
    failed = false;
  try {
    for await (const raw of readSse(response.body)) {
      const event = JSON.parse(raw) as AiStreamEvent;
      if (event.type === "error" && event.status === 401)
        notifyApiUnauthorized(new ApiClientError(401, event.code, event.message), requestEpoch);
      onEvent(event);
      if (event.type === "complete") completed = true;
      if (event.type === "error") failed = true;
    }
    if (!completed && !failed && !signal.aborted)
      throw new Error("The connection ended before completion. Partial text can be copied. Retry explicitly.");
  } catch (error) {
    if (!signal.aborted)
      throw new Error(apiErrorMessage(error, "Generation stopped. Partial text can be copied."), { cause: error });
  }
}
