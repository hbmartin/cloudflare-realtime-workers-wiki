# Deployment

NoteFlare targets Workers Paid for production capacity. The application uses Workers
Static Assets, D1, R2, and SQLite-backed Durable Objects.

Read [Configuration](CONFIGURATION.md) alongside this document; it is the reference for every value
named here.

Existing installations intentionally retain their `cloudflare-realtime-notes` Worker and resource
identifiers. These deployment names are compatibility details; the product presented to users is NoteFlare.

## 0. Prerequisites

- Node.js 22.18 or later in the Node 22 release line, or Node.js 24.2+, and pnpm 11.18.0.
- A **Workers Paid** plan, for production capacity rather than feature access. Workers Free caps
  requests at 100,000 per day and applies a tighter per-invocation CPU limit, and its Durable Object
  and D1 daily row limits are well below what an active workspace uses. SQLite-backed Durable Objects
  and cron triggers are both available on Free — the free plan offers only SQLite-backed Durable
  Objects, and allows 5 cron triggers per account against 250 on Paid — so a small evaluation
  installation does run there.
- R2 enabled on the account.
- Authenticated Wrangler: either `pnpm wrangler login`, or `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` in the environment.

An API token used for deployment needs Workers Scripts Edit, D1 Edit, R2 Edit, Workers Observability,
and account-level Durable Objects permissions.

## 1. Create resources

Authenticate Wrangler, then create one D1 database and two R2 buckets:

```sh
pnpm wrangler login
pnpm wrangler d1 create cloudflare-realtime-notes
pnpm wrangler r2 bucket create cloudflare-realtime-notes
pnpm wrangler r2 bucket create cloudflare-realtime-notes-preview
```

Bucket names may be changed as long as the binding remains `BUCKET`.

## 2. Configure the production environment

The top-level bindings in `wrangler.jsonc` are local-safe defaults. Remote commands and deployment use
the named `production` environment, which keeps account-specific values out of local development.

Set the production **`database_id`** to the ID returned by `d1 create`:

```jsonc
"env": {
  "production": {
    "d1_databases": [{ "binding": "DB", "database_id": "your-database-id" }],
  },
},
```

Set production **`BETTER_AUTH_URL`** to the exact HTTPS origin the installation will be served from.
Leave the top-level local value unchanged:

```jsonc
"env": {
  "production": {
    "vars": { "BETTER_AUTH_URL": "https://notes.example.com" },
  },
},
```

This is a plain variable, not a secret. It sets the Better Auth cookie origin _and_ is the allowlist the
`Origin` header is compared against on bootstrap, invite acceptance, and every WebSocket upgrade.
Leaving it unchanged breaks sign-in and causes `invalid_origin` on connection attempts.

The comparison is against this value, not against the hostname the request arrived on, so a Worker
reachable on more than one hostname — a `workers.dev` route left enabled alongside a custom domain —
serves the application only on the configured one. Requests carrying no `Origin` header are not
rejected; browsers always send one on the cross-origin requests this check exists to stop.

There is no `account_id` and no `routes` block in the configuration. The Worker deploys to the account
Wrangler is authenticated against and is served on `*.workers.dev` unless you attach a custom domain in
the Cloudflare dashboard under **Workers & Pages → your Worker → Settings → Domains & Routes**. If you
attach one, `BETTER_AUTH_URL` must match it exactly, including scheme and absence of a trailing slash.

## 3. Set secrets

```sh
pnpm wrangler secret put BETTER_AUTH_SECRET --env production
pnpm wrangler secret put BOOTSTRAP_TOKEN --env production
pnpm wrangler secret put WEBHOOK_ENCRYPTION_KEY --env production
pnpm wrangler secret put OBSERVABILITY_PROBE_TOKEN --env production
```

Use at least 32 random bytes for `BETTER_AUTH_SECRET`. Treat `BOOTSTRAP_TOKEN` as a one-time operator
credential and rotate or remove it after the owner is created.

