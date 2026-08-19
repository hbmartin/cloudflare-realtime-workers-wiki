# Operations

Day-to-day tasks for a running installation. For first-time setup see [Deployment](DEPLOYMENT.md); for
diagnosing a specific error see [Troubleshooting](TROUBLESHOOTING.md).

Every D1 command below is shown with `--remote`. Drop it to run against local state. Timestamps are
stored as epoch milliseconds, so the queries divide by 1000 before formatting.

## Member lifecycle

All member management happens in the application UI as an owner. There is no CLI.

| Task        | How                                                                           |
| ----------- | ----------------------------------------------------------------------------- |
| Invite      | Owner creates an invite; it is one-use, SHA-256 hashed, and expires in 7 days |
| Accept      | Recipient opens the invite link and sets a password (8 characters minimum)    |
| Change role | Owner edits the member; roles are `owner`, `editor`, `viewer`                 |
| Remove      | Owner removes the member; their sessions stop authorizing on the next check   |

Role changes take effect on the next authorization, not instantly. WebSocket connections carry a grant
of at most five minutes, so a demoted editor may retain write access for up to that long.

There is no way to revoke faster than that grant from inside the application. Removing the member and
rotating `BETTER_AUTH_SECRET` stops every new connection and invalidates existing sessions, but an
established socket already holds its role in Durable Object memory, and only the alarm that fires at the
grant's expiry closes it. To cut access off immediately, block the user at the edge and then rotate.

Two D1 triggers protect the last owner, created by `migrations/0001_initial.sql`:

- `prevent_final_owner_demotion`
- `prevent_final_owner_removal`

Attempting either returns `final_owner`. Promote a second owner first. The triggers are deliberately
written so that deleting the whole workspace is still possible.

To confirm the current membership:

```sh
pnpm wrangler d1 execute DB --remote --command \
  "SELECT u.email, m.role FROM workspace_members m JOIN user u ON u.id = m.user_id ORDER BY m.role, u.email;"
```

## Bootstrap token lifecycle

The token is only meaningful before the owner exists. After bootstrap, `/api/install/bootstrap` returns
`already_initialized` regardless of the token.

```sh
pnpm wrangler secret list                     # confirm what is set
pnpm wrangler secret delete BOOTSTRAP_TOKEN   # after the owner is created
```

If you need to re-run bootstrap against an empty installation, set a fresh strong token rather than
reusing the old one.

## Rotating BETTER_AUTH_SECRET

`BETTER_AUTH_SECRET` has two jobs. It signs Better Auth sessions, and it is the `x-notes-internal`
shared secret the Worker presents when calling a Durable Object directly for archive, version restore,
and purge. Both change at once.

Expected blast radius:

- Every session is invalidated. All users must sign in again.
- Internal Durable Object calls fail while the old and new values are both in flight. Archive
  operations that fail land in `archive_disconnect_targets` and are retried by the hourly cron;
  permanent-delete cleanup lands in `deletion_targets` and is likewise retried. Neither loses data.
- Live WebSocket connections are closed at their next grant expiry, within five minutes.

Procedure:

```sh
pnpm wrangler secret put BETTER_AUTH_SECRET   # paste at least 32 random bytes
```

Then confirm recovery:

```sh
pnpm wrangler d1 execute DB --remote --command \
  "SELECT COUNT(*) pending FROM archive_disconnect_targets;"
```

Rotate during low traffic. Do not rotate while a version restore is in progress.

## Inspecting the work queues

