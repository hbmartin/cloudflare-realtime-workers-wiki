# Phase 7: collaborative table authority

Status: not started. Round 2 candidate; must ship before new table views or property types.

## User contract

Two permitted members can edit different rows, cells, columns, and task-list entries at the same
time. Changes appear live in both browsers with a clear saved or retrying state. The 60-second
single-editor lease and force-unlock control disappear after cutover. If two members edit the
same cell concurrently, the server orders their operations and both see the resulting value and
revision; a stale conditional edit gets a conflict with the current value, never silent loss.
Bulk imports and Slack task actions use the same rules as browser writes. A temporary projection
failure must not make a committed edit vanish from the editor.

## Authority, interfaces, and data flow

- Add one Table Durable Object per table page. Its transactional storage holds schema, options,
  rows, typed cells, row order, revision, and operation receipts. Commands are
  `{operationId,actor,expectedRevision?,kind,payload}` with bounded bulk sizes matching
  `src/shared/table-limits.ts`. The Worker checks current member and space permissions before
  forwarding; the DO revalidates a short-lived signed actor assertion and current page state
  before commit. The DO owns ordering and broadcasts revisioned deltas over a table WebSocket.
  Clients reconnect with a revision and fetch a snapshot if the delta window expired. The
  per-table maximum remains 20,000 rows unless capacity tests justify another limit.
- Move `/api/tables/:pageId` reads and all table write routes through the DO, preserving current
  response shapes where possible and replacing lease tokens with operation IDs and revisions.
  Route `/api/task-lists/:pageId/tasks` and updates through the same command service. A row-detail
  page remains a D1 page: allocate its ID before the DO command, then use an idempotent page
  publication receipt so retries neither orphan a page nor create two task rows. Deletion and
  archiving follow the same receipt pattern.
- Keep D1 `table_state`, `table_columns`, `table_select_options`, `table_rows`, and `table_cells`
  as a read projection for task queries, search, import/export, Slack workflows, and legacy
  integrations. After each DO commit, append a durable projection event with table ID, revision,
  operation ID, and full changed entity payload. A single per-table projector applies events to
  D1 in order and records `projected_revision`; duplicate events are harmless. Readers needing
  current data wait for a requested revision or use the DO snapshot. Background consumers can
  tolerate measured lag but must not treat projected D1 as write authority. Search and Slack
  content links still perform live page permission checks.
- Expose a verification endpoint/metric comparing DO revision and canonical content hash with
  D1 projection revision/hash. A repair job can rebuild D1 rows, cells, columns, and options from
  an immutable DO snapshot in batches, then replay later events and atomically advance the
  projected revision. Keep row IDs and option IDs stable so task detail links and imports survive.

## Idempotent migration and lease retirement

Add a `table_authority` registry with `d1`, `seeding`, `do`, and `repairing` states, generation,
seed revision/hash, projected revision, and cutover time. For each table, fence new D1 writes by
generation, take a stable D1 snapshot using the existing `table_state` revision guard, seed the
DO with original IDs and values, and compare count/hash. If D1 changed before the fence, restart
the seed; if interrupted, resume by table ID and generation without duplicate rows. Switch the
registry to `do` only after both hashes match and the projector can apply a test event. A retry
of the migration is a no-op when the same generation/hash is already active.

During mixed rollout, old clients are read-only on migrated tables and receive an update prompt;
they cannot acquire a lease. Nonmigrated tables continue under the current lease path until
individually cut over. After all writers, including `tasks.ts`, import, and Slack, route through
the DO and projection lag stays within the agreed service bound (target: 60 seconds under normal
load), remove lease acquisition/renewal/force-unlock endpoints and D1 lease guards. Keep the
lease table for one release for rollback inspection, then drop it in a later migration. A DO
outage makes migrated tables temporarily read-only; never reopen D1 writes against a newer DO
generation. Recovery restores the DO from its durable storage and replays projection events.

## Exit matrix

| Scenario                                              | Required result                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Two browser writers on different and same cells       | Both see ordered revisions; conditional conflict reports current value                   |
| Duplicate command, lost response, WebSocket reconnect | One effect per operation ID; snapshot/delta converges                                    |
| Re-run seeding or interrupt cutover after any step    | Original IDs/count/hash preserved; one active authority                                  |
| Kill projector, commit edits, then rebuild D1         | Editor retains committed data; task/search/import/Slack reads recover to DO hash         |
| Task creation, row detail archive, Slack task action  | No orphan/duplicate row-detail page; current permissions enforced                        |
| Old client and expired lease during cutover           | Old client cannot write migrated table; no lease-based writer remains                    |
| Existing table and task API clients                   | Read shape and error contracts retained or versioned; writes return revision and receipt |
