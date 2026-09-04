# Troubleshooting

Organised by what you actually observe. For the tables and commands referenced here, see
[Operations](OPERATIONS.md); for limits and constants, see [Configuration](CONFIGURATION.md).

## Deployment failures

| Symptom                                                                                            | Cause                                                                                                       | Fix                                                                                        |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Couldn't find DB` or a D1 error on first deploy                                                   | Production `database_id` is missing or still a placeholder in `wrangler.jsonc`                              | Set `env.production.d1_databases` to the ID from `wrangler d1 create`                      |
| Sign-in fails; cookies not set; `invalid_origin` on connect                                        | Production `BETTER_AUTH_URL` does not exactly match the origin the browser used                             | Set `env.production.vars.BETTER_AUTH_URL` to the exact HTTPS origin, then redeploy         |
| Runtime `no such table` errors after a deploy                                                      | Worker deployed before `pnpm db:remote`                                                                     | Apply migrations, then redeploy                                                            |
| `BETTER_AUTH_SECRET is not defined` or 500s on every request                                       | Secret was not set for the production environment                                                           | Run `pnpm wrangler secret list --env production`, then `secret put --env production`       |
| CI fails at `cf-typegen:check`                                                                     | `worker-configuration.d.ts` is out of date with `wrangler.jsonc`                                            | Run `pnpm cf-typegen` and commit the result                                                |
| Deploy refuses an unrecognizable Wrangler migration listing                                        | Wrangler's human-readable migration output changed or was incomplete                                        | Verify the command output, then update and test `scripts/check-page-move-migration.mjs`    |
| Locally, `no such table` or a missing owner guard, with `pnpm db:local` reporting nothing to apply | The local D1 predates the squashed `0001_initial.sql` baseline, and `d1_migrations` already lists that name | Delete `.wrangler/state` and rerun `pnpm db:local`; there is no forward migration for this |
| Deploy succeeds but the old version appears live                                                   | Asset or browser caching, or you are looking at a preview URL                                               | `pnpm wrangler deployments list --env production` to confirm what is current               |

`/api/health` returning `{"ok":true,"version":"0.1.0"}` does **not** confirm which revision is live;
`version` is a hardcoded string.

## WebSocket close codes

All application close codes are in the 4xxx range. This is the first thing a user reports, usually as
"the page keeps disconnecting".

| Code   | Meaning                                                                  | Expected?                                                      |
| ------ | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `4401` | Authorization missing or expired. Every grant lasts at most five minutes | Yes — routine. The client reconnects and reauthorizes          |
| `4410` | This document epoch was retired, or a restored version replaced it       | Yes, after a version restore. The client follows the new epoch |
| `4411` | The page was permanently deleted                                         | Yes. Terminal; the client stops retrying                       |
| `4412` | The page was archived                                                    | Yes. The client reconciles and removes it from the tree        |
| `4429` | The room already has 30 collaborators                                    | Yes at capacity — **but see below**                            |

`4429` is not handled by the client's close reconciler, which only acts on `4410`, `4412`, and `1006`.
A client rejected from a full room therefore reconnects on the normal backoff schedule and is rejected
again. Operators see this as a sustained reconnect loop and elevated request volume against one room,
not as an error. The fix is fewer concurrent editors on that page; there is no server-side mitigation.

## HTTP error codes