Two D1 tables are the system's asynchronous work queues. Neither has a UI, and both are the first place
to look when cleanup appears stuck. See [Configuration](CONFIGURATION.md#cron-drain-rates-and-backoff)
for the drain rates that tell "stuck" from "backed off".

### Deletion jobs

Permanent deletion returns `202` and commits a job. The job purges each document epoch's Durable Object,
then deletes exact attachment keys and complete `documents/{pageId}/` prefixes.

```sh
pnpm wrangler d1 execute DB --remote --command \
  "SELECT id, root_page_id, attempts, datetime(next_attempt_at/1000,'unixepoch') AS next_attempt, last_error
     FROM deletion_jobs ORDER BY next_attempt_at;"
```

```sh
pnpm wrangler d1 execute DB --remote --command \
  "SELECT job_id, kind, target, attempts, last_error
     FROM deletion_targets WHERE completed_at IS NULL ORDER BY job_id;"
```

`kind` is one of `document_do`, `r2_object`, or `r2_prefix`. `last_error` is truncated to 1000
characters. A healthy installation has zero rows in both queries.

Do not delete a job manually unless every one of its targets has been independently verified as gone.
Removing the job is the only record that the work is outstanding.

### Archive disconnects

Archiving commits page metadata and an `archive_disconnect_targets` row before contacting each document
room. The page disappears from clients immediately; the row exists to guarantee the room is eventually
closed.

```sh
pnpm wrangler d1 execute DB --remote --command \
  "SELECT page_id, room, attempts, datetime(next_attempt_at/1000,'unixepoch') AS next_attempt, last_error
     FROM archive_disconnect_targets ORDER BY next_attempt_at;"
```

Restoring the page cancels its pending target. Otherwise allow the hourly retry to finish.

### Forcing the scheduled handler

There is no supported way to invoke the deployed cron on demand. Options:

- Wait for the next hourly tick.
- Trigger the work indirectly: archiving or permanently deleting anything runs an immediate attempt in
  the same request via `waitUntil`.
- Locally, `pnpm wrangler dev --test-scheduled` exposes a `/__scheduled` endpoint.

Confirm a tick ran by checking that queue rows advanced their `attempts` and `next_attempt_at`.

## Leases

Three unrelated mechanisms are called leases. Only the first is user-facing.

| Lease                    | Duration | Purpose                                                     |
| ------------------------ | -------- | ----------------------------------------------------------- |
| Table editing lease      | 60 s     | Makes a structured table single-writer; tables have no CRDT |
| Deletion-job claim       | 15 min   | Stops two cron runs processing the same job                 |
| Archive-disconnect claim | 60 s     | Same, for archive targets                                   |

### Table editing leases

Held in `table_leases`, one row per page, storing a SHA-256 hash of an opaque token — never the token
itself. Clients renew every 20 seconds.

```sh
pnpm wrangler d1 execute DB --remote --command \
  "SELECT page_id, holder_user_id, datetime(expires_at/1000,'unixepoch') AS expires,
          expires_at > unixepoch()*1000 AS active FROM table_leases;"
```

**Expiry is passive.** There is no sweeper, no alarm, and no cron for this table. An expired row simply
stops satisfying the `expires_at > ?` guard and is taken over by the next acquire. Rows left by dead
browsers persist in D1 until overwritten or the page is deleted; they are harmless.

A crashed browser locks a table for at most 60 seconds. An owner can clear it immediately with the
force-unlock action in the UI, which deletes the lease row unconditionally. Use it when a user reports
a table stuck as read-only and the holder is known to be gone.

Two tabs of the same session can both acquire, because the acquire condition also matches on
`holder_session_id`. Each acquire rotates the token, so the older tab's next mutation fails with
`table_lease_lost`. This is expected behavior, not a fault.

## Document size and the sticky read-only flag

Documents warn at 16 MiB and are forced read-only by the server at 24 MiB.

```sh
pnpm wrangler d1 execute DB --remote --command \
  "SELECT id, title, oversized, length(plain_text) AS text_len FROM pages WHERE oversized = 1;"
```

The read-only flag lives in the Durable Object, not D1, and it is **sticky**: it is written as
`read_only = CASE WHEN ? THEN 1 ELSE read_only END`, so deleting content never clears it. Recovery is
to restore an earlier version through the owner-only History panel, which seeds a fresh epoch whose
read-only flag starts clear.

Prevention is better: the 16 MiB warning is broadcast to editors, and large pages should be split
before they reach it. Pages accumulate size from embedded images and long edit histories.

## Capacity review

| Resource      | Limit                              | Check                            |
| ------------- | ---------------------------------- | -------------------------------- |
| D1 database   | 10 GB                              | Cloudflare dashboard, D1 metrics |
| Document size | 16 MiB warn / 24 MiB read-only     | Query above                      |
| Table rows    | 20000 per table, enforced on write | Rejected with `table_row_limit`  |
| Attachments   | 10 MiB per upload                  | Rejected with `upload_too_large` |
| Connections   | 30 per document epoch              | Excess closed with `4429`        |
| Versions      | 30 days, 200 per page              | Pruned during compaction         |

Table reads are paged, so a table that grows past the write limit through an out-of-band
write still reads back correctly. Inserting table rows directly in D1 is still unwise: it
bypasses the lease and revision guards, so a concurrent editor's write can be lost.

## Load testing safely

Two hazards, both easy to trigger by accident.

`scripts/realtime-load.mjs` checks `/api/install` and **bootstraps the installation if it reports
uninitialized**. Pointing `NOTES_LOAD_BASE_URL` at an uninitialized production URL creates an owner
account with the credentials you supplied. Only run it against an installation that is already
bootstrapped, or against a disposable target.

The Playwright suite hardcodes `owner@example.test`, `password123`, and `e2e-bootstrap-token`. Although
`NOTES_E2E_BASE_URL` makes it technically possible to aim the suite at any origin, **never point it at
production.** It signs in, creates, and deletes content.

To run the realtime load check against a deployed environment:

```sh
NOTES_LOAD_BASE_URL=https://notes.example.com \
NOTES_LOAD_EMAIL=loadtest@example.com \
NOTES_LOAD_PASSWORD=... \
pnpm load:realtime
```

`NOTES_LOAD_CONNECTIONS` (default 30, valid 1–100) and `NOTES_LOAD_HOLD_MS` (default 5000) tune the run.

## Known gaps

- **No staging environment.** The top-level `wrangler.jsonc` configuration is production. The only
  named environment, `notes-checks-e2e`, is for the local Playwright harness. `nightly.yml` refers to a
  `STAGING_BASE_URL` repository variable, but nothing in this repository deploys such an environment.
- **`nightly.yml` holds live account credentials.** `STAGING_LOAD_EMAIL` and `STAGING_LOAD_PASSWORD`
  are real sign-in credentials for whatever `STAGING_BASE_URL` points at. Scope that account to the
  minimum role and never point it at production.
- **No application rate limiting.** The Worker never returns `429`. Bootstrap, invite acceptance, and
  sign-in must be protected by Cloudflare WAF rules; see [Deployment](DEPLOYMENT.md#4-configure-rate-limiting).
- **`/api/health` cannot identify the running revision.** Its `version` field is a hardcoded string.
  Use `pnpm wrangler deployments list`.
- **Durable Object placement is permanent.** A workspace's location hint is fixed at bootstrap and
  Durable Objects do not relocate after creation.
