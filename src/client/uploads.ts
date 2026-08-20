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
};

/** Below this a single request is simpler and faster than negotiating a session. */
const SINGLE_SHOT_BYTES = 8 * 1024 * 1024;
const PART_CONCURRENCY = 3;
const PART_ATTEMPTS = 4;

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

// Parts are independent, so a transient failure is worth retrying in place rather than
// abandoning an upload that may already be gigabytes in.
function isRetryable(error: unknown) {
  if (error instanceof ApiClientError) return error.status >= 500;
  return true;
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
    const finished = await api<{ attachment: UploadedAttachment }>(`/api/uploads/${id}/complete`, { method: "POST" });
    return finished.attachment;
  } catch (error) {
    // The failure is already known here, so release the session rather than leaving the
    // parts for the reaper to collect a day later.
    await api(`/api/uploads/${id}`, { method: "DELETE" }).catch(() => undefined);
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
