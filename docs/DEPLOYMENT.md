# Deployment

NoteFlare targets Workers Paid for production capacity. The application uses Workers
Static Assets, D1, R2, and SQLite-backed Durable Objects.

Read [Configuration](CONFIGURATION.md) alongside this document; it is the reference for every value
named here.

Existing installations intentionally retain their `cloudflare-realtime-notes` Worker and resource
identifiers. These deployment names are compatibility details; the product presented to users is NoteFlare.

## Browser deployment

The portable deployment implementation is integrated on `main`. The native GitHub authorization and five editor-flow acceptance checks remain pending; the README deploy button is available as a preview. See [deployment evidence](evidence/ONE_CLICK_DEPLOYMENT_VERIFICATION.md#remaining-release-gate).

For a new installation, use Cloudflare's native
[Deploy to Cloudflare flow](https://developers.cloudflare.com/workers/platform/deploy-buttons/).
Account authorization, Workers Paid activation, and R2 activation are user steps. The application
requires no terminal commands or manual resource-ID editing in this flow.

1. Connect GitHub and Cloudflare and choose a repository, Worker name, D1 database, R2 bucket,
   delivery queue, and dead-letter queue in the deployment form. Cloudflare provisions the resources.
2. Leave `BETTER_AUTH_URL` as `auto`. Supply only `BOOTSTRAP_TOKEN`, labeled as the private **setup
   key**, with at least 32 random characters. Keep this key in a password manager.
3. Keep the detected `pnpm run build` and `pnpm run deploy` commands. Preparation resolves the
   authenticated account and Worker settings before Vite captures the configuration. It uses an
   existing exact HTTPS origin or derives `https://<worker>.<account-subdomain>.workers.dev` from
   Cloudflare's authenticated account API. Incoming request hosts never determine the auth origin.
4. Deployment applies migrations before uploading code, verifies `/api/health` and `/api/install`,
   and prints the installation URL. Open it, enter the setup key, create the owner, enroll an
   authenticator or passkey, and save recovery codes.
5. Delete `BOOTSTRAP_TOKEN` in the Worker's **Settings → Variables and Secrets** after owner setup.
   Redeployment does not recreate a removed setup key after initialization.

An uninitialized installation receives independent 32-byte `BETTER_AUTH_SECRET`,
`WEBHOOK_ENCRYPTION_KEY`, and `OBSERVABILITY_PROBE_TOKEN` values only when those secrets are missing.
Generated values travel with the Worker upload in an owner-readable temporary secrets file that is
removed after success or failure. They are never written to generated configuration or build metadata.
Existing secrets are preserved without reading their values. If an initialized installation is missing
`BETTER_AUTH_SECRET`, deployment stops: restore its original value from your secret backup before
retrying. Automatic replacement would invalidate sessions and internal authentication.

New portable installations enable expanded embeds, offline editing, block links, live diagram embeds,
and diff digests. Notion Markdown, workspace activity, Slack rollout flags, permissions, and owner
settings retain their existing defaults. Slack, AI connections, and custom domains can be configured
later.

### Portable updates and custom domains

Push an update to the repository Cloudflare created, or use **Retry deployment** after correcting a
failed build. Workers Builds prepares once, builds once, then verifies the build UUID, revision,
source, target, and generated configuration before migrating and uploading. Its ignored
`.wrangler/noteflare-build.json` metadata must belong to the current run. Retry reuses resource bindings
and already-applied migrations. Saved dashboard variables, including feature settings, are retained.

For a custom domain, attach it under **Settings → Domains & Routes** and set the Worker's
`BETTER_AUTH_URL` plaintext variable to that exact HTTPS origin (no path or trailing slash), then
redeploy. The portable template's `auto` value preserves this saved origin. An explicit HTTPS origin
in the repository overrides `auto`; keep the repository and dashboard in agreement. Secrets remain
Worker secrets and do not need to be copied into the repository or build settings.

Operators redeploying a portable installation from a local checkout use `pnpm deploy:one-click`;
ordinary local `pnpm build`, `pnpm deploy`, and `pnpm deploy:production` still select the named legacy
`production` environment. In Workers Builds, an explicit `CLOUDFLARE_ENV` takes precedence; otherwise
an existing Worker is recognized as legacy production only when its Worker identity and D1 binding
both match that environment. `WRANGLER_CI_OVERRIDE_NAME` selects the actual Worker name. Do not enable
both GitHub Actions and Workers Builds as independent production release systems.

### Fresh installs and upgrade safeguards

The migration wrapper accepts `--config` so migration and upload use the same Vite-generated
configuration. It skips upgrade-only quiescence confirmations only if `0001_initial.sql` is pending,
there are no application tables, and no migrations have been recorded. Only known D1/SQLite internal
tables are ignored. Unexpected tables, applied history with a pending baseline, malformed query
results, and failed queries stop deployment before upload.

Every other database retains page-move and Slack migration confirmations and digest-collision
preflights. No deployment helper sets those confirmations automatically. SQL files and ordering are
unchanged; follow the upgrade procedures in [Upgrading](UPGRADING.md) before retrying a guarded upgrade.

### Native-button release checklist

The README button is available as a preview. Complete this checklist before removing the preview
status: test a disposable deployment with Cloudflare's default authorization and package-manager
launcher. Verify owner creation, MFA, collaborative editing,
attachment upload, export, and each of the five enabled editor features. Then remove the setup key,
create content, change a feature setting, and redeploy. Confirm the resource bindings, origin, secret
names, owner, content, and saved feature settings persist. Validate the existing GitHub Actions
production selection and release gate separately. Dry runs alone do not satisfy this release check.

## Existing production deployment

The following manual path and GitHub Actions release gate continue using the named `production`
environment and its original resources, URL, flags, and Durable Object migration tags.

## 0. Prerequisites

- Node.js 22.22.2+ in the Node 22 release line, 24.15+ in the Node 24 release line, or 26+; and pnpm 11.18.0.
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

The top-level bindings in `wrangler.jsonc` are portable installation defaults; Vite supplies a localhost
origin during local development. Ordinary local deployment commands use the named `production`
environment, which retains its account-specific resources.

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

**Existing installation:** read [Upgrading and rollback](UPGRADING.md) before deployment, including pending receipt and Slack pause/drain prerequisites. Fresh databases use the narrowly verified preflight described above.

```sh
pnpm run deploy
```

This command selects named legacy production locally, builds, applies guarded D1 migrations, then uploads the Worker. A build or migration failure stops deployment. Applied migrations are skipped. Direct `wrangler deploy` bypasses D1 migration safeguards. For a portable installation, use `pnpm deploy:one-click` or its configured Workers Builds flow instead.

## 6. Bootstrap the owner

Open the deployment and complete the first-run screen, or call the API directly:

```sh
curl -s https://notes.example.com/api/install          # {"initialized":false}
```

Submit the workspace name, owner name, email, password, and setup key (`BOOTSTRAP_TOKEN`) on the install screen.
Enroll an authenticator or passkey and save recovery codes before entering the workspace.
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

## Automated deployment

`.github/workflows/deploy.yml` deploys after successful CI for the current tip of `main`, and on a
manual `workflow_dispatch` after running `pnpm check`. There is no staging environment. Passing CI makes the current `main` revision eligible; guarded migrations and workflow failures can still prevent deployment. The workflow applies D1 migrations before uploading code, matching the manual order above. Before applying migrations, the workflow lists the production
database's pending migrations. If `0011_page_move_receipt_envelopes.sql` is pending, an automatic run stops
before making changes. Quiesce page moves or verify that the live Worker already reads versioned receipts,
then use `workflow_dispatch` and check its page-move receipt migration confirmation. Keep requests quiesced
until that manually dispatched run has deployed the new Worker.

Pending `0069_slack_file_cleanup.sql`, `0070_slack_review_fences.sql`, `0071_slack_authorization_cleanup.sql`, `0072_slack_link_authorization_started_at.sql`, `0073_slack_membership_revocation.sql`, `0074_slack_enqueue_recovery.sql`, `0075_slack_delivery_recovery.sql`, `0076_slack_delivery_recovery_followup.sql`, `0077_slack_recovery_query_indexes.sql`, `0078_slack_delivery_recovery_repairs.sql`, or `0079_slack_verified_recovery.sql` also stop automatic deployment.
Follow the [Slack rollout pause](UPGRADING.md#slack-review-follow-up-migration), then manually dispatch with
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
deployments, or a staging environment would trade instead. Successful named-production deploy records are in the [status audit](evidence/documentation-audit-2026-10-12.md). They do not establish every optional integration or the portable native-form gate.
