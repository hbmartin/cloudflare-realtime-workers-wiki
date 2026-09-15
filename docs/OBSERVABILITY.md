# Observability

This installation uses Cloudflare-native telemetry only: Workers Logs, Workers Traces, Analytics Engine,
Cloudflare product metrics, and a GitHub Actions failure notification. It does not use Sentry, Logpush, an
external OTLP backend, or an in-app dashboard.

## Collection and retention

Production collects 100% of structured application and invocation logs and samples traces at 5%. Local and
E2E runs collect all traces so Local Explorer can show a complete request. Analytics Engine points are
non-blocking and retained by Cloudflare for three months. The production dataset is
`cloudflare_realtime_notes_production`; that pre-NoteFlare identifier is retained so existing telemetry
history and dashboards continue to work.

Every response, including a WebSocket handshake, carries `X-Request-Id`. When version metadata is available it
also carries `X-Worker-Version`; `GET /api/health` exposes the same deployment ID. The Notion-compatible API
continues to return its `request_id` field and now uses the outer Worker request ID.

Custom spans use these fixed names:

| Span                                                                              | Scope                             |
| --------------------------------------------------------------------------------- | --------------------------------- |
| `notes.route_request`                                                             | HTTP route or WebSocket handshake |
| `notes.document.compact`                                                          | document or diagram compaction    |
| `notes.document.restore`                                                          | version restore transaction       |
| `notes.scheduled.<task>`                                                          | one cron subtask                  |
| `notes.workflow.job`                                                              | one Workflow invocation           |
| `notes.job.import`, `notes.job.export`                                            | import/export job body            |
| `notes.outbox.delivery`                                                           | durable outbox delivery           |
| `notes.integration.webhook`, `notes.integration.slack`, `notes.integration.email` | outbound integration call         |

Cloudflare adds automatic child spans for handlers, bindings, and outbound requests.
`notes.route_request` sets `http.route` to the responding Hono template, a fixed Party template, or
`/unmatched` after routing; it never attaches raw URL identifiers.

## Structured log contract

Each application log call emits one JSON object. Required fields are `schema`, `event`, `severity`,
`component`, and `message`. Invocation context adds `requestId`, `correlationId`, `rayId`, `trigger`,
`versionId`, and `versionTag` when available. Errors are normalized and bounded.

Stable event families include:

| Family        | Examples                                                                                           | Owner               |
| ------------- | -------------------------------------------------------------------------------------------------- | ------------------- |
| HTTP/realtime | `http.request.failed`, `http.request.unhandled_error`, `realtime.handshake.failed`                 | application on-call |
| scheduler     | `scheduled.task.failed`, `scheduled.task_state.failed`, `scheduled.run.completed`                  | application on-call |
| jobs/outbox   | `workflow.job.failed`, `workflow.*.start_failed`, `outbox.enqueue.failed`, `queue.delivery.failed` | application on-call |
| documents     | `document.compaction.failed`, `document.restore.failed`, `document.restore_reconcile.failed`       | storage on-call     |
| consistency   | `table.revision.invariant_failed`, `page_move.receipt.invalid`, `page_move.batch_result.invalid`   | incident commander  |
| integrations  | `webhook.verification.failed`, `slack.channel_digest.failed`, `notification.digest_email.failed`   | integrations owner  |
| browser       | `client.error.reported` with a fixed `eventCode` and hashed `fingerprint`                          | frontend owner      |
| readiness     | `health.readiness.failed`                                                                          | application on-call |

Expected HTTP errors and ordinary request volume are metrics, not application logs. Successful compactions,
outbox deliveries, and integration calls are spans/metrics. Logs retain warnings, failures, recovery actions,
and lifecycle summaries.

### Privacy policy

