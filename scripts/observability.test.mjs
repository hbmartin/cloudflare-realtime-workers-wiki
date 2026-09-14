import { describe, expect, it } from "vitest";
import { analyticsQuery, evaluateThresholds, probeReadiness } from "./observability.mjs";

function healthy() {
  const now = Date.now();
  return {
    now,
    readiness: [{ ok: true }, { ok: true }, { ok: true }],
    worker: [{ sum: { requests: 50, errors: 2 }, dimensions: { status: "success" } }],
    analytics: [
      { event: "http.request", code: "200", outcome: "success", count: 49 },
      { event: "http.request", code: "500", outcome: "server_error", count: 1 },
      { event: "client.error", subtype: "fingerprint", count: 4 },
      { event: "document.compaction", outcome: "failure", count: 1 },
      { event: "document.restore", outcome: "failure", count: 1 },
    ],
    delivery: { backlog_count: 100, oldest_message_timestamp_ms: now - 5 * 60_000 },
    dlq: { backlog_count: 0 },
    database: { file_size: 8_000_000_000 },
    queue: [{ avg: { messages: 100 } }],
    workflow: [
      {
        datetime: new Date(now - 30 * 60_000).toISOString(),
        eventType: "WORKFLOW_QUEUED",
        instanceId: "healthy-workflow",
      },
    ],
  };
}

function evaluate(value) {
  return evaluateThresholds(value, value.now);
}

describe("observability thresholds", () => {
  it("makes Analytics Engine counts sampling-aware", () => {
    expect(analyticsQuery(15)).toContain("SUM(_sample_interval) AS count");
  });

  it("performs exactly three readiness probes with two retry intervals", async () => {
    const calls = [];
    const delays = [];
    const attempts = await probeReadiness("https://notes.example.test", "probe", {
      fetcher: async (url, init) => {
        calls.push({ url: String(url), header: init.headers["x-observability-token"] });
        return new Response(JSON.stringify({ ok: false }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      },
      delay: async (milliseconds) => delays.push(milliseconds),
    });
    expect(attempts).toHaveLength(3);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([45_000, 45_000]);
  });
  it("keeps every healthy boundary non-paging", () => {
    expect(evaluate(healthy())).toEqual([]);
  });

  it.each([
    ["readiness_failed", (value) => (value.readiness = [{ ok: false }, { ok: false }, { ok: false }])],
    ["worker_exceptions_high", (value) => (value.worker[0].sum.errors = 3)],
    ["worker_5xx_rate_high", (value) => (value.analytics[1].count = 2)],
    ["client_error_fingerprint_repeated", (value) => (value.analytics[2].count = 5)],
    ["document_compaction_repeated_failure", (value) => (value.analytics[3].count = 2)],
    ["document_restore_repeated_failure", (value) => (value.analytics[4].count = 2)],
    ["delivery_dlq_nonempty", (value) => (value.dlq.backlog_count = 1)],
    ["d1_size_high", (value) => (value.database.file_size = 8_000_000_001)],
    ["queue_oldest_message_high", (value) => (value.delivery.oldest_message_timestamp_ms -= 1)],
    [
      "queue_backlog_sustained",
      (value) => {
        value.delivery.backlog_count = 101;
        value.queue[0].avg.messages = 101;
      },
    ],
    [
      "workflow_queued_stale",
      (value) => (value.workflow[0].datetime = new Date(value.now - 30 * 60_000 - 1).toISOString()),
    ],
    ["workflow_infrastructure_failure", (value) => (value.workflow[0].eventType = "WORKFLOW_FAILURE")],
  ])("pages at the %s threshold", (code, mutate) => {
    const value = healthy();
    mutate(value);
    expect(evaluate(value)).toContain(code);
  });

  it("does not page when a queued Workflow later starts", () => {
    const value = healthy();
    value.workflow[0].datetime = new Date(value.now - 31 * 60_000).toISOString();
    value.workflow.push({
      datetime: new Date(value.now - 29 * 60_000).toISOString(),
      eventType: "WORKFLOW_START",
      instanceId: "healthy-workflow",
    });
    expect(evaluate(value)).not.toContain("workflow_queued_stale");
  });
});