Generate `OBSERVABILITY_PROBE_TOKEN` independently with at least 32 random bytes. Put the same value in
the GitHub `OBSERVABILITY_PROBE_TOKEN` Actions secret; it protects the dependency-aware readiness endpoint.

Generate `WEBHOOK_ENCRYPTION_KEY` as exactly 32 random bytes in unpadded base64url form, for example
with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`. It encrypts integration webhook
verification secrets at rest; webhook subscription creation and delivery are disabled when it is
absent or malformed.

When upgrading an installation that already has webhook subscriptions, preserve the existing AES key
by replacing the old arbitrary-string value with its SHA-256 digest in unpadded base64url form before
deploying this version:

```sh
printf %s "$CURRENT_WEBHOOK_KEY" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '='
```

Changing to unrelated key material makes existing verification tokens unreadable and requires those
subscriptions to be recreated.

`BETTER_AUTH_SECRET` is not only the session signing key. It is also the shared secret the Worker sends
as the `x-notes-internal` header when it calls a Durable Object directly, for archive, version restore,
and purge. Rotating it therefore invalidates every session _and_ briefly disrupts internal Durable
Object calls while the new value propagates. See
[Operations](OPERATIONS.md#rotating-better_auth_secret).

Optionally set `DO_LOCATION_HINT` to one of `wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `oc`, `afr`,
or `me`. If omitted, bootstrap maps the initial request continent to a broad Cloudflare hint. The saved
workspace hint is immutable in v1, and it is an optimization rather than a data-residency guarantee.

Slack is optional. Import `slack-app-manifest.yaml` in Slack, then set all four values before installing
from Workspace settings:

```sh
pnpm wrangler secret put SLACK_CLIENT_ID --env production
pnpm wrangler secret put SLACK_CLIENT_SECRET --env production
pnpm wrangler secret put SLACK_SIGNING_SECRET --env production
pnpm wrangler secret put SLACK_TOKEN_ENCRYPTION_KEY --env production
```

Use an independently generated high-entropy encryption key. If any value is absent, the application
keeps in-app notifications active and clearly reports Slack as unavailable.

Migration `0035_slack_secure_foundation.sql` retains the `account.issuer` column and index and
populates `issuer` on new accounts so the previous Better Auth 1.7.2 Worker remains compatible
between migration and deployment, and after a code-only rollback. Keep this compatibility until
that Worker is outside the rollback window. Deploy the Worker and additive D1 migration before
importing the updated manifest. Then have the
workspace owner use **Reauthorize Slack** once and confirm that Settings reports no missing bot scopes.
The bot install callback and Better Auth OpenID callback are intentionally separate. Reauthorization
must use the Slack team already bound to the NoteFlare workspace; changing teams requires a future
explicit reset flow. Slash search, unfurls, and personal notifications require verified Slack identities and their capability scopes.

## 4. Configure rate limiting

The `/v1` API uses `API_SOURCE_BURST_LIMIT` / `API_SOURCE_MINUTE_LIMIT` bindings before token lookup, keyed
by source IP or by caller zone for cross-zone Worker traffic. It then uses `API_BURST_LIMIT` /
`API_MINUTE_LIMIT` bindings per authenticated integration. These are declared
in `wrangler.jsonc`. The source limits are 300 requests per 10 seconds and 1,800 per minute; integration
limits are 100 per 10 seconds and 600 per minute. Both return a Notion-compatible `429` response. Browser
authentication is also limited in D1: password sign-in, signup, and two-factor routes allow three requests
per source IP every ten seconds, while failed password attempts share a normalized-account limit of ten per
15 minutes across source IPs. Install bootstrap and the work performed before invite authentication still
need edge protection. A dashboard rule for `/v1/*` can additionally reject abuse before Worker execution.

Add Cloudflare Rate Limiting rules before exposing the origin publicly. At minimum:

