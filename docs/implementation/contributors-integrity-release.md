# Contributors, document validation and integrity release

This increment adds authenticated contributor capture, page information, native editor table compatibility and read-only integrity checks. It is local implementation work until the release evidence records an implementation SHA, deployment SHA and production migration results. See the [release ledger](release.md) for the complete increment sequence and closeout requirements.

The implementation is first-party code. Outline `b4bef2c0141c73ba260040bbbdba3ee1add6d752` provided behavior references; its BSL code was not copied. The applicable source restrictions are recorded in [third-party notices](../../THIRD_PARTY_NOTICES.md).

## Document write boundary and stable table identity

[Document validation](../../src/shared/document-validation.ts) checks complete candidate trees against the supported headless ProseMirror schema. HTTP block mutations, content replacement, import or template initialization and version restore normalize table structure and validate the resulting tree before publishing a Yjs update. A rejected candidate returns `422` with `invalid_document` and creates no mutation receipt. Restore validation precedes closing connections or advancing the content epoch.

Validation covers block IDs, supported nodes and marks, scalar attributes, table spans and consistent row geometry, tab structure, footnote containers and status attributes. Structural bounds include 250,000 nodes and depth 64. Dangling footnote references remain readable for recovery. Native table cells accept automatic column widths represented by zero.

Legacy Notion API tables used nested block containers for rows. Normalization converts those rows into editor-native `tableRow` children while preserving their original IDs in `apiRowId`. Virtual API row blocks resolve through this attribute, retaining existing `api_blocks` mappings across conversion, updates, append and compaction. Native cell content uses `tableParagraph`; header cell types remain meaningful. Invalid row geometry is rejected before a mutation becomes visible.

CRDT WebSocket updates continue to be durably recorded. Complete-tree HTTP validation does not pretend to reject every possible malformed binary CRDT update. Recovery and integrity inspection can read the persisted evidence, and compaction reports invalid structures without inventing repairs.

## Schema reader capability gate

Clients advertise a comma-separated `editorCapabilities` query parameter on the collaboration connection. The server checks features present in the current document before accepting writes. The initial capability set is:

- `native-tables-v1`
- `tabs-v1`
- `footnotes-v1`
- `status-badges-v1`
- `linked-table-views-v1`
- `diagram-links-v1`

A client missing a required capability becomes read-only and receives `document-schema-upgrade` with the required capabilities. This requirement is recalculated after updates, so a collaborator introducing a new feature protects it from older clients already connected. Unknown stored document node types also prevent unsupported clients from writing. Diagram link attributes require capability support even when their stored value needs recovery.

Deploy capable readers before enabling `EDITOR_BLOCKS_V2_ENABLED`. Disabling insertion does not erase existing features or reopen old-client writes.

## Attribution durability and compatibility

[The document Durable Object](../../src/worker/document.ts) records the set of authenticated authors represented by each merged update flush. Its SQLite transaction writes the author array together with the existing update chunks and idempotency receipts. Author state is cleared only after persistence succeeds. No changes are made to the legacy scalar primary editor semantics.

Compaction captures contributor IDs and their first and last observed update timestamps through a fixed update sequence before awaiting external writes. It writes the page revision and contributor ledger in the same guarded D1 batch. Updates arriving during compaction remain available for the next pass. A separate durable version-author accumulator survives ordinary compactions until a saved version commits, so all observed authors in the saved interval are retained. The accumulator is cleared only through the committed version's sequence.

[Migration 0083](../../migrations/0083_page_contributors.sql) adds page and version contributor records, a tracking-start timestamp and checkpoint contributor arrays. Historical backfill uses only retained evidence: creator, last editor and saved version editor. It cannot reconstruct authors whose update events were already compacted away. Contributor identities survive account deletion and resolve to “Former collaborator” when a current display name is unavailable.

[Migration 0089](../../migrations/0089_contributor_events.sql) carries additive contributor arrays through workspace activity, Slack channel events and checkpoint-backed personal digests. Activity and notification responses resolve current display names; channel and personal digest summaries include captured coauthors. Coalesced events retain the union of the authors from the updates they represent. Personal edit notices exclude every author captured for that update. Existing `actorId`, `actorName`, event IDs, checkpoint IDs and digest coverage semantics remain intact. Legacy single-actor events receive a supported singleton fallback.

