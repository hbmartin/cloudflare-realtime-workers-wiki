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

  it("reports global errors without recursively reporting a failed telemetry request", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const event = new ErrorEvent("error", { error: new Error("boom") });

    window.dispatchEvent(event);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throttles distinct reports to five per minute", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    for (let index = 0; index < 6; index += 1) {
      await reportClientError("client.realtime_connection_failed", new Error(`failure-${index}`));
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
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
