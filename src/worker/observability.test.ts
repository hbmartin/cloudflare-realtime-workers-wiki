import { describe, expect, it, vi } from "vitest";
import { LOG_STACK_LIMIT } from "../shared/error-log";
import type { Env } from "./env";
import {
  OBSERVABILITY_SCHEMA,
  logger,
  metricRouteTemplate,
  recordMetric,
  setMetricRouteTemplate,
  traced,
  withObservabilityContext,
} from "./observability";

describe("worker observability", () => {
  it("emits one structured, correlated, redacted log object", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { CF_VERSION_METADATA: { id: "version-1", tag: "release", timestamp: "now" } } as Env;
    withObservabilityContext(
      env,
      { trigger: "fetch", requestId: "request-1", correlationId: "correlation-1", rayId: "ray-1" },
      () =>
        logger.error("http.request.failed", "http", "Failed for person@example.com", {
          token: "secret",
          pageId: "page-1",
        }),
    );

    expect(output).toHaveBeenCalledTimes(1);
    expect(output.mock.calls[0]?.[0]).toMatchObject({
      schema: OBSERVABILITY_SCHEMA,
      event: "http.request.failed",
      requestId: "request-1",
      correlationId: "correlation-1",
      versionId: "version-1",
      token: "[redacted]",
      pageId: "page-1",
      message: "Failed for [redacted-email]",
    });
    output.mockRestore();
  });

  it("keeps concurrent async invocation contexts isolated", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const env = {} as Env;
    await Promise.all(
      ["one", "two"].map((requestId) =>
        withObservabilityContext(env, { trigger: "fetch", requestId }, async () => {
          await Promise.resolve();
          logger.info("test.context", "test", "context");
        }),
      ),
    );
    expect(
      output.mock.calls
        .map((call) => call[0])
        .map((entry) => entry.requestId)
        .sort((left, right) => String(left).localeCompare(String(right))),
    ).toEqual(["one", "two"]);
    output.mockRestore();
  });

  it("writes the documented Analytics Engine positions", () => {
    const writeDataPoint = vi.fn();
    const env = {
      OBSERVABILITY: { writeDataPoint },
      CF_VERSION_METADATA: { id: "version-2" },
    } as unknown as Env;
    recordMetric(env, {
      event: "http.request",
      component: "http",
      operation: "/api/pages/:id",
      outcome: "success",
      code: "200",
      durationMs: 12,
      bytes: 34,
    });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ["http.request"],
      blobs: [OBSERVABILITY_SCHEMA, "http", "/api/pages/:id", "success", "200", "", "version-2"],
      doubles: [12, 34, 0, 0, 0, 0, 1],
    });

    writeDataPoint.mockClear();
    recordMetric(env, { event: "http.request", component: "http" });
    expect(writeDataPoint.mock.calls[0]?.[0].doubles).toEqual([0, 0, 0, 0, 0, 0, 0]);

    writeDataPoint.mockClear();
    recordMetric(env, { event: "http.request", component: "http", bytes: 0 });
    expect(writeDataPoint.mock.calls[0]?.[0].doubles).toEqual([0, 0, 0, 0, 0, 0, 1]);
  });

  it("keeps the registered metric route template in the request context", () => {
    const env = {} as Env;
    withObservabilityContext(env, { trigger: "fetch" }, () => {
      expect(metricRouteTemplate()).toBe("/unmatched");
      setMetricRouteTemplate("/api/pages/:id/attachments");
      expect(metricRouteTemplate()).toBe("/api/pages/:id/attachments");
    });
    expect(metricRouteTemplate()).toBe("/unmatched");
  });

  it("redacts nested data and survives hostile error objects", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("getter failed");
        },
        ownKeys() {
          throw new Error("keys failed");
        },
      },
    );

    expect(() =>
      logger.error(
        "test.hostile",
        "test",
        "Bearer abc Basic Zm9vOmJhcg== crn_thismustberedacted xoxb-thismustberedacted secret_thismustberedacted person@example.com https://example.test/path?secret=yes",
        { nested: { authorization: "Basic credential", value: "person@example.com" }, hostile },
        hostile,
      ),
    ).not.toThrow();
    const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record.message).toBe(
      "Bearer [redacted] Basic [redacted] [redacted-secret] [redacted-secret] [redacted-secret] [redacted-email] https://example.test/path",
    );
    expect(record.nested).toBe('{"authorization":"[redacted]","value":"[redacted-email]"}');
    expect(record.hostile).toBe('"[object omitted]"');
    output.mockRestore();
  });

  it("redacts invocation context and preserves the stack-specific size limit", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("failed");
    error.stack = `Basic Zm9vOmJhcg== secret_thismustberedacted ${"x".repeat(LOG_STACK_LIMIT + 1_000)}`;

    withObservabilityContext({} as Env, { trigger: "queue", correlationId: "secret_thismustberedacted" }, () =>
      logger.error("test.stack", "test", "failed", {}, error),
    );

    const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record.correlationId).toBe("[redacted-secret]");
    expect(String(record.errorStack).length).toBeGreaterThan(2_000);
    expect(String(record.errorStack).length).toBeLessThanOrEqual(LOG_STACK_LIMIT);
    expect(record.errorStack).toMatch(/…\[truncated\]$/);
    expect(record.errorStack).toContain("Basic [redacted]");
    expect(record.errorStack).not.toContain("secret_thismustberedacted");
    output.mockRestore();
  });

  it("protects required fields and treats missing tracing support as a no-op", () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const result = traced(undefined, "notes.test", { ignored: true }, () => "completed");
    logger.info("test.required", "test", "required", {
      schema: "hostile",
      event: "hostile",
      severity: "error",
      requestId: "hostile",
    });
    expect(result).toBe("completed");
    expect(output.mock.calls[0]?.[0]).toMatchObject({
      schema: OBSERVABILITY_SCHEMA,
      event: "test.required",
      severity: "info",
    });
    expect(output.mock.calls[0]?.[0]).not.toHaveProperty("requestId");
    output.mockRestore();
  });
});
