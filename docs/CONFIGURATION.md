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

| Name                         | Required             | Notes                                                                                                                                                                                                                                        |
| ---------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`         | Yes                  | At least 32 random bytes. Signs sessions **and** is the `x-notes-internal` shared secret for Worker-to-Durable-Object calls. Rotation has a wider blast radius than it appears; see [Operations](OPERATIONS.md#rotating-better_auth_secret). |
| `BOOTSTRAP_TOKEN`            | Yes, until bootstrap | One-time operator install credential, compared in constant time against a SHA-256 digest. Delete or rotate after the owner exists.                                                                                                           |
| `OBSERVABILITY_PROBE_TOKEN`  | Yes                  | High-entropy bearer value accepted only in `X-Observability-Token` on `GET /api/health/ready`. Store the same value in GitHub Actions.                                                                                                       |
| `DO_LOCATION_HINT`           | No                   | One of `wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `oc`, `afr`, `me`. If unset, derived from the bootstrap request's `cf.continent`, defaulting to `wnam`.                                                                                |
| `SLACK_CLIENT_ID`            | No                   | Slack app client ID shared by the separate bot-install and Slack OpenID flows. Slack remains visibly disabled unless all four Slack values are set.                                                                                          |
| `SLACK_CLIENT_SECRET`        | No                   | Slack app client secret. Register both `/api/slack/oauth/callback` and `/api/auth/callback/slack`; OpenID uses only `openid profile email`.                                                                                                  |
| `SLACK_SIGNING_SECRET`       | No                   | Verifies slash commands, events, and interactive shortcuts; requests older than five minutes and signature replays are rejected.                                                                                                             |
| `SLACK_TOKEN_ENCRYPTION_KEY` | No                   | High-entropy key used to encrypt bot access and refresh tokens with AES-GCM before D1 storage. Rotate by reinstalling Slack with the new key before removing the old deployment.                                                             |
| `WEBHOOK_ENCRYPTION_KEY`     | For webhooks         | Exactly 32 random bytes encoded as 43 characters of unpadded base64url. Encrypts integration webhook verification tokens with AES-GCM; webhook subscription creation and delivery remain unavailable when it is unset or malformed.          |

`DO_LOCATION_HINT` is frozen into `workspaces.location_hint` at bootstrap and is **immutable in v1**.
Changing the secret later has no effect on an existing workspace. It influences first Durable Object
placement only; it is an optimization, not a data-residency boundary. D1 and other Cloudflare metadata
are not constrained by it.

For local development these live in `.dev.vars`; see `.dev.vars.example`.

## Bindings

Declared in `wrangler.jsonc`, typed in `src/worker/env.ts`.
The existing `cloudflare-realtime-notes` resource names are intentionally retained so the NoteFlare
rebrand does not replace production data or deployment infrastructure.

| Binding                          | Kind           | Target                                                                                      |
| -------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `DB`                             | D1             | `cloudflare-realtime-notes`, migrations in `migrations/`                                    |
| `BUCKET`                         | R2             | `cloudflare-realtime-notes`, preview `cloudflare-realtime-notes-preview`                    |
| `DOCUMENT`                       | Durable Object | class `Document`, SQLite-backed, hibernating                                                |
| `WORKSPACE_EVENTS`               | Durable Object | class `WorkspaceEvents`, SQLite-backed, hibernating, audience-filtered                      |
| `NOTES_WORKFLOW`                 | Workflow       | resumable imports, exports, template clones, migrations, and reindexing                     |
| `DELIVERY_QUEUE`                 | Queue          | notification, email, Slack, and digest fan-out; configured with a DLQ                       |
| `BROWSER`                        | Browser Run    | optional PDF generation                                                                     |
| `SEND_EMAIL`                     | Email Service  | optional email delivery; the UI reports it unavailable when absent                          |
| `API_SOURCE_BURST_LIMIT`         | Rate Limit     | Pre-authentication `/v1` throttle: 300 requests per source per 10 seconds                   |
| `API_SOURCE_MINUTE_LIMIT`        | Rate Limit     | Pre-authentication `/v1` throttle: 1,800 requests per source per minute                     |
| `API_BURST_LIMIT`                | Rate Limit     | Authenticated `/v1` throttle: 100 requests per integration per 10 seconds                   |
| `API_MINUTE_LIMIT`               | Rate Limit     | Authenticated `/v1` throttle: 600 requests per integration per minute                       |
| `CLIENT_TELEMETRY_PREAUTH_LIMIT` | Rate Limit     | Browser telemetry pre-authentication throttle: 300 requests per hashed source IP per minute |
| `CLIENT_TELEMETRY_LIMIT`         | Rate Limit     | Authenticated browser error reports: 20 requests per hashed user ID per minute              |
| `OBSERVABILITY`                  | Analytics      | Fixed-position operational metrics; production dataset retained 3 months                    |
| `CF_VERSION_METADATA`            | Version        | Active Worker version ID, tag, and deployment timestamp                                     |