Responses are `{"error":{"code","message","details"}}`. Unrecognised exceptions are logged and returned
as a bare `500 internal_error` with no detail. Expected 5xx errors that need operator attention are logged
explicitly and listed under [Log triage](#log-triage).

### Authentication and installation

| Code                           | Status | Meaning                                                                                                                                                                                           |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_origin`               | 403    | The `Origin` header did not match `BETTER_AUTH_URL` exactly. Almost always a misconfigured `BETTER_AUTH_URL`, or a request reaching the Worker on a second hostname such as a `workers.dev` route |
| `registration_closed`          | 403    | Public sign-up is deliberately blocked. Expected; it is a smoke-test assertion                                                                                                                    |
| `invalid_bootstrap_token`      | 403    | Wrong or rotated `BOOTSTRAP_TOKEN`                                                                                                                                                                |
| `already_initialized`          | 409    | The owner already exists. Bootstrap is one-time                                                                                                                                                   |
| `invite_invalid`               | 404    | Invite is invalid, expired, or already used                                                                                                                                                       |
| `invite_used`                  | 409    | Another request consumed the invite first                                                                                                                                                         |
| `final_owner`                  | 409    | Blocked by the last-owner triggers. Promote another owner first                                                                                                                                   |
| `owner_required` / `read_only` | 403    | Role gate. `read_only` means an editor action attempted by a viewer                                                                                                                               |

### Pages and content

| Code                        | Status | Meaning                                                                                                                                                   |
| --------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stale_epoch`               | 409    | The client asked for a document epoch that is no longer current, typically mid-restore. The client refetches and follows the new epoch                    |
| `page_cycle`                | 409    | A move would make a page its own ancestor                                                                                                                 |
| `idempotency_key_reused`    | 409    | A page-create or page-move operation id was reused with different request content. Generate a new operation id                                            |
| `move_not_found`            | 404    | No committed move receipt exists for that workspace, page, and operation id, including because its seven-day recovery window expired                      |
| `page_move_unresolved`      | 503    | D1 could not determine whether an operation-id-keyed move committed. Retry with the same operation id; do not generate a replacement id                   |
| `archive_first`             | 409    | Permanent deletion attempted on a page that is not archived                                                                                               |
| `page_archived`             | 409    | A receipt-backed page-create replay or concurrent page move targeted an archived page; restore it, permanently delete it, or retry against an active page |
| `upload_too_large`          | 413    | Over 10 MiB on the single-shot form route, or over 10 GiB on a multipart upload                                                                           |
| `upload_session_not_found`  | 404    | The multipart session was aborted, completed, reaped, or its page archived                                                                                |
| `upload_part_size`          | 422    | Part number outside the upload, or a part that is not exactly the size the server assigned                                                                |
| `upload_incomplete`         | 409    | Complete was called before every part arrived                                                                                                             |
| `upload_size_mismatch`      | 422    | The uploaded parts do not add up to the size declared at init                                                                                             |
| `multipart_complete_failed` | 503    | R2 refused to finalise the upload. Retry; the parts are still held                                                                                        |
| `batch_too_large`           | 422    | A batched page create asked for more than `PAGE_BATCH_MAX` pages                                                                                          |
| `unsafe_file_type`          | 415    | Active content — HTML, SVG, XML, script — is rejected by design                                                                                           |
| `attachment_missing`        | 404    | D1 metadata exists but the R2 object does not. See [Backup and recovery](BACKUP_AND_RECOVERY.md#attachment-object-missing)                                |
| `version_missing`           | 404    | Version row exists but its R2 object does not                                                                                                             |
| `restore_failed`            | 503    | Version restore could not complete. Usually an R2 or D1 outage. Whether it retries depends on how far it got — see below                                  |
| `room_not_found`            | 404    | A `/parties/*` upgrade named a room that cannot exist: an unknown workspace, or a page id or epoch that is not the exact text this installation produces  |

### Tables

Structured tables have no CRDT, so they use an explicit lease plus optimistic revisions. Most table
errors are normal concurrency outcomes.

| Code                              | Status | Meaning                                                   | Action                                        |
| --------------------------------- | ------ | --------------------------------------------------------- | --------------------------------------------- |
| `lease_conflict`                  | 409    | Another session holds the editing lease                   | Wait up to 60 s, or owner force-unlock        |
| `lease_lost` / `table_lease_lost` | 409    | The lease expired or was taken over                       | Client reacquires automatically               |
| `table_revision_conflict`         | 409    | The table changed underneath this edit                    | Client reloads and retries once               |
| `mutation_target_not_found`       | 404    | The row, column, or option being changed no longer exists | Normal after a concurrent delete              |
| `table_row_limit`                 | 422    | `TABLE_MAX_ROWS` reached; enforced on write only          | Split the table                               |
| `invalid_table_cursor`            | 422    | Bad `limit`, `after*` cursor, or `offset` on a table read | Restart the page walk from the first page     |
| `invalid_table_sort`              | 422    | `sort` names no column on this table, or a bad `dir`      | Reload the client; check the request          |
| `empty_bulk_write`                | 422    | Bulk write declared neither a column nor a row            | Skip the request; it would change nothing     |
| `bulk_too_large`                  | 422    | Bulk write exceeds the per-request column, row, cell cap  | Split into smaller batches                    |
| `invalid_bulk_reference`          | 422    | Bulk cell names an unknown column id or `ref:` token      | Check the column was declared in the request  |
| `invalid_cell`                    | 422    | A submitted cell value failed type validation             | Correct the cell value                        |
| `select_required`                 | 422    | Add-option targeted a column whose type is not `select`   | Reload the client; check the request's column |
| `table_revision_failed`           | 500    | **An invariant was violated.** See below                  | Escalate; do not retry                        |

`select_required` is not reachable from the UI, which offers **Add option** only on select columns.
Seeing it means a stale client, a hand-built API call, or a column whose type changed underneath the
request. Investigate the caller, not the cell.

## The table mutation guard

Every guarded table mutation runs as one D1 batch of three statements: the data change, a revision
bump, then a read-back of the lease and revision.

```sql
UPDATE table_state SET revision = revision + 1
 WHERE page_id = ? AND revision = ? AND changes() > 0 AND <lease guards>
```

`changes()` reports the row count of the statement immediately before it in the batch, so the revision
bump applies exactly when the data change matched a row. There is no trigger and no `mutation_guard`
column; the guard is the `changes() > 0` predicate, enforced inside the batch's implicit transaction.

The data change carries the same lease and revision guards as the bump, evaluated against the same
timestamp. That closes the invariant in both directions: the bump cannot apply without the change
(`changes() > 0`), and the change cannot apply without the bump (whatever the change matched on, the
bump matches on too).

### The bulk variant

`POST /api/tables/:pageId/bulk` is the one route that drops `changes() > 0`, because that predicate
reads only the statement immediately before the bump and a bulk write emits several. Dropping it is
safe **only** because every bulk statement inserts freshly generated ids, which cannot match zero
rows, and each carries the same lease guards as the bump inside the same transaction — so the inserts
apply exactly when the bump does. This is why the route is append-only: adding a bulk update or
delete would reintroduce a statement that can legitimately match nothing, and the reasoning would
have to be redone. `mutation_target_not_found` is unreachable on this path.

A bulk write also renews its own lease, so a long import cannot outlive the 60-second window. The
renewal carries its own guard and therefore cannot revive a lease that already lapsed.

**The invariant: a revision advances if and only if its paired data mutation applied.** Neither half can
commit alone. This is what stops a failed write from silently advancing the revision, which would make
every other client believe it had already applied the change.

The handler classifies the outcome from the batch's row counts and the read-back, in this order:

| Mutation applied | Revision bumped | Read-back                      | Result                          |
| ---------------- | --------------- | ------------------------------ | ------------------------------- |
| Yes              | Yes             | not consulted                  | Success, `revision + 1`         |
| No               | No              | Lease no longer valid          | `409 table_lease_lost`          |
| No               | No              | Revision moved underneath      | `409 table_revision_conflict`   |
| No               | No              | Lease and revision both intact | `404 mutation_target_not_found` |
| Yes              | No              | —                              | `500 table_revision_failed`     |

The last row is defensive: the shared guards make it unreachable, and it is kept distinguishable rather
than misreported as a conflict.

`table_revision_failed` means the invariant did not hold. It is not a transient error and retrying will
not help. Escalate it.

The Worker logs client-facing errors that need operator attention explicitly. Expected errors are normally
not logged, but `page_move_unresolved`, invalid persisted move receipts, post-move receipt conflicts, and
invalid move-batch results, and `table_revision_failed` are exceptions because there is no metric carrying the response code. Search Workers
Logs for the matching entry in [Log triage](#log-triage). Page-move entries carry the workspace, page, and
operation ids, a `receiptReadPhase`, and flattened error details. Recovery-phase entries also carry
`moveError*`; receipt failures use `receiptError*`, and a failed commit-phase page-state fallback uses
`pageStateError*`. `Table revision could not be advanced` carries the page id,
the revision the caller expected, the revision actually stored, and whether the lease was still valid. Lease
tokens and session ids are deliberately omitted because they authenticate the caller.

Classification depends only on `meta.changes` from the batch results and the read-back row, not on any
D1 error message, so a change to D1's error formatting cannot degrade a `404` into a generic `500`.

## Log triage

Logs use stable message strings with structured diagnostic fields. Unhandled Hono errors carry a
`requestRayId` when Cloudflare supplied one; other entries have no request-id correlation. Triage starts with
the message string in the Workers Logs search box and then uses the attached identifiers.

| Message                                                       | Meaning                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Scheduled deletion cleanup failed`                           | The hourly deletion pass threw. Check `deletion_jobs`                                                                                                                                                                                                                    |
| `Scheduled archive disconnect failed`                         | The hourly archive pass threw. Check `archive_disconnect_targets`                                                                                                                                                                                                        |
| `Failed to prune page move receipts`                          | The hourly seven-day move-receipt retention pass threw. Check D1 availability and the `page_move_receipts` index                                                                                                                                                         |
| `Page move receipt pruning reached its hourly catch-up limit` | Ten batches deleted 10000 expired receipts, but more may remain. Check the expired-row count and whether move volume is staying above the hourly cleanup capacity                                                                                                        |
| `Page move receipt could not be read.`                        | D1 could not determine whether the operation has a receipt. The request returns `503 page_move_unresolved`; retry with the same operation id. `receiptReadPhase` identifies preflight, recovery, or reconciliation                                                       |
| `Page move receipt was invalid.`                              | A receipt or committed batch result was malformed, unsupported, or inconsistent. On a `commit` entry, `recoveredFromPageState` means the response used authoritative batch state; `pageStateError*` means that fallback failed and stored-receipt recovery was attempted |
| `Committed page move receipt result was inconsistent.`        | A committed batch result contradicted the request identity or hash. The anomaly is logged before the Worker retries from the authoritative stored receipt                                                                                                                |
| `Page move batch result was invalid or inconsistent.`         | D1 returned malformed metadata or contradictory state. Inspect `moveError*`. `recoveredFromReceipt`: true = recovered `200`; false = failure. Match receipt logs by operation id: unreadable = `503` (retry same id), conflicting = `409`, invalid or absent = `500`     |
| `Page move recovery found a conflicting receipt.`             | A move attempt failed and recovery found the operation id attached to different request content. The request returns `409 idempotency_key_reused`; inspect both `moveError*` and `receiptError*`                                                                         |
| `Unhandled request error`                                     | An unexpected Hono API failure was collapsed to `500 internal_error`. Inspect `requestMethod`, `requestPath`, `requestRayId`, and the bounded `error*` fields                                                                                                            |
| `Immediate deletion cleanup failed`                           | The inline attempt during a delete request failed. The cron will retry                                                                                                                                                                                                   |
| `Failed to discard staged deletion job`                       | A permanent delete failed _and_ its rollback failed. Inspect `deletion_jobs` for an orphan                                                                                                                                                                               |
| `Failed to reschedule archive disconnect`                     | Backoff could not be persisted. The row may retry sooner than intended                                                                                                                                                                                                   |
| `Document restore failed`                                     | A version restore threw. The room stays read-only until reconciled                                                                                                                                                                                                       |
| `Document restore validation failed`                          | The version row or its R2 object could not be read. Nothing was staged, so **nothing retries**; the user must restore again                                                                                                                                              |
| `Table revision could not be advanced`                        | A table mutation applied but its revision update did not, which the batch cannot produce. Carries the page and both revisions. Not transient                                                                                                                             |
| `Failed to confirm restore commit state`                      | Restore could not determine whether it committed. Left pending for the alarm                                                                                                                                                                                             |
| `Failed to reconcile pending document restore`                | A pending restore retried and failed again. Repeats on the backoff below, not in a hot loop                                                                                                                                                                              |
| `Failed to record restore reconciliation attempt`             | The backoff counter could not be persisted. The next retry may come sooner than intended                                                                                                                                                                                 |
| `Failed to schedule restore reconciliation`                   | The retry alarm could not be armed. The room stays read-only until a request wakes it                                                                                                                                                                                    |
| `Failed to prune document versions`                           | Version retention did not run. Storage grows; not urgent                                                                                                                                                                                                                 |
| `Failed to broadcast workspace event`                         | A page-tree or projection event was dropped. Clients recover on reconnect                                                                                                                                                                                                |
| `Failed to broadcast projection update`                       | Same, from the document side                                                                                                                                                                                                                                             |
| `Failed to schedule compaction retry`                         | The compaction alarm could not be re-armed. The room may stay dirty                                                                                                                                                                                                      |
| `Failed to resume document alarm after transition`            | Alarm re-arm failed after archive, restore, or purge                                                                                                                                                                                                                     |
| `Failed to persist retired document state`                    | An epoch could not be marked retired                                                                                                                                                                                                                                     |
| `Failed to handle document party request for <room>`          | An unexpected failure on a `/parties/document/*` upgrade. The room is a validated `<pageId>~<epoch>`, or `an undecoded room` when the failure preceded validation                                                                                                        |
| `Failed to handle workspace-events party request for <room>`  | The same for a `/parties/workspace-events/*` upgrade                                                                                                                                                                                                                     |

### A restore returned 503

`restore_failed` covers two cases that need different responses. Tell them apart by the log line:

| Log line                             | What happened                                                                                                         | Response                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Document restore validation failed` | The version row lookup or its R2 read failed. Nothing was staged and no recovery state exists, so **nothing retries** | Tell the user to retry from the History panel once the dependency is back |
| `Document restore failed`            | The transition was staged before the failure, so recovery state is persisted                                          | Leave it; the room reconciles on its own backoff, below                   |

Only the second leaves the room read-only with a pending restore. The first leaves the document exactly
as it was, still editable.

### Pending restore backoff

A restore that cannot finish leaves the room read-only and retries on a capped exponential backoff:
ceilings of 5, 10, 20, 40, 80, 160 then 300 seconds, each delay drawn with equal jitter from
`[ceiling / 2, ceiling]`. Both the attempt count and the time the next attempt is due are persisted in
the room's own SQLite (`document_meta.restore_attempts` and `restore_retry_at`), so an eviction
mid-outage does not reset the room to the fast first retry. Both reset to zero when the restore
resolves, and when a new restore starts.

One alarm delivery makes at most one attempt. A request that wakes an evicted room reconciles
immediately rather than waiting out the quiet period — a client connecting mid-outage is a useful
signal that the dependency is back.

Symptom of a genuine outage: one page stuck read-only, and `Failed to reconcile pending document
restore` repeating at a widening interval that settles at 5 minutes. It self-heals once the dependency
recovers. Repeats faster than that, or two entries per interval, mean the backoff state is not being
persisted — look for `Failed to record restore reconciliation attempt` alongside it.

## Known unresolved issues

Recorded because they change how you interpret symptoms. They are code-level and out of scope for a
documentation change.

**Unreachable `ASSETS` branch.** `app.notFound` in `src/worker/index.ts` calls `c.env.ASSETS.fetch(...)`,
but the `assets` block in `wrangler.jsonc` declares no `binding`, and `ASSETS` is absent from the
generated `worker-configuration.d.ts`. The branch is unreachable in practice because `run_worker_first`
covers only `/api/*` and `/parties/*`; every other path is served by the asset layer without invoking
the Worker. It would throw if reached. Do not "fix" this by adding the binding without also confirming
the routing assumption still holds.

## Escalation

Before escalating a data-affecting issue, capture:

1. `pnpm wrangler deployments list --env production` — which revision is live.
2. The relevant queue query output from [Operations](OPERATIONS.md#inspecting-the-work-queues).
3. Workers Logs for the matching message string, with timestamps.
4. Whether the hourly cron has run since the incident began.

Do not delete Durable Objects, remove queue rows, or recreate a room to clear a symptom. The Durable
Object may hold the only copy of a document's recent tail; see
[Backup and recovery](BACKUP_AND_RECOVERY.md#r2-current-snapshot-missing).
