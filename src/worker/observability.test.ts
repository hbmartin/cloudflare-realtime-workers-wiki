import { describe, expect, it, vi } from "vitest";
import {
  LOG_IDENTIFIER_LIMIT,
  LOG_STACK_LIMIT,
  LOG_TEXT_LIMIT,
  PERSISTED_ERROR_MESSAGE_LIMIT,
  TRUNCATION_MARKER,
} from "../shared/error-log";
import type { Env } from "./env";
import {
  OBSERVABILITY_SCHEMA,
  boundedNestedJson,
  logger,
  metricRouteTemplate,
  recordMetric,
  safeTelemetryErrorMessage,
  setMetricRouteTemplate,
  traced,
  withObservabilityContext,
} from "./observability";

describe("worker observability", () => {
  it("emits one structured, correlated, redacted log object", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
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
    } finally {
      output.mockRestore();
    }
  });

  it("keeps concurrent async invocation contexts isolated", async () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
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
    } finally {
      output.mockRestore();
    }
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
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      withObservabilityContext(env, { trigger: "fetch" }, () => {
        expect(metricRouteTemplate()).toBe("/unmatched");
        setMetricRouteTemplate("/api/pages/:id/attachments");
        expect(metricRouteTemplate()).toBe("/api/pages/:id/attachments");
        logger.info("test.route", "test", "route selected");
      });
      expect(metricRouteTemplate()).toBe("/unmatched");
      expect(output.mock.calls[0]?.[0]).not.toHaveProperty("metricRouteTemplate");
    } finally {
      output.mockRestore();
    }
  });

  it("redacts nested data and survives hostile error objects", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
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
          "Bearer abc123 Basic Zm9vOmJhcg== crn_thismustberedacted xoxb-thismustberedacted secret_thismustberedacted person@example.com https://example.test/path?secret=yes",
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
    } finally {
      output.mockRestore();
    }
  });

  it("keeps Basic prose but redacts decodable free-text credentials", () => {
    expect(safeTelemetryErrorMessage(new Error("unable to verify basic constraints or Basic idea"), "fallback")).toBe(
      "unable to verify basic constraints or Basic idea",
    );
    expect(
      safeTelemetryErrorMessage(
        new Error("Basic Og== and basic Zm9vOmJhcg== and Basic\tOg== and Basic not-base64!"),
        "fallback",
      ),
    ).toBe("Basic [redacted] and basic [redacted] and Basic\t[redacted] and Basic not-base64!");
  });

  it("redacts credential-like Bearer values without consuming punctuation or prose", () => {
    expect(safeTelemetryErrorMessage(new Error("Authorization: Bearer abc"), "fallback")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(safeTelemetryErrorMessage(new Error('Response {"authorization":"Bearer abc"} failed'), "fallback")).toBe(
      'Response {"authorization":"Bearer [redacted]"} failed',
    );
    expect(safeTelemetryErrorMessage(new Error("Bearer abc123"), "fallback")).toBe("Bearer [redacted]");
    expect(safeTelemetryErrorMessage(new Error("Bearer abc123."), "fallback")).toBe("Bearer [redacted].");
    expect(safeTelemetryErrorMessage(new Error(`Bearer ${"a".repeat(16)}`), "fallback")).toBe("Bearer [redacted]");
    expect(safeTelemetryErrorMessage(new Error("Use the Bearer token scheme"), "fallback")).toBe(
      "Use the Bearer token scheme",
    );
    expect(safeTelemetryErrorMessage(new Error("Bearer api:key"), "fallback")).toBe("Bearer api:key");
  });

  it("redacts every email shape covered by the previous policy", () => {
    expect(safeTelemetryErrorMessage(new Error(`${"a".repeat(65)}@example.com`), "fallback")).toBe("[redacted-email]");
    expect(safeTelemetryErrorMessage(new Error("name@example.com-foo"), "fallback")).toBe("[redacted-email]-foo");
    expect(safeTelemetryErrorMessage(new Error("name@example.co.uk"), "fallback")).toBe("[redacted-email]");
  });

  it("keeps Basic prose and later nested JSON keys intact", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const error = new Error("Basic Constraints");
      error.stack = "at new Basic (worker.ts:10:1)";
      logger.error(
        "test.json",
        "test",
        "failed",
        {
          details: {
            a: "Basic idea",
            b: "later key",
            header: "Proxy-Authorization: Basic Zm9vOmJhcg==",
          },
        },
        error,
      );
      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(JSON.parse(String(record.details))).toEqual({
        a: "Basic idea",
        b: "later key",
        header: "Proxy-Authorization: Basic [redacted]",
      });
      expect(record.errorMessage).toBe("Basic Constraints");
      expect(record.errorStack).toBe("at new Basic (worker.ts:10:1)");
    } finally {
      output.mockRestore();
    }
  });

  it("bounds adversarial error fields before scanning and hides truncation-edge secrets", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const adversarial = "a".repeat(80_000) + "@example.test Authorization: Basic " + "A".repeat(80_000);
      const error = new Error(adversarial);
      error.stack = adversarial;
      const started = performance.now();
      logger.error(
        "test.long",
        "test",
        adversarial,
        {
          nested: { value: adversarial, later: "retained" },
          otherId: adversarial,
        },
        error,
      );
      expect(performance.now() - started).toBeLessThan(2_000);
      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(String(record.message).length).toBeLessThanOrEqual(2_000);
      expect(String(record.errorMessage).length).toBeLessThanOrEqual(2_000);
      expect(String(record.errorStack).length).toBeLessThanOrEqual(LOG_STACK_LIMIT);
      expect(String(record.otherId).length).toBeLessThanOrEqual(200);
      expect(() => JSON.parse(String(record.nested))).not.toThrow();
      expect(
        safeTelemetryErrorMessage(new Error("x".repeat(970) + " person@example.com" + "z".repeat(80)), "fallback"),
      ).not.toContain("person@");
      expect(
        safeTelemetryErrorMessage(new Error("x".repeat(975) + " crn_abcdefghijklmnop" + "z".repeat(80)), "fallback"),
      ).not.toContain("crn_abc");
      expect(safeTelemetryErrorMessage(new Error("local@".repeat(20_000)), "fallback").length).toBeLessThanOrEqual(
        1_000,
      );
    } finally {
      output.mockRestore();
    }
  });

  it("retains bounded content from long whitespace-free diagnostics and field names", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const minified = `{"message":"${"x".repeat(LOG_TEXT_LIMIT + 200)}"}`;
      const longUrl = `https://example.test/${"p".repeat(LOG_TEXT_LIMIT + 100)}`;
      const firstKey = `alpha-${"a".repeat(LOG_IDENTIFIER_LIMIT + 50)}`;
      const secondKey = `beta-${"b".repeat(LOG_IDENTIFIER_LIMIT + 50)}`;
      const error = new Error(minified);
      error.stack = "x".repeat(LOG_STACK_LIMIT + 1_000);

      logger.error("test.whitespace_free", "test", minified, { [firstKey]: 1, [secondKey]: 2, longUrl }, error);

      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(record.message).toMatch(/^\{"message":"x+/);
      expect(record.message).toMatch(/…\[truncated\]$/);
      expect(String(record.message)).toHaveLength(LOG_TEXT_LIMIT);
      expect(record.errorStack).toMatch(/^x+/);
      expect(record.errorStack).toMatch(/…\[truncated\]$/);
      expect(String(record.errorStack)).toHaveLength(LOG_STACK_LIMIT);
      expect(record.longUrl).toMatch(/^https:\/\/example\.test\/p+/);
      expect(record.longUrl).toMatch(/…\[truncated\]$/);
      const retainedKeys = Object.keys(record).filter((key) => key.startsWith("alpha-") || key.startsWith("beta-"));
      expect(retainedKeys).toHaveLength(2);
      expect(retainedKeys.every((key) => key.length <= LOG_IDENTIFIER_LIMIT)).toBe(true);
    } finally {
      output.mockRestore();
    }
  });

  it("does not split a surrogate pair at the sanitized truncation boundary", () => {
    const prefix = "x".repeat(PERSISTED_ERROR_MESSAGE_LIMIT - TRUNCATION_MARKER.length - 1);
    const result = safeTelemetryErrorMessage(new Error(`${prefix}😀${"z".repeat(LOG_TEXT_LIMIT)}`), "fallback");

    expect(result).not.toContain("�");
    expect(result).toMatch(/…\[truncated\]$/);
  });

  it("redacts authorization headers and preserves non-credential free-text Basic values", () => {
    const message =
      "Basic bm9jb2xvbg==; Basic not-base64!; Basic\nZm9vOmJhcg==; Authorization: Basic badtoken; Basic idea,";
    expect(safeTelemetryErrorMessage(new Error(message), "fallback")).toBe(
      "Basic bm9jb2xvbg==; Basic not-base64!; Basic\nZm9vOmJhcg==; Authorization: Basic [redacted]; Basic idea,",
    );
    const longToken = "Ab1+".repeat(20);
    const result = safeTelemetryErrorMessage(
      new Error(`${"x".repeat(954)} Authorization: Basic ${longToken}`),
      "fallback",
    );
    expect(result).toContain("Basic [redacted]");
    expect(result).not.toContain(longToken.slice(0, 20));
    expect(result.length).toBeLessThanOrEqual(1_000);
  });

  it("scrubs normalized error strings before their log-field limits", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const token = "Ab1+".repeat(30);
      const error = new Error(`${"x".repeat(1_950)} Authorization: Basic ${token}`);
      error.stack = `${"y".repeat(LOG_STACK_LIMIT - 50)} Authorization: Basic ${token}`;
      logger.error("test.error", "test", "failed", {}, error);
      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(record.errorMessage).toContain("Basic [redacted]");
      expect(record.errorStack).toContain("Basic [redacted]");
      expect(record.errorMessage).not.toContain(token.slice(0, 20));
    } finally {
      output.mockRestore();
    }
  });

  it("redacts invocation context and preserves the stack-specific size limit", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const error = new Error("failed");
      error.stack = `Authorization: Basic Zm9vOmJhcg== secret_thismustberedacted ${"x".repeat(LOG_STACK_LIMIT + 1_000)}`;

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
      expect(record.errorStack).toContain("x".repeat(1_000));
    } finally {
      output.mockRestore();
    }
  });

  it("sanitizes nested and top-level field names without dropping colliding fields", () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      logger.info("test.keys", "test", "keys", {
        "one@example.com": "first",
        "two@example.com": "second",
        details: {
          "three@example.com": "third",
          "four@example.com": "fourth",
          accessToken: "secret",
        },
      });
      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(record["[redacted-email]"]).toBe("first");
      expect(record["[redacted-email]#2"]).toBe("second");
      expect(JSON.parse(String(record.details))).toEqual({
        "[redacted-email]": "third",
        "[redacted-email]#2": "fourth",
        accessToken: "[redacted]",
      });
    } finally {
      output.mockRestore();
    }
  });

  it("retains a valid bounded JSON summary for oversized nested fields", () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      logger.info("test.large_nested", "test", "large nested", {
        details: Object.fromEntries(
          Array.from({ length: 30 }, (_, index) => [`field${index}`, `value ${"word ".repeat(40)}`]),
        ),
      });
      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      const serialized = String(record.details);
      expect(serialized.length).toBeLessThanOrEqual(2_000);
      expect(JSON.parse(serialized)).toMatchObject({
        field0: expect.stringContaining("value"),
        omitted: "[entries omitted]",
      });
      expect(serialized).not.toBe('"[object truncated]"');

      output.mockClear();
      logger.info("test.large_child", "test", "large child", {
        details: {
          child: Object.fromEntries(
            Array.from({ length: 30 }, (_, index) => [`field${index}`, `value ${"word ".repeat(40)}`]),
          ),
        },
      });
      const childRecord = output.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(JSON.parse(String(childRecord.details))).toEqual({
        child: "[value omitted]",
        omitted: "[entries omitted]",
      });
    } finally {
      output.mockRestore();
    }
  });

  it("continues bounded nested summaries after oversized values", () => {
    const objectSummary = boundedNestedJson({ blob: "x".repeat(5_000), other: 1 }, LOG_TEXT_LIMIT);
    expect(objectSummary.length).toBeLessThanOrEqual(LOG_TEXT_LIMIT);
    expect(JSON.parse(objectSummary)).toEqual({
      blob: "[value omitted]",
      other: 1,
      omitted: "[entries omitted]",
    });

    const childSummary = boundedNestedJson(
      {
        child: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, "word ".repeat(40)])),
        other: 1,
      },
      LOG_TEXT_LIMIT,
    );
    expect(childSummary.length).toBeLessThanOrEqual(LOG_TEXT_LIMIT);
    expect(JSON.parse(childSummary)).toEqual({
      child: "[value omitted]",
      other: 1,
      omitted: "[entries omitted]",
    });

    const arraySummary = boundedNestedJson(["x".repeat(5_000), 1], LOG_TEXT_LIMIT);
    expect(arraySummary.length).toBeLessThanOrEqual(LOG_TEXT_LIMIT);
    expect(JSON.parse(arraySummary)).toEqual(["[value omitted]", 1, "[entries omitted]"]);
  });

  it("keeps bounded JSON valid when an omission marker does not fit", () => {
    const summary = boundedNestedJson({ blob: "x".repeat(100), other: 1 }, 20);
    expect(summary.length).toBeLessThanOrEqual(20);
    expect(JSON.parse(summary)).toEqual({ other: 1 });

    const collision = boundedNestedJson({ omitted: "kept", blob: "x".repeat(5_000), other: 1 }, LOG_TEXT_LIMIT);
    expect(JSON.parse(collision)).toEqual({
      omitted: "kept",
      blob: "[value omitted]",
      other: 1,
      "omitted#2": "[entries omitted]",
    });
  });

  it("protects required fields and treats missing tracing support as a no-op", () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
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
    } finally {
      output.mockRestore();
    }
  });
});
