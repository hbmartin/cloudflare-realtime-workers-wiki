# Backup and recovery

The system has three durable data planes:

- D1: accounts, sessions, workspace/page metadata, search/reference/mention projections, mention read cursors, deletion jobs, attachments, versions, and tables.
- R2: current document snapshots, immutable history snapshots, and attachments.
- Durable Object SQLite: the current post-snapshot Yjs update log and room manifest; workspace event rooms contain no authoritative page state.

Normal document recovery loads the current R2 snapshot and replays ordered Durable Object SQLite chunks. Incoming updates are merged and flushed after a 1–5 second debounce. Compaction clears the dirty flag it owns before external writes, deletes only log sequences captured by that compaction, and re-dirties the room after any failed R2/D1 write.

## Backup

Schedule D1 exports and R2 replication/copies according to the installation’s recovery objective. At minimum, before an upgrade:

```sh
pnpm wrangler d1 export DB --remote --output backup.sql
```

Use Cloudflare R2 tooling or an S3-compatible client to copy both `assets/` and `documents/`. Preserve object metadata.

Cloudflare does not expose a bulk user-managed export of each Durable Object’s SQLite database. Therefore an R2 copy can lag active editing by up to the 30-second compaction interval. Durable Object storage remains the primary recovery source for its flushed tail. A process crash inside the configured five-second debounce can lose the server’s in-memory copy; connected browsers retain local Yjs state in IndexedDB and resynchronize it. For a maintenance-window backup, stop writes, wait at least one compaction interval, confirm document versions/current objects were updated, then copy R2 and D1.

## Recovery cases

### Restore metadata and objects

1. Deploy the same application revision and migrations.
2. Import the D1 export into an empty replacement D1 database.
3. Restore R2 keys without changing them.
4. Point bindings at the restored resources.
5. Verify attachment authorization and current/history snapshot reads before enabling edits.

### Restore one document to a prior version

Use the owner-only History panel. Restore retires and closes the old epoch, saves a final pre-restore version when a current snapshot exists, seeds a fresh epoch from the selected snapshot, and atomically advances page metadata. Old browser IndexedDB data is never merged into the new epoch.

### R2 current snapshot missing

Do not delete or recreate the Durable Object. Its SQLite update log may still contain the authoritative tail or complete state. Restore the missing R2 key from backup if available, then reconnect and allow compaction. Escalate before manipulating DO storage.

### Attachment object missing

Restore the exact `r2_key` from backup. D1 authorization metadata is intentionally separate. If it cannot be recovered, delete the attachment record through the application so users no longer receive a broken link.

### Permanent deletion cleanup is incomplete

Permanent deletion removes page metadata and commits a D1 cleanup job before returning `202`. Each document epoch Durable Object has its alarm canceled and is purged with `storage.deleteAll()` before the job deletes exact attachment keys and complete `documents/{pageId}/` prefixes. Inspect `deletion_jobs` and unfinished `deletion_targets`; the hourly cron retries them idempotently with backoff. Do not remove a job manually unless every target has been independently verified. Pages deleted before this queue existed cannot be enumerated if no D1/R2/operator identifier remains; use operator records to seed targeted cleanup.

### Archived editors remain connected

Archiving commits page metadata and an `archive_disconnect_targets` row before contacting each document room. The page disappears from clients immediately; the hourly cron retries any room that could not be closed. Inspect `archive_disconnect_targets.last_error` and allow the retry to finish, or restore the page to cancel its pending target.

## Recovery validation

- Compare D1 workspace/page/member counts with the source export.
- Open representative documents from old and recent epochs.
- Verify current snapshot plus update replay converges in two clients.
- Download a full attachment and a byte range; compare ETag/size.
- Revalidate that attachment with `If-None-Match` and require a bodyless `304`.
- Verify backlinks, mention inbox counts/read cursors, and page previews for an authorized member.
- Open version history and restore a disposable page.
- Acquire, renew, release, expire, and force-release a table lease.
- Confirm `deletion_jobs` is empty, no `deletion_targets` rows have `completed_at IS NULL`, and deleted page prefixes are empty in R2.
- Confirm `archive_disconnect_targets` is empty after archive-disconnect retries have run.
