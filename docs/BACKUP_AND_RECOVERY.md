# Backup and recovery

The system has three durable data planes:

- D1: accounts, sessions, workspace/page metadata, search/reference/mention projections, mention read
  cursors, deletion jobs, attachments, versions, and tables.
- R2: current document snapshots, immutable history snapshots, and attachments.
- Durable Object SQLite: the current post-snapshot Yjs update log and room manifest; workspace event
  rooms contain no authoritative page state.

Normal document recovery loads the current R2 snapshot and replays ordered Durable Object SQLite
chunks. Incoming updates are merged and flushed after a 1–5 second debounce. Compaction clears the
dirty flag it owns before external writes, deletes only log sequences captured by that compaction, and
re-dirties the room after any failed R2/D1 write.

## Recovery point objective per plane

| Plane                       | Worst-case loss                                           | Mitigation                                                                          |
| --------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| D1                          | Everything since the last export                          | Export on a schedule matching your objective                                        |
| R2 current snapshots        | Up to the 30-second compaction interval                   | The Durable Object log holds the tail                                               |
| R2 attachments and versions | Written synchronously; no lag                             | —                                                                                   |
| Durable Object SQLite       | Up to the 5-second save debounce, on a process crash only | Connected browsers hold local Yjs state in IndexedDB and resynchronize on reconnect |

Cloudflare does not expose a bulk user-managed export of each Durable Object's SQLite database. The
Durable Object remains the primary recovery source for its own flushed tail, and an R2 copy can lag
active editing by up to one compaction interval.

## Backup

Schedule D1 exports and R2 replication or copies according to the installation's recovery objective.
At minimum, before an upgrade:

```sh
pnpm db:export --remote --output backup.sql
```

Use `pnpm db:export`, not `wrangler d1 export` directly. D1 refuses to export a database containing a
virtual table:

```
D1 Export error: cannot export databases with Virtual Tables (fts5)
```

`page_search` is an FTS5 index, so a plain export exits 1 and writes nothing. Every authoritative table
is ordinary, and the index is derived from `pages`, so the script exports the real tables by name and
leaves the index to be rebuilt on import. It discovers the table list from `sqlite_master` on each run,
so a migration that adds a table needs no change here.

Use Cloudflare R2 tooling or an S3-compatible client to copy both `assets/` and `documents/`. Preserve
object metadata.

### Maintenance-window backup

For a consistent copy rather than a best-effort one:

1. Stop writes by removing access at the edge. Demoting members does not work: `prevent_final_owner_demotion`
   refuses to demote the last owner, and an established WebSocket keeps the role it was granted at
   connection time regardless of any later change.
2. Wait for connections to lose write access — up to the 5-minute connection grant — then one compaction
   interval of 30 seconds plus the 5-second save debounce. The alarm closes each connection when its
   grant expires; confirm no connections remain before continuing.
3. Confirm document versions and current snapshot objects were updated, by checking `updated_at` on the
   affected pages and the modification time of the `documents/{pageId}/epochs/{epoch}/current.bin`
   objects.
4. Export D1 with `pnpm db:export`.
5. Copy R2 `assets/` and `documents/`.
6. Restore write access.

Skipping step 2 produces a copy that is inconsistent across planes: D1 metadata from one moment and
Durable Object state from another.

A process crash inside the five-second debounce can lose the server's in-memory copy; connected
browsers retain local Yjs state in IndexedDB and resynchronize it.

## Recovery cases

### Restore metadata and objects

1. Deploy the same application revision and migrations.
2. Import the D1 export into an **empty** replacement D1 database. The export carries its own
   `CREATE TABLE` statements and the `d1_migrations` rows, so do not apply migrations first — the import
   would collide with the tables they create.

   ```sh
   pnpm wrangler d1 execute DB --env production --remote --file backup.sql
   ```

3. Rebuild the search index. The export omits `page_search` because D1 cannot export a virtual table,
   and nothing else reconstructs it:

   ```sh
   pnpm wrangler d1 execute DB --env production --remote --command \
     "CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(
        page_id UNINDEXED, workspace_id UNINDEXED, title, body, tokenize = 'unicode61');
      DELETE FROM page_search;
      INSERT INTO page_search (page_id, workspace_id, title, body)
      SELECT id, workspace_id, title, plain_text FROM pages WHERE archived_at IS NULL;"
   ```

   Archived pages are deliberately excluded, matching what compaction maintains. Search returns nothing
   until this runs; every other feature works without it.

