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

function cloudflareFetcher(overrides = {}) {
  return async (url, init = {}) => {
    const target = String(url);
    if (target.includes("/api/health/ready")) return Response.json({ ok: true });
    if (target.includes("/analytics_engine/sql")) return Response.json({ data: [] });
    if (target.includes("/queues?"))
      return (
        overrides.queues?.(target, init) ??
        Response.json({ success: true, result: [], result_info: { page: 1, total_pages: 1 } })
      );
    if (target.includes("/queues/") && target.endsWith("/metrics"))
      return overrides.metrics?.(target, init) ?? Response.json({ result: { backlog_count: 0 } });
    if (target.includes("/d1/database?")) return Response.json({ result: [] });
    if (target.includes("/workflows/cloudflare-realtime-notes-jobs/instances"))
      return overrides.workflows?.(target, init) ?? Response.json({ success: true, result: [] });
    if (target.endsWith("/graphql"))
      return (
        overrides.graphql?.(target, init) ??
        Response.json({ data: { viewer: { accounts: [{ worker: [], workflow: [], queue: [] }] } } })
      );
    throw new Error(`Unexpected observability request: ${target} ${String(init.method ?? "GET")}`);
  };
}

const malformedWorkflowFetcher = cloudflareFetcher({
  workflows: () => Response.json({ success: true }),
});
const malformedQueuePaginationFetcher = cloudflareFetcher({
  queues: () => Response.json({ success: true, result: [], result_info: { page: 2, total_pages: 2 } }),
});

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
    const fetcher = cloudflareFetcher({
      workflows: (target) => {
        workflowInstancesUrl = new URL(target);
        return Response.json({ success: true, result: [] });
      },
      graphql: (_target, init) => {
        const body = JSON.parse(String(init.body));
        workflowQuery = body.query;
        workflowStart = Date.parse(body.variables.workflowStart);
        return Response.json({ data: { viewer: { accounts: [{ worker: [], workflow: [], queue: [] }] } } });
      },
    });

    await collectSnapshot(
      { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" },
      { fetcher, delay: async () => undefined, graphqlMinutes: 5 },
    );

    expect(workflowStart).toBeLessThanOrEqual(before - 2 * 60 * 60_000 + 1_000);
    expect(workflowStart).toBeGreaterThanOrEqual(before - 2 * 60 * 60_000 - 1_000);
    expect(workflowQuery).toContain("orderBy: [datetime_DESC]");
    expect(workflowInstancesUrl.searchParams.get("status")).toBe("queued");
    expect(workflowInstancesUrl.searchParams.get("per_page")).toBe("100");
    expect(Date.parse(workflowInstancesUrl.searchParams.get("date_end"))).toBeGreaterThanOrEqual(
      before - 30 * 60_000 - 1_000,
    );
    expect(Date.parse(workflowInstancesUrl.searchParams.get("date_end"))).toBeLessThanOrEqual(before - 30 * 60_000);
  });

  it("isolates a malformed authoritative Workflow response", async () => {
    const snapshot = await collectSnapshot(
      { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" },
      { fetcher: malformedWorkflowFetcher, delay: async () => undefined },
    );
    expect(snapshot.readiness[0].ok).toBe(true);
    expect(evaluateThresholds(snapshot)).toContain("workflow_metadata_unavailable");
  });

  it("keeps an old queued Workflow paging until authoritative current state resolves it", async () => {
    const timestamp = Date.now();
    const stale = {
      id: "old-workflow",
      status: "queued",
      created_on: new Date(timestamp - 3 * 60 * 60_000).toISOString(),
    };
    let currentQueued = [stale];
    const fetcher = cloudflareFetcher({
      workflows: () => Response.json({ success: true, result: currentQueued }),
    });
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
    const fetcher = cloudflareFetcher({
      queues: (target) => {
        const page = Number(new URL(target).searchParams.get("page"));
        queuePages.push(page);
        const result =
          page === 2
            ? [{ queue_name: "cloudflare-realtime-notes-delivery", queue_id: "delivery-id" }]
            : page === 3
              ? [{ queue_name: "cloudflare-realtime-notes-delivery-dlq", queue_id: "dlq-id" }]
              : [];
        return Response.json({ success: true, result, result_info: { page, total_pages: 3 } });
      },
    });
    const snapshot = await collectSnapshot(
      { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" },
      { fetcher, delay: async () => undefined },
    );
    expect(queuePages).toEqual([1, 2, 3]);
    expect(snapshot.deliveryQueueId).toBe("delivery-id");
    expect(evaluateThresholds(snapshot)).not.toContain("delivery_dlq_metadata_missing");
  });

  it("isolates malformed Queue API pagination", async () => {
    const snapshot = await collectSnapshot(
      { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" },
      { fetcher: malformedQueuePaginationFetcher, delay: async () => undefined },
    );
    expect(snapshot.readiness[0].ok).toBe(true);
    expect(evaluateThresholds(snapshot)).toContain("queue_listing_unavailable");
  });

  it("accepts a single-page Queue response without pagination metadata", async () => {
    const fetcher = cloudflareFetcher({
      queues: () =>
        Response.json({
          success: true,
          result: [
            { name: "cloudflare-realtime-notes-delivery", id: "delivery-id" },
            { queue_name: "cloudflare-realtime-notes-delivery-dlq", queue_id: "dlq-id" },
          ],
        }),
    });
    const snapshot = await collectSnapshot(
      { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" },
      { fetcher, delay: async () => undefined },
    );
    expect(snapshot.deliveryQueueId).toBe("delivery-id");
    expect(snapshot.sourceFailures).toEqual([]);
  });

  it("accepts zero pages for an empty Queue list but alerts on absent named queues", async () => {
    const snapshot = await collectSnapshot(
      { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" },
      {
        fetcher: cloudflareFetcher({
          queues: () => Response.json({ success: true, result: [], result_info: { total_pages: 0 } }),
        }),
        delay: async () => undefined,
      },
    );
    expect(snapshot.sourceFailures).toEqual([]);
    expect(evaluateThresholds(snapshot)).toContain("delivery_queue_metadata_missing");
  });

  it("alerts when a full Queue page has no way to continue discovery", async () => {
    const snapshot = await collectSnapshot(
      { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" },
      {
        fetcher: cloudflareFetcher({
          queues: () =>
            Response.json({
              success: true,
              result: Array.from({ length: 100 }, (_, index) => ({ queue_name: `unrelated-${index}` })),
            }),
        }),
        delay: async () => undefined,
      },
    );
    expect(evaluateThresholds(snapshot)).toContain("queue_listing_unavailable");
  });

  it("keeps other probes while a legacy monitoring token receives Workflow 403", async () => {
    const snapshot = await collectSnapshot(
      { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" },
      {
        fetcher: cloudflareFetcher({ workflows: () => new Response("Forbidden", { status: 403 }) }),
        delay: async () => undefined,
      },
    );
    expect(snapshot.readiness[0].ok).toBe(true);
    expect(snapshot.analytics).toEqual([]);
    expect(snapshot.staleQueuedWorkflows).toBeNull();
    expect(evaluateThresholds(snapshot)).toContain("workflow_metadata_unavailable");
  });

  it("reports forty stale Workflow instances instead of capping the count at one", async () => {
    const snapshot = await collectSnapshot(
      { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" },
      {
        fetcher: cloudflareFetcher({
          workflows: () =>
            Response.json({
              success: true,
              result: Array.from({ length: 40 }, (_, index) => ({ id: `stale-${index}` })),
            }),
        }),
        delay: async () => undefined,
      },
    );
    expect(snapshot.staleQueuedWorkflows).toHaveLength(40);
    expect(snapshot.staleWorkflowCountComplete).toBe(true);
    expect(evaluateThresholds(snapshot)).toContain("workflow_queued_stale");
  });

  it("follows Workflow cursors and marks an unpageable full result incomplete", async () => {
    const config = { accountId: "account", token: "token", baseUrl: "https://notes.example.test", probeToken: "probe" };
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `stale-${index}` }));
    const fetcher = cloudflareFetcher({
      workflows: (target) =>
        new URL(target).searchParams.get("cursor") === "next"
          ? Response.json({
              success: true,
              result: Array.from({ length: 40 }, (_, index) => ({ id: `later-${index}` })),
            })
          : Response.json({ success: true, result: firstPage, result_info: { cursor: "next" } }),
    });
    const paged = await collectSnapshot(config, { fetcher, delay: async () => undefined });
    expect(paged.staleQueuedWorkflows).toHaveLength(140);
    expect(paged.staleWorkflowCountComplete).toBe(true);

    const incomplete = await collectSnapshot(config, {
      fetcher: cloudflareFetcher({ workflows: () => Response.json({ success: true, result: firstPage }) }),
      delay: async () => undefined,
    });
    expect(incomplete.staleWorkflowCountComplete).toBe(false);
    expect(evaluateThresholds(incomplete)).toContain("workflow_count_incomplete");
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
