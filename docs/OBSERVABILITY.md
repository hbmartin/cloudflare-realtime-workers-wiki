# Observability

## What exists

`wrangler.jsonc` enables Workers Logs and source map upload:

```jsonc
"observability": { "enabled": true },
"upload_source_maps": true,
```

That is the entirety of the instrumentation. There is deliberately **no** Sentry, Analytics Engine
binding, tail consumer, Logpush configuration, OpenTelemetry export, or metrics emitter. Application
logging is 20 `console.error` calls in the Worker, with no request-id correlation. All but one pass a
bare error object; `Table revision could not be advanced` carries structured fields, because it is the
one invariant violation that no other signal would surface.

Plan monitoring around that constraint: Cloudflare's own dashboards carry the numeric signal, and the
two D1 work queues carry the durable error state. Logs are for narrative detail after something else
has told you where to look.

## Health checking

```sh
curl -s https://notes.example.com/api/health
```

```json
{ "ok": true, "version": "0.1.0", "time": "2026-08-18T00:00:00.000Z" }
```

Two limitations that determine how you use it:

- It runs `SELECT 1` against D1 and nothing else. **It reports healthy during a complete R2 or Durable
  Object outage.** An uptime monitor on this endpoint proves the Worker is running and D1 is reachable;
  it proves nothing about document editing, attachments, or version history.
- `version` is a hardcoded string, not a build identifier. It cannot tell you which revision is live.
  Use `pnpm wrangler deployments list --env production`.

`GET /api/install` returns `{"initialized": boolean}` and is a useful probe for the bootstrap state of
a fresh installation. Both endpoints are unauthenticated.

## What to watch

| Signal                                 | Where                   | Why                                                   |
| -------------------------------------- | ----------------------- | ----------------------------------------------------- |
| Worker error rate                      | Workers metrics         | The primary outage indicator                          |
| Worker CPU time                        | Workers metrics         | Compaction of large documents is the expensive path   |
| Cron invocation success                | Workers → Cron Triggers | Every queue and reaper stalls silently if this fails  |
| R2 Class A operations                  | R2 metrics              | Every uploaded part is one, so multipart moves this   |
| Incomplete multipart uploads           | `attachment_uploads`    | Parts R2 still holds for uploads nobody finished      |
| D1 database size                       | D1 metrics              | Hard 10 GB cap; there is no sharding                  |
| D1 query latency                       | D1 metrics              | Single-threaded; search and projection writes contend |
| R2 storage and Class A/B operations    | R2 metrics              | Grows with attachments, snapshots, and versions       |
| Durable Object billed duration         | Durable Object metrics  | Idle connected rooms should approach zero             |
| Durable Object request rate per object | Durable Object metrics  | A single hot room is a single-threaded bottleneck     |

Durable Object billed duration deserves specific attention. Both classes set `hibernate: true`, and the
design depends on idle rooms costing nothing. Miniflare cannot prove hibernation behavior, so this can
only be verified on a deployed account — it is listed in the
[production smoke checklist](DEPLOYMENT.md#production-smoke-checklist) for that reason. If idle rooms
accrue duration, hibernation is not working and cost scales with connections rather than activity.

## Suggested alerts

| Alert                   | Condition                                                                                                 | Why it matters                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Cron failure            | Scheduled invocation errors, or no successful invocation in 2 hours                                       | Both cleanup queues stop draining; deleted content leaks and archived pages keep editors connected                                   |
| Sustained 5xx           | Worker error rate above baseline for 5 minutes                                                            | General outage                                                                                                                       |
| `table_revision_failed` | Any `Table revision could not be advanced` log line                                                       | A table mutation invariant was violated. Not transient; see [Troubleshooting](TROUBLESHOOTING.md#the-table-mutation-guard)           |
| Deletion backlog        | `deletion_jobs` count above 10                                                                            | 10 is the per-tick drain rate, so this is the point where the queue stops keeping up                                                 |
| Stuck deletion          | Any `deletion_jobs` row with `next_attempt_at` more than 2 hours past, or `attempts` above 5              | Overdue by more than a cron interval, so the runner is not clearing it; `attempts` past the clamp means it is at the 16-hour ceiling |
| Stuck archive           | Any `archive_disconnect_targets` row with `next_attempt_at` more than 2 hours past, or `attempts` above 9 | Same, against the 42 min 40 s ceiling                                                                                                |
| Stuck upload            | Any `attachment_uploads` row with `next_attempt_at` more than 2 hours past, or `attempts` above 5         | The reaper is not clearing it, so R2 keeps holding the parts                                                                         |
| D1 size                 | Above 8 GB                                                                                                | Approaching the 10 GB cap with no migration path                                                                                     |

The queue-based alerts have no push mechanism in this repository. Run the queries from
[Operations](OPERATIONS.md#inspecting-the-work-queues) from an external scheduler and alert on a
non-zero count.

Alert on `next_attempt_at` and `attempts`, never on how old a row is. The only general runner is the
hourly cron, so a row that failed with a 10-second backoff still waits until the next tick: a healthy
retrying row is routinely older than the delay that scheduled it. Row age says nothing about whether
work is progressing.

## Log triage

Search Workers Logs by message string; see the full table in
[Troubleshooting](TROUBLESHOOTING.md#log-triage). The highest-signal strings are:

```
Scheduled deletion cleanup failed
Scheduled archive disconnect failed
Document restore failed
Failed to reconcile pending document restore
Failed to handle document party request for
```

Source maps are uploaded, so stack traces in the dashboard resolve to TypeScript source rather than
bundled output.

Two things to remember:

- Unrecognised exceptions are collapsed into `500 internal_error` with the original logged separately.
  A 500 in a client report and a log entry are two views of one event; correlate by timestamp, since
  there is no request id.
- Expected errors are never logged, by design. A client reporting a `404 room_not_found` or a
  `409 stale_epoch` on `/parties/*` will leave no trace in Workers Logs. Malformed upgrade paths land
  in that group, so a burst of them is visible in request metrics but not in the logs.

## Verifying a deploy

```sh
pnpm wrangler deployments list --env production          # which revision is live
curl -s https://notes.example.com/api/health
pnpm wrangler d1 execute DB --env production --remote --command \
  "SELECT COUNT(*) jobs FROM deletion_jobs;"
```

Then confirm the next hourly cron tick succeeds before considering the deploy settled.
