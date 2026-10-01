# Phase 8: table views and core properties

Status: implementation pending. Requires Phase 7's Table Durable Object and verified D1 projection.

## User contract

Every table can have saved **Grid**, **Board**, and **Month calendar** views. A view saves its
name, type, selected grouping/date property, filters, sort order, visible columns, and owner or
shared visibility. Members with read access can switch views; editors can create and edit shared
views. All views show the same underlying rows and cells. Board columns group by one select or
status property, including an **Unassigned** column. Dragging a card to a column updates that
property. Calendar shows rows by one date property; rows without a date appear in an **Unscheduled**
list. Dragging an event to another day updates that chosen date while preserving its local time
and timezone. A failed drag restores the prior position and explains why.

Add multi-select, person, URL, status, created time/by, and last edited time/by properties to the
existing text, number, checkbox, date, and select types. Status has stable option IDs and one
value per row; multi-select has stable option IDs and a set of values; person stores member IDs,
allows more than one member, and renders a former member as a retained label without granting
access. URL accepts an absolute HTTP(S) URL and renders a safe external link. Created and edited
metadata are read-only and server-maintained. Empty values and deleted options have explicit
display states; property deletion warns about affected view filters and grouping.

## Interfaces and data flow

- Extend `ColumnType`, table validation, DO schema, and D1 projection with typed cells for the
  new properties. Represent multi-select and person values as bounded sorted ID arrays, not a
  comma-delimited string. Store status options with stable IDs, label, color, and order; renaming
  an option keeps row values. `created_at/by` is set once at row creation; `edited_at/by` changes
  on committed row mutations and is never client supplied. Import/export and Slack task paths
  receive explicit mappings for new types, with an unsupported-value error instead of coercion.
- Add view commands and reads to the table DO: list/create/update/delete view, query rows for a
  view, and `move_row` with `{operationId,rowId,viewId,targetOptionId|targetDate,
expectedCellRevision}`. The DO validates that the view's grouping or date column still exists,
  checks write permission, changes exactly one typed cell, and broadcasts the row delta. A
  revision conflict returns the current row so the client can restore it. View definitions have
  stable IDs and optimistic revisions; delete of the active view falls back to Grid.
- Define one filter AST shared by grid, board, and calendar: `and`/`or` groups with typed
  operators for equality, membership, contains, empty, and date comparisons. Sort has ordered
  property/direction clauses and a row-ID tie breaker. Validate depth and clause limits. Query
  over all matching rows, not only the loaded page; paginate with stable cursors and return group
  counts from the same revision. Board and calendar virtualization must handle the existing
  20,000-row table cap without fetching every card into the browser. Month navigation uses the
  viewer's display timezone; the stored date value and drag update use the property's timezone
  rule. Saved view filters/sorts apply identically in all three modes.
- Project new typed cells, option labels, and metadata into D1 for task/search/import/Slack
  consumers. Bump projection schema/version before enabling writes and require projection hash
  parity through Phase 7's repair flow. Store view definitions in DO storage and list them from
  the DO, without a second view index. Permission changes immediately affect view reads and drag
  commands, regardless of projection lag.

## Migration, rollout, and recovery

Backfill created/edited metadata from current `table_rows.created_at`, `updated_at`, and
`created_by`, leaving unknown editor IDs null rather than guessing. Preserve existing select
options and cell IDs. Migrate each table's DO schema idempotently, then the D1 projection, then
enable creation of new properties. Release saved Grid first, then Board and Calendar behind view
flags. A disabled view still leaves its definition and row values intact. If an option or date
column is removed, mark affected saved views invalid with a visible repair prompt and fall back
to Grid; do not silently retarget a different property. A failed projection can be rebuilt from
the DO snapshot and event log, as in Phase 7. Rollback to an older client must show unknown
properties read-only rather than overwrite them.

## Exit matrix

| Scenario                                                       | Required result                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Save, share, rename, and switch Grid/Board/Calendar            | Stable view definition; same row values across views                           |
| Board drag to status/select and Calendar drag across month/DST | One typed cell change; all clients and D1 projection converge                  |
| Filter and sort on each new property across 20,000 rows        | Complete matching set, stable pagination and group counts                      |
| Concurrent drag and option/property deletion                   | Conflict or repair prompt; no row silently moved to wrong value                |
| Re-run type/backfill migration or rebuild projection           | Original IDs and metadata preserved; DO/D1 hashes match                        |
| Read-only member, revoked space access, forged metadata write  | No unauthorized view edit, cell edit, or metadata change                       |
| View API retry, stale cursor, invalid filter                   | Stable receipt or explicit validation/conflict; no partial view or cell update |
