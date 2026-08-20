# Configuration reference

Every value the installation reads, and every limit it enforces. Source files are given so a value can
be confirmed rather than trusted.

## Variables

Set in the environment's `vars` block of `wrangler.jsonc`. Plaintext; visible in the dashboard and in
the repository.

| Name              | Default                 | Notes                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_URL` | `http://localhost:5173` | The exact origin the installation is served from. Sets the Better Auth cookie origin, and is the allowlist the `Origin` header is compared against on bootstrap, invite acceptance, and WebSocket upgrades. A request carrying no `Origin` header is not rejected; it is left to the session check. **The production environment must use its deployed HTTPS origin.** |

## Secrets

Set for deployment with `wrangler secret put --env production`. Never place these in `wrangler.jsonc`.

| Name                 | Required             | Notes                                                                                                                                                                                                                                        |
| -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | Yes                  | At least 32 random bytes. Signs sessions **and** is the `x-notes-internal` shared secret for Worker-to-Durable-Object calls. Rotation has a wider blast radius than it appears; see [Operations](OPERATIONS.md#rotating-better_auth_secret). |
| `BOOTSTRAP_TOKEN`    | Yes, until bootstrap | One-time operator install credential, compared in constant time against a SHA-256 digest. Delete or rotate after the owner exists.                                                                                                           |
| `DO_LOCATION_HINT`   | No                   | One of `wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `oc`, `afr`, `me`. If unset, derived from the bootstrap request's `cf.continent`, defaulting to `wnam`.                                                                                |

`DO_LOCATION_HINT` is frozen into `workspaces.location_hint` at bootstrap and is **immutable in v1**.
Changing the secret later has no effect on an existing workspace. It influences first Durable Object
placement only; it is an optimization, not a data-residency boundary. D1 and other Cloudflare metadata
are not constrained by it.

For local development these live in `.dev.vars`; see `.dev.vars.example`.

## Bindings

Declared in `wrangler.jsonc`, typed in `src/worker/env.ts`.

| Binding            | Kind           | Target                                                                   |
| ------------------ | -------------- | ------------------------------------------------------------------------ |
| `DB`               | D1             | `cloudflare-realtime-notes`, migrations in `migrations/`                 |
| `BUCKET`           | R2             | `cloudflare-realtime-notes`, preview `cloudflare-realtime-notes-preview` |
| `DOCUMENT`         | Durable Object | class `Document`, SQLite-backed, hibernating                             |
| `WORKSPACE_EVENTS` | Durable Object | class `WorkspaceEvents`, SQLite-backed, hibernating, read-only           |

No KV, Queues, Workers AI, Vectorize, Hyperdrive, Analytics Engine, Workflows, or Containers bindings
are used, and there are no third-party HTTP dependencies at runtime.

Durable Object class migrations are append-only:

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["Document"] },
  { "tag": "v2", "new_sqlite_classes": ["WorkspaceEvents"] },
]
```

Never rename or delete a class or binding without a Cloudflare Durable Object migration plan.

## Worker settings

| Setting                     | Value                      | Effect                                                                   |
| --------------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `compatibility_date`        | `2026-08-14`               | Runtime behavior baseline                                                |
| `compatibility_flags`       | `nodejs_compat`            | Required by Better Auth                                                  |
| `observability.enabled`     | `true`                     | Workers Logs                                                             |
| `upload_source_maps`        | `true`                     | Symbolicated stack traces in logs                                        |
| `preview_urls`              | `true`                     | Per-version preview URLs                                                 |
| `assets.not_found_handling` | `single-page-application`  | SPA fallback                                                             |
| `assets.run_worker_first`   | `["/api/*", "/parties/*"]` | Everything else is served by the asset layer without invoking the Worker |
| `triggers.crons`            | `0 * * * *`                | Hourly cleanup; **required**                                             |

## R2 key layout

| Prefix                                          | Contents                                         |
| ----------------------------------------------- | ------------------------------------------------ |
| `documents/{pageId}/epochs/{epoch}/current.bin` | Current Yjs snapshot for an epoch                |
| `documents/{pageId}/versions/{versionId}.bin`   | Immutable version snapshots                      |
| `assets/{workspaceId}/{uuid}`                   | Attachment bodies, server-generated private keys |

## Tunable constants

These are compile-time constants. Changing one requires a code edit and a redeploy; none is
configurable at runtime.

| Constant                                                | Value                                                                    | Source                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| Yjs save debounce                                       | 1 s, 5 s maximum                                                         | `src/worker/document.ts` `callbackOptions`      |
| `COMPACTION_DELAY_MS`                                   | 30 s                                                                     | `src/worker/document.ts`                        |
| `ALARM_RETRY_DELAY_MS`                                  | 5 s — the transition-deferral delay, and the base of the restore backoff | `src/worker/document.ts`                        |
| `RESTORE_RECONCILIATION_MAX_DELAY_MS`                   | 5 min — the ceiling that backoff holds at                                | `src/worker/document.ts`                        |
| `VERSION_INTERVAL_MS`                                   | 15 min                                                                   | `src/worker/document.ts`                        |
| `VERSION_RETENTION_MS`                                  | 30 days, and at most 200 versions per page                               | `src/worker/document.ts`, `pruneVersions`       |
| `WARN_BYTES`                                            | 16 MiB                                                                   | `src/worker/document.ts`                        |
| `READ_ONLY_BYTES`                                       | 24 MiB                                                                   | `src/worker/document.ts`                        |
| Connections per document epoch                          | 30, then close `4429`                                                    | `src/worker/document.ts` `onConnect`            |
| Connection grant lifetime                               | `min(session expiry, now + 5 min)`                                       | `src/worker/index.ts` `handlePartyRequest`      |
| `UPDATE_CHUNK_BYTES`                                    | 1 MiB                                                                    | `src/shared/bytes.ts`                           |
| `MAX_UPLOAD_BYTES` (single-shot form upload)            | 10 MiB                                                                   | `src/worker/attachments.ts`                     |
| `MAX_ATTACHMENT_BYTES` (chunked multipart upload)       | 10 GiB                                                                   | `src/worker/attachments.ts`                     |
| Multipart part size                                     | 8 MiB default, clamped to 5-64 MiB                                       | `src/worker/attachments.ts`                     |
| `UPLOAD_SESSION_TTL_MS`                                 | 24 h; each accepted part pushes the deadline out                         | `src/worker/attachments.ts`                     |
| `PAGE_BATCH_MAX`                                        | 50 pages per batched create                                              | `src/worker/index.ts`                           |
| `TABLE_LEASE_DURATION_MS`                               | 60 s                                                                     | `src/worker/index.ts`                           |
| Table row limit (`TABLE_MAX_ROWS`)                      | 20000, enforced on write only                                            | `src/shared/table-limits.ts`                    |
| Table page size (`TABLE_PAGE_DEFAULT`/`TABLE_PAGE_MAX`) | 500 default and maximum rows per read                                    | `src/shared/table-limits.ts`                    |
| Sorted table depth (`TABLE_SORT_MAX_OFFSET`)            | 5000 rows reachable by offset when sorting                               | `src/shared/table-limits.ts`                    |
| Bulk write caps                                         | 50 columns, 200 rows, 2000 cells, 1 MiB body per request                 | `src/shared/table-limits.ts`                    |
| Bulk receipt retention                                  | 24 h, pruned by the hourly cron                                          | `src/shared/table-limits.ts`                    |
| `DELETION_TARGET_BATCH_SIZE`                            | 50                                                                       | `src/worker/index.ts`                           |
| `CLEANUP_LEASE_MS`                                      | 15 min                                                                   | `src/worker/cleanup.ts`                         |
| `DOCUMENT_PURGE_TIMEOUT_MS`                             | 30 s                                                                     | `src/worker/cleanup.ts`                         |
| `ARCHIVE_DISCONNECT_BATCH_SIZE`                         | 25                                                                       | `src/worker/archive.ts`                         |
| `ARCHIVE_DISCONNECT_TIMEOUT_MS`                         | 30 s                                                                     | `src/worker/archive.ts`                         |
| `ARCHIVE_DISCONNECT_LEASE_MS`                           | 60 s                                                                     | `src/worker/archive.ts`                         |
| Search results / terms / query length                   | 30 / 20 / 200 chars                                                      | `src/worker/index.ts`                           |
| Mentions per page                                       | 100                                                                      | `src/worker/index.ts`                           |
| Mention suggestions                                     | 10 pages + 10 members                                                    | `src/worker/index.ts`                           |
| Invite lifetime                                         | 7 days, one use                                                          | `src/worker/index.ts`                           |
| Hidden-tab disconnect                                   | 30 s                                                                     | `src/client/collaboration.ts`                   |
| Client reconnect backoff                                | `min(30 s, 1 s × 2^min(attempt, 5))`, jittered                           | `src/client/retry.ts`                           |
| Restore reconciliation backoff                          | `min(5 min, 5 s × 2^attempt)`, jittered                                  | `src/worker/document.ts`, `src/shared/retry.ts` |

Both backoffs draw from `jitteredBackoff` in `src/shared/retry.ts`, which applies equal jitter: the
delay lands anywhere in `[ceiling / 2, ceiling]`, so a fleet that failed together does not retry in
lockstep. For a pending restore the ceilings run 5 → 10 → 20 → 40 → 80 → 160 → 300 seconds and then
hold. The attempt count and the time the next attempt is due are persisted in the room's own SQLite
(`document_meta.restore_attempts` and `restore_retry_at`) because the Durable Object hibernates; both
reset when the restore resolves or a new one starts. See
[Troubleshooting](TROUBLESHOOTING.md#pending-restore-backoff).

The 24 MiB read-only flag is **sticky**. It is written as
`read_only = CASE WHEN ? THEN 1 ELSE read_only END`, so shrinking a document never clears it. Recovery
requires restoring an earlier version into a fresh epoch. See
[Operations](OPERATIONS.md#document-size-and-the-sticky-read-only-flag).

## Cron drain rates and backoff

The hourly handler processes both work queues with per-tick caps. These determine how long a backlog
takes to clear, and whether a stalled row is broken or merely waiting.

| Queue                        | Per tick | Backoff                                 | Effective ceiling |
| ---------------------------- | -------- | --------------------------------------- | ----------------- |
| `deletion_jobs`              | 10       | `min(24 h, 1 h × 2^min(attempts-1, 4))` | 16 h              |
| `archive_disconnect_targets` | 50       | `min(1 h, 10 s × 2^min(attempts-1, 8))` | 42 min 40 s       |
| `table_bulk_writes`          | all      | Pruned, not retried; 24 h retention     | n/a               |

The outer `min` in each expression is never reached: the attempt clamp caps the exponent first, at
`1 h × 2^4` and `10 s × 2^8` respectively. Read the effective ceiling column, not the outer bound.

Two consequences worth internalising:

- A deletion job's **first** retry is a full hour away. A job that fails once will not be retried
  sooner, no matter how transient the cause.
- At 10 jobs per hour, a backlog of 60 deletion jobs takes at least six hours to drain even if every
  attempt succeeds.

Archive disconnects are far more forgiving: 50 per tick with a 10-second initial backoff.

## Security headers

Served from `public/_headers` for all asset paths:

```
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob: data:;
  style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; object-src 'none';
  base-uri 'self'; frame-ancestors 'none'
```

## Authentication policy

| Property                   | Value                                                            |
| -------------------------- | ---------------------------------------------------------------- |
| Password minimum           | 8 characters                                                     |
| Public sign-up             | Blocked; `/api/auth/sign-up/email` returns `registration_closed` |
| Email verification         | Not implemented, by design                                       |
| Password reset             | Not implemented, by design — an owner revokes and reinvites      |
| Invites                    | One use, SHA-256 hashed, 7-day lifetime                          |
| Roles                      | `owner`, `editor`, `viewer`                                      |
| Connection reauthorization | Every 5 minutes                                                  |
| Application rate limiting  | **None.** Must be provided by Cloudflare WAF                     |

## Environments

`wrangler.jsonc` keeps local-safe defaults at the top level and defines two named environments:
`production`, which holds the deployed D1, R2, Durable Object, and origin bindings; and
`notes-checks-e2e`, used only by the local Playwright harness. Production scripts always pass
`--env production` explicitly.

There is no staging environment. `nightly.yml` refers to a `STAGING_BASE_URL` repository variable for
its realtime load check, but no configuration in this repository deploys such an environment; it must
be created and maintained separately if wanted. See
[Operations](OPERATIONS.md#known-gaps).
