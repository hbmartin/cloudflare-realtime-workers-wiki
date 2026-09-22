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
  ATOMIC_SANITIZATION_MARKERS,
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

function isWellFormed(value: string) {
  return (value as string & { isWellFormed(): boolean }).isWellFormed();
}

function warmedMedianPerOperation(operation: () => void) {
  for (let index = 0; index < 5; index += 1) operation();
  let iterations = 1;
  while (iterations < 16_384) {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) operation();
    if (performance.now() - started >= 20) break;
    iterations *= 2;
  }
  const samples = Array.from({ length: 5 }, () => {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) operation();
    return (performance.now() - started) / iterations;
  }).sort((left, right) => left - right);
  return samples[2]!;
}

const UNICODE_SIMPLE_FOLD_BEARER_CHARACTERS = ["\u017f", "\u212a"] as const;
const JAVASCRIPT_WHITESPACE_SEPARATORS = [
  " ",
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  "\r\n",
  "\u00a0",
  "\u1680",
  ...Array.from({ length: 11 }, (_, offset) => String.fromCodePoint(0x2000 + offset)),
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
] as const;

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

  it("redacts quoted free-text credentials while preserving their wrappers", () => {
    expect(safeTelemetryErrorMessage(new Error('Basic "dXNlcjpwYXNz"'), "fallback")).toBe('Basic "[redacted]"');
    expect(safeTelemetryErrorMessage(new Error("Basic 'dXNlcjpwYXNz'"), "fallback")).toBe("Basic '[redacted]'");
    expect(safeTelemetryErrorMessage(new Error('Bearer "eyJhbGciOiJIUzI1NiJ9.payload.signature"'), "fallback")).toBe(
      'Bearer "[redacted]"',
    );
    expect(safeTelemetryErrorMessage(new Error("Bearer 'eyJhbGciOiJIUzI1NiJ9.payload.signature'"), "fallback")).toBe(
      "Bearer '[redacted]'",
    );
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
    expect(safeTelemetryErrorMessage(new Error("Bearer abc123!secretpart"), "fallback")).toBe("Bearer [redacted]");
    expect(safeTelemetryErrorMessage(new Error("Bearer abc!secretpartlongvalue"), "fallback")).toBe(
      "Bearer [redacted]",
    );
    expect(safeTelemetryErrorMessage(new Error("Bearer abc123!?"), "fallback")).toBe("Bearer [redacted]!?");
    for (const delimiter of [":", "\\", ">", "`", "&", "%", "*", "|"]) {
      expect(safeTelemetryErrorMessage(new Error(`Bearer abc123${delimiter} expired`), "fallback")).toBe(
        `Bearer [redacted]${delimiter} expired`,
      );
    }
    expect(safeTelemetryErrorMessage(new Error(`Bearer ${"a".repeat(16)}`), "fallback")).toBe("Bearer [redacted]");
    expect(safeTelemetryErrorMessage(new Error("Use the Bearer token scheme"), "fallback")).toBe(
      "Use the Bearer token scheme",
    );
    expect(safeTelemetryErrorMessage(new Error("Bearer api:key"), "fallback")).toBe("Bearer api:key");
  });

  it("treats Unicode simple-fold characters as Bearer boundaries", () => {
    for (const boundary of UNICODE_SIMPLE_FOLD_BEARER_CHARACTERS) {
      expect(safeTelemetryErrorMessage(new Error(`${boundary}Bearer abc123`), "fallback")).toBe(
        `${boundary}Bearer [redacted]`,
      );
      expect(safeTelemetryErrorMessage(new Error(`${boundary}Authorization: Bearer abc`), "fallback")).toBe(
        `${boundary}Authorization: Bearer [redacted]`,
      );
    }
  });

  it("keeps Bearer schemes embedded in ASCII identifiers", () => {
    expect(safeTelemetryErrorMessage(new Error("_Bearer abc123"), "fallback")).toBe("_Bearer abc123");
  });

  it("redacts Bearer values separated by JavaScript whitespace", () => {
    for (const separator of JAVASCRIPT_WHITESPACE_SEPARATORS) {
      for (const [message, expected] of [
        [`Bearer${separator}abc123`, `Bearer${separator}[redacted]`],
        [`Authorization: Bearer${separator}abc`, `Authorization: Bearer${separator}[redacted]`],
        [
          `{"name":"authorization","value":"Bearer${separator}abc"}`,
          `{"name":"authorization","value":"Bearer${separator}[redacted]"}`,
        ],
      ] as const) {
        const once = safeTelemetryErrorMessage(new Error(message), "fallback");
        expect(once).toBe(expected);
        expect(safeTelemetryErrorMessage(new Error(once), "fallback")).toBe(expected);
      }
    }

    const nested = safeTelemetryErrorMessage(new Error("Bearer abc123*Bearer\u00a0def456"), "fallback");
    expect(nested).toBe("Bearer [redacted]Bearer\u00a0[redacted]");
    expect(safeTelemetryErrorMessage(new Error(nested), "fallback")).toBe(nested);

    for (const message of [
      "Basic\u00a0Zm9vOmJhcg==",
      "Authorization: Basic\u00a0badtoken",
      '{"name":"authorization","value":"Basic\u00a0badtoken"}',
    ]) {
      expect(safeTelemetryErrorMessage(new Error(message), "fallback")).toBe(message);
    }
  });

  it("redacts colon, assignment, JSON, and escaped JSON authorization labels", () => {
    for (const message of [
      "Authorization: Bearer abc",
      "authorization=Bearer abc",
      'authorization = "Bearer abc"',
      "Proxy-Authorization=Bearer abc",
      '{"authorization":"Bearer abc"}',
      String.raw`{\"authorization\":\"Bearer abc\"}`,
    ]) {
      expect(safeTelemetryErrorMessage(new Error(message), "fallback")).not.toContain("Bearer abc");
    }
    for (const message of [
      "Authorization: Basic badtoken",
      "authorization=Basic badtoken",
      'authorization = "Basic badtoken"',
      "Proxy-Authorization=Basic badtoken",
      '{"authorization":"Basic badtoken"}',
      String.raw`{\"authorization\":\"Basic badtoken\"}`,
    ]) {
      expect(safeTelemetryErrorMessage(new Error(message), "fallback")).not.toContain("Basic badtoken");
    }
  });

  it("redacts labeled credentials across serialized formats and malformed token punctuation", () => {
    const cases = new Map([
      ["Authorization: Bearer abc:key, status=bad", "Authorization: Bearer [redacted], status=bad"],
      ['Authorization: Bearer "abc:key" later', 'Authorization: Bearer "[redacted]" later'],
      ["Authorization: Basic 'user:pass' later", "Authorization: Basic '[redacted]' later"],
      ['"authorization" => "Bearer abc:key" later', '"authorization" => "Bearer [redacted]" later'],
      ['["authorization","Bearer abc:key"] later', '["authorization","Bearer [redacted]"] later'],
      ['{"authorization":["Bearer abc:key"]} later', '{"authorization":["Bearer [redacted]"]} later'],
      [String.raw`{"authorization":"Bearer abc\/def"} later`, String.raw`{"authorization":"Bearer [redacted]"} later`],
      [
        String.raw`{\"authorization\":\"Bearer abc\\\"def\"} later`,
        String.raw`{\"authorization\":\"Bearer [redacted]\"} later`,
      ],
      [
        String.raw`{\\\"authorization\\\":\\\"Bearer abc:key\\\"} later`,
        String.raw`{\\\"authorization\\\":\\\"Bearer [redacted]\\\"} later`,
      ],
      ["Authorization Bearer abc:key done", "Authorization Bearer [redacted] done"],
      ["Proxy-Authorization: Basic user:pass; done", "Proxy-Authorization: Basic [redacted]; done"],
    ]);

    for (const [message, expected] of cases) {
      expect(safeTelemetryErrorMessage(new Error(message), "fallback")).toBe(expected);
    }

    expect(safeTelemetryErrorMessage(new Error("Bearer api:key"), "fallback")).toBe("Bearer api:key");
  });

  it("redacts CGI, camelCase, tuple, map, and Undici authorization labels", () => {
    const cases = new Map([
      ["HTTP_AUTHORIZATION: Bearer abc", "HTTP_AUTHORIZATION: Bearer [redacted]"],
      ["HTTP_PROXY_AUTHORIZATION: Basic badtoken", "HTTP_PROXY_AUTHORIZATION: Basic [redacted]"],
      ["REDIRECT_HTTP_AUTHORIZATION: Bearer abc", "REDIRECT_HTTP_AUTHORIZATION: Bearer [redacted]"],
      [
        "REDIRECT_REDIRECT_HTTP_PROXY_AUTHORIZATION: Basic badtoken",
        "REDIRECT_REDIRECT_HTTP_PROXY_AUTHORIZATION: Basic [redacted]",
      ],
      ["authorizationHeader: Bearer abc", "authorizationHeader: Bearer [redacted]"],
      ["proxyAuthorizationHeader: Basic badtoken", "proxyAuthorizationHeader: Basic [redacted]"],
      ["proxyAuthorization: Bearer abc", "proxyAuthorization: Bearer [redacted]"],
      ["authorization_header: Bearer abc", "authorization_header: Bearer [redacted]"],
      ["proxy_authorization_header: Basic badtoken", "proxy_authorization_header: Basic [redacted]"],
      ["X_AUTHORIZATION: Bearer abc", "X_AUTHORIZATION: Bearer [redacted]"],
      ["HTTP_X_AUTHORIZATION: Bearer abc", "HTTP_X_AUTHORIZATION: Bearer [redacted]"],
      ["upstream_authorization: Bearer abc", "upstream_authorization: Bearer [redacted]"],
      ["Map(1) { 'authorization' => 'Bearer abc' }", "Map(1) { 'authorization' => 'Bearer [redacted]' }"],
      ['["authorization", "Basic badtoken"]', '["authorization", "Basic [redacted]"]'],
      [
        "HeadersList { headersMap: Map(1) { 'authorization' => { name: 'authorization', value: 'Bearer abc' } } }",
        "HeadersList { headersMap: Map(1) { 'authorization' => { name: 'authorization', value: 'Bearer [redacted]' } } }",
      ],
      [
        "HeadersList { headersMap: Map(1) { 'proxy-authorization' => { name: 'proxy-authorization', value: 'Basic badtoken' } } }",
        "HeadersList { headersMap: Map(1) { 'proxy-authorization' => { name: 'proxy-authorization', value: 'Basic [redacted]' } } }",
      ],
      ['{"name":"authorization","value":"Bearer abc"}', '{"name":"authorization","value":"Bearer [redacted]"}'],
      ['{"name":"x-authorization","value":"Bearer abc"}', '{"name":"x-authorization","value":"Bearer [redacted]"}'],
      [
        '{"name":"authorization","status":401,"value":"Bearer abc"}',
        '{"name":"authorization","status":401,"value":"Bearer [redacted]"}',
      ],
      [
        '{"name":"authorization","meta":{"status":401},"value":"Bearer abc"}',
        '{"name":"authorization","meta":{"status":401},"value":"Bearer [redacted]"}',
      ],
      ['{"value":"Bearer abc","name":"authorization"}', '{"value":"Bearer [redacted]","name":"authorization"}'],
      [
        '{"value":"Bearer abc","meta":{"status":401},"name":"authorization"}',
        '{"value":"Bearer [redacted]","meta":{"status":401},"name":"authorization"}',
      ],
      [
        '{ value: "Basic badtoken", status: 401, name: "proxy_authorization" }',
        '{ value: "Basic [redacted]", status: 401, name: "proxy_authorization" }',
      ],
      [
        String.raw`{\"name\":\"authorization\",\"value\":\"Bearer abc\"}`,
        String.raw`{\"name\":\"authorization\",\"value\":\"Bearer [redacted]\"}`,
      ],
      [
        String.raw`{\"value\":\"Bearer abc\",\"name\":\"authorization\"}`,
        String.raw`{\"value\":\"Bearer [redacted]\",\"name\":\"authorization\"}`,
      ],
      [
        '{"name":"x-authorization","metadata":{"source":"upstream"},"value":"Bearer abc"}',
        '{"name":"x-authorization","metadata":{"source":"upstream"},"value":"Bearer [redacted]"}',
      ],
      [
        '{"value":"Bearer abc","metadata":{"source":"upstream"},"name":"HTTP_X_AUTHORIZATION"}',
        '{"value":"Bearer [redacted]","metadata":{"source":"upstream"},"name":"HTTP_X_AUTHORIZATION"}',
      ],
    ]);

    for (const [message, expected] of cases) {
      expect(safeTelemetryErrorMessage(new Error(message), "fallback")).toBe(expected);
    }

    expect(
      safeTelemetryErrorMessage(
        new Error('{"name":"content-type","metadata":{"name":"authorization"},"value":"Bearer abc"}'),
        "fallback",
      ),
    ).toBe('{"name":"content-type","metadata":{"name":"authorization"},"value":"Bearer abc"}');
    expect(safeTelemetryErrorMessage(new Error("fooauthorization: Bearer abc"), "fallback")).toBe(
      "fooauthorization: Bearer abc",
    );
  });

  it("associates distant unbraced serialized header fields within one segment", () => {
    const metadata = `metadata:"${"x".repeat(300)}"`;
    const cases = new Map([
      [
        `name:"authorization",${metadata},value:"Bearer abc"`,
        `name:"authorization",${metadata},value:"Bearer [redacted]"`,
      ],
      [
        `value:"Bearer abc",${metadata},name:"authorization"`,
        `value:"Bearer [redacted]",${metadata},name:"authorization"`,
      ],
    ]);

    for (const [message, expected] of cases) {
      expect(safeTelemetryErrorMessage(new Error(message), "fallback")).toBe(expected);
    }

    for (const separator of [";", "\n"]) {
      const message = `name:"authorization"${separator}${metadata},value:"Bearer abc"`;
      expect(safeTelemetryErrorMessage(new Error(message), "fallback")).toBe(message);
    }
  });

  it("does not treat suffixed serialized property names as header fields", () => {
    for (const message of [
      '{display-name:"authorization",value:"Bearer abc"}',
      '{name:"authorization",display-value:"Bearer abc"}',
    ]) {
      expect(safeTelemetryErrorMessage(new Error(message), "fallback")).toBe(message);
    }
  });

  it("is idempotent across raw, quoted, escaped, aliased, and existing-marker forms", () => {
    for (const message of [
      "Authorization: Bearer abc",
      'authorization = "Bearer abc"',
      String.raw`{\"authorization\":\"Bearer abc\"}`,
      "HTTP_AUTHORIZATION: Basic badtoken",
      "authorizationHeader: Bearer abc",
      "Authorization: Bearer [redacted]",
      'Authorization: Bearer "[redacted]"',
    ]) {
      const once = safeTelemetryErrorMessage(new Error(message), "fallback");
      const twice = safeTelemetryErrorMessage(new Error(once), "fallback");
      expect(twice).toBe(once);
      expect(once.match(/\[redacted]/g)).toHaveLength(1);
    }
  });

  it("keeps marker-only labeled and serialized authorization values stable", () => {
    for (const message of [
      "Authorization: Bearer [redacted].[value omitted].",
      'name:"authorization",value:"Bearer [redacted].[value omitted]."',
    ]) {
      expect(safeTelemetryErrorMessage(new Error(message), "fallback")).toBe(message);
    }
  });

  it("does not trust a redaction marker that only prefixes a labeled credential", () => {
    for (const message of [
      "Authorization: Bearer [redacted]secret",
      'Authorization: Bearer "[redacted]secret"',
      "HTTP_AUTHORIZATION: Basic [redacted]secret",
      "authorizationHeader: Bearer [redacted]:secret",
      "name: 'authorization', value: 'Bearer [redacted]secret'",
    ]) {
      const result = safeTelemetryErrorMessage(new Error(message), "fallback");
      expect(result).not.toContain("secret");
      expect(result.match(/\[redacted]/g)).toHaveLength(1);
    }
  });

  it("keeps malformed quote recovery token-bounded and preserves punctuation", () => {
    const cases = new Map([
      [
        "Authorization: Bearer 'abc don't erase this, later' after",
        "Authorization: Bearer '[redacted] don't erase this, later' after",
      ],
      ['Authorization: Bearer "abc unrelated tail', 'Authorization: Bearer "[redacted] unrelated tail'],
      ["Authorization: Bearer 'abc\" unrelated tail", "Authorization: Bearer '[redacted]\" unrelated tail"],
      [String.raw`Authorization: Bearer "abc\\" later`, String.raw`Authorization: Bearer "[redacted]\\" later`],
      ["Authorization: Bearer (abc] tail", "Authorization: Bearer ([redacted]] tail"],
      ["Authorization: Bearer abc123.", "Authorization: Bearer [redacted]."],
      ["Authorization: Bearer abc.def", "Authorization: Bearer [redacted]"],
      ["Authorization: Bearer abc123!", "Authorization: Bearer [redacted]!"],
      ["Authorization: Bearer abc123?", "Authorization: Bearer [redacted]?"],
      ["Authorization: Bearer abc!secret", "Authorization: Bearer [redacted]"],
      ["Authorization: Bearer abc?secret", "Authorization: Bearer [redacted]"],
      ["Authorization: Bearer abc!?secret", "Authorization: Bearer [redacted]"],
      ["Authorization: Bearer abc...secret", "Authorization: Bearer [redacted]"],
      ["Authorization: Bearer abc123.!?", "Authorization: Bearer [redacted].!?"],
      ["authorization=Bearer word!&other=1", "authorization=Bearer [redacted]!&other=1"],
      ["authorization=Bearer word?&other=1", "authorization=Bearer [redacted]?&other=1"],
      ['Authorization: Bearer "abc def"', 'Authorization: Bearer "[redacted] def"'],
      ["Authorization: Bearer [] after", "Authorization: Bearer [] after"],
      ["Authorization: Bearer    ", "Authorization: Bearer"],
    ]);

    for (const [message, expected] of cases) {
      expect(safeTelemetryErrorMessage(new Error(message), "fallback")).toBe(expected);
    }
  });

  it("keeps truncated labeled redactions idempotent", () => {
    const once = safeTelemetryErrorMessage(new Error(`Authorization: Bearer ${"a".repeat(1_100)}`), "fallback");
    const twice = safeTelemetryErrorMessage(new Error(once), "fallback");

    expect(once).toBe("Authorization: Bearer [redacted]…[truncated]");
    expect(twice).toBe(once);
    expect(safeTelemetryErrorMessage(new Error("Authorization: Bearer [redacted]…[truncated]secret"), "fallback")).toBe(
      "Authorization: Bearer [redacted]",
    );
  });

  it("does not expose plain Bearer suffixes appended to sanitization markers", () => {
    expect(safeTelemetryErrorMessage(new Error("Bearer [redacted]abcdefghijklmnopqrstuvwxyz0123"), "fallback")).toBe(
      "Bearer [redacted]",
    );
    expect(safeTelemetryErrorMessage(new Error("Bearer [redacted]"), "fallback")).toBe("Bearer [redacted]");
    expect(
      safeTelemetryErrorMessage(new Error("Bearer [redacted]…[truncated]abcdefghijklmnopqrstuvwxyz0123"), "fallback"),
    ).toBe("Bearer [redacted]");
  });

  it("redacts malformed internal Bearer punctuation without consuming trailing delimiters or prose", () => {
    for (const separator of ["*", "|", "%", "$", "@", "\\", ">", "`", "^", "#"]) {
      const message = `Bearer abc${separator}def`;
      const once = safeTelemetryErrorMessage(new Error(message), "fallback");
      expect(once).toBe("Bearer [redacted]");
      expect(safeTelemetryErrorMessage(new Error(once), "fallback")).toBe(once);
    }

    expect(safeTelemetryErrorMessage(new Error("Bearer abc123* expired"), "fallback")).toBe(
      "Bearer [redacted]* expired",
    );
    expect(safeTelemetryErrorMessage(new Error("Bearer api:key"), "fallback")).toBe("Bearer api:key");
    expect(safeTelemetryErrorMessage(new Error("Use the Bearer token scheme"), "fallback")).toBe(
      "Use the Bearer token scheme",
    );
  });

  it("redacts nested Bearer prefixes without advancing past the nested credential", () => {
    for (const message of [
      "Bearer [redacted]Bearer abc123",
      "Bearer abc123[redacted]Bearer def456",
      "Bearer Bearer abc123",
    ]) {
      const once = safeTelemetryErrorMessage(new Error(message), "fallback");
      expect(once).not.toContain("abc123");
      expect(once).not.toContain("def456");
      expect(safeTelemetryErrorMessage(new Error(once), "fallback")).toBe(once);
    }
  });

  it("redacts chained authorization schemes across supported separators", () => {
    for (const separator of JAVASCRIPT_WHITESPACE_SEPARATORS) {
      const labeled = `Authorization: Bearer${separator}Bearer abc123`;
      const labeledOnce = safeTelemetryErrorMessage(new Error(labeled), "fallback");
      expect(labeledOnce).toBe(`Authorization: Bearer${separator}[redacted]`);
      expect(safeTelemetryErrorMessage(new Error(labeledOnce), "fallback")).toBe(labeledOnce);

      const serialized = `name:"authorization",value:"Bearer${separator}Bearer abc123"`;
      const serializedOnce = safeTelemetryErrorMessage(new Error(serialized), "fallback");
      expect(serializedOnce).toBe(`name:"authorization",value:"Bearer${separator}[redacted]"`);
      expect(safeTelemetryErrorMessage(new Error(serializedOnce), "fallback")).toBe(serializedOnce);

      const nestedLabeled = `Authorization: Bearer Bearer${separator}abc123`;
      const nestedLabeledOnce = safeTelemetryErrorMessage(new Error(nestedLabeled), "fallback");
      expect(nestedLabeledOnce).toBe("Authorization: Bearer [redacted]");
      expect(safeTelemetryErrorMessage(new Error(nestedLabeledOnce), "fallback")).toBe(nestedLabeledOnce);

      const nestedSerialized = `name:"authorization",value:"Bearer Bearer${separator}abc123"`;
      const nestedSerializedOnce = safeTelemetryErrorMessage(new Error(nestedSerialized), "fallback");
      expect(nestedSerializedOnce).toBe('name:"authorization",value:"Bearer [redacted]"');
      expect(safeTelemetryErrorMessage(new Error(nestedSerializedOnce), "fallback")).toBe(nestedSerializedOnce);
    }

    expect(safeTelemetryErrorMessage(new Error("Authorization: Basic Bearer abc123"), "fallback")).toBe(
      "Authorization: Basic [redacted]",
    );
    expect(safeTelemetryErrorMessage(new Error("Authorization: Bearer Basic dXNlcjpwYXNz"), "fallback")).toBe(
      "Authorization: Bearer [redacted]",
    );
  });

  it("keeps deeply wrapped marker-only Bearer values stable", () => {
    for (const count of [16, 32, 128]) {
      const message = `Bearer ${"(".repeat(count)}[value omitted]`;
      expect(safeTelemetryErrorMessage(new Error(message), "fallback")).toBe(message);
    }
  });

  it("handles every ordered pair of sanitization markers without exposing appended Bearer suffixes", () => {
    const tokenSuffix = "abcdefghijklmnopqrstuvwxyz0123";
    const separators = ["-", "~", "_", "+", "/", "=", ".", "!", "?", "*", "|", "%", "$", "@", "\\", ":"];

    for (const firstMarker of ATOMIC_SANITIZATION_MARKERS) {
      for (const secondMarker of ATOMIC_SANITIZATION_MARKERS) {
        const markerRun = `${firstMarker}${secondMarker}`;
        const plain = `Bearer ${markerRun}`;
        expect(safeTelemetryErrorMessage(new Error(plain), "fallback")).toBe(plain);
        expect(safeTelemetryErrorMessage(new Error(`${plain}${tokenSuffix}`), "fallback")).toBe("Bearer [redacted]");

        const labeled = `Authorization: Bearer ${markerRun}`;
        expect(safeTelemetryErrorMessage(new Error(labeled), "fallback")).toBe(labeled);
        expect(safeTelemetryErrorMessage(new Error(`${labeled}${tokenSuffix}`), "fallback")).toBe(
          "Authorization: Bearer [redacted]",
        );

        const rawLabeled = `Authorization: Bearer abc${markerRun}`;
        const sanitizedLabeled = `Authorization: Bearer [redacted]${markerRun}`;
        const onceLabeled = safeTelemetryErrorMessage(new Error(rawLabeled), "fallback");
        expect(onceLabeled).not.toContain("abc");
        expect(markerRun.endsWith(TRUNCATION_MARKER) || onceLabeled === sanitizedLabeled).toBe(true);
        expect(!markerRun.endsWith(TRUNCATION_MARKER) || onceLabeled.endsWith(TRUNCATION_MARKER)).toBe(true);
        expect(safeTelemetryErrorMessage(new Error(onceLabeled), "fallback")).toBe(onceLabeled);

        const rawPlain = `Bearer abc123${markerRun}${tokenSuffix}`;
        const sanitizedRawPlain = safeTelemetryErrorMessage(new Error(rawPlain), "fallback");
        expect(sanitizedRawPlain).toBe("Bearer [redacted]");
        expect(safeTelemetryErrorMessage(new Error(sanitizedRawPlain), "fallback")).toBe(sanitizedRawPlain);

        const longRun = `Bearer ${firstMarker}${secondMarker}${firstMarker}${tokenSuffix}`;
        const sanitizedLongRun = safeTelemetryErrorMessage(new Error(longRun), "fallback");
        expect(sanitizedLongRun).toBe("Bearer [redacted]");
        expect(safeTelemetryErrorMessage(new Error(sanitizedLongRun), "fallback")).toBe(sanitizedLongRun);

        for (const separator of separators) {
          for (const label of ["", "Authorization: "]) {
            const separated = `${label}Bearer ${firstMarker}${separator}${secondMarker}${tokenSuffix}`;
            const once = safeTelemetryErrorMessage(new Error(separated), "fallback");
            expect(once).toBe(`${label}Bearer [redacted]`);
            expect(safeTelemetryErrorMessage(new Error(once), "fallback")).toBe(once);
          }
        }
      }
    }
  });

  it("preserves truncated redactions through serialized JSON layers", () => {
    const message = "Authorization: Bearer [redacted]…[truncated]";
    const serialized = JSON.stringify({ message });
    const doubleSerialized = JSON.stringify(serialized);

    expect(safeTelemetryErrorMessage(new Error(serialized), "fallback")).toBe(serialized);
    expect(safeTelemetryErrorMessage(new Error(doubleSerialized), "fallback")).toBe(doubleSerialized);
  });

  it("preserves complete atomic markers after labeled credentials without trusting suffixed markers", () => {
    for (const marker of ATOMIC_SANITIZATION_MARKERS) {
      const expected = `Authorization: Bearer [redacted]${marker}`;
      const once = safeTelemetryErrorMessage(new Error(`Authorization: Bearer abc${marker}`), "fallback");
      expect(once).not.toContain("abc");
      expect(marker === TRUNCATION_MARKER || once === expected).toBe(true);
      expect(marker !== TRUNCATION_MARKER || once.endsWith(TRUNCATION_MARKER)).toBe(true);
      expect(safeTelemetryErrorMessage(new Error(once), "fallback")).toBe(once);
      expect(safeTelemetryErrorMessage(new Error(`Authorization: Bearer abc${marker}secret`), "fallback")).toBe(
        "Authorization: Bearer [redacted]",
      );
    }

    expect(safeTelemetryErrorMessage(new Error("Authorization: Bearer abc…[truncated]"), "fallback")).toBe(
      "Authorization: Bearer [redacted]…[truncated]",
    );
  });

  it("applies escaped authorization labels to nested fields and error stacks", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const escaped = String.raw`{\"authorization\":\"Bearer abc\"}`;
      const error = new Error("failed");
      error.stack = escaped;

      logger.error("test.escaped_authorization", "test", "failed", { details: { diagnostic: escaped } }, error);

      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(String(record.details)).not.toContain("Bearer abc");
      expect(record.errorStack).not.toContain("Bearer abc");
    } finally {
      output.mockRestore();
    }
  });

  it("redacts every email shape covered by the previous policy", () => {
    expect(safeTelemetryErrorMessage(new Error(`${"a".repeat(65)}@example.com`), "fallback")).toBe("[redacted-email]");
    expect(safeTelemetryErrorMessage(new Error("name@example.com-foo"), "fallback")).toBe("[redacted-email]-foo");
    expect(safeTelemetryErrorMessage(new Error("name@example.co.uk"), "fallback")).toBe("[redacted-email]");
  });

  it("does not walk through a neighboring email when truncating a URL host", () => {
    const value = "https://alice.smith@example.com@bitbucket.org/repository";
    const secondAt = value.lastIndexOf("@");
    const hostEnd = value.indexOf("/", secondAt);
    for (let cut = secondAt + 1; cut <= hostEnd; cut += 1) {
      const result = safeTelemetryErrorMessage(
        new Error(`${value}${"tail".repeat(20)}`),
        "fallback",
        cut + TRUNCATION_MARKER.length,
      );
      expect(result).not.toContain("alice.smith@");
      expect(result).toMatch(/…\[truncated\]$/);
      expect(isWellFormed(result)).toBe(true);
    }
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
    const raw = `${prefix}😀${"z".repeat(LOG_TEXT_LIMIT)}`;
    const cut = PERSISTED_ERROR_MESSAGE_LIMIT - TRUNCATION_MARKER.length;
    expect(raw.charCodeAt(cut - 1)).toBeGreaterThanOrEqual(0xd800);
    expect(raw.charCodeAt(cut - 1)).toBeLessThanOrEqual(0xdbff);
    expect(raw.charCodeAt(cut)).toBeGreaterThanOrEqual(0xdc00);
    expect(raw.charCodeAt(cut)).toBeLessThanOrEqual(0xdfff);
    const result = safeTelemetryErrorMessage(new Error(raw), "fallback");

    expect(result).toBe(prefix + TRUNCATION_MARKER);
    expect(isWellFormed(result)).toBe(true);
  });

  it("does not split a surrogate pair at a post-redaction truncation boundary", () => {
    const limit = 80;
    const safePrefix = "Basic [redacted] ";
    const payloadLimit = limit - TRUNCATION_MARKER.length;
    const rawPrefix = `Basic Og== ${"x".repeat(payloadLimit - safePrefix.length - 1)}`;
    const raw = `${rawPrefix}😀${"z".repeat(limit)}`;
    const sanitizedPrefixLength = safePrefix.length + rawPrefix.length - "Basic Og== ".length;
    expect(sanitizedPrefixLength).toBe(payloadLimit - 1);

    const result = safeTelemetryErrorMessage(new Error(raw), "fallback", limit);

    expect(result).toBe(`${safePrefix}${"x".repeat(payloadLimit - safePrefix.length - 1)}${TRUNCATION_MARKER}`);
    expect(result).not.toContain("Og==");
    expect(isWellFormed(result)).toBe(true);
  });

  it("honors a caller-supplied persistence limit", () => {
    const result = safeTelemetryErrorMessage(
      new Error(`${"x".repeat(45)} Authorization: Basic dXNlcjpwYXNz ${"y".repeat(80)}`),
      "fallback",
      64,
    );

    expect(result.length).toBeLessThanOrEqual(64);
    expect(result).not.toContain("dXNlcjpwYXNz");
    expect(result).toMatch(/…\[truncated\]$/);
  });

  it("is a bounded, well-formed fixed point across representative cut positions", () => {
    const values = [
      "https://alice.smith@example.com@bitbucket.org/repository",
      "Authorization: Bearer\u00a0Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
      'Basic "dXNlcjpwYXNz" after',
      `Bearer 1 ${"x".repeat(50)} Basic dXNlcjpwYXNz tail`,
      "Bearer .[redacted].[value omitted]. tail",
      `prefix 😀 Authorization: Bearer abc123 ${"z".repeat(40)}`,
    ];

    for (const value of values) {
      for (let limit = TRUNCATION_MARKER.length + 1; limit < value.length; limit += 1) {
        const once = safeTelemetryErrorMessage(new Error(value), "fallback", limit);
        const twice = safeTelemetryErrorMessage(new Error(once), "fallback", limit);
        expect(once.length).toBeLessThanOrEqual(limit);
        expect(isWellFormed(once)).toBe(true);
        expect(twice).toBe(once);
      }
    }
  });

  it("keeps redaction and truncation markers atomic when sanitizing expands the payload", () => {
    for (const credential of [" Bearer abc123", " Authorization: Bearer abc123"]) {
      const payloadLimit = PERSISTED_ERROR_MESSAGE_LIMIT - TRUNCATION_MARKER.length;
      const raw = `${"x".repeat(payloadLimit - credential.length)}${credential}${"tail".repeat(20)}`;
      const result = safeTelemetryErrorMessage(new Error(raw), "fallback");

      expect(result).not.toContain("abc123");
      expect(result.replaceAll("[redacted]", "")).not.toContain("[reda");
      expect(result).toMatch(/…\[truncated\]$/);
      expect(result.length).toBeLessThanOrEqual(PERSISTED_ERROR_MESSAGE_LIMIT);
      expect(result.match(/…\[truncated\]/g)).toHaveLength(1);
      expect(isWellFormed(result)).toBe(true);
    }
  });

  it("reruns cut-aware redaction after an earlier replacement expands the payload", () => {
    const limit = 96;
    const payloadLimit = limit - TRUNCATION_MARKER.length;
    const firstCredential = "Bearer 1 ";
    const finalCredential = "Basic dXNlcjpwYXNz";
    const rawPrefix = `${firstCredential}${"x".repeat(payloadLimit - firstCredential.length - finalCredential.length - 1)} ${finalCredential}`;
    const result = safeTelemetryErrorMessage(new Error(`${rawPrefix}${"tail".repeat(20)}`), "fallback", limit);

    expect(result).not.toContain("dXNlcjpwYXNz");
    expect(result).not.toMatch(/Basic dXN/);
    expect(result.length).toBeLessThanOrEqual(limit);
    expect(result).toMatch(/…\[truncated\]$/);
    expect(isWellFormed(result)).toBe(true);
  });

  it("keeps an existing truncation marker intact across repeated sanitization", () => {
    const raw = `${"x".repeat(960)} Authorization: Bearer abc${"tail".repeat(100)}`;
    const once = safeTelemetryErrorMessage(new Error(raw), "fallback");
    const twice = safeTelemetryErrorMessage(new Error(once), "fallback");

    expect(once).toMatch(/…\[truncated\]$/);
    expect(once.match(/…\[truncated\]/g)).toHaveLength(1);
    expect(twice).toBe(once);
    expect(twice).not.toMatch(/\]\]$/);
    expect(safeTelemetryErrorMessage(new Error("Authorization: Bearer …[truncated]secret"), "fallback")).toBe(
      "Authorization: Bearer [redacted]",
    );
  });

  it("re-bounds raw strings that grow during redaction", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const credential of [" Bearer abc123", " Authorization: Bearer abc123"]) {
        const expanding = (limit: number) => "x".repeat(limit - credential.length) + credential;
        const persisted = safeTelemetryErrorMessage(new Error(expanding(PERSISTED_ERROR_MESSAGE_LIMIT)), "fallback");
        const error = new Error(expanding(LOG_TEXT_LIMIT));
        error.stack = expanding(LOG_STACK_LIMIT);

        logger.error(
          "test.redaction_growth",
          "test",
          expanding(LOG_TEXT_LIMIT),
          { otherId: expanding(LOG_IDENTIFIER_LIMIT), note: expanding(LOG_TEXT_LIMIT) },
          error,
        );

        const record = output.mock.calls.at(-1)?.[0] as Record<string, unknown>;
        for (const [value, limit] of [
          [persisted, PERSISTED_ERROR_MESSAGE_LIMIT],
          [String(record.otherId), LOG_IDENTIFIER_LIMIT],
          [String(record.note), LOG_TEXT_LIMIT],
          [String(record.message), LOG_TEXT_LIMIT],
          [String(record.errorMessage), LOG_TEXT_LIMIT],
          [String(record.errorStack), LOG_STACK_LIMIT],
        ] as const) {
          expect(value.length).toBeLessThanOrEqual(limit);
          expect(value).toContain(TRUNCATION_MARKER);
          expect(value.replaceAll("[redacted]", "")).not.toContain("[reda");
          expect(isWellFormed(value)).toBe(true);
        }
      }
    } finally {
      output.mockRestore();
    }
  });

  it("bounds long labeled credentials in near-linear time without losing safe context", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const diagnostic = `trace Authorization: Bearer abc retained-context ${"x".repeat(17_000)}`;
      const error = new Error(diagnostic);
      error.stack = diagnostic;
      const started = performance.now();

      const persisted = safeTelemetryErrorMessage(error, "fallback");
      logger.error("test.long_labeled", "test", diagnostic, {}, error);

      expect(performance.now() - started).toBeLessThan(1_000);
      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      for (const [value, limit] of [
        [persisted, PERSISTED_ERROR_MESSAGE_LIMIT],
        [String(record.message), LOG_TEXT_LIMIT],
        [String(record.errorStack), LOG_STACK_LIMIT],
      ] as const) {
        expect(value.length).toBeLessThanOrEqual(limit);
        expect(value).toContain("retained-context");
        expect(value).toMatch(/…\[truncated]$/);
        expect(value.match(/\[redacted]/g)).toHaveLength(1);
        expect(value).not.toContain("[[redacted]]");
      }
    } finally {
      output.mockRestore();
    }
  });

  it("redacts maximum-length punctuation runs without losing safe context", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const credential = `${".".repeat(15_300)}a`;
      const diagnostic = `Authorization: Bearer ${credential} retained-context`;
      const error = new Error("failed");
      error.stack = diagnostic;

      for (let index = 0; index < 8; index += 1) {
        logger.error("test.punctuation_run", "test", "failed", {}, error);
      }

      for (const [record] of output.mock.calls) {
        const stack = String((record as Record<string, unknown>).errorStack);
        expect(stack).toBe("Authorization: Bearer [redacted] retained-context");
        expect(stack).not.toContain(credential.slice(0, 100));
      }
    } finally {
      output.mockRestore();
    }
  });

  it("safely handles large adversarial serialized-header inputs", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const sanitize = (diagnostic: string) => {
        const error = new Error("failed");
        error.stack = diagnostic;
        logger.error("test.serialized_header_adversarial", "test", "failed", {}, error);
        const record = output.mock.calls.at(-1)?.[0] as Record<string, unknown>;
        return String(record.errorStack);
      };
      const repeatedName = 'name:"authorization",';
      const inputs = [
        (length: number) => `${"\\".repeat(length)}"name":"authorization","value":"Bearer abc"`,
        (length: number) => `${repeatedName.repeat(Math.floor(length / repeatedName.length))}value:"Bearer abc"`,
      ];

      for (const input of inputs) {
        const result = sanitize(input(15_000));
        expect(result).toContain("[redacted]");
        expect(result).not.toContain("Bearer abc");
        expect(result.length).toBeLessThanOrEqual(LOG_STACK_LIMIT);
        expect(isWellFormed(result)).toBe(true);
      }
    } finally {
      output.mockRestore();
    }
  }, 10_000);

  it("keeps adversarial serialized-header scans near-linear", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const medianDuration = (diagnostic: string) => {
        const error = new Error("failed");
        error.stack = diagnostic;
        const duration = warmedMedianPerOperation(() => {
          logger.error("test.serialized_header_warmup", "test", "failed", {}, error);
        });
        const record = output.mock.calls.at(-1)?.[0] as Record<string, unknown>;
        return { duration, stack: String(record.errorStack) };
      };
      const repeatedName = 'name:"authorization",';
      const inputs = [
        (length: number) => `${"\\".repeat(length)}"name":"authorization","value":"Bearer abc"`,
        (length: number) => `${repeatedName.repeat(Math.floor(length / repeatedName.length))}value:"Bearer abc"`,
      ];

      for (const input of inputs) {
        const shortResult = medianDuration(input(4_000));
        const longResult = medianDuration(input(15_000));
        expect(longResult.duration / Math.max(shortResult.duration, 0.01)).toBeLessThan(8);
        for (const result of [shortResult, longResult]) {
          expect(result.stack).toContain("[redacted]");
          expect(result.stack).not.toContain("Bearer abc");
        }
      }
    } finally {
      output.mockRestore();
    }
  }, 10_000);

  it("safely handles large adversarial wrapper and partial-secret cuts", () => {
    const wrapperInput = (length: number) =>
      `Bearer ${"(".repeat(64)}${"[redacted]a".repeat(Math.ceil(length / 11))}`.slice(0, length);
    const secretInput = (length: number) => "-sk_".repeat(Math.ceil(length / 4)).slice(0, length);
    for (const input of [wrapperInput, secretInput]) {
      const limit = 14_999;
      const once = safeTelemetryErrorMessage(new Error(input(15_000)), "fallback", limit);
      expect(once).toContain(input === wrapperInput ? "[redacted]" : "[redacted-secret]");
      expect(once.length).toBeLessThanOrEqual(limit);
      expect(once).toMatch(/…\[truncated\]$/);
      expect(once.match(/…\[truncated\]/g)).toHaveLength(1);
      expect(isWellFormed(once)).toBe(true);
      expect(safeTelemetryErrorMessage(new Error(once), "fallback", limit)).toBe(once);
    }
  }, 10_000);

  it("keeps wrapper and partial-secret cut scans near-linear", () => {
    const medianDuration = (input: () => string, limit: number) => {
      return warmedMedianPerOperation(() => {
        safeTelemetryErrorMessage(new Error(input()), "fallback", limit);
      });
    };

    const wrapperInput = (length: number) =>
      `Bearer ${"(".repeat(64)}${"[redacted]a".repeat(Math.ceil(length / 11))}`.slice(0, length);
    const secretInput = (length: number) => "-sk_".repeat(Math.ceil(length / 4)).slice(0, length);
    expect(safeTelemetryErrorMessage(new Error(wrapperInput(4_000)), "fallback", 3_999)).toContain("[redacted]");
    expect(safeTelemetryErrorMessage(new Error(secretInput(4_000)), "fallback", 3_999)).toContain("[redacted-secret]");

    for (const input of [wrapperInput, secretInput]) {
      const shortDuration = medianDuration(() => input(4_000), 3_999);
      const longDuration = medianDuration(() => input(15_000), 14_999);
      expect(longDuration / Math.max(shortDuration, 0.01)).toBeLessThan(8);
    }
  }, 10_000);

  it("keeps semantic authorization-boundary scans near-linear", () => {
    const measure = (length: number) => {
      const diagnostic = `Bearer https://x/${"a-".repeat(Math.ceil(length / 2))}`.slice(0, length);
      const error = new Error(diagnostic);
      const duration = warmedMedianPerOperation(() => {
        safeTelemetryErrorMessage(error, "fallback", LOG_STACK_LIMIT);
      });
      return { duration, result: safeTelemetryErrorMessage(error, "fallback", LOG_STACK_LIMIT) };
    };

    const shortResult = measure(4_000);
    const longResult = measure(15_000);
    expect(longResult.duration / Math.max(shortResult.duration, 0.01)).toBeLessThan(8);
    for (const result of [shortResult, longResult]) expect(result.result).toBe("Bearer [redacted]");
  }, 10_000);

  it("redacts quoted URLs, repeated quoted schemes, and fake Basic markers", () => {
    const cases = [
      ['Bearer "https://api.io/cb?a=1&token=SECRET123"', 'Bearer "[redacted]"'],
      ['Bearer \\"https://api.io/cb?a=1&token=SECRET123\\"', 'Bearer \\"[redacted]\\"'],
      ['Authorization: Bearer Basic "dXNlcjpwYXNz"', 'Authorization: Bearer Basic "[redacted]"'],
      ['Bearer Bearer "eyJhbGciOiJIUzI1NiJ9.payload.signature"', 'Bearer Bearer "[redacted]"'],
      ["Basic [redacted]dXNlcjpwYXNz", "Basic [redacted]"],
      ["Basic [redacted][redacted]dXNlcjpwYXNz", "Basic [redacted]"],
      ["Basic dXNlcj[redacted]pwYXNz", "Basic [redacted]"],
    ] as const;

    for (const [raw, expected] of cases) {
      const once = safeTelemetryErrorMessage(new Error(raw), "fallback");
      expect(once).toBe(expected);
      expect(once).not.toContain("SECRET123");
      expect(once).not.toContain("dXNlcjpwYXNz");
      expect(safeTelemetryErrorMessage(new Error(once), "fallback")).toBe(once);
    }
  });

  it("redacts authorization URLs through queries and URL punctuation", () => {
    const cases = [
      ["Authorization: Bearer https://x.io/cb?a=1&token=SECRET", "Authorization: Bearer [redacted]"],
      ['Authorization: Bearer "https://x.io/cb?a=1&token=SECRET"', 'Authorization: Bearer "[redacted]"'],
      ["Bearer https://x.io/a;b?token=SECRET", "Bearer [redacted]"],
      ["Authorization: Bearer https://[::1]/cb?token=SECRET", "Authorization: Bearer [redacted]"],
      ["Authorization: Bearer https://x.io/[redacted-email]?token=SECRET", "Authorization: Bearer [redacted]"],
      ["Bearer https://x.io/o'brien/cb?token=SECRET", "Bearer [redacted]"],
      [`Bearer "https://x.io/o'brien/cb?token=SECRET"`, `Bearer "[redacted]"`],
      ['Bearer "https://x.io/cb?token=SECRET diagnostic text', 'Bearer "[redacted] diagnostic text'],
    ] as const;

    for (const [raw, expected] of cases) {
      const once = safeTelemetryErrorMessage(new Error(raw), "fallback");
      expect(once).toBe(expected);
      expect(once).not.toContain("SECRET");
      expect(safeTelemetryErrorMessage(new Error(once), "fallback")).toBe(once);
    }
  });

  it("stops authorization URLs only at semantic authorization restarts", () => {
    const cases = [
      ["tokens=[Bearer https://x.io/cb,Bearer eyJhbGciOi.payload.sig]", "tokens=[Bearer [redacted],Bearer [redacted]]"],
      ...["|", ":", "/", "?", "#", "+", "[", "{", "("].map(
        (separator) =>
          [
            `Bearer https://x.io/cb${separator}Bearer eyJhbGciOi.payload.sig`,
            `Bearer [redacted]${separator}Bearer [redacted]`,
          ] as const,
      ),
      [
        "authorization=Bearer https://x.io/cb;proxy-authorization=Basic user:pass;status=401;request_id=abc",
        "authorization=Bearer [redacted];proxy-authorization=Basic [redacted];status=401;request_id=abc",
      ],
      [
        "Authorization: Bearer https://x.io/cb;proxy-authorization=Basic user:pass;status=401;request_id=abc",
        "Authorization: Bearer [redacted];proxy-authorization=Basic [redacted];status=401;request_id=abc",
      ],
      [
        '{"name":"authorization","value":"Bearer https://x.io/cb;proxy-authorization=Basic user:pass;status=401;request_id=abc"}',
        '{"name":"authorization","value":"Bearer [redacted];proxy-authorization=Basic [redacted];status=401;request_id=abc"}',
      ],
      ["Bearer https://x.io/a;b?token=SECRET", "Bearer [redacted]"],
      ["Bearer https://x.io/cb?a=1&token=SECRET", "Bearer [redacted]"],
      ["Bearer HTTPS://x.io/cb?a=1&token=SECRET", "Bearer [redacted]"],
    ] as const;

    for (const [raw, expected] of cases) {
      const once = safeTelemetryErrorMessage(new Error(raw), "fallback");
      expect(once).toBe(expected);
      expect(once).not.toContain("payload.sig");
      expect(once).not.toContain("user:pass");
      expect(once).not.toContain("SECRET");
      expect(safeTelemetryErrorMessage(new Error(once), "fallback")).toBe(once);
    }
  });

  it("redacts URL authority userinfo before preserving the URL base", () => {
    for (const [raw, expected] of [
      [
        "request https://alice:secret@example.test/path?trace=1 failed",
        "request https://[redacted]@example.test/path failed",
      ],
      [
        "request https://alice:secret@localhost/path?trace=1 failed",
        "request https://[redacted]@localhost/path failed",
      ],
      [
        "request https://alice:secret@127.0.0.1/path?trace=1 failed",
        "request https://[redacted]@127.0.0.1/path failed",
      ],
      [
        "request HTTPS://alice:secret@example.test/path?trace=1 failed",
        "request HTTPS://[redacted]@example.test/path failed",
      ],
      [
        String.raw`request https://example.test\docs@v1/file?trace=1 failed`,
        String.raw`request https://example.test\docs@v1/file failed`,
      ],
      [
        String.raw`request https://alice:secret@example.test\docs@v1/file?trace=1 failed`,
        String.raw`request https://[redacted]@example.test\docs@v1/file failed`,
      ],
      ["request https://alice:p@ss@localhost/path?trace=1 failed", "request https://[redacted]@localhost/path failed"],
    ] as const) {
      const once = safeTelemetryErrorMessage(new Error(raw), "fallback");
      expect(once).toBe(expected);
      expect(once).not.toContain("alice");
      expect(once).not.toContain("secret");
      expect(safeTelemetryErrorMessage(new Error(once), "fallback")).toBe(once);
    }

    for (const whitespace of ["\t", "\r", "\n"]) {
      const raw = `request https://alice:secret${whitespace}@example.test/path?trace=1 failed`;
      const once = safeTelemetryErrorMessage(new Error(raw), "fallback");
      expect(once).toBe("request https://[redacted]@example.test/path failed");
      expect(once).not.toContain("alice");
      expect(once).not.toContain("secret");
      expect(once).not.toContain("trace");
    }

    for (const diagnostic of [
      '{"url":"https://example.test","peer":"user@localhost"}',
      "url=https://example.test;peer=user@localhost;status=500",
      "url=https://example.test,peer=user@localhost,status=500",
    ]) {
      expect(safeTelemetryErrorMessage(new Error(diagnostic), "fallback")).toBe(diagnostic);
    }
  });

  it("keeps marker-prefixed Basic URLs for query scrubbing and makes Basic redaction a fixed point", () => {
    const cases = [
      ["Basic …[truncated]https://x.io/cb?t=secret", "Basic …[truncated]https://x.io/cb"],
      ["Basic [redacted]https://x.io/cb?t=secret", "Basic [redacted]https://x.io/cb"],
      ["Basic a@b.co=1 failed", "Basic [redacted-email]=1 failed"],
      ["Basic dXNl[redacted]YXNz", "Basic dXNl[redacted]YXNz"],
    ] as const;

    for (const [raw, expected] of cases) {
      const once = safeTelemetryErrorMessage(new Error(raw), "fallback");
      expect(once).toBe(expected);
      expect(safeTelemetryErrorMessage(new Error(once), "fallback")).toBe(once);
    }
  });

  it("keeps the conservative Bearer newline behavior", () => {
    const direct = safeTelemetryErrorMessage(
      new Error("Authorization: Bearer\n  at handler (worker.ts:10:2)"),
      "fallback",
    );
    expect(direct).toBe("Authorization: Bearer\n  [redacted] handler (worker.ts:10:2)");

    const repeated = safeTelemetryErrorMessage(
      new Error("Authorization: Bearer Bearer\n  at handler (worker.ts:10:2)"),
      "fallback",
    );
    expect(repeated).toBe("Authorization: Bearer [redacted] handler (worker.ts:10:2)");
    expect(safeTelemetryErrorMessage(new Error(direct), "fallback")).toBe(direct);
    expect(safeTelemetryErrorMessage(new Error(repeated), "fallback")).toBe(repeated);
  });

  it("uses the same canonical secret prefixes for full values and truncation boundaries", () => {
    const prefixes = ["sk_", "crn_", "ghp_", "github_pat_", "secret_", "xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"];
    const limit = 96;
    const payloadLimit = limit - TRUNCATION_MARKER.length;

    for (const prefix of prefixes) {
      const full = `${prefix}abcdefgh`;
      expect(safeTelemetryErrorMessage(new Error(full), "fallback")).toBe("[redacted-secret]");

      const fragment = `${prefix}abc`;
      const raw = `${"x".repeat(payloadLimit - fragment.length - 1)} ${fragment}${"tail".repeat(10)}`;
      const once = safeTelemetryErrorMessage(new Error(raw), "fallback", limit);
      expect(once).toMatch(/…\[truncated\]$/);
      expect(once.match(/…\[truncated\]/g)).toHaveLength(1);
      expect(once).not.toContain(fragment);
      expect(once.length).toBeLessThanOrEqual(limit);
      expect(isWellFormed(once)).toBe(true);
      expect(safeTelemetryErrorMessage(new Error(once), "fallback", limit)).toBe(once);
    }
  });

  it("checks raw cut boundaries before URL-query stripping and preserves expanded context", () => {
    const limit = 96;
    const payloadLimit = limit - TRUNCATION_MARKER.length;
    const leaked = "YWxpY2UuYWRtaW46aHVud";
    const boundary = `/cb?h=Basic ${leaked}`;
    const raw = `${"x".repeat(payloadLimit - boundary.length)}${boundary}ZXI= retained`;
    const cut = safeTelemetryErrorMessage(new Error(raw), "fallback", limit);
    expect(cut).not.toContain(leaked);
    expect(cut.match(/…\[truncated\]/g)).toHaveLength(1);
    expect(cut.length).toBeLessThanOrEqual(limit);
    expect(isWellFormed(cut)).toBe(true);
    expect(safeTelemetryErrorMessage(new Error(cut), "fallback", limit)).toBe(cut);

    const alreadyCut = `before Basic YTpi retained-context${TRUNCATION_MARKER}`;
    const expanded = safeTelemetryErrorMessage(new Error(alreadyCut), "fallback", limit);
    expect(expanded).toContain("Basic [redacted] retained-context");
    expect(expanded.match(/…\[truncated\]/g)).toHaveLength(1);
    expect(expanded.length).toBeLessThanOrEqual(limit);
    expect(safeTelemetryErrorMessage(new Error(expanded), "fallback", limit)).toBe(expanded);
  });

  it("scrubs open sensitive suffixes at the raw boundary", () => {
    const cutMessage = (value: string, leading = "", valueBoundary = " ") => {
      const prefixLength = PERSISTED_ERROR_MESSAGE_LIMIT - TRUNCATION_MARKER.length - leading.length - value.length;
      const prefix = `${leading}${"x".repeat(prefixLength - valueBoundary.length)}${valueBoundary}`;
      return safeTelemetryErrorMessage(new Error(`${prefix}${value}${"tail".repeat(30)}`), "fallback");
    };
    const boundaryMessage = (
      scheme: "Basic" | "Bearer",
      fragment: string,
      leading = "",
      separator = " ",
      schemeBoundary = " ",
    ) => cutMessage(`${scheme}${separator}${fragment}`, leading, schemeBoundary);

    for (const length of [1, 5, 9, 13, 15]) {
      const fragment = "A".repeat(length);
      const result = boundaryMessage("Basic", fragment);
      expect(result).not.toContain(`Basic ${fragment}`);
      expect(result).toMatch(/…\[truncated\]$/);
      expect(result.length).toBeLessThanOrEqual(PERSISTED_ERROR_MESSAGE_LIMIT);
      expect(result.replaceAll("[redacted]", "")).not.toContain("[reda");
    }
    for (const length of [1, 15]) {
      const fragment = "a".repeat(length);
      const result = boundaryMessage("Bearer", fragment);
      expect(result).not.toContain(`Bearer ${fragment}`);
      expect(result).toMatch(/…\[truncated\]$/);
      expect(result.length).toBeLessThanOrEqual(PERSISTED_ERROR_MESSAGE_LIMIT);
      expect(result.replaceAll("[redacted]", "")).not.toContain("[reda");
    }

    const afterEarlierRedaction = boundaryMessage("Bearer", "a", "Authorization: Bearer abcdefghijklmnop ");
    expect(afterEarlierRedaction).not.toContain("Bearer a");

    const unicodeWhitespace = boundaryMessage("Bearer", "a", "", "\u00a0");
    expect(unicodeWhitespace).not.toContain("Bearer\u00a0a");
    expect(unicodeWhitespace).toMatch(/…\[truncated\]$/);
    expect(unicodeWhitespace.length).toBeLessThanOrEqual(PERSISTED_ERROR_MESSAGE_LIMIT);
    expect(unicodeWhitespace.replaceAll("[redacted]", "")).not.toContain("[reda");

    for (const boundary of UNICODE_SIMPLE_FOLD_BEARER_CHARACTERS) {
      const unicodeCaseFoldBoundary = boundaryMessage("Bearer", "a", "", " ", boundary);
      expect(unicodeCaseFoldBoundary).not.toContain(`${boundary}Bearer a`);
      expect(unicodeCaseFoldBoundary).toMatch(/…\[truncated\]$/);
      expect(unicodeCaseFoldBoundary.length).toBeLessThanOrEqual(PERSISTED_ERROR_MESSAGE_LIMIT);
      expect(unicodeCaseFoldBoundary.replaceAll("[redacted]", "")).not.toContain("[reda");

      for (const fragment of [boundary, `a${boundary}`]) {
        const unicodeCaseFoldFragment = boundaryMessage("Bearer", fragment);
        expect(unicodeCaseFoldFragment).not.toContain(`Bearer ${fragment}`);
        expect(unicodeCaseFoldFragment).toMatch(/…\[truncated\]$/);
        expect(unicodeCaseFoldFragment.length).toBeLessThanOrEqual(PERSISTED_ERROR_MESSAGE_LIMIT);
        expect(unicodeCaseFoldFragment.replaceAll("[redacted]", "")).not.toContain("[reda");
      }

      const longUnicodeCaseFoldFragment = boundaryMessage("Bearer", `${"a".repeat(15)}${boundary}`);
      expect(longUnicodeCaseFoldFragment).toMatch(/Bearer \[redacted\]…\[truncated\]$/);
      expect(longUnicodeCaseFoldFragment.length).toBeLessThanOrEqual(PERSISTED_ERROR_MESSAGE_LIMIT);
    }

    for (const punctuation of ["!", "?", "*", "|", "%", "$", "@", "\\", ">", "`", "^", "#", ":"]) {
      const shortMalformedFragment = boundaryMessage("Bearer", `a${punctuation}`);
      expect(shortMalformedFragment).toMatch(/Bearer …\[truncated\]$/);
      expect(shortMalformedFragment).not.toContain(`Bearer a${punctuation}`);

      const longMalformedFragment = boundaryMessage("Bearer", `${"a".repeat(15)}${punctuation}`);
      const preservedPunctuation = punctuation === "!" || punctuation === "?" ? punctuation : "";
      expect(longMalformedFragment).toContain(`Bearer [redacted]${preservedPunctuation}${TRUNCATION_MARKER}`);
      expect(longMalformedFragment.length).toBeLessThanOrEqual(PERSISTED_ERROR_MESSAGE_LIMIT);
    }

    for (const delimiter of [",", ";", "}", "]", ")", "&", " ", "\t", '"', "'"]) {
      const delimitedFragment = boundaryMessage("Bearer", `a${delimiter}`);
      expect(delimitedFragment).toContain(`Bearer a${delimiter}${TRUNCATION_MARKER}`);
      expect(delimitedFragment).not.toContain("[redacted]");
    }

    const terminalPunctuation = ["", ".", "!", "?", "!?"] as const;
    const sensitiveSuffixes = [
      { raw: "Bearer aaa", leaked: "Bearer aaa", expected: "Bearer [redacted]", marker: "[redacted]" },
      {
        raw: "Basic dXNlcm5hbWU",
        leaked: "Basic dXNlcm5hbWU",
        expected: "Basic [redacted]",
        marker: "[redacted]",
      },
      {
        raw: "first.last@exampl",
        leaked: "first.last@exampl",
        expected: "[redacted-email]",
        marker: "[redacted-email]",
      },
      {
        raw: "ghp_abcd",
        leaked: "ghp_abcd",
        expected: "[redacted-secret]",
        marker: "[redacted-secret]",
      },
      {
        raw: "sk_abcd",
        leaked: "sk_abcd",
        expected: "[redacted-secret]",
        marker: "[redacted-secret]",
      },
      {
        raw: "crn_abcd",
        leaked: "crn_abcd",
        expected: "[redacted-secret]",
        marker: "[redacted-secret]",
      },
      {
        raw: "github_pat_abcd",
        leaked: "github_pat_abcd",
        expected: "[redacted-secret]",
        marker: "[redacted-secret]",
      },
      {
        raw: "secret_abcd",
        leaked: "secret_abcd",
        expected: "[redacted-secret]",
        marker: "[redacted-secret]",
      },
      {
        raw: "xoxb-abcd",
        leaked: "xoxb-abcd",
        expected: "[redacted-secret]",
        marker: "[redacted-secret]",
      },
    ] as const;

    for (const marker of ATOMIC_SANITIZATION_MARKERS) {
      for (const punctuation of terminalPunctuation) {
        const markerOnlyValue = `Bearer ${marker}${punctuation}`;
        const markerOnly = cutMessage(markerOnlyValue);
        expect(markerOnly).toContain(`${markerOnlyValue}${TRUNCATION_MARKER}`);
        expect(markerOnly.length).toBeLessThanOrEqual(PERSISTED_ERROR_MESSAGE_LIMIT);
        expect(isWellFormed(markerOnly)).toBe(true);
        expect(safeTelemetryErrorMessage(new Error(markerOnly), "fallback")).toBe(markerOnly);

        for (const { raw, leaked, expected, marker: expectedMarker } of sensitiveSuffixes) {
          const markedCredential = cutMessage(`${raw}${marker}${punctuation}`);
          expect(markedCredential).not.toContain(leaked);
          expect(markedCredential).toContain(`${expected}${punctuation}${TRUNCATION_MARKER}`);
          expect(markedCredential.split(expectedMarker)).toHaveLength(2);
          expect(markedCredential).toMatch(/…\[truncated\]$/);
          expect(markedCredential.length).toBeLessThanOrEqual(PERSISTED_ERROR_MESSAGE_LIMIT);
          expect(safeTelemetryErrorMessage(new Error(markedCredential), "fallback")).toBe(markedCredential);
        }
      }
    }

    const alternatingMarkerRun = cutMessage(`Bearer aaa[redacted].[value omitted]!?`);
    expect(alternatingMarkerRun).toContain(`Bearer [redacted][value omitted]!?${TRUNCATION_MARKER}`);
    expect(alternatingMarkerRun).not.toContain("aaa");
    expect(safeTelemetryErrorMessage(new Error(alternatingMarkerRun), "fallback")).toBe(alternatingMarkerRun);

    const punctuationOnly = cutMessage("Bearer .");
    expect(punctuationOnly).toContain(`Bearer ${TRUNCATION_MARKER}`);
    expect(safeTelemetryErrorMessage(new Error(punctuationOnly), "fallback")).toBe(punctuationOnly);

    const markerOnlyAlternatingValue = "Bearer [redacted].[value omitted].";
    const markerOnlyAlternating = cutMessage(markerOnlyAlternatingValue);
    expect(markerOnlyAlternating).toContain(`${markerOnlyAlternatingValue}${TRUNCATION_MARKER}`);
    expect(safeTelemetryErrorMessage(new Error(markerOnlyAlternating), "fallback")).toBe(markerOnlyAlternating);
    expect(safeTelemetryErrorMessage(new Error(markerOnlyAlternatingValue), "fallback")).toBe(
      markerOnlyAlternatingValue,
    );

    for (const wrapper of ["[", "(", '"', "'"]) {
      const markerOnlyValue = `Bearer ${wrapper}[value omitted].`;
      const markerOnly = cutMessage(markerOnlyValue);
      expect(markerOnly).toContain(`${markerOnlyValue}${TRUNCATION_MARKER}`);
      expect(safeTelemetryErrorMessage(new Error(markerOnly), "fallback")).toBe(markerOnly);

      const wrappedCredential = cutMessage(`Bearer ${wrapper}aaa[value omitted].`);
      expect(wrappedCredential).toContain(`Bearer ${wrapper}[redacted].${TRUNCATION_MARKER}`);
      expect(wrappedCredential).not.toContain("aaa");
      expect(safeTelemetryErrorMessage(new Error(wrappedCredential), "fallback")).toBe(wrappedCredential);

      const wrappedBasic = cutMessage(`Basic ${wrapper}dXNlcm5hbWU`);
      expect(wrappedBasic).toContain(`Basic ${wrapper}[redacted]${TRUNCATION_MARKER}`);
      expect(wrappedBasic).not.toContain("dXNlcm5hbWU");
      expect(safeTelemetryErrorMessage(new Error(wrappedBasic), "fallback")).toBe(wrappedBasic);
    }
  });

  it("redacts authorization headers and preserves non-credential free-text Basic values", () => {
    const message =
      "Basic bm9jb2xvbg==; Basic not-base64!; Basic\nZm9vOmJhcg==; Authorization: Basic badtoken; Basic idea,";
    expect(safeTelemetryErrorMessage(new Error(message), "fallback")).toBe(
      "Basic bm9jb2xvbg==; Basic not-base64!; Basic\nZm9vOmJhcg==; Authorization: Basic [redacted]; Basic idea,",
    );
    const longToken = "Ab1+".repeat(20);
    const result = safeTelemetryErrorMessage(
      new Error(`${"x".repeat(PERSISTED_ERROR_MESSAGE_LIMIT - 46)} Authorization: Basic ${longToken}`),
      "fallback",
    );
    expect(result).toContain("Basic [redacted]");
    expect(result).not.toContain(longToken.slice(0, 20));
    expect(result.length).toBeLessThanOrEqual(PERSISTED_ERROR_MESSAGE_LIMIT);
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

  it("keeps colliding key suffixes Unicode-safe and sanitization markers atomic", () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const surrogateFirst = `one@example.com${"x".repeat(181)}😀`;
      const surrogateSecond = `two@example.com${"x".repeat(181)}😀`;
      const truncatedPrefix = "k".repeat(LOG_IDENTIFIER_LIMIT);

      logger.info("test.key_boundaries", "test", "key boundaries", {
        [surrogateFirst]: 1,
        [surrogateSecond]: 2,
        [`${truncatedPrefix}one`]: 3,
        [`${truncatedPrefix}two`]: 4,
      });

      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => key.startsWith("[redacted-email]") || key.startsWith("k"));
      expect(keys).toHaveLength(4);
      expect(keys.every(isWellFormed)).toBe(true);
      expect(keys.some((key) => key.endsWith("😀"))).toBe(true);
      expect(keys.some((key) => key.endsWith("#2"))).toBe(true);
      expect(keys.some((key) => key.endsWith(`${TRUNCATION_MARKER}#2`))).toBe(true);
      expect(keys.every((key) => !key.replaceAll(TRUNCATION_MARKER, "").includes("…["))).toBe(true);
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
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      expect(parsed.field0).toEqual(expect.stringContaining("value"));
      expect(Object.keys(parsed)).toHaveLength(30);
      expect(parsed).not.toHaveProperty("omitted");
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
      const childParsed = JSON.parse(String(childRecord.details)) as { child: Record<string, unknown> };
      expect(Object.keys(childParsed.child)).toHaveLength(30);
      expect(childParsed.child.field0).toEqual(expect.stringContaining("value"));
      expect(childParsed.child.field29).toEqual(expect.stringMatching(/…\[truncated\]$/));
    } finally {
      output.mockRestore();
    }
  });

  it("marks object and array entries omitted by the safe nesting key cap", () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      logger.info("test.key_cap", "test", "key cap", {
        details: {
          omitted: "kept",
          ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, index])),
        },
        items: Array.from({ length: 31 }, (_, index) => index),
      });

      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      const details = JSON.parse(String(record.details)) as Record<string, unknown>;
      const items = JSON.parse(String(record.items)) as unknown[];
      expect(details.omitted).toBe("kept");
      expect(details["omitted#2"]).toBe("[entries omitted]");
      expect(details).not.toHaveProperty("field29");
      expect(items).toHaveLength(31);
      expect(items.at(-1)).toBe("[entries omitted]");
    } finally {
      output.mockRestore();
    }
  });

  it("continues bounded nested summaries after oversized values", () => {
    const objectSummary = boundedNestedJson({ blob: "x".repeat(5_000), other: 1 }, LOG_TEXT_LIMIT);
    expect(objectSummary.length).toBeLessThanOrEqual(LOG_TEXT_LIMIT);
    expect(JSON.parse(objectSummary)).toEqual({ blob: expect.stringMatching(/…\[truncated\]$/), other: 1 });

    const childSummary = boundedNestedJson(
      {
        child: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, "word ".repeat(40)])),
        other: 1,
      },
      LOG_TEXT_LIMIT,
    );
    expect(childSummary.length).toBeLessThanOrEqual(LOG_TEXT_LIMIT);
    const childParsed = JSON.parse(childSummary) as { child: Record<string, unknown>; other: number };
    expect(childParsed.other).toBe(1);
    expect(Object.keys(childParsed.child)).toHaveLength(30);
    expect(childParsed.child.field0).toEqual(expect.stringContaining("word"));
    expect(childParsed.child.field29).toEqual(expect.stringMatching(/…\[truncated\]$/));

    const arraySummary = boundedNestedJson(["x".repeat(5_000), 1], LOG_TEXT_LIMIT);
    expect(arraySummary.length).toBeLessThanOrEqual(LOG_TEXT_LIMIT);
    expect(JSON.parse(arraySummary)).toEqual([expect.stringMatching(/…\[truncated\]$/), 1]);

    expect(boundedNestedJson(["abcdefghijklmnopqrstuvwxyz"], 19)).toBe('["abc…[truncated]"]');
  });

  it("keeps sanitization markers atomic while compacting nested strings", () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      logger.info("test.nested_marker", "test", "nested marker", {
        details: { note: `${"x".repeat(1_960)} Bearer abc123 ${"z".repeat(100)}` },
      });

      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      const parsed = JSON.parse(String(record.details)) as { note: string };
      expect(parsed.note).not.toContain("abc123");
      expect(parsed.note.replaceAll("[redacted]", "")).not.toContain("[reda");
      expect(parsed.note.match(/…\[truncated\]/g)).toHaveLength(1);
      expect(isWellFormed(parsed.note)).toBe(true);
      expect(String(record.details).length).toBeLessThanOrEqual(LOG_TEXT_LIMIT);
    } finally {
      output.mockRestore();
    }
  });

  it("never compacts safe-nesting placeholders into partial markers", () => {
    for (const marker of [
      "[property omitted]",
      "[entries omitted]",
      "[depth omitted]",
      "[circular]",
      "[object omitted]",
      "[empty key]",
      "[function omitted]",
      "[symbol omitted]",
    ]) {
      const summary = boundedNestedJson([marker], 19);
      expect(summary.length).toBeLessThanOrEqual(19);
      expect(() => JSON.parse(summary)).not.toThrow();
      expect(summary).not.toContain(TRUNCATION_MARKER);
    }
  });

  it("reruns boundary redaction after a nested string is compacted", () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      logger.info("test.nested_boundary", "test", "nested boundary", {
        details: { note: `${"x".repeat(1_966)} Bearer api:key ${"z".repeat(100)}` },
      });

      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      const parsed = JSON.parse(String(record.details)) as { note: string };
      expect(parsed.note).not.toContain("Bearer api");
      expect(parsed.note.replaceAll("[redacted]", "")).not.toContain("[reda");
      expect(parsed.note.match(/…\[truncated\]/g)).toHaveLength(1);
      expect(isWellFormed(parsed.note)).toBe(true);
    } finally {
      output.mockRestore();
    }
  });

  it("retains a bounded nested error stack and its later metadata", () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const cause = Object.assign(new Error("nested failure"), { reason: "later metadata" });
      cause.stack = `nested-stack:${"x".repeat(5_000)}`;

      logger.info("test.nested_error", "test", "nested error", { cause });

      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      const parsed = JSON.parse(String(record.cause)) as Record<string, unknown>;
      expect(parsed.errorStack).toMatch(/^nested-stack:x+…\[truncated\]$/);
      expect(parsed.errorReason).toBe("later metadata");
      expect(String(record.cause).length).toBeLessThanOrEqual(LOG_TEXT_LIMIT);
    } finally {
      output.mockRestore();
    }
  });

  it("recursively retains nested containers, Errors, and later siblings", () => {
    const output = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const cause = Object.assign(new Error("nested failure"), { reason: "later metadata" });
      cause.stack = `nested-stack:${"x".repeat(5_000)}`;

      logger.info("test.recursive_nested", "test", "recursive nested", {
        details: {
          cause,
          sibling: "retained",
        },
        items: [{ note: "y".repeat(5_000), later: 1 }, "array sibling"],
      });

      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      const parsed = JSON.parse(String(record.details)) as {
        cause: Record<string, unknown>;
        sibling: string;
      };
      const items = JSON.parse(String(record.items)) as Array<Record<string, unknown> | string>;
      expect(parsed.cause.errorStack).toMatch(/^nested-stack:x+…\[truncated\]$/);
      expect(parsed.cause.errorReason).toBe("later metadata");
      expect((items[0] as Record<string, unknown>).note).toMatch(/^y+…\[truncated\]$/);
      expect((items[0] as Record<string, unknown>).later).toBe(1);
      expect(items[1]).toBe("array sibling");
      expect(parsed.sibling).toBe("retained");
      expect(String(record.details).length).toBeLessThanOrEqual(LOG_TEXT_LIMIT);
      expect(String(record.items).length).toBeLessThanOrEqual(LOG_TEXT_LIMIT);
    } finally {
      output.mockRestore();
    }
  });

  it("keeps object-valued normalized error fields as valid bounded JSON", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      logger.error(
        "test.object_error",
        "test",
        "object error",
        {},
        { status: "x".repeat(5_000), reason: "later metadata" },
      );

      const record = output.mock.calls[0]?.[0] as Record<string, unknown>;
      const serialized = String(record.errorValue);
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      expect(serialized.length).toBeLessThanOrEqual(LOG_TEXT_LIMIT);
      expect(parsed.status).toMatch(/^x+…\[truncated\]$/);
      expect(parsed.reason).toBe("later metadata");
    } finally {
      output.mockRestore();
    }
  });

  it("marks only entries that were actually dropped", () => {
    const summary = boundedNestedJson({ blob: "x".repeat(100), other: 1 }, 20);
    expect(summary.length).toBeLessThanOrEqual(20);
    expect(JSON.parse(summary)).toBe("[entries omitted]");

    const collision = boundedNestedJson(
      { omitted: "kept", first: "x".repeat(100), second: "y".repeat(100), third: 1 },
      70,
    );
    expect(JSON.parse(collision)).toMatchObject({ omitted: "kept", third: 1, "omitted#2": "[entries omitted]" });

    const arraySummary = boundedNestedJson(
      Array.from({ length: 10 }, () => ({ long: "x".repeat(100) })),
      50,
    );
    expect(JSON.parse(arraySummary).at(-1)).toBe("[entries omitted]");

    for (const limit of [23, 25]) {
      expect(JSON.parse(boundedNestedJson({ a: { long: "x".repeat(100) } }, limit))).toEqual({
        a: "[value omitted]",
      });
    }
  });

  it("uses truthful valid JSON fallbacks at tiny nested-value limits", () => {
    const oversized = { value: "x".repeat(100) };
    expect(boundedNestedJson(oversized, 0)).toBe("");
    expect(boundedNestedJson(oversized, 1)).toBe("");
    expect(boundedNestedJson(oversized, 2)).toBe('""');
    expect(boundedNestedJson(oversized, 3)).toBe('""');
    expect(boundedNestedJson(oversized, 4)).toBe("null");

    const sparse: unknown[] = [];
    sparse.length = 2;
    for (let limit = 2; limit <= 12; limit += 1) {
      const summary = boundedNestedJson(sparse, limit);
      expect(summary.length).toBeLessThanOrEqual(limit);
      expect(() => JSON.parse(summary)).not.toThrow();
    }
    expect(boundedNestedJson(sparse, 11)).toBe("[null,null]");
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
