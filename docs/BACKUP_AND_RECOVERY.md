# Backup and recovery

The system has three durable data planes:

- D1: accounts, sessions, workspace/page metadata, search projection, attachments, versions, and tables.
- R2: current document snapshots, immutable history snapshots, and attachments.
- Durable Object SQLite: the current post-snapshot Yjs update log and room manifest.

Normal document recovery loads the current R2 snapshot and replays ordered Durable Object SQLite chunks. R2 is deliberately never allowed to acknowledge/deletes those chunks after a failed snapshot write.

## Backup

Schedule D1 exports and R2 replication/copies according to the installation’s recovery objective. At minimum, before an upgrade:

```sh
pnpm wrangler d1 export DB --remote --output backup.sql
```

Use Cloudflare R2 tooling or an S3-compatible client to copy both `assets/` and `documents/`. Preserve object metadata.

Cloudflare does not expose a bulk user-managed export of each Durable Object’s SQLite database. Therefore an R2 copy can lag active editing by up to the 30-second compaction interval. Durable Object storage itself remains the primary recovery source for that tail. For a maintenance-window backup, stop writes, wait at least one compaction interval, confirm document versions/current objects were updated, then copy R2 and D1.

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

## Recovery validation

- Compare D1 workspace/page/member counts with the source export.
- Open representative documents from old and recent epochs.
- Verify current snapshot plus update replay converges in two clients.
- Download a full attachment and a byte range; compare ETag/size.
- Open version history and restore a disposable page.
- Acquire, renew, release, expire, and force-release a table lease.