No KV, Workers AI, Vectorize, Hyperdrive, or Containers bindings are used. Slack is
inactive until its four secrets are configured. Verified integration webhooks can make outbound HTTPS
requests and require `WEBHOOK_ENCRYPTION_KEY`.

Durable Object class migrations are append-only:

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["Document"] },
  { "tag": "v2", "new_sqlite_classes": ["WorkspaceEvents"] },
]
```

Never rename or delete a class or binding without a Cloudflare Durable Object migration plan.

## Worker settings

| Setting                     | Value                                           | Effect                                                                                                                        |
| --------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `compatibility_date`        | `2026-08-14`                                    | Runtime behavior baseline                                                                                                     |
| `compatibility_flags`       | `nodejs_compat`, `global_fetch_strictly_public` | Required by Better Auth and to keep outbound webhook fetches on public network destinations                                   |
| `observability.logs`        | enabled, sampling `1`, invocation logs enabled  | 100% structured production and local Workers Logs                                                                             |
| `observability.traces`      | production `0.05`, local/E2E `1`                | Automatic and custom Workers Traces                                                                                           |
| `upload_source_maps`        | `true`                                          | Symbolicated stack traces in logs                                                                                             |
| `preview_urls`              | `false`                                         | Disabled; Durable Object Workers do not receive preview URLs                                                                  |
| `assets.not_found_handling` | `single-page-application`                       | SPA fallback                                                                                                                  |
| `assets.run_worker_first`   | `["/api/*", "/parties/*", "/v1/*", "/share/*"]` | Browser APIs, collaboration sockets, Notion-compatible APIs, and public shares invoke the Worker before static-asset fallback |
| `triggers.crons`            | `*/15 * * * *`                                  | Outbox recovery, digests, expiry, and cleanup; **required**                                                                   |

Cloudflare does not generate preview URLs for Workers that implement a Durable Object, and this
The Worker exports two Durable Object classes, so per-version preview URLs are unavailable. See
[Continuous deployment](CONTINUOUS_DEPLOYMENT.md#preview-urls-do-not-exist-for-this-worker).

## R2 key layout

| Prefix                                          | Contents                                         |
| ----------------------------------------------- | ------------------------------------------------ |
| `documents/{pageId}/epochs/{epoch}/current.bin` | Current Yjs snapshot for an epoch                |
| `documents/{pageId}/versions/{versionId}.bin`   | Immutable version snapshots                      |
| `diagrams/{pageId}/epochs/{epoch}/current.bin`  | Current diagram Yjs snapshot for an epoch        |
| `diagrams/{pageId}/epochs/{epoch}/projections/` | Structured diagram JSON projections              |
| `diagrams/{pageId}/epochs/{epoch}/thumbnails/`  | Generated private SVG thumbnails                 |
| `diagrams/{pageId}/versions/{versionId}.bin`    | Immutable diagram version snapshots              |
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
| Bulk receipt retention                                  | Durable until the table/page cascade removes it                          | `table_bulk_writes`                             |
| Page-create receipt retention                           | Durable until the page/workspace cascade removes it                      | `page_create_receipts`                          |
| `PAGE_MOVE_RECEIPT_RETENTION_MS`                        | 7 days; expired receipts are pruned on each cron tick                    | `src/shared/page-move.ts`                       |
| `PAGE_MOVE_RECEIPT_PRUNE_BATCH_SIZE`                    | 1000 expired receipts per delete                                         | `src/shared/page-move.ts`                       |
| `PAGE_MOVE_RECEIPT_PRUNE_MAX_BATCHES`                   | 10 delete batches per cron tick                                          | `src/shared/page-move.ts`                       |
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

The scheduled handler runs every 15 minutes (`triggers.crons`) and processes retry queues and retention
cleanup with per-tick caps. These determine how long a backlog takes to clear, and whether a stalled row
is broken or merely waiting. Four ticks per hour, so multiply any per-tick cap by four for hourly capacity.

| Work item                    | Per tick | Backoff                                 | Effective ceiling |
| ---------------------------- | -------- | --------------------------------------- | ----------------- |
| `deletion_jobs`              | 10       | `min(24 h, 1 h × 2^min(attempts-1, 4))` | 16 h              |
| `archive_disconnect_targets` | 50       | `min(1 h, 10 s × 2^min(attempts-1, 8))` | 42 min 40 s       |
| `attachment_uploads`         | 50       | `min(1 h, 10 s × 2^min(attempts-1, 8))` | 42 min 40 s       |
| Expired `page_move_receipts` | 10000    | n/a; oldest receipts first              | n/a               |

The outer `min` in each expression is never reached: the attempt clamp caps the exponent first, at
`1 h × 2^4` and `10 s × 2^8` respectively. Read the effective ceiling column, not the outer bound.

Two consequences worth internalising:

- A deletion job's **first** retry is a full hour away. A job that fails once will not be retried
  sooner, no matter how transient the cause.
- At 10 jobs per tick and four ticks per hour, a backlog of 60 deletion jobs takes at least 90 minutes to
  drain even if every attempt succeeds.

Archive disconnects are far more forgiving: 50 per tick with a 10-second initial backoff.

An outbox sweep is bounded to five batches of 50 rows and protected by a five-minute singleton lease.
Producers that encounter the lease request an atomic rescan from its owner. If immediately available rows
remain at the cap, the owner queues a continuation; contended continuation deliveries back off, and the cron
remains the recovery path if that queue send fails.

PDF and portable HTML exports accept at most 64 accessible linked-diagram thumbnails and load them
sequentially. PDF rejects more than 24 MiB of thumbnail bytes; portable HTML uses the export's 64 MiB
artifact limit. Non-portable exports resolve diagram links in bounded query batches without loading thumbnails.

Expired move receipts are retention cleanup, not retry work. Each pass deletes up to ten batches of
1000 rows. Reaching that catch-up limit emits a warning because expired rows may remain; a sustained
expiration rate above 40000 receipts per hour (10000 per tick, four ticks) will outgrow the configured
cleanup capacity.

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

| Property                   | Value                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Password minimum           | 8 characters                                                                                   |
| Public sign-up             | Blocked; `/api/auth/sign-up/email` returns `registration_closed`                               |
| Email verification         | Not implemented, by design                                                                     |
| Password reset             | Not implemented, by design — an owner revokes and reinvites                                    |
| Invites                    | One use, SHA-256 hashed, 7-day lifetime                                                        |
| Roles                      | `owner`, `editor`, `viewer`                                                                    |
| Connection reauthorization | Every 5 minutes                                                                                |
| Application rate limiting  | `/v1` and browser telemetry use Worker Rate Limit bindings; authentication still relies on WAF |

## Slack thread mirrors

Channel mappings remain one-way until an owner with a verified Slack identity selects **Validate and enable mirror**
in Slack Settings. The bot and the owner must be channel members. Mirroring requires `chat:write`, `channels:read`,
`groups:read`, `channels:history`, `groups:history`, and `users:read`; public/private channels are supported, while DMs,
MPIMs, Slack Connect, and archived channels are rejected. Existing search, unfurls, and notifications retain their
original scope requirements.

A page mirror takes precedence over its space mirror when a new thread link is reserved. Existing links keep their
original mapping while it remains enabled and covers the page. Mirroring covers new comments and resolution changes
independently of one-way notification filters/cadence; enabling it does not backfill history. Disabling or deleting a
mapping retires its roots. Re-enabling permits a new root on the next eligible event. Muted/snoozed mappings suppress
new roots and channel notifications, but replies on existing roots continue.

One-way notifications have separate channel health from mirror validation. Shared channels may receive one-way
notifications even though they cannot host mirrors. A definitive channel failure blocks that mapping's notifications
and discards waiting events; an owner can verify bot access in Settings to resume with new events. An installation token
failure is shown separately and requires reauthorization; it does not disable mirrors or mislabel a channel as lost.

Slack replies require a current OpenID-verified member, channel membership, and current page access. Resolve/Reopen
uses NoteFlare's existing resolution permission. Bot messages, edits, deletes, and unsupported message subtypes are
ignored. A `thread_broadcast` pointer is resolved against the actual threaded reply before import and deduplicated
against an ordinary message event by its reply timestamp. Conversion accepts at most 16 KiB of Slack text, 50 distinct mention tokens, 201 text blocks, and 300 inline
nodes before the existing 32 KiB comment validation. Unknown mentions remain plain text. Delivery rechecks current
authority; disconnect invalidates queued work and requires identity verification and mirror opt-in after reconnect.

Outbound posts carry an opaque delivery marker. A lost response or abandoned send is reconciled against at most 20
history pages of 100 messages. Replies waiting for an earlier delivery stay pending; Settings shows waiting and
unresolved reconciliation separately. An uncertain send is never blindly reposted. Do not reset a `sending` record
to `pending`: Slack may already have accepted it. Installation authentication outages and failed history lookups pause
the reconciliation clock. After 24 eligible hours without confirmation, an uncertain reply is skipped and later
replies can continue. An uncertain root retires its link, so a later eligible event can establish a new root.
History permission loss holds the send for owner verification or reauthorization. Disabling the mirror retires its
unsent work without deleting Slack history.
Ephemeral denials are best effort and never fall back to public channel messages.
Definitively rejected replies are recorded as failed and skipped so later replies continue; a rejected root retires
its link. Pending receipts and deliveries are redriven with bounded backoff, at most eight eligible redrives or 24
eligible hours. Authentication outages pause those limits; ordering waits consume no redrive budget. Slack Settings
retains terminal delivery failures, including after mapping deletion, until an owner acknowledges their visibility.
Acknowledgment does not retry or remove a delivery. Owners can Verify and resume after repairing channel access.
Unapplied buttons expire after ten minutes.

## Interactive Slack workspace

`/notes <query>` opens a search modal with space, tag, page-kind, and archive filters. Search and pagination
show ten currently accessible results at a time. The Slack App Home Mentions tab shows ten mentions per page,
with unread state and a **Mark inbox read** action. Opening Home starts a fresh inbox snapshot; Next and Previous
continue within that snapshot. Configure the manifest's interactivity **Options Load URL** alongside its Request URL
to load Space and Tags options. Legacy `/notes link` users must verify their Slack identity from NoteFlare Settings
before searching. New mentions use the actor of the update that introduced them; historical or automated mentions
without proven provenance display “A collaborator.”

Canonical thread roots offer Resolve/Reopen and page Watch/Unwatch. A page Unwatch also overrides a watched
space. Workspace owners can Mute/Unmute or Snooze the mapping for 1, 8, or 24 hours. Unmute clears both mute
and snooze; Snooze replaces an indefinite mute. These controls also appear in Slack Settings without requiring an
active root. Pending digests are discarded on mute or snooze, and unmute resumes with new events. Owners can create
or view the current public share from a supported root or mapped page unfurl. The link is returned as a channel-level
ephemeral to the acting user while they are active in Slack; an uncertain send is never blindly reposted. These actions
recheck current identity, membership, mapping, and page permissions when delayed work runs; old buttons and
saved modal state do not grant access.

## Environments

`wrangler.jsonc` keeps local-safe defaults at the top level and defines two named environments:
`production`, which holds the deployed D1, R2, Durable Object, and origin bindings; and
`notes-checks-e2e`, used only by the local Playwright harness. Production scripts always pass
`--env production` explicitly.

There is no staging environment. `nightly.yml` refers to a `STAGING_BASE_URL` repository variable for
its realtime load check, but no configuration in this repository deploys such an environment; it must
be created and maintained separately if wanted. See
[Operations](OPERATIONS.md#known-gaps).
