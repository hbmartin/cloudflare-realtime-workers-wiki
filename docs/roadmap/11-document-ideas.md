# Phase 11: Block links, live diagrams, and document diff digests

Status: merged and deployed at audited `b61dfbd`; release controls and live exit acceptance are tracked in the [roadmap](README.md) and [audit evidence](../evidence/documentation-audit-2026-10-12.md).

## Increment 1: Private block links

`BLOCK_LINKS_ENABLED` enables Copy link to block in editor block actions, plus a native keyboard-accessible Block
actions control for viewers. The existing page URL carries `#block=<encoded BlockNote ID>`. IDs and serialization
are preserved. Navigation handles first load, same-page fragments, and history; changing pages discards stale block
targets. Collapsed ancestors expand through BlockNote's local toggle state. Highlighting respects reduced motion.
Missing targets have an explicit notice; offline misses request reconnection instead of claiming deletion. Clipboard
failure leaves a selectable URL. Native editor and text-input context menus remain available. Connectivity changes
retry only unresolved targets; confirmed missing targets stop observing document edits. Permission checks remain the normal page checks; public shares stay static.

## Increment 2: Whole-diagram live embeds

`LIVE_DIAGRAM_EMBEDS_ENABLED` upgrades existing linkedDiagram blocks and retains their saved props and picker.
The lazy React Flow view reuses diagram node and edge rendering, fits on initial sync, pans by drag, and offers zoom,
Fit, and Open diagram. Wheel events continue scrolling the document. It has no diagram editing controls.

Only visible embeds in foreground tabs subscribe. Duplicate references share one room per account and current epoch;
the last visible subscriber releases it. Metadata refresh reconnects restored epochs. An optional `mode=read` reduces
an authorized diagram connection to viewer even for an owner. The embed reads only after authoritative sync and
never initializes shared diagram metadata. Offline views retain in-memory content; initial loads use the authorized
thumbnail. Denial clears live records. Public shares and export rendering retain the thumbnail path.

## Increment 3: Document comparisons in existing digests

`DIFF_DIGESTS_ENABLED` captures immutable projection references in the same D1 transaction as document projection
publication. Migration `0081` adds checkpoints, recipient eligibility, frozen delivery references, and retryable
projection cleanup. Exact coverage begins at the current projection; there is no reconstruction from periodic versions.
Watch eligibility is recorded independently of unread notification coalescing, with actor exclusion and live access.
Channel digest edit events retain exact checkpoint references even when immediate notifications coalesce.

The shared comparison matches stable IDs, compares own content separately from children, and distinguishes additions,
removals, modifications, and moves. Cosmetic marks/colors/layout are ignored. Link destinations, attachments, formulas,
Mermaid source, and linked-page properties participate. Digests provide counts and at most three excerpts, capped at
240 Unicode characters per before/after value. History uses this same engine and displays changed blocks alongside the full saved-version text before restore.

Personal email, personal Slack, and mapped channel digests keep current preferences, schedules/timezones, actor
exclusion, subscriptions, mappings, mute/snooze rules, departure notices, open-work summaries, and delivery claims.
Selected checkpoint pairs are frozen in receipts before sending. Inputs missing, expired, or larger than 2 MiB each
fall back to the existing summary with an explicit unavailable notice. Slack sections/messages are bounded after
escaping; compact summaries and comparison links remain when all excerpts cannot fit.
Personal diff digests select up to forty item groups, including at most ten retained document comparisons. The
existing delivery cursor advances only through processed recipients, stopping before a candidate exceeds the tick budget. One busy page occupies one slot regardless of its edit count. Its frozen range
covers every qualifying checkpoint before the existing timezone cutoff; successful delivery consumes that range
without consuming edits that arrive during delivery. The original notification delivery timestamps are updated in
that same transaction so checkpoint expiration cannot resurface an already delivered change.
Candidate costs include comparison queries in the existing D1
statement budget. Personal Slack splits comparisons into sections bounded after escaping, with no second escape.
Mapped Slack windows that include document edits without retained checkpoints use the summary fallback for that
page; a partial retained window is never presented as a complete comparison.

The authenticated comparison endpoint validates page ownership of both checkpoints, order, retention, and current
read access, then rechecks access after R2 reads. Digest URLs use compareFrom/compareTo to open History. Current
surviving blocks have block links; removed content is available only in the comparison. Retention is 30 days.
Checkpoint cascades enqueue retryable R2 cleanup on permanent deletion, alongside existing page-prefix cleanup.
Migration `0082` changes digest suppression to recipient primary-key lookups and indexes delivery outbox/channel
lookups. Finalization consumes only explicit IDs from claimed receipts and indexed page/time ranges. Malformed
personal comparison JSON is repaired under the delivery claim; valid frozen pairs remain unchanged.

Cleanup keeps checkpoints for all documents for 30 days. Each leased invocation removes up to five ordered batches
of 100 expired checkpoints and ten batches of 100 GC keys, with a 30-second work budget. GC checks current and
retained projection references with indexes, deletes unreferenced R2 objects in bulk, and leaves failed deletions
retryable. Backlogs continue through the existing delivery queue using `documentChangesCleanup`; the 15-minute cron
recovers interrupted work. Cleanup logs report deleted checkpoints, examined/deleted projections, continuation, and
the oldest expired checkpoint instead of counting all retained rows.

Mapped Slack edit events use the activity trigger when activity is enabled and direct fanout otherwise. Coverage
accepts both checkpoint-backed IDs, including already pending duplicates. Each delivery invocation reuses the
comparison for a page/checkpoint pair while repeating current access checks before dispatch. Slack display text is
escaped separately from URL targets, so underscores in page and block IDs survive.

## Release and deployed exit matrix

Review/release these increments independently in order; enable one control at a time. Do not mark shipped until its
live rows pass. Production pilot messages require an explicitly selected real email recipient and test Slack mapping.
No pilot messages or production deployment are part of the local validation run.

| Area          | Required deployed evidence                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Block links   | Nested collapsed targets, viewer keyboard controls, clipboard failure, deleted and offline targets, same-page fragments, browser history, reduced motion                                |
| Live diagrams | Second-browser edits, write rejection for an editor's read connection, local viewport without shared updates, duplicate/offscreen/hidden connection counts, restore and permission loss |
| Comparison    | Adds/removals/edits/moves/nesting, meaningful custom props, cosmetic changes, edit/revert, restoration across epochs                                                                    |
| Delivery      | Personal email/Slack and mapped Slack, timezone boundaries, unread coalescing, concurrent edits, frozen retries, permission loss, oversized/missing/expired fallback                    |
| Cleanup       | Thirty-day expiration, referenced baseline survival, permanent deletion, retry after R2 failure                                                                                         |
| Matrix        | Full Chromium, Firefox, WebKit and mobile Chromium suite, then repository checks                                                                                                        |

Monitor document.comparison.unavailable/fallback/pruned logs and R2 retained projection storage. Use existing client
connection telemetry and integration/delivery failure metrics for embeds and digests. Disable the relevant flag on
regression; migrations and existing serialized blocks remain compatible.
