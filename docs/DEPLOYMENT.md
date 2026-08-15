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
3. Run `pnpm db:remote` and verify both `migrations/0004_realtime_knowledge_cleanup.sql` and `migrations/0005_archive_disconnects.sql` complete before `pnpm deploy`; this Worker requires its projection, mention, deletion-job, and archive-disconnect tables.
4. Deploy the Worker.
5. Test sign-in, page metadata, document and workspace-event WebSockets, attachment range/conditional download, table lease, and version listing.

Durable Object migrations are append-only in `wrangler.jsonc`. Never rename or delete the `Document`/`WorkspaceEvents` classes or their bindings without a Cloudflare Durable Object migration plan. The hourly `0 * * * *` cron is required: it retries document-room disconnects left by archive and independently tracked Durable Object/R2 targets left by permanent deletion.

## Production smoke checklist

- Better Auth cookies are Secure, HttpOnly, and same-origin.
- Direct `/api/auth/sign-up/email` returns `registration_closed`.
- A viewer can connect and read but cannot persist a crafted Yjs update.
- A hidden tab disconnects after 30 seconds and reconnects on visibility.
- A document restores after a Worker/DO restart.
- R2 failure leaves the DO update log intact.
- Edits arriving during compaction remain dirty and are included by the next compaction.
- Rename or move a page in one browser and observe the other browser update without reload.
- Archive a page while its document room is unavailable, then confirm `archive_disconnect_targets` is eventually empty.
- Matching attachment `If-None-Match` returns a bodyless `304`; bounded, open-ended, and suffix ranges return correct lengths.
- Permanently delete a disposable multi-epoch page, then confirm `deletion_jobs` is empty, no unfinished `deletion_targets` remain, and its `documents/{pageId}/` prefix is empty.
- The hourly scheduled handler runs successfully and no deletion jobs or unfinished targets remain.
- Idle connected rooms stop accruing billed duration in Cloudflare analytics.
- D1/R2/DO metrics and Worker structured logs are visible.

The last item must be measured on staging; Miniflare cannot prove billing behavior.
