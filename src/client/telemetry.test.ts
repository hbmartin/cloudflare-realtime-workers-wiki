// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installClientTelemetry,
  observeWorkerResponse,
  reportClientError,
  resetClientTelemetryForTests,
} from "./telemetry";

let uninstall: () => void;

beforeEach(() => {
  resetClientTelemetryForTests();
  uninstall = installClientTelemetry();
});

afterEach(() => {
  uninstall();
  resetClientTelemetryForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("client telemetry", () => {
  it("sends a private fingerprint payload and deduplicates matching failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    observeWorkerResponse(new Headers({ "x-request-id": "request-1", "x-worker-version": "release-1" }));
    const error = new Error("private message person@example.test");
    error.stack = `Error: private message\n at fn (${window.location.origin}/assets/app.js?token=secret:12:4)`;

    await reportClientError("client.api_response_invalid", error);
    await reportClientError("client.api_response_invalid", error);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: "client.api_response_invalid",
      errorName: "Error",
      requestId: "request-1",
      release: "release-1",
      online: expect.any(Boolean),
      visibility: expect.any(String),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(payload).not.toHaveProperty("message");
    expect(payload).not.toHaveProperty("stack");
    expect(JSON.stringify(payload)).not.toContain("private message");
    expect(JSON.stringify(payload)).not.toContain("person@example.test");
    expect(payload.source).toEqual({ path: "/assets/app.js", line: 12, column: 4 });
  });

  it("preserves explicit null response identifiers instead of using stale latest values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    observeWorkerResponse(new Headers({ "x-request-id": "stale-request", "x-worker-version": "stale-release" }));

    await reportClientError("client.api_response_invalid", new Error("response failed"), {
      requestId: null,
      release: null,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("requestId");
    expect(payload).not.toHaveProperty("release");
  });

  it("uses explicit response identifiers when both are present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    observeWorkerResponse(new Headers({ "x-request-id": "stale-request", "x-worker-version": "stale-release" }));

    await reportClientError("client.api_response_invalid", new Error("response failed"), {
      requestId: "response-request",
      release: "response-release",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      requestId: "response-request",
      release: "response-release",
    });
  });

  it("reports global errors without recursively reporting a failed telemetry request", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const event = new ErrorEvent("error", { error: new Error("boom") });

    window.dispatchEvent(event);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses reports when Web Crypto is unavailable or hashing fails", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", {});
    await expect(reportClientError("client.global_error", new Error("missing crypto"))).resolves.toBeUndefined();

    vi.stubGlobal("crypto", { subtle: { digest: vi.fn().mockRejectedValue(new Error("digest failed")) } });
    await expect(reportClientError("client.global_error", new Error("failed crypto"))).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queues distinct reports and reserves the five-report cap before hashing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        reportClientError("client.realtime_connection_failed", new Error(`simultaneous-${index}`)),
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("sends a queued report after an earlier request finishes", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstBlocked;
        return new Response(null, { status: 204 });
      })
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = reportClientError("client.global_error", new Error("first"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = reportClientError("client.global_error", new Error("second"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not consume deduplication or rate budget when authentication rejects a report", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const error = new Error("reported after sign-in");

    await reportClientError("client.global_error", error);
    await reportClientError("client.global_error", error);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throttles distinct reports to five per minute", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    for (let index = 0; index < 6; index += 1) {
      await reportClientError("client.realtime_connection_failed", new Error(`failure-${index}`));
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("removes expired fingerprints while retaining active deduplication", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const expired = new Error("expired fingerprint");

    await reportClientError("client.global_error", expired);
    const deleteSpy = vi.spyOn(Map.prototype, "delete");
    vi.advanceTimersByTime(60_001);
    const active = new Error("new fingerprint");
    await reportClientError("client.global_error", active);

    expect(deleteSpy.mock.calls.some(([key]) => String(key).startsWith("client.global_error:"))).toBe(true);
    await reportClientError("client.global_error", active);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    deleteSpy.mockRestore();
  });

  it("drops hostile correlation headers and normalizes a non-code error name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    observeWorkerResponse(
      new Headers({
        "x-request-id": "person@example.test",
        "x-worker-version": "release?secret=yes",
      }),
    );
    const error = new Error("private");
    error.name = "person@example.test";

    await reportClientError("client.global_error", error, { requestId: "Bearer private" });

    const firstCall = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    const payload = JSON.parse(String(firstCall[1].body));
    expect(payload.errorName).toBe("UnknownError");
    expect(payload).not.toHaveProperty("requestId");
    expect(payload).not.toHaveProperty("release");
    expect(JSON.stringify(payload)).not.toContain("person@example.test");
  });
});
