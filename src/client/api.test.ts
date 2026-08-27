// @vitest-environment jsdom

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  ApiClientError,
  api,
  InvalidApiResponseError,
  json,
  onApiUnauthorized,
  UnreadableApiResponseError,
} from "./api";

afterEach(() => vi.unstubAllGlobals());

function unreadableResponse(cause: unknown, init?: ResponseInit) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(cause);
    },
  });
  return new Response(body, init);
}

describe("api", () => {
  it("adds JSON content type while preserving caller headers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api<{ ok: boolean }>("/api/example", {
        method: "POST",
        headers: { "x-request-id": "request-1" },
        body: json({ value: 1 }),
      }),
    ).resolves.toEqual({ ok: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-request-id")).toBe("request-1");
  });

  it("leaves multipart content type generation to the browser", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const form = new FormData();
    form.set("file", new File(["notes"], "notes.txt"));

    await api("/api/upload", { method: "POST", body: form });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });

  it("normalizes nested and malformed error responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "forbidden", message: "No access." } }), { status: 403 }),
      )
      .mockResolvedValueOnce(new Response("not-json", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("/api/private")).rejects.toEqual(
      expect.objectContaining({ status: 403, code: "forbidden", message: "No access." }),
    );
    const error = await api("/api/upstream").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      status: 502,
      code: "request_failed",
      message: "Request failed (502).",
    });
  });

  it("uses the fallback when an error-response body cannot be read", async () => {
    const bodyError = new TypeError("The response stream terminated.");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        unreadableResponse(bodyError, {
          status: 502,
          headers: { "content-type": "application/problem+json" },
        }),
      ),
    );

    const error = await api("/api/upstream").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      status: 502,
      code: "request_failed",
      message: "Request failed (502).",
    });
  });

  it("treats an empty error-response body as an absent payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 502 })));

    await expect(api("/api/upstream")).rejects.toMatchObject({
      status: 502,
      code: "request_failed",
      message: "Request failed (502).",
    });
  });

  it("classifies malformed successful responses by media type", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("not-json", {
          status: 201,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "APPLICATION/PROBLEM+JSON; charset=utf-8" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const jsonError = await api("/api/json").catch((cause: unknown) => cause);
    const htmlError = await api("/api/html").catch((cause: unknown) => cause);
    const problemJsonError = await api("/api/problem").catch((cause: unknown) => cause);

    expect(jsonError).toBeInstanceOf(InvalidApiResponseError);
    expect(jsonError).toMatchObject({
      status: 201,
      hasJsonContentType: true,
      cause: expect.any(SyntaxError),
    });
    expect(htmlError).toMatchObject({ status: 200, hasJsonContentType: false });
    expect(problemJsonError).toMatchObject({ status: 200, hasJsonContentType: true });
  });

  it("preserves successful response body read failures", async () => {
    const bodyError = new DOMException("The operation timed out.", "TimeoutError");
    const response = unreadableResponse(bodyError, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const error = await api("/api/example?view=summary").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(UnreadableApiResponseError);
    expect(error).toMatchObject({
      status: 200,
      hasJsonContentType: true,
      cause: bodyError,
    });
  });

  it("normalizes API error codes and messages and replaces blank values", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "  unavailable  ", message: "" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "   ", message: "   " }), { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "  unavailable  ", message: "  Service temporarily unavailable.  " } }),
          { status: 503 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("/api/empty-message")).rejects.toMatchObject({
      code: "unavailable",
      message: "Request failed (503).",
      messageFromFallback: true,
    });
    await expect(api("/api/blank-error")).rejects.toMatchObject({
      code: "request_failed",
      message: "Request failed (503).",
      messageFromFallback: true,
    });
    await expect(api("/api/padded-error")).rejects.toMatchObject({
      code: "unavailable",
      message: "Service temporarily unavailable.",
      messageFromFallback: false,
    });
  });

  it("notifies subscribers when an API request is unauthorized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "session_expired", message: "Sign in again." } }), {
          status: 401,
        }),
      ),
    );
    const unauthorized = vi.fn();
    const unsubscribe = onApiUnauthorized(unauthorized);
    onTestFinished(unsubscribe);

    await expect(api("/api/private")).rejects.toMatchObject({ status: 401, code: "session_expired" });
    expect(unauthorized).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401, code: "session_expired", message: "Sign in again." }),
    );
  });

  it("isolates unauthorized subscribers and preserves the API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: "session_expired", message: "Sign in again." } }), {
          status: 401,
        }),
      ),
    );
    const subscriberError = new Error("subscriber failed");
    const laterSubscriber = vi.fn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => logged.mockRestore());
    const unsubscribeThrowing = onApiUnauthorized(() => {
      throw subscriberError;
    });
    const unsubscribeLater = onApiUnauthorized(laterSubscriber);
    onTestFinished(() => {
      unsubscribeThrowing();
      unsubscribeLater();
    });

    await expect(api("/api/private")).rejects.toMatchObject({ status: 401, code: "session_expired" });
    expect(laterSubscriber).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
    expect(logged).toHaveBeenCalledWith("API unauthorized handler failed", subscriberError);
  });
});