| Path                     | Suggested limit               |
| ------------------------ | ----------------------------- |
| `/api/install/bootstrap` | 5 requests per minute per IP  |
| `/api/auth/*`            | 20 requests per minute per IP |
| `/api/invites/accept`    | 10 requests per minute per IP |
| `/v1/*`                  | Tune to expected API traffic  |

These are configured in the Cloudflare dashboard, not in this repository.

## 5. Migrate and deploy

```sh
pnpm run deploy
```

Migrations must complete before the Worker is deployed. The Worker queries the projection, mention,
deletion-job, archive-disconnect, table-state, page-creation receipt, and page-move receipt tables on
ordinary request paths; deploying code that expects a migration which has not been applied produces
runtime failures rather than a clean startup error.

`pnpm run deploy` runs the full typecheck and production build, applies all pending D1 migrations,
then deploys the Worker. A failed build or migration stops the command before deployment. Already
applied migrations are skipped. Use this command for local releases; invoking `wrangler deploy`
directly bypasses the D1 migration step. CI also applies migrations before uploading the Worker; see
[Automated deployment](#automated-deployment).

`0001_initial.sql` is the squashed pre-production baseline. Files `0002` and later are forward-only
production migrations and must remain in order; never edit an applied migration or mark it applied by
hand. Before upgrading an existing installation, take a D1 export and stop any running Notion import,
then run `pnpm run deploy` to apply pending migrations before deploying the Worker that consumes the
new schema. `pnpm db:remote` remains available for a deliberate migration-only operation.

Remote releases with pending Slack migrations `0069`, `0070`, `0071`, `0072`, `0073`, `0074`, `0075`, `0076`, `0077`, or `0078` require
`SLACK_REVIEW_MIGRATION_SAFE=true` after the [Slack rollout pause](#slack-review-follow-up-migration).
This guard applies to both `pnpm db:remote` and `pnpm run deploy`; local database migrations do not
require confirmation. The confirmation acknowledges an operator-completed pause and drain, rather
than pausing consumers automatically.

Before an older database applies `0067_review_delivery.sql`, quiesce legacy digest scheduling and keep it
quiesced through migration application and the Worker rollout. `pnpm db:local` and `pnpm db:remote` run
`scripts/migrate-d1.mjs`, which checks the exact first-ten-page event assignments that 0067 will backfill.
CLI deployment and CI both use the guarded remote command. Overlapping pending receipts that assign the
same event stop the command before any migration is applied, with a collision count and at most 20 event
samples and 10 receipt IDs per sample. IDs are limited to 200 characters in the report. The guard performs
read-only queries and never repairs data. Export D1 and investigate reported receipt windows before retrying.
Already-upgraded databases and fresh databases without legacy receipt tables skip the collision query.
Existing migrations, including 0067, remain unchanged. Direct Wrangler migration application bypasses this guard.

Apply the additive `0068_slack_recovery.sql` before deploying this recovery update. It adds guarded virtual
receipt identities, indexes for receipt/retry and deadline lookups, separate claim rechecks, paused-operation
scope requirements, and channel-validation scope-failure bookkeeping. Existing history and payloads remain
intact. Production migration, deployment and feature activation are separate release actions.

The wrapper allows 60 seconds for migration listing and defaults to 300,000 ms **per preflight query**.
For a slower legacy database, pass `--preflight-timeout-ms` with a positive integer, for example
`pnpm db:remote --preflight-timeout-ms 600000` (or the same option with `pnpm db:local`). The wrapper reports
the failing stage and identifies `ETIMEDOUT` distinctly. Migration application inherits interactive output and
has no wrapper deadline, including time spent at Wrangler's confirmation prompt. Existing CI/job deadlines
still apply. The collision guard and quiescing requirements above remain in force.

For OAuth and MCP releases, apply `0062_oauth_mcp.sql`, `0063_oauth_staged_receipt_index.sql`,
`0064_oauth_cleanup_indexes.sql`, and `0065_mcp_workspace_generation.sql` in order before
deploying this Worker. Migration `0065` adds a workspace consent generation and a pending-code
index; it preserves existing grants and document content. Disabling MCP after deployment revokes
all workspace connections and pending authorization codes. Re-enabling MCP requires clients to
reconnect.

For the security lifecycle follow-up, apply `0029_security_lifecycle.sql` and then
`0030_security_review_followups.sql` before deploying the updated Worker. Migration `0030` is compatible
with the Worker released alongside `0029`, so both migrations can finish before the code rollout. It adds
expiring invitation claim leases, staged recovery-code storage, rate-limit retention indexing, stricter
invite-completion validation, and restore-order-safe account-security initialization.

`0005_import_reliability.sql` adopts existing multipart sessions as `active`, so uploads already in
progress remain recoverable. It also clears legacy bulk-write replay receipts because they have no
request hash and cannot safely distinguish a retry from reuse of the same request id with different
content. Newly hashed receipts are durable until their table is deleted; do not run an old importer
between applying `0005` and deploying the matching Worker, because it can create another unhashed
receipt in that window.

`0006_page_create_receipts.sql` introduces request receipts for client-addressed page creation without
backfilling existing pages, because a batch's original request grouping cannot be reconstructed.
`0007_page_create_receipt_lifecycle.sql` retains only receipts whose live page still exists in the same
workspace, reduces them to request hashes, and makes them cascade when that page is permanently deleted.
`0008_page_create_receipt_integrity.sql` constrains future receipts to the same workspace/page pair.
Pages without receipts continue to use the legacy live-metadata replay check, while active receipt
replays return current authoritative page metadata instead of a creation-time snapshot. Apply all three
migrations before deploying the Worker that reads or writes these receipts.

`0009_page_move_receipts.sql` adds operation-specific move receipts. Each receipt stores the committed
page snapshot so an uncertain client request can distinguish its own move from a later reorder of the
same page. Receipts cascade when their page or workspace is permanently deleted. Missing operation ids
from older browser bundles are generated by the Worker. `0010_page_move_receipt_retention.sql` indexes
receipt age so the scheduled Worker cleanup can prune entries after seven days. Apply `0009` before
deploying any Worker that handles page moves or serves move-receipt lookups; every move writes a receipt,
including moves from older browser bundles. Apply `0010` before deploying this Worker version: its
already-configured scheduled handler prunes receipts on every run, and the index prevents a full-table scan.
`0011_page_move_receipt_envelopes.sql` wraps receipts already written in the temporary bare-page format. For a
normal upgrade from a Worker that already reads both bare receipts and versioned envelopes, apply it with the
other migrations before deploying this Worker version. If the live Worker only reads bare receipts, first
quiesce page-move requests and keep them quiesced until both the migration and Worker deployment complete; the
migration can otherwise rewrite a receipt that the live Worker still needs to replay. A bridge release that
reads both formats while continuing to write bare receipts is an alternative when downtime is unacceptable.

This Worker writes explicitly versioned receipt envelopes but continues to read bare-page receipts during the
compatibility window. Record when the last deployed Worker capable of writing bare receipts is retired, keep
the fallback for at least the seven-day receipt-retention window after that time, and verify scheduled pruning is
healthy before removing it.

Before removing the fallback, run this against every production database. A non-zero count blocks removal. A
zero count is necessary but not sufficient: `0011` rewrites historical bare receipts, so the query does not
prove that every bare-writing Worker has retired or that the retention window has elapsed.

```sql
SELECT COUNT(*) AS bare_receipts
  FROM page_move_receipts
 WHERE CASE
         WHEN json_valid(response_json) THEN
           CASE
             WHEN json_type(response_json) = 'object' THEN
               json_type(response_json, '$.pageMoveReceiptVersion') IS NULL
             ELSE 0
           END
         ELSE 0
       END;
```

## 6. Bootstrap the owner

Open the deployment and complete the first-run screen, or call the API directly:

```sh
curl -s https://notes.example.com/api/install          # {"initialized":false}
```

Submit the workspace name, owner name, email, password, and `BOOTSTRAP_TOKEN` on the install screen.
Passwords must be at least 8 characters. There is no email verification and no password reset by
design; recovery means an owner revokes and reinvites the account.

Do not expose the site publicly before the owner is created unless the bootstrap token is strong.
Once the owner exists, rotate or remove the token:

```sh
pnpm wrangler secret delete BOOTSTRAP_TOKEN --env production
```

Deleting it is safe. `/api/install/bootstrap` returns `already_initialized` after the first successful
bootstrap regardless.

## 7. Verify

```sh
curl -i -s https://notes.example.com/api/health
curl -fsS -H "X-Observability-Token: $OBSERVABILITY_PROBE_TOKEN" \
  https://notes.example.com/api/health/ready
pnpm observability:check
```

Expect `ok:true`, a `deployment.id` matching the `X-Worker-Version` response header, and protected readiness
status `ready`. Readiness checks D1, R2, a read-only Durable Object request, cron freshness, and durable queues.
Compare the ID with `pnpm wrangler deployments list --env production`.

### Production smoke checklist

- Better Auth cookies are Secure, HttpOnly, and same-origin.
- Direct `/api/auth/sign-up/email` returns `registration_closed`.
- A viewer can connect and read but cannot persist a crafted Yjs update.
- A hidden tab disconnects after 30 seconds and reconnects on visibility.
- A document restores after a Worker or Durable Object restart.
- R2 failure leaves the Durable Object update log intact.
- Edits arriving during compaction remain dirty and are included by the next compaction.
- Rename or move a page in one browser and observe the other browser update without reload.
- Archive a page while its document room is unavailable, then confirm `archive_disconnect_targets` is
  eventually empty.
- Matching attachment `If-None-Match` returns a bodyless `304`; bounded, open-ended, and suffix ranges
  return correct lengths.
- Permanently delete a disposable multi-epoch page, then confirm `deletion_jobs` is empty, no unfinished
  `deletion_targets` remain, and its `documents/{pageId}/` prefix is empty.
- The scheduled handler runs successfully and no deletion jobs or unfinished targets remain.
- Idle connected rooms stop accruing billed duration in Cloudflare analytics.
- D1, R2, and Durable Object metrics and Worker logs are visible.
- Workers Traces contain D1, R2, Durable Object, and fixed `notes.*` custom spans.
- Analytics Engine contains each exercised event family and the next cron advances every
  `observability_task_runs.last_succeeded_at` value.
- A manual run of `.github/workflows/observability.yml` succeeds and writes a healthy summary.

The last item must be measured on a deployed account; Miniflare cannot prove billing behavior.

## Upgrade procedure

1. Export D1 with `pnpm db:export --remote` and back up R2, as described in
   [Backup and recovery](BACKUP_AND_RECOVERY.md). Confirm the export is non-empty before continuing;
   `wrangler d1 export` on its own fails on this schema.
2. Build and test the exact revision locally with `pnpm check`. CI runs a superset of the same gate on
   every push and the deploy workflow refuses to proceed unless it passed, so a failure here is a
   failure there.
3. Run `pnpm run deploy`, which builds, applies pending migrations, and then deploys the Worker.
   Confirm every migration in `migrations/` reports success before the Worker upload starts.
   The directory is the source of truth for what must be applied; do not rely on a list enumerated in
   documentation, which drifts.
4. Test sign-in, page metadata, document and workspace-event WebSockets, attachment range and
   conditional download, table lease acquisition, and version listing.

Durable Object migrations are append-only in `wrangler.jsonc`. Never rename or delete the `Document` or
`WorkspaceEvents` classes or their bindings without a Cloudflare Durable Object migration plan.

## Rollback

Rollback is asymmetric. Worker code is reversible; data schema is not.

| Change                          | Reversible                                                           |
| ------------------------------- | -------------------------------------------------------------------- |
| Worker code and assets          | Yes — `pnpm wrangler rollback` or the dashboard's deployment history |
| `vars` and secrets              | Yes — set the previous value                                         |
| D1 migrations                   | **No** — migrations are forward-only; there are no down migrations   |
| Durable Object SQLite schema    | **No** — applied inline on room start                                |
| Durable Object class migrations | **No** — append-only by design                                       |

To roll back a release that included a migration:

1. Stop writes if the schema change is destructive.
2. Restore D1 from the export taken in step 1 of the upgrade procedure, into a replacement database.
3. Point the `DB` binding at the restored database.
4. Deploy the previous revision.
5. Accept that Durable Object update logs are ahead of the restored D1 metadata. Documents converge on
   reconnect; page metadata does not. Verify page tree, membership, and version listings before
   reopening access.

If the release contained no migration, `pnpm wrangler rollback` alone is sufficient.

## Automated deployment

`.github/workflows/deploy.yml` deploys after successful CI for the current tip of `main`, and on a
manual `workflow_dispatch` after running `pnpm check`. There is no staging environment, so a bad
commit on `main` reaches users if its CI passes; the workflow applies D1 migrations before deploying,
matching the normal manual order above. Before applying migrations, the workflow lists the production
database's pending migrations. If `0011_page_move_receipt_envelopes.sql` is pending, an automatic run stops
before making changes. Quiesce page moves or verify that the live Worker already reads versioned receipts,
then use `workflow_dispatch` and check its page-move receipt migration confirmation. Keep requests quiesced
until that manually dispatched run has deployed the new Worker.

Pending `0069_slack_file_cleanup.sql`, `0070_slack_review_fences.sql`, `0071_slack_authorization_cleanup.sql`, `0072_slack_link_authorization_started_at.sql`, `0073_slack_membership_revocation.sql`, `0074_slack_enqueue_recovery.sql`, `0075_slack_delivery_recovery.sql`, `0076_slack_delivery_recovery_followup.sql`, `0077_slack_recovery_query_indexes.sql`, `0078_slack_delivery_recovery_repairs.sql`, or `0079_slack_verified_recovery.sql` also stop automatic deployment.
Follow the [Slack rollout pause](#slack-review-follow-up-migration), then manually dispatch with
`confirm_slack_review_migration_safe` checked. The workflow passes this confirmation to the guarded
remote migration command. Once these migrations are applied, later automatic releases need no Slack
confirmation.

It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository or environment secrets and
`PRODUCTION_BASE_URL` as a variable. The monitor additionally needs `CLOUDFLARE_OBSERVABILITY_TOKEN` and
`OBSERVABILITY_PROBE_TOKEN`; its Cloudflare token includes Workers Scripts Read so it can list current Workflow
instance states. Secrets set with `wrangler secret put --env production` are not
managed by the workflow; they persist across deploys and are set once, manually, per the steps above.

See [Continuous deployment](CONTINUOUS_DEPLOYMENT.md) for the gate's behavior, the credentials, the
optional manual-approval gate, how to switch to manual releases, and what Workers Builds, gradual
deployments, or a staging environment would trade instead. The workflow has not been exercised
against a live Cloudflare account in this repository; validate it on a throwaway Worker before
relying on it.

### Slack review follow-up migration

Apply additive `0069_slack_file_cleanup.sql` before deploying the Slack review follow-up. It snapshots
allocation ownership and adds an indexed cleanup ledger plus transactional capture triggers. Additive
`0070_slack_review_fences.sql` adds a monotonically increasing channel-validation revision.
`0071_slack_authorization_cleanup.sql` separates primary login from private Slack access, binds access and primary proofs to protection generations, records file-scope blocks and preserves explicit allocation ownership. It keeps existing links only for accounts with an enrolled factor, saved recovery codes and no recovery in progress; their original linking authorization cannot be established. Existing transient primary proofs are cleared, and proof reads reject older writes without authenticated-source metadata. `0072_slack_link_authorization_started_at.sql` separates the continuous access-grant start from verification and relink timestamps, preserving eligible earlier previews through unchanged relinking or legacy verification. It backfills only known timestamps; lost historical grant times are not reconstructed. `0073_slack_membership_revocation.sql` removes links without workspace membership and revokes workspace Slack links whenever a member is removed. Rejoining requires explicit relinking with a new access-grant start. Installation disconnect/reconnect still requires explicit relinking. OAuth login is preserved. Do not roll back to code that allows linking without fresh verification.

`0074_slack_enqueue_recovery.sql` adds persistent enqueue intent, repairs pending Activity rows damaged by
legacy recovery, and backfills missing share-response identities only from verified bindings authorized continuously
since before the accepted request. It requeues responses blocked solely by `request_identity_unavailable`.
Scope-paused, completed, sending, uncertain, and actively claimed work is preserved. Apply this migration before
the updated Worker, using the same queue pause and validation drain below.

`0075_slack_delivery_recovery.sql` and `0076_slack_delivery_recovery_followup.sql` remain historical migrations for
enqueue counters, cleanup cursors, and recovery indexes. The migration runner no longer reconstructs legacy share
identities or performs compatibility repairs outside migrations.

`0077_slack_recovery_query_indexes.sql` adds a partial index on pending, never-attempted digest children for orphan reservation discovery. It is an index-only forward migration; it does not backfill or revive work. Apply it under the same pause, disabled-validation, backup, 16-minute drain, deployment, and verification sequence below.

`0078_slack_delivery_recovery_repairs.sql` establishes missing recovery deadlines for already-enqueued Round 2-owned channel receipts, including legacy IDs on initialized mappings. It preserves completed/suppressed receipts, scope pauses, fresh claims, existing schedules, retry budgets, and explicit repair signatures. Apply it before deploying the Worker using the queue pause, validation disable, backup, and 16-minute drain sequence below. Verify the repaired rows before restoring flags and delivery.

`0079_slack_verified_recovery.sql` adds fixed-window history progress, installation/generation/method cooldowns,
and a partial recovery index beginning with `subscription_id`. It requires verified identity authorization and drops
the obsolete token table. It does not backfill, convert, or replay historical records. Historical migrations and
compatibility columns remain; the runtime no longer reads initialization or migration-state columns.

Slack recovery after these migrations is forward-only. Keep the queue paused and channel validation disabled
if migration or deployment fails, and repair the forward migration/deployment sequence before resuming delivery.
Do not deploy legacy Slack code that relies on the removed token table or permits linking without fresh
identity verification. The general code rollback procedure does not make that legacy code compatible.

Slack has not been deployed. Apply the full forward migration chain before its first deployment, keeping production
flags off until deployment is separately verified. Validation disabled holds all channel delivery; enabling it
resumes the saved backlog without spending another retry. Mapping revalidation runs independently when enabled.

Maintenance queues uncertain delivery, with at most one history page per invocation. Owner Verify and Repair each
process one batch of at most five receipts and five history calls within twenty seconds. Continue verification uses
a mapping token and fixed pass boundary. Uncertain sends remain incomplete through a 60-second settle window
from the send attempt without making history calls. After settling, the first scan fixes the search window;
incomplete searches retain that window, timestamp progress, and candidate match without a fixed total page cap.
Earlier incomplete searches whose upper bound does not extend beyond the settle window restart before scanning.
Permanent or ambiguous results block automatic polling; authentication and supported scope errors
pause recovery. Transient errors retain retry deadlines. Honor `retryAt` and persisted method cooldowns before
continuing. Never resend uncertain messages.

Inspect digest/bulk cleanup, recovery-stage failures, stranded counts, enqueue failures, and queue errors. Obsolete
installation-generation retirement uses `slack.delivery.retired` structured logging rather than a delivery failure
for every retired receipt.

`outbox.slack_enqueue_failure_count` drives enqueue backoff and persistent failure alerts;
`outbox.attempts` remains the scheduling version. A cached destination error preserves work until
revalidation; a fresh permanent destination failure retires unsent work in all three delivery modes.

Existing failed/retired allocations are backfilled; allocations whose original Slack identity cannot be verified
are reported for manual cleanup rather than deleted. Existing migrations remain unchanged.

When any of these migrations is pending, perform this sequence **before applying migrations**:

1. Pause the shared production delivery queue:

   ```sh
   pnpm wrangler queues pause-delivery cloudflare-realtime-notes-delivery --env production
   ```

2. In the live Worker's Cloudflare settings, set `SLACK_CHANNEL_VALIDATION_ENABLED` to `false` and
   apply the variable change using the currently deployed code. Keep it `false` in the release's
   production configuration too. This stops scheduled channel validation; the queue pause stops
   new thumbnail consumers. Other queued jobs and notifications wait, while page editing remains
   available. Record the intended Slack flags so they can be restored after verification.
3. Wait **16 minutes after both changes take effect** for existing queue and scheduled invocations
   to finish. The 60-second artifact claim expiry is not proof that an old consumer has stopped.
   The interval exceeds Cloudflare's documented
   [15-minute queue and cron invocation limit](https://developers.cloudflare.com/queues/platform/limits/).
4. Export D1, then either manually dispatch the release workflow with
   `confirm_slack_review_migration_safe` checked, or run:

   ```sh
   SLACK_REVIEW_MIGRATION_SAFE=true pnpm run deploy
   ```

   For separate migration and deployment commands, run
   `SLACK_REVIEW_MIGRATION_SAFE=true pnpm db:remote`, then build and deploy the new Worker while
   keeping the queue paused and channel validation disabled. Any pending page-move migration still
   requires its separate safety procedure.

5. Verify the deployed revision and readiness, then inspect Slack repair counts, remaining explicit
   candidates, enqueue-failure counts, overdue recovery deadlines, and cleanup records before restoring flags or queue delivery.
   Allow maintenance to repair recoverable damage while the flags remain disabled. Restore the intended Slack flags, synchronize configuration, and resume delivery:

   ```sh
   pnpm wrangler queues resume-delivery cloudflare-realtime-notes-delivery --env production
   ```

6. After recovery resumes, verify scope-pause wakes preserve share budgets, obsolete thumbnail allocations reach the existing cleanup ledger, and Slack delivery IDs and event timestamps show no duplicate sends. Use the existing recovery, scope, file-cleanup, and queue telemetry; investigate any growing overdue count before continuing the rollout.

If migration or deployment fails, leave the queue paused and channel validation disabled until
recovery is complete. Do not purge queued messages. Queue pause and resume use Cloudflare's
[delivery controls](https://developers.cloudflare.com/queues/configuration/pause-purge/); queue
messages remain subject to their normal retention period while paused. Operators need
[Queues Edit permission](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
for these controls in addition to the usual deployment credentials.

Use the existing 15-minute cron. Cleanup runs independently of delivery recovery and thumbnail flags,
with at most 25 candidates and two potentially effective or uncertain deletion attempts per file; definite 429 responses defer without consuming that budget. Validate partial OAuth grants,
saved repairs with blocked bulk receipts, unmute/expiry wakeups, and cleanup health notices in staging.
See [configuration and manual cleanup](CONFIGURATION.md#interactive-slack-workspace) for the
operator procedure. The guarded release may apply migrations and deploy in one run after the manual
pause and drain. Feature activation follows health verification; this change introduces no new flags
or cron schedule.
