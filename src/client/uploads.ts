import { jitteredBackoff } from "../shared/retry";
import { api, ApiClientError } from "./api";

/**
 * Attachment uploads, single-shot for small files and chunked for everything else.
 *
 * The editor stores a **relative** `/api/attachments/{id}` in the block, never an
 * absolute URL: that value is persisted in the Yjs document forever, so baking in the
 * current origin would break every existing image the day the app moves to a custom
 * domain.
 */

type UploadedAttachment = {
  id: string;
  pageId: string;
  name: string;
  mime: string;
  size: number;
  contentSha256?: string | null;
};

type UploadStatus = {
  status: "active" | "completing" | "r2_complete" | "committed" | "reaping" | "aborting";
  attachment?: UploadedAttachment;
};

/** Below this a single request is simpler and faster than negotiating a session. */
const SINGLE_SHOT_BYTES = 8 * 1024 * 1024;
const PART_CONCURRENCY = 3;
const PART_ATTEMPTS = 4;
const COMPLETE_ATTEMPTS = 4;

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

// Parts are independent, so a transient failure is worth retrying in place rather than
// abandoning an upload that may already be gigabytes in.
function isRetryable(error: unknown) {
  if (error instanceof ApiClientError) {
    return error.status >= 500 || [408, 409, 425, 429].includes(error.status);
  }
  return true;
}

// Authentication, authorization, ambiguous 404s, conflicts, and throttling can all
// leave a valid server-side session behind. Abort only when the server has definitively
// rejected the upload's immutable inputs.
function isTerminalClientFailure(error: unknown) {
  return (
    error instanceof ApiClientError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 403, 404, 408, 409, 425, 429].includes(error.status)
  );
}

async function uploadPart(uploadId: string, partNumber: number, slice: Blob) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await api(`/api/uploads/${uploadId}/parts/${partNumber}`, { method: "PUT", body: slice });
      return;
    } catch (error) {
      if (attempt >= PART_ATTEMPTS - 1 || !isRetryable(error)) throw error;
      await delay(jitteredBackoff(attempt, 500, 15_000));
    }
  }
}

async function uploadStatus(uploadId: string) {
  try {
    return await api<UploadStatus>(`/api/uploads/${uploadId}`);
  } catch {
    // The completion error remains authoritative. Status is a best-effort way to
    // reconcile a response that may have been lost after the server committed.
    return null;
  }
}

async function completeUpload(uploadId: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < COMPLETE_ATTEMPTS; attempt += 1) {
    try {
      const result = await api<{ attachment: UploadedAttachment }>(`/api/uploads/${uploadId}/complete`, {
        method: "POST",
      });
      return result.attachment;
    } catch (error) {
      lastError = error;
      const status = await uploadStatus(uploadId);
      if (status?.status === "committed" && status.attachment) return status.attachment;
      if (!isRetryable(error) || attempt >= COMPLETE_ATTEMPTS - 1) throw error;
      await delay(jitteredBackoff(attempt, 500, 15_000));
    }
  }
  throw lastError;
}

export async function uploadAttachment(pageId: string, file: File, onProgress?: (fraction: number) => void) {
  if (file.size <= SINGLE_SHOT_BYTES) {
    const body = new FormData();
    body.set("file", file);
    const result = await api<{ attachment: UploadedAttachment }>(`/api/pages/${pageId}/attachments`, {
      method: "POST",
      body,
    });
    onProgress?.(1);
    return result.attachment;
  }

  const started = await api<{ upload: { id: string; partSize: number; partCount: number } }>(
    `/api/pages/${pageId}/uploads`,
    {
      method: "POST",
      body: JSON.stringify({
        name: file.name,
        mime: file.type || "application/octet-stream",
        size: file.size,
      }),
    },
  );
  const { id, partSize, partCount } = started.upload;
  try {
    const pending = Array.from({ length: partCount }, (_, index) => index + 1);
    let completed = 0;
    const workers = Array.from({ length: Math.min(PART_CONCURRENCY, partCount) }, async () => {
      for (let partNumber = pending.shift(); partNumber !== undefined; partNumber = pending.shift()) {
        const start = (partNumber - 1) * partSize;
        await uploadPart(id, partNumber, file.slice(start, Math.min(start + partSize, file.size)));
        completed += 1;
        onProgress?.(completed / partCount);
      }
    });
    await Promise.all(workers);
    return await completeUpload(id);
  } catch (error) {
    if (isTerminalClientFailure(error)) {
      await api(`/api/uploads/${id}`, { method: "DELETE" }).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Normalizes a stored file URL back to the relative form the app serves.
 *
 * Anything already relative passes straight through. An absolute same-origin URL is
 * repaired, which covers content pasted between installations or imported before this
 * rule existed. External URLs are returned untouched: users can paste them, and the
 * content security policy decides whether they load. This must never throw - BlockNote
 * calls it while rendering.
 */
export function resolveAttachmentUrl(url: string) {
  if (url.startsWith("/api/attachments/")) return url;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin === window.location.origin && parsed.pathname.startsWith("/api/attachments/")) {
      return parsed.pathname;
    }
  } catch {
    // Not a URL at all, so there is nothing to normalize.
  }
  return url;
}
