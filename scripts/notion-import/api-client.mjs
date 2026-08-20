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
import { jitteredBackoff } from "../../src/shared/retry.ts";

const RETRYABLE_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 120_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "DELETE"]);

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

export async function createClient({ baseURL, email, password, requestsPerSecond = 20 }) {
  const origin = new URL(baseURL).origin;
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
      if (response.ok) return response.status === 204 ? null : response.json();
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

    async createPages(pages) {
      // One request per tree level rather than per page: each create otherwise
      // broadcasts a workspace event that every connected client acts on.
      const result = await request(
        "/api/pages/batch",
        { method: "POST", body: JSON.stringify({ pages }) },
        { retryable: false },
      );
      return result.pages;
    },

    async uploadAttachment(pageId, name, mime, bytes) {
      const body = new FormData();
      body.set("file", new File([bytes], name, { type: mime }));
      const result = await request(`/api/pages/${pageId}/attachments`, { method: "POST", body }, { retryable: false });
      return result.attachment;
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

    async readTable(pageId) {
      return request(`/api/tables/${pageId}?count=true&limit=1`);
    },

    async tree() {
      const result = await request("/api/pages/tree");
      return result.pages;
    },
  };
}
