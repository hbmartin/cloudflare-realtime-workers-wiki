// @vitest-environment jsdom

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { api, json, onApiUnauthorized } from "./api";

afterEach(() => vi.unstubAllGlobals());

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
    await expect(api("/api/upstream")).rejects.toEqual(
      expect.objectContaining({
        status: 502,
        code: "request_failed",
        message: "Request failed (502).",
      }),
    );
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
