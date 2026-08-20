/**
 * Authenticated client for the notes API, with the throttle the server does not have.
 *
 * There is no machine credential: authentication is a Better Auth session cookie, and
 * the bootstrap token is one-shot and dead after install. So the importer signs in as an
 * owner or editor exactly the way `scripts/realtime-load.mjs` does, and carries the
 * cookie plus the configured origin on every request.
 *
 * The Worker has no rate limiting anywhere and never answers 429, which means nothing
 * pushes back if the importer goes too fast. The token bucket here is the only
 * backpressure in the system, so it is not optional.
 */
import { setTimeout as delay } from "node:timers/promises";
import { open, readFile } from "node:fs/promises";
import { jitteredBackoff } from "../../src/shared/retry.ts";
import { canonicalJson, sha256Hex } from "../../src/shared/import-integrity.ts";

const RETRYABLE_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 120_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "DELETE"]);
const SINGLE_SHOT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "[::1]"]);

export function validateBaseURL(value) {
  const url = new URL(value);
  if (url.username || url.password) throw new Error("--base-url must not contain credentials.");
  const loopback = LOOPBACK_HOSTS.has(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("--base-url must use HTTPS (plain HTTP is allowed only for localhost).");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--base-url must be an origin without a path, query, or fragment.");
  }
  return url.origin;
}

class Throttle {
  #interval;
  #next = 0;

  constructor(requestsPerSecond) {
    this.#interval = 1000 / requestsPerSecond;
  }

  async take() {
    const now = Date.now();
    const at = Math.max(now, this.#next);
    this.#next = at + this.#interval;
    if (at > now) await delay(at - now);
  }
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class AmbiguousWriteError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "AmbiguousWriteError";
  }
}

