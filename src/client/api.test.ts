// @vitest-environment jsdom

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  ApiClientError,
  api,
  apiErrorMessage,
  EmptyApiResponseError,
  InvalidApiResponseError,
  isPageNotFoundError,
  isSuccessfulJsonResponseBodyError,
  json,
  onApiUnauthorized,
  UnreadableApiResponseError,
} from "./api";

afterEach(() => vi.unstubAllGlobals());

function responseAt(url: string, body: BodyInit | null, init?: ResponseInit) {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function unreadableResponseAt(url: string, cause: unknown, init?: ResponseInit) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(cause);
    },
  });
  return responseAt(url, body, init);
}

function silenceApiResponseReport() {
  const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
  onTestFinished(() => reported.mockRestore());
  return reported;
}

describe("api", () => {
  it("accepts only supported page-not-found statuses", () => {
    expect(isPageNotFoundError(new ApiClientError(410, "page_not_found", "Page not found."))).toBe(true);
    expect(isPageNotFoundError(new ApiClientError(500, "page_not_found", "Page not found."))).toBe(false);
    expect(isPageNotFoundError(new ApiClientError(404, "page_not_found", "Page not found."))).toBe(true);
  });

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
    const reported = silenceApiResponseReport();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "forbidden", message: "No access." } }), { status: 403 }),
      )
      .mockResolvedValueOnce(
        responseAt("https://example.test/proxy-error", "not-json", {
          status: 502,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("/api/private")).rejects.toEqual(
      expect.objectContaining({ status: 403, code: "forbidden", message: "No access." }),
    );
    const error = await api("/api/upstream").catch((cause: unknown) => cause);

    if (!(error instanceof ApiClientError)) throw new TypeError("Expected ApiClientError.");
    expect(error.stack).toEqual(expect.any(String));
    expect(error).toMatchObject({
      name: "ApiClientError",
      status: 502,
      code: "request_failed",
      message: "Request failed (502).",
      requestPath: "/api/upstream",
      responseUrl: "https://example.test/proxy-error",
      contentType: "text/html; charset=utf-8",
      responseBodyFailure: "parse",
      cause: expect.any(SyntaxError),
    });
    expect(reported).toHaveBeenCalledWith(
      "API response could not be processed",
      expect.objectContaining({
        name: "ApiClientError",
        stack: error.stack ?? null,
        status: 502,
        requestPath: "/api/upstream",
        responseBodyFailure: "parse",
        causeName: "SyntaxError",
      }),
    );
    expect(reported.mock.calls[0]?.[1]).not.toHaveProperty("cause");
  });

  it("only exposes explicit API messages to the UI", () => {
    expect(apiErrorMessage(new ApiClientError(503, "unavailable", "Service unavailable."), "Try again.")).toBe(
      "Service unavailable.",
    );
    expect(
      apiErrorMessage(new ApiClientError(503, "request_failed", "Request failed (503).", true), "Try again."),
    ).toBe("Try again.");
    expect(apiErrorMessage(new TypeError("Failed to fetch"), "Try again.")).toBe("Try again.");
    expect(apiErrorMessage(new Error("Internal implementation detail"), "Try again.")).toBe("Try again.");
    expect(
      apiErrorMessage(
        new ApiClientError(503, "unavailable", "Service unavailable.", false, {
          cause: new DOMException("The operation timed out.", "TimeoutError"),
        }),
        "Try again.",
      ),
    ).toBe("Try again.");
  });

  it("uses the fallback when an error-response body cannot be read", async () => {
    const reported = silenceApiResponseReport();
    const bodyError = new TypeError("The response stream terminated.");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        unreadableResponseAt("https://example.test/upstream", bodyError, {
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
      requestPath: "/api/upstream",
      responseUrl: "https://example.test/upstream",
      contentType: "application/problem+json",
      responseBodyFailure: "read",
      cause: bodyError,
    });
    expect(reported).toHaveBeenCalledWith(
      "API response could not be processed",
      expect.objectContaining({
        status: 502,
        requestPath: "/api/upstream",
        responseBodyFailure: "read",
        causeName: "TypeError",
      }),
    );
  });

  it("classifies a primitive response-body cause without treating its type as a name", async () => {
    const reported = silenceApiResponseReport();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        unreadableResponseAt("https://example.test/upstream", "stream failed", {
          status: 502,
          headers: { "content-type": "application/problem+json" },
        }),
      ),
    );

    const error = await api("/api/upstream").catch((cause: unknown) => cause);

    expect(error).toMatchObject({ responseBodyFailure: "read", cause: "stream failed" });
    expect(reported).toHaveBeenCalledWith(
      "API response could not be processed",
      expect.objectContaining({ causeName: null, causeType: "string" }),
    );
    expect(reported.mock.calls[0]?.[1]).not.toHaveProperty("cause");
  });

  it("distinguishes a null response-body cause from an absent cause", async () => {
    const reported = silenceApiResponseReport();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        unreadableResponseAt("https://example.test/upstream", null, {
          status: 502,
          headers: { "content-type": "application/problem+json" },
        }),
      ),
    );

    const error = await api("/api/upstream").catch((cause: unknown) => cause);

    expect(error).toMatchObject({ responseBodyFailure: "read", cause: null });
    expect(reported).toHaveBeenCalledWith(
      "API response could not be processed",
      expect.objectContaining({ causeName: null, causeType: "null" }),
    );
  });

  it.each([
    ["an empty", null],
    ["a whitespace-only", " \n\t "],
  ] as const)("treats %s error-response body as an absent payload", async (_case, body) => {
    const reported = silenceApiResponseReport();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 502 })));

    const error = await api("/api/upstream").catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      status: 502,
      code: "request_failed",
      message: "Request failed (502).",
      responseBodyFailure: null,
    });
    expect(reported).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty", null],
    ["a whitespace-only", " \n\t "],
  ] as const)("classifies %s successful response body as empty", async (_case, body) => {
    const reported = silenceApiResponseReport();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        responseAt("https://example.test/api/example", body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const error = await api("/api/example").catch((cause: unknown) => cause);

    if (!(error instanceof EmptyApiResponseError)) throw new TypeError("Expected EmptyApiResponseError.");
    expect(error.stack).toEqual(expect.any(String));
    expect(error).toMatchObject({
      status: 200,
      hasJsonContentType: true,
      requestPath: "/api/example",
      responseUrl: "https://example.test/api/example",
      contentType: "application/json",
      responseBodyFailure: "empty",
    });
    expect(reported).toHaveBeenCalledWith(
      "API response could not be processed",
      expect.objectContaining({
        name: "EmptyApiResponseError",
        responseBodyFailure: "empty",
        causeName: null,
        causeType: null,
        stack: error.stack ?? null,
      }),
    );
    expect(reported.mock.calls[0]?.[1]).not.toHaveProperty("cause");
  });

  it("classifies malformed successful responses by media type", async () => {
    const reported = silenceApiResponseReport();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        responseAt("https://example.test/api/json", "not-json", {
          status: 201,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      )
      .mockResolvedValueOnce(
        responseAt("https://example.test/login", "not-json", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      )
      .mockResolvedValueOnce(
        responseAt("https://example.test/api/problem", "not-json", {
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
      requestPath: "/api/json",
      responseUrl: "https://example.test/api/json",
      contentType: "application/json; charset=utf-8",
      cause: expect.any(SyntaxError),
    });
    expect(htmlError).toMatchObject({
      status: 200,
      hasJsonContentType: false,
      requestPath: "/api/html",
      responseUrl: "https://example.test/login",
      contentType: "text/html; charset=utf-8",
      message: "The server returned an unexpected non-JSON response.",
    });
    expect(problemJsonError).toMatchObject({
      status: 200,
      hasJsonContentType: true,
      requestPath: "/api/problem",
      responseUrl: "https://example.test/api/problem",
      contentType: "APPLICATION/PROBLEM+JSON; charset=utf-8",
    });
    expect(reported).toHaveBeenCalledTimes(3);
  });

  it("uses the JSON response contract as evidence that a successful mutation reached the API", () => {
    const jsonError = new UnreadableApiResponseError(200, {
      requestPath: "/api/example",
      responseUrl: null,
      contentType: "application/json",
      cause: new TypeError("The response stream terminated."),
    });
    const htmlError = new InvalidApiResponseError(200, {
      requestPath: "/api/example",
      responseUrl: null,
      contentType: "text/html",
      cause: new SyntaxError("Unexpected token '<'"),
    });
    const untypedEmptyError = new EmptyApiResponseError(204, {
      requestPath: "/api/example",
      responseUrl: null,
      contentType: null,
    });

    expect(isSuccessfulJsonResponseBodyError(jsonError)).toBe(true);
    expect(isSuccessfulJsonResponseBodyError(htmlError)).toBe(false);
    expect(isSuccessfulJsonResponseBodyError(untypedEmptyError)).toBe(false);
  });

  it("preserves successful response body read failures", async () => {
    const reported = silenceApiResponseReport();
    const bodyError = new DOMException("The operation timed out.", "TimeoutError");
    const response = unreadableResponseAt("https://example.test/api/example?view=summary", bodyError, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const error = await api("/api/example?view=summary").catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(UnreadableApiResponseError);
    expect(error).toMatchObject({
      status: 200,
      hasJsonContentType: true,
      requestPath: "/api/example?view=summary",
      responseUrl: "https://example.test/api/example?view=summary",
      contentType: "application/json",
      cause: bodyError,
    });
    expect(reported).toHaveBeenCalledWith(
      "API response could not be processed",
      expect.objectContaining({
        name: "UnreadableApiResponseError",
        status: 200,
        requestPath: "/api/example?view=summary",
        responseBodyFailure: "read",
        causeName: "TimeoutError",
      }),
    );
    expect(reported.mock.calls[0]?.[1]).not.toHaveProperty("cause");
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
