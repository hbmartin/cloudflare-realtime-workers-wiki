import { describe, expect, it } from "vitest";
import { analyticsQuery, collectSnapshot, evaluateThresholds, probeReadiness } from "./observability.mjs";

function healthy() {
  const now = Date.now();
  return {
    now,
    readiness: [{ ok: true }, { ok: true }, { ok: true }],
    worker: [{ sum: { requests: 50, errors: 2 }, dimensions: { status: "success" } }],
    analytics: [
      { event: "http.request", code: "200", outcome: "success", count: 49 },
      { event: "http.request", code: "500", outcome: "server_error", count: 1 },
      { event: "client.error", operation: "client.global_error", subtype: "fingerprint", count: 4 },
      { event: "document.compaction", outcome: "failure", count: 1 },
      { event: "document.restore", outcome: "failure", count: 1 },
    ],
    delivery: { backlog_count: 100, oldest_message_timestamp_ms: now - 5 * 60_000 },
    dlq: { backlog_count: 0 },
    database: { file_size: 8_000_000_000 },
    queue: [{ avg: { messages: 100 } }],
    staleQueuedWorkflows: [],
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
  return evaluateThresholds(value);
}

async function malformedWorkflowFetcher(url, init = {}) {
  const target = String(url);
  if (target.includes("/api/health/ready")) return Response.json({ ok: true });
  if (target.includes("/analytics_engine/sql")) return Response.json({ data: [] });
  if (target.includes("/queues?"))
    return Response.json({ success: true, result: [], result_info: { page: 1, total_pages: 1 } });
  if (target.includes("/d1/database?")) return Response.json({ result: [] });
  if (target.includes("/workflows/cloudflare-realtime-notes-jobs/instances")) {
    return Response.json({ success: true });
  }
  if (target.endsWith("/graphql")) {
    return Response.json({
      data: { viewer: { accounts: [{ worker: [], workflow: [], queue: [] }] } },
    });
  }
  throw new Error(`Unexpected observability request: ${target} ${String(init.method ?? "GET")}`);
}

async function malformedQueuePaginationFetcher(url) {
  const target = String(url);
  if (target.includes("/api/health/ready")) return Response.json({ ok: true });
  if (target.includes("/analytics_engine/sql")) return Response.json({ data: [] });
  if (target.includes("/d1/database?")) return Response.json({ result: [] });
  if (target.includes("/workflows/cloudflare-realtime-notes-jobs/instances")) {
    return Response.json({ success: true, result: [] });
  }
  if (target.includes("/queues?"))
    return Response.json({ success: true, result: [], result_info: { page: 2, total_pages: 2 } });
  throw new Error(`Unexpected observability request: ${target}`);
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

  it("stops probing after the first successful readiness response", async () => {
    const delay = [];
    const attempts = await probeReadiness("https://notes.example.test", "probe", {
      fetcher: async () => Response.json({ ok: true }),
      delay: async (milliseconds) => delay.push(milliseconds),
    });
    expect(attempts).toHaveLength(1);
    expect(delay).toEqual([]);
    const value = healthy();
    value.readiness = attempts;
    expect(evaluate(value)).not.toContain("readiness_failed");
  });

  it("fails closed when no readiness attempts are available", () => {
    expect(evaluate({ ...healthy(), readiness: [] })).toContain("readiness_failed");
  });

  it("retries one failed readiness response, then stops at success", async () => {
    let calls = 0;
    const delays = [];
    const attempts = await probeReadiness("https://notes.example.test", "probe", {
      fetcher: async () =>
        ++calls === 1 ? Response.json({ ok: false }, { status: 503 }) : Response.json({ ok: true }),
      delay: async (milliseconds) => delays.push(milliseconds),
    });
    expect(attempts).toHaveLength(2);
    expect(delays).toEqual([45_000]);
    expect(evaluate({ ...healthy(), readiness: attempts })).not.toContain("readiness_failed");
  });

  it("queries two hours of Workflow events and authoritative stale queued state", async () => {
    let workflowStart = 0;
    let workflowQuery = "";
    let workflowInstancesUrl;
    const before = Date.now();
    const fetcher = async (url, init = {}) => {
      const target = String(url);
      if (target.includes("/api/health/ready")) return Response.json({ ok: true });
      if (target.includes("/analytics_engine/sql")) return Response.json({ data: [] });
      if (target.includes("/queues?"))
        return Response.json({ success: true, result: [], result_info: { page: 1, total_pages: 1 } });
      if (target.includes("/d1/database?")) return Response.json({ result: [] });
      if (target.includes("/workflows/cloudflare-realtime-notes-jobs/instances")) {
        workflowInstancesUrl = new URL(target);
        return Response.json({ success: true, result: [] });
      }
      if (target.endsWith("/graphql")) {
        const body = JSON.parse(String(init.body));
        workflowQuery = body.query;
        workflowStart = Date.parse(body.variables.workflowStart);
        return Response.json({
          data: { viewer: { accounts: [{ worker: [], workflow: [], queue: [] }] } },
        });
      }
      throw new Error(`Unexpected observability request: ${target}`);
    };

    await collectSnapshot(
      { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" },
      { fetcher, delay: async () => undefined, graphqlMinutes: 5 },
    );

    expect(workflowStart).toBeLessThanOrEqual(before - 2 * 60 * 60_000 + 1_000);
    expect(workflowStart).toBeGreaterThanOrEqual(before - 2 * 60 * 60_000 - 1_000);
    expect(workflowQuery).toContain("orderBy: [datetime_DESC]");
    expect(workflowInstancesUrl.searchParams.get("status")).toBe("queued");
    expect(workflowInstancesUrl.searchParams.get("per_page")).toBe("1");
    expect(Date.parse(workflowInstancesUrl.searchParams.get("date_end"))).toBeGreaterThanOrEqual(
      before - 30 * 60_000 - 1_000,
    );
    expect(Date.parse(workflowInstancesUrl.searchParams.get("date_end"))).toBeLessThanOrEqual(before - 30 * 60_000);
  });

  it("rejects a malformed authoritative Workflow response", async () => {
    await expect(
      collectSnapshot(
        { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" },
        { fetcher: malformedWorkflowFetcher, delay: async () => undefined },
      ),
    ).rejects.toThrow("Cloudflare Workflow instance query returned an invalid response");
  });

  it("keeps an old queued Workflow paging until authoritative current state resolves it", async () => {
    const timestamp = Date.now();
    const stale = {
      id: "old-workflow",
      status: "queued",
      created_on: new Date(timestamp - 3 * 60 * 60_000).toISOString(),
    };
    let currentQueued = [stale];
    const fetcher = async (url) => {
      const target = String(url);
      if (target.includes("/api/health/ready")) return Response.json({ ok: true });
      if (target.includes("/analytics_engine/sql")) return Response.json({ data: [] });
      if (target.includes("/queues?"))
        return Response.json({ success: true, result: [], result_info: { page: 1, total_pages: 1 } });
      if (target.includes("/d1/database?")) return Response.json({ result: [] });
      if (target.includes("/workflows/cloudflare-realtime-notes-jobs/instances")) {
        return Response.json({ success: true, result: currentQueued });
      }
      if (target.endsWith("/graphql")) {
        return Response.json({ data: { viewer: { accounts: [{ worker: [], workflow: [], queue: [] }] } } });
      }
      throw new Error(`Unexpected observability request: ${target}`);
    };
    const config = { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" };
    const options = { fetcher, delay: async () => undefined, timestamp };

    const queued = await collectSnapshot(config, options);
    expect(queued.workflow).toEqual([]);
    expect(evaluateThresholds(queued)).toContain("workflow_queued_stale");

    currentQueued = [];
    const resolved = await collectSnapshot(config, options);
    expect(evaluateThresholds(resolved)).not.toContain("workflow_queued_stale");
  });
  it("keeps every healthy boundary non-paging", () => {
    expect(evaluate(healthy())).toEqual([]);
  });

  it("sums identical fingerprints across online state and error-name rows", () => {
    const value = healthy();
    value.analytics = [
      {
        event: "client.error",
        operation: "client.global_error",
        subtype: "same",
        outcome: "online",
        code: "TypeError",
        count: 3,
      },
      {
        event: "client.error",
        operation: "client.global_error",
        subtype: "same",
        outcome: "offline",
        code: "Error",
        count: 2,
      },
    ];
    expect(evaluate(value)).toContain("client_error_fingerprint_repeated");
    value.analytics[1].subtype = "different";
    expect(evaluate(value)).not.toContain("client_error_fingerprint_repeated");
  });

  it("finds both named queues beyond the first Queue API page", async () => {
    const queuePages = [];
    const fetcher = async (url) => {
      const target = String(url);
      if (target.includes("/api/health/ready")) return Response.json({ ok: true });
      if (target.includes("/analytics_engine/sql")) return Response.json({ data: [] });
      if (target.includes("/d1/database?")) return Response.json({ result: [] });
      if (target.includes("/workflows/cloudflare-realtime-notes-jobs/instances")) {
        return Response.json({ success: true, result: [] });
      }
      if (target.includes("/queues?")) {
        const page = Number(new URL(target).searchParams.get("page"));
        queuePages.push(page);
        const result =
          page === 2
            ? [{ queue_name: "cloudflare-realtime-notes-delivery", queue_id: "delivery-id" }]
            : page === 3
              ? [{ queue_name: "cloudflare-realtime-notes-delivery-dlq", queue_id: "dlq-id" }]
              : [];
        return Response.json({ success: true, result, result_info: { page, total_pages: 3 } });
      }
      if (target.includes("/queues/delivery-id/metrics")) return Response.json({ result: { backlog_count: 0 } });
      if (target.includes("/queues/dlq-id/metrics")) return Response.json({ result: { backlog_count: 0 } });
      if (target.endsWith("/graphql")) {
        return Response.json({ data: { viewer: { accounts: [{ worker: [], workflow: [], queue: [] }] } } });
      }
      throw new Error(`Unexpected observability request: ${target}`);
    };
    const snapshot = await collectSnapshot(
      { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" },
      { fetcher, delay: async () => undefined },
    );
    expect(queuePages).toEqual([1, 2, 3]);
    expect(snapshot.deliveryQueueId).toBe("delivery-id");
    expect(evaluateThresholds(snapshot)).not.toContain("delivery_dlq_metadata_missing");
  });

  it("rejects malformed Queue API pagination", async () => {
    await expect(
      collectSnapshot(
        { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" },
        { fetcher: malformedQueuePaginationFetcher, delay: async () => undefined },
      ),
    ).rejects.toThrow("invalid pagination metadata");
  });

  it.each([
    ["readiness_failed", (value) => (value.readiness = [{ ok: false }, { ok: false }, { ok: false }])],
    ["worker_exceptions_high", (value) => (value.worker[0].sum.errors = 3)],
    ["worker_5xx_rate_high", (value) => (value.analytics[1].count = 2)],
    ["client_error_fingerprint_repeated", (value) => (value.analytics[2].count = 5)],
    ["document_compaction_repeated_failure", (value) => (value.analytics[3].count = 2)],
    ["document_restore_repeated_failure", (value) => (value.analytics[4].count = 2)],
    ["delivery_queue_metadata_missing", (value) => (value.delivery = null)],
    ["delivery_dlq_metadata_missing", (value) => (value.dlq = null)],
    ["d1_metadata_missing", (value) => (value.database = null)],
    ["delivery_dlq_nonempty", (value) => (value.dlq.backlog_count = 1)],
    ["d1_size_high", (value) => (value.database.file_size = 8_000_000_001)],
    [
      "queue_backlog_sustained",
      (value) => {
        value.delivery.backlog_count = 101;
        value.queue[0].avg.messages = 101;
      },
    ],
    [
      "workflow_queued_stale",
      (value) =>
        (value.staleQueuedWorkflows = [
          { id: "stale-workflow", status: "queued", created_on: new Date(value.now - 90 * 60_000).toISOString() },
        ]),
    ],
    ["workflow_infrastructure_failure", (value) => (value.workflow[0].eventType = "WORKFLOW_INTERNAL_ERROR")],
  ])("pages at the %s threshold", (code, mutate) => {
    const value = healthy();
    mutate(value);
    expect(evaluate(value)).toContain(code);
  });

  it.each([
    ["delivery queue", "delivery_queue_metadata_missing", (value) => delete value.delivery.backlog_count],
    ["delivery DLQ", "delivery_dlq_metadata_missing", (value) => delete value.dlq.backlog_count],
    ["D1", "d1_metadata_missing", (value) => delete value.database.file_size],
    [
      "invalid delivery count",
      "delivery_queue_metadata_missing",
      (value) => (value.delivery.backlog_count = "invalid"),
    ],
    ["invalid DLQ count", "delivery_dlq_metadata_missing", (value) => (value.dlq.backlog_count = -1)],
    ["invalid D1 size", "d1_metadata_missing", (value) => (value.database.file_size = "NaN")],
  ])("pages when %s metadata omits its monitored value", (_resource, code, mutate) => {
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

  it("does not page for expected job failures or stale queue-age metadata", () => {
    const value = healthy();
    value.delivery.oldest_message_timestamp_ms = value.now - 24 * 60 * 60_000;
    value.workflow[0].eventType = "WORKFLOW_FAILURE";
    expect(evaluate(value)).not.toContain("queue_oldest_message_high");
    expect(evaluate(value)).not.toContain("workflow_infrastructure_failure");
  });

  it("evaluates infrastructure failures from the latest event for each Workflow", () => {
    const recovered = healthy();
    recovered.workflow = [
      {
        datetime: new Date(recovered.now - 10 * 60_000).toISOString(),
        eventType: "WORKFLOW_INTERNAL_ERROR",
        instanceId: "recovered-workflow",
      },
      {
        datetime: new Date(recovered.now - 9 * 60_000).toISOString(),
        eventType: "WORKFLOW_SUCCESS",
        instanceId: "recovered-workflow",
      },
    ];
    expect(evaluate(recovered)).not.toContain("workflow_infrastructure_failure");

    recovered.workflow[1].eventType = "WORKFLOW_INTERNAL_ERROR";
    expect(evaluate(recovered)).toContain("workflow_infrastructure_failure");
  });

  it("detects a Workflow that has remained queued for ninety minutes", () => {
    const value = healthy();
    value.workflow = [];
    value.staleQueuedWorkflows = [
      { id: "stale-workflow", status: "queued", created_on: new Date(value.now - 90 * 60_000).toISOString() },
    ];
    expect(evaluate(value)).toContain("workflow_queued_stale");
  });
});
