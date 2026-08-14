# Deployment

Cloudflare Realtime Notes targets Workers Paid. The application uses Workers Static Assets, D1, R2, and SQLite-backed Durable Objects.

## 1. Create resources

Authenticate Wrangler, then create one D1 database and two R2 buckets:

```sh
pnpm wrangler login
pnpm wrangler d1 create cloudflare-realtime-notes
pnpm wrangler r2 bucket create cloudflare-realtime-notes
pnpm wrangler r2 bucket create cloudflare-realtime-notes-preview
```

Replace the placeholder `database_id` in `wrangler.jsonc` with the returned D1 ID. Bucket names may be changed as long as the binding remains `BUCKET`.

## 2. Configure production values

Set `BETTER_AUTH_URL` in `wrangler.jsonc` to the final HTTPS origin. Add secrets:

```sh
pnpm wrangler secret put BETTER_AUTH_SECRET
pnpm wrangler secret put BOOTSTRAP_TOKEN
```

Use at least 32 random bytes for `BETTER_AUTH_SECRET`. Treat `BOOTSTRAP_TOKEN` as a one-time operator credential and rotate or remove it after the owner is created.

Optionally set `DO_LOCATION_HINT` to one of `wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `oc`, `afr`, or `me`. If omitted, bootstrap maps the initial request continent to a broad Cloudflare hint. The saved workspace hint is immutable in v1.

## 3. Migrate and deploy

```sh
pnpm build
pnpm db:remote
pnpm deploy
```

Open the deployment, bootstrap the owner, then verify `/api/health`. Do not expose the site publicly before the owner is created unless the bootstrap token is strong.

## Upgrade procedure

1. Export D1 and back up R2 as described in `BACKUP_AND_RECOVERY.md`.
2. Build and test the exact revision locally.
3. Apply additive D1 migrations before deploying code that requires them.
4. Deploy the Worker.
5. Test sign-in, page metadata, one document WebSocket, attachment range download, table lease, and version listing.

Durable Object migrations are append-only in `wrangler.jsonc`. Never rename or delete the `Document` class or `DOCUMENT` binding without a Cloudflare Durable Object migration plan.

## Production smoke checklist

- Better Auth cookies are Secure, HttpOnly, and same-origin.
- Direct `/api/auth/sign-up/email` returns `registration_closed`.
- A viewer can connect and read but cannot persist a crafted Yjs update.
- A hidden tab disconnects after 30 seconds and reconnects on visibility.
- A document restores after a Worker/DO restart.
- R2 failure leaves the DO update log intact.
- Idle connected rooms stop accruing billed duration in Cloudflare analytics.
- D1/R2/DO metrics and Worker structured logs are visible.

The last item must be measured on staging; Miniflare cannot prove billing behavior.