Never add cookies, authorization headers, credentials, email addresses, request bodies, document content or
titles, Slack/webhook payloads, or URL query strings to telemetry. The logger redacts sensitive keys, known
credential formats, email-shaped values, Basic values in authorization contexts or with token-shaped text, Bearer
values, and query strings, including nested diagnostic values. Redaction runs before log-length limits. A bare
all-lowercase malformed Basic value in generic free text is indistinguishable from ordinary prose and may remain;
never put authorization headers in diagnostic text.
Opaque workspace, page, job, and outbox IDs are allowed only in short-lived logs and spans. Do not write them to
Analytics Engine. HTTP metric operations use Hono's registered route template, fixed Party templates, or
`/unmatched`; they never derive a route value from request path segments.

Browser reports are accepted only with a valid Better Auth session and contain only an event code, error name,
SHA-256 fingerprint, same-origin source path/line/column, request ID, release, online state, and visibility. Raw
messages and stacks never leave the browser; pre-login failures are deliberately not ingested.
The browser budgets five attempted telemetry POSTs per minute, including rejected and network-failed attempts,
and counts an in-flight attempt once. Fingerprint deduplication begins only after a report is accepted.
The Worker separately limits 300 requests per source IP or originating Worker zone per minute before origin/session
checks and 20 authenticated requests per user per minute. Both keys are hashed before passing them to Worker Rate
Limit bindings.

## Analytics Engine schema

`index1` is always `event`. Positions are fixed:

| Position            | Value                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------- |
| `blob1`…`blob7`     | schema, component, operation/route, outcome, code, subtype, Worker version ID           |
| `double1`…`double7` | duration ms, bytes, attempts, lag ms, backlog, connection count, byte-count-known (`1`) |

Treat `double2` as a response byte count only when `double7 = 1`; older points and responses without a valid
`Content-Length` have `double7 = 0`.
Queue delivery metric outcomes are `acknowledged`, `retried`, or `discarded`; a thrown attempt records `failure`
before retrying. A retry is not counted as a successful delivery.

Analytics Engine may sample rows. Every count and weighted aggregate must use `_sample_interval`:

```sql
SELECT index1 AS event, blob2 AS component, blob4 AS outcome,
       SUM(_sample_interval) AS events,
       quantileExactWeighted(0.95)(double1, _sample_interval) AS p95_duration_ms
FROM cloudflare_realtime_notes_production
WHERE timestamp > NOW() - INTERVAL '15' MINUTE
GROUP BY event, component, outcome
ORDER BY events DESC;
```

To investigate repeated browser failures:

```sql
SELECT blob3 AS event_code, blob6 AS fingerprint, SUM(_sample_interval) AS reports
FROM cloudflare_realtime_notes_production
WHERE index1 = 'client.error' AND timestamp > NOW() - INTERVAL '15' MINUTE
GROUP BY event_code, fingerprint
HAVING reports >= 5;
```

Suggested Cloudflare dashboard views are Worker requests/errors and CPU, trace latency by span name, Queue
backlog/DLQ, Workflow status/queued events, D1 storage/latency, R2 operations/storage, and Durable Object billed
duration. The five-minute GitHub monitor is the paging view; dashboards are for diagnosis and capacity.

## Health and paging

`GET /api/health` remains public and checks D1 compatibility. Protected readiness uses a secret header:

```sh
curl -fsS -H "X-Observability-Token: $OBSERVABILITY_PROBE_TOKEN" \
  "$PRODUCTION_BASE_URL/api/health/ready"
```

Readiness runs D1, R2 sentinel `head`, read-only Durable Object, cron-freshness, and durable queue checks in
parallel with a two-second timeout per check. It returns `200`/`ready` or `503`/`degraded` with stable sanitized
codes. A missing or invalid probe token returns `401`.

The monitor makes one to three readiness probes, stopping at the first success. It waits 45 seconds only between
failed attempts and evaluates:

- every attempted readiness probe fails, or an active scheduled task's success is more than 35 minutes old.
  Removed tasks' historical rows are ignored. The first readiness probe registers a missing active task in D1 and
  gives it one durable 35-minute first-success grace period; later deploys cannot renew it. Existing never-successful
  rows at migration time get no renewed grace;