4. Restore R2 keys without changing them.
5. Point bindings at the restored resources.
6. Verify search, attachment authorization, and current/history snapshot reads before enabling edits.

### Restore one document to a prior version

Use the owner-only History panel. Restore retires and closes the old epoch, saves a final pre-restore
version when a current snapshot exists, seeds a fresh epoch from the selected snapshot, and atomically
advances page metadata. Old browser IndexedDB data is never merged into the new epoch.

This is also the remedy for a document that has latched into server-enforced read-only at 24 MiB: the
new epoch starts with a clear flag. See [Operations](OPERATIONS.md#document-size-and-the-sticky-read-only-flag).

### R2 current snapshot missing

Do not delete or recreate the Durable Object. Its SQLite update log may still contain the authoritative
tail or complete state. Restore the missing R2 key from backup if available, then reconnect and allow
compaction. Escalate before manipulating Durable Object storage.

### Attachment object missing

Restore the exact `r2_key` from backup. D1 authorization metadata is intentionally separate. If it
cannot be recovered, delete the attachment record through the application so users no longer receive a
broken link.

### Permanent deletion cleanup is incomplete

Permanent deletion removes page metadata and commits a D1 cleanup job before returning `202`. Each
document epoch Durable Object has its alarm canceled and is purged with `storage.deleteAll()` before the
job deletes exact attachment keys and complete `documents/{pageId}/` prefixes.

Inspect `deletion_jobs` and unfinished `deletion_targets`; the hourly cron retries them idempotently
with backoff capped at 16 hours. Because only 10 jobs drain per tick and the first retry is a full hour
out, a job that looks stuck may simply be waiting — check `next_attempt_at` before intervening.

Do not remove a job manually unless every target has been independently verified. Pages deleted before
this queue existed cannot be enumerated if no D1, R2, or operator identifier remains; use operator
records to seed targeted cleanup.

### Archived editors remain connected

Archiving commits page metadata and an `archive_disconnect_targets` row before contacting each document
room. The page disappears from clients immediately; the hourly cron retries any room that could not be
closed. Inspect `archive_disconnect_targets.last_error` and allow the retry to finish, or restore the
page to cancel its pending target.

## Recovery validation

- Compare D1 workspace/page/member counts with the source export.
- Open representative documents from old and recent epochs.
- Verify current snapshot plus update replay converges in two clients.
- Download a full attachment and a byte range; compare ETag/size.
- Revalidate that attachment with `If-None-Match` and require a bodyless `304`.
- Verify backlinks, mention inbox counts/read cursors, and page previews for an authorized member.
- Open version history and restore a disposable page.
- Acquire, renew, release, expire, and force-release a table lease.
- Confirm `deletion_jobs` is empty, no `deletion_targets` rows have `completed_at IS NULL`, and deleted
  page prefixes are empty in R2.
- Confirm `archive_disconnect_targets` is empty after archive-disconnect retries have run.

## Restore drill

Rehearse this on a disposable page before you need it. It exercises every plane.

1. Create a page, add several paragraphs and one image attachment.
2. Wait 30 seconds so compaction writes a current snapshot, then confirm the R2 object exists under
   `documents/{pageId}/epochs/1/`.
3. Edit again and immediately check that the page still opens correctly in a second browser — this
   proves snapshot-plus-log replay.
4. Open History, restore the earlier version, and confirm the old connection closes with `4410` and the
   client follows the new epoch.
5. Confirm the attachment still downloads, including a byte range and a conditional `If-None-Match`
   returning a bodyless `304`.
6. Archive the page, confirm it disappears from the tree, then confirm `archive_disconnect_targets`
   drains to empty.
7. Permanently delete it, then confirm `deletion_jobs` empties, no `deletion_targets` remain with
   `completed_at IS NULL`, and the `documents/{pageId}/` prefix is gone from R2.

Queries for steps 6 and 7 are in [Operations](OPERATIONS.md#inspecting-the-work-queues). Step 7 may
take up to an hour if the first cleanup attempt fails.