Attribution describes authenticated uploaders. An offline Yjs payload uploaded under one account may contain operations created under another account; the existing protocol has no authenticated per-operation author evidence. The API reports this boundary as `contributorAttribution: "authenticated_uploaders"`.

## Page information API

`GET /api/pages/:id/info` requires current page access and rechecks access after reading. Its response contains:

| Field                            | Meaning                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `id`, `createdAt`, `updatedAt`   | Current page metadata; times are milliseconds                                                |
| `createdBy`, `lastEditedBy`      | Existing creator and primary editor identities, with display names                           |
| `contributors`                   | Up to 50 `{id, name, firstEditedAt, lastEditedAt}` entries                                   |
| `nextCursor`                     | Sealed continuation bound to user, workspace and page; expires after 15 minutes              |
| `contributorHistorySince`        | Contributor tracking migration timestamp                                                     |
| `contributorHistoryComplete`     | Whether the page was created after tracking began                                            |
| `contributorAttribution`         | `authenticated_uploaders`                                                                    |
| `wordCount`, `wordCountComplete` | Word count from indexed plain text; null for tables, incomplete at the projection text bound |

Contributors sort by last observed edit descending, then ID. Pagination follows changing current observations rather than a historical snapshot. Saved version responses add contributor identities while retaining `lastEditorId`.

## Read-only integrity contracts

[The shared metadata evaluator](../../src/shared/integrity.ts) is used by the owner API and the deployment script. It checks workspace and space scope, revisions, ancestors and cycles, row-detail ownership, import source roles and attachment metadata. Legitimate roots, archived pages, templates, staged imports and generated import artifacts receive explicit classifications.

`GET /api/admin/integrity` is owner-only. Metadata batches contain at most 100 pages; stored-content batches contain at most five. Sealed cursors are bound to the user, workspace and inspection mode and expire after 15 minutes. The scan compares workspace revision fingerprints across batches. Findings from every batch must be retained; the final batch alone does not establish a successful workspace scan.

Content inspection reads committed R2 snapshots and projections without requesting a room flush or waking a document Durable Object. It checks identity, epoch and sequence, object size and hash, document structure, snapshot-to-projection parity and canonical page references. Diagrams also compare their stored Yjs snapshot to the diagram projection and validate page and saved-view references. Version and attachment objects are checked for existence and size. Untouched empty pages with sequence zero need no initialized snapshot; unpublished import staging has no committed content contract.

Tables are checked from their persisted D1 projection: state revision, authority transition status, projected revision consistency, normalized property names, option ownership and uniqueness, cell row/property scope, typed values and scalar-to-JSON mirror consistency. The checker does not contact a live table authority to certify its private SQLite state. Formula execution and table authority parity require the separate table closeout evidence.

Bounds are explicit. A content object larger than 10 MiB, more than 2,000 canonical references, more than 100 versions per page, excessive attachments or table collections, an unavailable read, or a changed revision reports incomplete coverage. It cannot return success. A table inspection permits at most 200 columns, 2,000 rows, 2,000 options and 10,000 cells within its value-size bound. Larger tables require a future paginated content inspection contract.

## Operator procedure and verification

Deployment invokes the read-only metadata checker before and after migrations, using the configured Cloudflare credentials and D1 query adapter. No owner session is required for these deployment checks. Fresh empty databases are supported; optional legacy tables are identified in `supportedTables`. Unsupported core schemas and truncated metadata reads cannot pass. Integrity checks never repair content, roll back migrations or modify migration history.

The standalone metadata command is:

```sh
node scripts/integrity.mjs --metadata --remote --env production
```

For a local database, use `--local` with the same configuration and persistence directory as migration tooling. The owner content command uses `INTEGRITY_BASE_URL` and `INTEGRITY_SESSION_COOKIE` from a private environment:

```sh
node scripts/integrity.mjs --content
```

The script follows every cursor, accumulates all findings and verifies exact page coverage. A hard failure or incomplete result exits unsuccessfully. Keep session cookies out of command arguments, logs and release artifacts.

Focused acceptance covers atomic multi-author capture, version accumulation across compactions, compaction failure recovery, page access and sealed cursors, historical coverage, invalid-tree rejection without receipts, stable native row API mappings, unsupported client writes, coauthor activity and personal digest data, and channel digest authors. Integrity tests cover bounded and stale scans, metadata cycles, no live flush, missing artifacts, canonical references, table corruption and diagram parity. Record the complete CI and production evidence in the [release ledger](release.md); local tests alone do not establish production acceptance.
