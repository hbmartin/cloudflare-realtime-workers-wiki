# Deployment

Cloudflare Realtime Notes targets Workers Paid for production capacity. The application uses Workers
Static Assets, D1, R2, and SQLite-backed Durable Objects.

Read [Configuration](CONFIGURATION.md) alongside this document; it is the reference for every value
named here.

## 0. Prerequisites

- Node.js 22 or later and pnpm 11.18.0.
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
```

Use at least 32 random bytes for `BETTER_AUTH_SECRET`. Treat `BOOTSTRAP_TOKEN` as a one-time operator
credential and rotate or remove it after the owner is created.

`BETTER_AUTH_SECRET` is not only the session signing key. It is also the shared secret the Worker sends
as the `x-notes-internal` header when it calls a Durable Object directly, for archive, version restore,
and purge. Rotating it therefore invalidates every session _and_ briefly disrupts internal Durable
Object calls while the new value propagates. See
[Operations](OPERATIONS.md#rotating-better_auth_secret).

Optionally set `DO_LOCATION_HINT` to one of `wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `oc`, `afr`,
or `me`. If omitted, bootstrap maps the initial request continent to a broad Cloudflare hint. The saved
workspace hint is immutable in v1, and it is an optimization rather than a data-residency guarantee.

## 4. Configure rate limiting

The application performs no rate limiting of its own. It never returns `429`. `/api/install/bootstrap`,
`/api/invites/accept`, and `/api/auth/*` sign-in are all unthrottled at the application layer, which
makes the bootstrap token and member passwords brute-forceable without external protection.

Add Cloudflare Rate Limiting rules before exposing the origin publicly. At minimum:

| Path                     | Suggested limit               |
| ------------------------ | ----------------------------- |
| `/api/install/bootstrap` | 5 requests per minute per IP  |
| `/api/auth/*`            | 20 requests per minute per IP |
| `/api/invites/accept`    | 10 requests per minute per IP |

These are configured in the Cloudflare dashboard, not in this repository.

## 5. Migrate and deploy

```sh
pnpm build
pnpm db:remote
pnpm deploy
```

Migrations must complete before the Worker is deployed. The Worker queries the projection, mention,
deletion-job, archive-disconnect, table-state, page-creation receipt, and page-move receipt tables on
ordinary request paths; deploying code that expects a migration which has not been applied produces
runtime failures rather than a clean startup error.

`pnpm deploy` runs `pnpm build` again, which runs the full typecheck. To deploy from CI instead, see
[Automated deployment](#automated-deployment).

`0001_initial.sql` is the squashed pre-production baseline. Files `0002` and later are forward-only
production migrations and must remain in order; never edit an applied migration or mark it applied by
hand. Before upgrading an existing installation, take a D1 export and stop any running Notion import,
then run `pnpm db:remote` before deploying the Worker that consumes the new schema.

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
receipt age so the hourly Worker cleanup can prune entries after seven days. Apply `0009` before
deploying any Worker that handles page moves or serves move-receipt lookups; every move writes a receipt,
including moves from older browser bundles. Apply `0010` before deploying this Worker version: its
already-configured scheduled handler prunes receipts on every run, and the index prevents a full-table scan.
This Worker writes explicitly versioned receipt envelopes but continues to read the temporary bare-page
format. Keep that compatibility fallback for at least the seven-day receipt-retention window after every
deployed Worker writes envelopes, and verify hourly pruning is healthy before a future Worker removes it.
No bulk receipt rewrite is required for this deployment.

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
curl -s https://notes.example.com/api/health
```

Expect `{"ok":true,"version":"0.1.0","time":"..."}`. Note that `version` is a hardcoded string, not a
build identifier, so this endpoint confirms the Worker is up and D1 is reachable but **cannot tell you
which revision is live**. Use `pnpm wrangler deployments list --env production` for that.

The health check probes D1 only. It returns `ok` during a complete R2 or Durable Object outage.

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
- The hourly scheduled handler runs successfully and no deletion jobs or unfinished targets remain.
- Idle connected rooms stop accruing billed duration in Cloudflare analytics.
- D1, R2, and Durable Object metrics and Worker logs are visible.

The last item must be measured on a deployed account; Miniflare cannot prove billing behavior.

## Upgrade procedure

1. Export D1 with `pnpm db:export --remote` and back up R2, as described in
   [Backup and recovery](BACKUP_AND_RECOVERY.md). Confirm the export is non-empty before continuing;
   `wrangler d1 export` on its own fails on this schema.
2. Build and test the exact revision locally with `pnpm check`. CI runs a superset of the same gate on
   every push and the deploy workflow refuses to proceed unless it passed, so a failure here is a
   failure there.
3. Run `pnpm db:remote` and confirm every migration in `migrations/` reports success before deploying.
   The directory is the source of truth for what must be applied; do not rely on a list enumerated in
   documentation, which drifts.
4. Deploy the Worker.
5. Test sign-in, page metadata, document and workspace-event WebSockets, attachment range and
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
matching the manual order above.

It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository or environment secrets and
`PRODUCTION_BASE_URL` as a variable. Secrets set with `wrangler secret put --env production` are not
managed by the workflow; they persist across deploys and are set once, manually, per the steps above.

See [Continuous deployment](CONTINUOUS_DEPLOYMENT.md) for the gate's behavior, the credentials, the
optional manual-approval gate, how to switch to manual releases, and what Workers Builds, gradual
deployments, or a staging environment would trade instead. The workflow has not been exercised
against a live Cloudflare account in this repository; validate it on a throwaway Worker before
relying on it.