- three Worker exceptions in five minutes, or 5xx above 2% with at least 50 requests;
- missing delivery Queue, DLQ, or D1 metadata; any DLQ backlog; or Queue backlog above 100 throughout 15 minutes;
  oldest message age remains diagnostic because delayed webhook retries intentionally remain queued;
- latest-state Workflow internal/rollback failures from the two-hour event window, a Workflow whose authoritative
  current state remains `queued` above 30 minutes, or a locally durable job unchanged in `queued` for 30 minutes;
- deletion/upload attempts above five, archive attempts above nine, durable work overdue by two hours after its
  `next_attempt_at`, outbox due above 15 minutes, or D1 size above 8 GB; active multipart uploads retain their full
  24-hour session deadline before the overdue grace starts;
- any invariant-corruption metric, two compaction failures, two restore 5xx failures, or five identical
  authenticated browser fingerprints in 15 minutes.

Missing external metadata reports `delivery_queue_metadata_missing`, `delivery_dlq_metadata_missing`, or
`d1_metadata_missing` instead of interpreting an unavailable resource as zero. Queue listing, individual Queue
metrics, D1, Analytics, GraphQL, and Workflow instance failures produce source-specific diagnostics; report mode
continues with unavailable values and check mode exits nonzero after printing the partial summary.
Queue discovery accepts a single-page response without pagination metadata and follows `total_pages` when present;
a full page with no way to continue reports `queue_listing_unavailable`. A failed Workflow instances request reports
`workflow_metadata_unavailable` without aborting the other probes. Stale Workflow counts follow up to five cursor
pages; a further cursor or a full page without one is reported as a lower bound with `workflow_count_incomplete`,
never as an exact count. Existing monitor tokens need Workers Scripts Read (or Workers Tail Read) for Workflow instances;
verify or rotate older tokens before relying on this probe.

Cron state uses a separate, strictly increasing execution token for latest-run outcome fields while `last_started_at`
holds the actual start time (`0` means registered but never started). Any completed success or failure advances its
heartbeat even when a newer execution has already started; an older result cannot overwrite the newer execution's
error or duration.

Run the same collector by hand:

```sh
pnpm observability:report   # 15-minute and 24-hour summaries
pnpm observability:check    # paging thresholds, non-zero on failure
```

The commands require `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_OBSERVABILITY_TOKEN`, `PRODUCTION_BASE_URL`, and
`OBSERVABILITY_PROBE_TOKEN`. The read-only Cloudflare token needs Workers Observability Read, Workers Scripts Read,
Analytics Engine Read, Queues Read, and D1 Read for the configured account. Operators own
`.github/workflows/observability.yml` and must enable GitHub Actions failure emails under GitHub notification
settings.

## Request-ID triage

Start with the `X-Request-Id` shown by the browser/API caller. Search Workers Logs for `requestId`, then pivot to
`correlationId` to follow the job, outbox, Queue, Workflow, and internal Durable Object work. Old persisted rows
fall back to their job or outbox ID. Compare `versionId` with the response's `X-Worker-Version` and the active
Cloudflare deployment. Use `rayId` only as a secondary Cloudflare edge lookup.

For local investigation run `pnpm dev`, open the Vite plugin's Local Explorer link, and filter logs/traces by the
response request ID. Local trace sampling is 100%, so the request, binding calls, outbound calls, and custom spans
should form one story.

## Post-deploy verification

After migrations and deploy:

1. Confirm `/api/health` deployment ID equals `X-Worker-Version` and the active Cloudflare version.
2. Call protected readiness and run `pnpm observability:check`.
3. In Local Explorer, confirm a local request has correlated logs and D1/R2/Durable Object spans.
4. In production, confirm Analytics Engine receives `http.request`, scheduled, document, outbox, integration,
   and client event families as applicable.
5. Wait for the next cron and verify every `observability_task_runs.last_succeeded_at` advances.
6. Manually dispatch the Production observability workflow and confirm its job summary is healthy.