export async function createClient({ baseURL, email, password, requestsPerSecond = 20 }) {
  const origin = validateBaseURL(baseURL);
  baseURL = origin;
  const throttle = new Throttle(requestsPerSecond);

  async function send(path, init = {}, cookie = "") {
    await throttle.take();
    const headers = new Headers(init.headers);
    // assertSameOrigin pins to the configured BETTER_AUTH_URL, and the WebSocket upgrade
    // needs the same pair, so both are set on every request rather than selectively.
    headers.set("origin", origin);
    if (cookie) headers.set("cookie", cookie);
    if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return fetch(new URL(path, baseURL), {
      ...init,
      headers,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  const installResponse = await send("/api/install");
  if (!installResponse.ok) {
    throw new Error(`${baseURL} did not answer /api/install (${installResponse.status}). Check --base-url.`);
  }
  const install = await installResponse.json();
  if (!install.initialized) {
    throw new Error(`${baseURL} has not been set up yet. Complete the first-run screen before importing.`);
  }
  const signIn = await send("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password, callbackURL: "/" }),
  });
  if (!signIn.ok) {
    throw new Error(`Sign in as ${email} failed (${signIn.status}). Check NOTES_IMPORT_PASSWORD.`);
  }
  const cookie = signIn.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  if (!cookie) throw new Error("Sign in succeeded but returned no session cookie.");

  async function request(path, init = {}, policy = {}) {
    const method = (init.method ?? "GET").toUpperCase();
    const retryable = policy.retryable ?? SAFE_METHODS.has(method);
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await send(path, init, cookie);
      } catch (cause) {
        // An ambiguous transport failure is retried only when this operation is repeatable.
        if (!retryable || attempt >= RETRYABLE_ATTEMPTS - 1) throw cause;
        await delay(jitteredBackoff(attempt, 500, 15_000));
        continue;
      }
      if (response.ok) {
        if (response.status === 204) return null;
        try {
          return await response.json();
        } catch (cause) {
          // Receiving a success status without a complete response body is ambiguous:
          // the server may have committed a write. Replay only receipt/id backed calls.
          if (retryable && attempt < RETRYABLE_ATTEMPTS - 1) {
            await delay(jitteredBackoff(attempt, 500, 15_000));
            continue;
          }
          if (!SAFE_METHODS.has(method)) {
            throw new AmbiguousWriteError(
              `${method} ${path} returned an unreadable success response; the write outcome is ambiguous.`,
              { cause },
            );
          }
          throw cause;
        }
      }
      if (retryable && response.status >= 500 && attempt < RETRYABLE_ATTEMPTS - 1) {
        await delay(jitteredBackoff(attempt, 500, 15_000));
        continue;
      }
      const payload = await response.json().catch(() => null);
      const error = payload?.error ?? payload ?? {};
      throw new ApiError(
        response.status,
        error.code ?? "request_failed",
        error.message ?? `Request failed (${response.status}).`,
      );
    }
  }

  const me = await request("/api/me");
  // requireEditor rejects a viewer on every write, so fail here rather than after
  // creating nothing across a thousand requests.
  if (me.role === "viewer") {
    throw new Error(`${email} is a viewer in this workspace and cannot create pages.`);
  }

  return {
    baseURL,
    origin,
    cookie,
    role: me.role,
    workspaceId: me.workspace.id,
    request,

    async hasAttachment(id) {
      const response = await send(`/api/attachments/${id}`, { headers: { range: "bytes=0-0" } }, cookie);
      await response.body?.cancel().catch(() => undefined);
      return response.ok;
    },

    async listAttachments(pageId) {
      return (await request(`/api/pages/${pageId}/attachments`)).attachments;
    },

    async pageVerification(pageId) {
      return (await request(`/api/pages/${pageId}/verification`)).verification;
    },

    async tableVerification(pageId) {
      return (await request(`/api/tables/${pageId}/verification`)).verification;
    },

    async createPages(pages) {
      // One request per tree level rather than per page: each create otherwise
      // broadcasts a workspace event that every connected client acts on.
      const result = await request(
        "/api/pages/batch",
        { method: "POST", body: JSON.stringify({ pages }) },
        // Every import supplies deterministic page ids. The batch route treats an
        // identical replay as success, so a lost response is safe to retry.
        { retryable: pages.every((page) => typeof page.id === "string" && page.id.length > 0) },
      );
      return result.pages;
    },

    async uploadAttachment(pageId, name, mime, source, options = {}) {
      const size = source?.size ?? source?.byteLength;
      if (!Number.isInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`Attachment ${name} has an unsupported size (${size ?? "unknown"} bytes).`);
      }
      const attachmentId = options.attachmentId;
      const contentSha256 = options.contentSha256;
      if (typeof attachmentId !== "string" || !attachmentId) throw new Error(`Attachment ${name} has no stable id.`);
      if (!/^[a-f\d]{64}$/i.test(contentSha256 ?? "")) {
        throw new Error(`Attachment ${name} has no valid content SHA-256 digest.`);
      }
      // Must match normalizeFilename in the Worker before computing the canonical hash.
      const normalizedName =
        name
          .replace(/[\r\n"\\/]/g, "_")
          .trim()
          .slice(0, 180) || "download";
      const requestHash = await sha256Hex(
        canonicalJson({ attachmentId, pageId, name: normalizedName, mime, size, contentSha256 }),
      );
      if (size <= SINGLE_SHOT_BYTES) {
        const bytes = source.path ? await readFile(source.path) : source;
        const body = new FormData();
        body.set("file", new File([bytes], normalizedName, { type: mime }));
        body.set("attachmentId", attachmentId);
        body.set("contentSha256", contentSha256);
        body.set("requestHash", requestHash);
        const result = await request(`/api/pages/${pageId}/attachments`, { method: "POST", body }, { retryable: true });
        return result.attachment;
      }

      let session;
      let completedParts = new Set();
      if (options.uploadId ?? attachmentId) {
        let resumed;
        try {
          resumed = await request(`/api/uploads/${options.uploadId ?? attachmentId}`);
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error;
          resumed = null;
        }
        if (resumed?.status === "committed") return resumed.attachment;
        if (resumed) {
          session = resumed.upload;
          completedParts = new Set((resumed.parts ?? []).map((part) => part.partNumber));
        }
      }
      if (!session) {
        const started = await request(
          `/api/pages/${pageId}/uploads`,
          {
            method: "POST",
            body: JSON.stringify({ attachmentId, name: normalizedName, mime, size, contentSha256, requestHash }),
          },
          { retryable: true },
        );
        if (started.status === "committed") return started.attachment;
        session = started.upload;
        await options.onSession?.(session.id);
      }
      if (
        session.id !== attachmentId ||
        session.pageId !== pageId ||
        session.name !== normalizedName ||
        session.mime !== mime ||
        session.size !== size ||
        session.contentSha256 !== contentSha256
      ) {
        throw new Error(`Saved upload ${session.id} does not match ${name}.`);
      }

      const file = await open(source.path, "r");
      try {
        for (let partNumber = 1; partNumber <= session.partCount; partNumber += 1) {
          if (completedParts.has(partNumber)) continue;
          const start = (partNumber - 1) * session.partSize;
          const length = Math.min(session.partSize, size - start);
          const bytes = Buffer.allocUnsafe(length);
          let offset = 0;
          while (offset < length) {
            const read = await file.read(bytes, offset, length - offset, start + offset);
            if (read.bytesRead === 0) throw new Error(`Attachment ${name} ended while reading part ${partNumber}.`);
            offset += read.bytesRead;
          }
          await request(
            `/api/uploads/${session.id}/parts/${partNumber}`,
            { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: bytes },
            { retryable: true },
          );
        }
      } finally {
        await file.close();
      }

      const finished = await request(
        `/api/uploads/${session.id}/complete`,
        { method: "POST", body: "{}" },
        { retryable: true },
      );
      return finished.attachment;
    },

    async acquireTableLease(pageId) {
      // Reacquiring from the same session replaces the first token. If its response was
      // lost, the replacement returned by a retry is the only token the caller observes.
      return request(`/api/tables/${pageId}/lease`, { method: "POST", body: "{}" }, { retryable: true });
    },

    async releaseTableLease(pageId, leaseToken) {
      return request(`/api/tables/${pageId}/lease`, { method: "DELETE", body: JSON.stringify({ leaseToken }) });
    },

    async bulkTableWrite(pageId, body) {
      // The import supplies clientRequestId, and the server stores the response in the
      // same transaction as the rows, so an ambiguous response can be replayed safely.
      return request(
        `/api/tables/${pageId}/bulk`,
        { method: "POST", body: JSON.stringify(body) },
        { retryable: typeof body.clientRequestId === "string" && body.clientRequestId.length > 0 },
      );
    },

    async readTable(pageId, options = {}) {
      const query = new URLSearchParams({
        count: options.count === false ? "false" : "true",
        limit: String(options.limit ?? 1),
      });
      if (options.afterPosition !== undefined) query.set("afterPosition", String(options.afterPosition));
      if (options.afterId !== undefined) query.set("afterId", options.afterId);
      return request(`/api/tables/${pageId}?${query}`);
    },

    async tree() {
      const result = await request("/api/pages/tree");
      return result.pages;
    },
  };
}
