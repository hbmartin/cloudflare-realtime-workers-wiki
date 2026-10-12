# Phase 9 review-fix evidence

Local implementation and verification, 2026-10-02. Production release controls remain off. No remote migration,
deployment, Slack installation change, or production activation was performed.

## Review increments

| Increment                     | Scope                                                                                                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery and recovery         | Forward migration 0067; claim ownership, sending checkpoints, authentication/scope handling, uncertain-post reconciliation, and private thumbnail upload phases.                                                                                |
| Digests, Activity and bulk    | Durable partitions of at most ten pages; exact event membership; late-event continuation; Activity eligibility/context; import suppression; one title-free bulk summary per channel, including overlapping mappings.                            |
| Slack settings, shares and UI | Legacy destination/event compatibility; destination state reset; explicit configuration sync; revoked-share replacement; refreshed previews; channel picker reset; workspace/archived Activity choices; persistent scoped paste status.         |
| DOCX and imports              | Package main-part resolution; validated-entry Mammoth adapter; unique image budget; XML sanitation; explicit breaks/tabs; merged cells; list/image ordering; title origin marker; layout traversal; Markdown delimiter and Slack label repairs. |
| Cleanup and documentation     | Shared format capabilities, lightweight MIME metadata and lazy conversion; OAuth query consolidation and deterministic rate-limit boundary; corrected deployment variables, flags and roadmap status.                                           |

Related changes sometimes precede their consuming increment so later changes have their required schema and metadata.
The cumulative branch is the implementation to review and release.

## Earlier local verification

- The full `pnpm check` gate passed with 1,471 unit tests and 943 Worker tests against current `main`. It covers formatting, lint, middleware Semgrep rules/tests, all TypeScript projects, unit and
  Worker coverage, dead-code analysis, binding type generation, the production build and the Worker deployment dry run.
- Chromium: all three `slack-round2.spec.ts` scenarios passed, including refreshed Activity, real cross-space/archived departure filters, and mapping picker reset.
- Chromium built-app tests: all three paste/paragraph scenarios passed, including preservation of the mounted live
  region and rejection of a stale paste choice.
- A final delivery/queue regression run passed 214 tests; the final Activity unit run passed all four tests.
- Targeted regression runs exercised migration of existing receipts/artifacts, real task DELETE receipt replay,
  missing scope/authentication during validation, competing/stolen claims, permission changes during lookup, digest
  partitions at 0/10/11/25 pages, late events, bulk summaries across both cadences, rollback, revoked public-share
  replacement, private upload recovery, and DOCX/Markdown/Slack import compatibility.
- The generated Worker entry dispatches DOCX import/export with dynamic imports of a separate `assets/docx-*.js`
  chunk. Mammoth, DOCX and HTML-parser conversion code is absent from the entry's eager dependency path. DOCX export
  retrieves the document without building discarded Markdown/HTML serializations.

## DOCX memory measurement

A standalone Node benchmark compared the pre-fix converter with the validated-entry adapter. Both used the independent
`rich-text.docx` fixture plus 32 MiB of random unused ZIP media, producing a 32.795 MiB upload. Each variant ran in a
fresh process three times with the same fixture and a 1 GiB heap limit. Peak RSS came from
`process.resourceUsage().maxRSS`; this includes loaded libraries and the input, rather than measuring only conversion
allocations.

| Converter | Peak RSS samples (MiB) | Median peak RSS (MiB) | Median conversion time (ms) |
| --------- | ---------------------- | --------------------- | --------------------------- |
| Before    | 192.78, 197.52, 194.75 | 194.75                | 517.19                      |
| After     | 197.70, 201.58, 201.30 | 201.30                | 505.04                      |

This fixture does **not** demonstrate a peak-RSS reduction. The adapter removes the duplicate upload Buffer and
Mammoth's second ZIP-reader path, and repeated images now share one asset/budget entry; those structural improvements
should not be presented as a measured Worker memory saving. Worker peak memory and CPU still require representative
live import measurements.

## Remaining live verification

Before activation, apply forward migrations in the deployment process, configure a valid IANA default timezone,
run the owner channel-validation report, then call `POST /api/slack/configuration/sync`. Keep activation separate from
this implementation. Verify the Phase 9 live exit matrix with real Slack public/private channels, reconnect and
permission recovery, rate limits and lost responses, private diagram files, bulk summaries and multi-message daily
windows. Check exported DOCX fixtures in Word and a compatible independent reader, and measure realistic Worker
import memory/CPU. Retain the existing scopes and private thumbnail policy.

## Accepted review follow-up

The follow-up implements the 17 accepted findings without changing HTTP interfaces, database schemas or migration history. `ActivityView.archiveRefreshVersion` is the only component interface addition.

The final follow-up `pnpm check` passed against the working tree on 2026-10-02: **1,482 unit tests passed** (one existing test skipped) and **979 Worker tests passed** across 20 files. Formatting, lint, middleware Semgrep rules/tests, all TypeScript projects, both coverage gates, dead-code analysis, generated Worker bindings, the production build and the Worker deployment dry run passed. The final focused authentication, HTTP mutation and thumbnail recovery run also passed all 23 selected cases. Worker line coverage was 82.49% and branch coverage was 71.41%.

All work and checks were local. Production flags remain off; no remote migration, deployment or feature activation was performed.

Bulk moves and archives retain the deliberate cadence exception: one summary sends immediately for both immediate and digest mappings. Their events remain in Activity and are excluded from scheduled digests. Existing bulk tests for both cadences and overlapping mappings remain in place.

Regression coverage exercises:

- Canonical channel names on unchanged destinations, legacy manual names, four installation authentication failures during delivery and validation followed by reauthorization, preservation of unrelated channel blocks, mute and snooze settings, and outbox enqueueing after share and mapping HTTP mutations, including a changed channel destination.
- Shared digest eligibility for receipt reopening and page selection: access loss, bulk summaries, mirrored threads, templates, staged imports, mapping scope, cadence and reserved events. Sent and skipped receipts remain completed across repeated scheduler ticks; events remain recorded. An eligible late event recreates the outbox on the first tick and appends exactly one partition.
- All eight thumbnail flag combinations across selection, consumption, redrive and delivery; disabled markers survive and recover after enabling. Expired obsolete uploads retire after disconnect or generation change, live claims survive, uncertain message receipts survive, and disabled uploads do not cause sweep continuation.
- A task root archived after its child was independently archived; Activity choices after archive, restore and deletion; current-record precedence; superseded archive responses; preservation of the last successful list on failure; and a stale-activity test that waits for its actual deferred request.
- Malformed DOCX relationship and content-type paths returning `422 invalid_docx`, all XML 1.0 invalid control ranges and lone surrogates, formatted code and hard breaks checked against the actual editor schema, distinct Slack label branches and imported link marks, and existing Notion URL policies using the shared control check.
- Existing delimiter compatibility tests plus homogeneous, escaped and mixed runs up to 512 KiB, with text and nearby formatting assertions. Unit tests have no timing thresholds.

### Delimiter benchmark

Standalone local Node runs used Vite's module runner to load the original `HEAD` implementation and the working tree implementation, with warmup and the median of three samples. The original long-run workload was repeated; additional paragraphs exercised the opening-run boundary adjustment directly.

| Workload                                                             | Before median (ms) | After median (ms) |
| -------------------------------------------------------------------- | ------------------ | ----------------- |
| One 512 KiB homogeneous run                                          | 554.57             | 548.69            |
| One paragraph with a 4,000-character opening run                     | 6.08               | 0.52              |
| One paragraph with an 8,000-character opening run                    | 11.83              | 0.63              |
| 64 paragraphs with 8,000-character opening runs (512,000 delimiters) | 1,134.79           | 42.21             |

## Remaining review follow-up

This local follow-up preserves the preceding commit's fixes, HTTP response shapes, component interfaces,
database schema and every existing migration. Slack Connect page previews remain **deferred**; this change
does not address the shared-channel preview finding. Bulk moves and archives still send one immediate,
title-free summary for both cadences and stay out of scheduled digests.

Final verification on 2026-10-02 after rebasing onto current `main`: **`pnpm check` passed**, with
**1,518 unit tests passed** (one existing test skipped) and **1,024 Worker tests passed** across 20 files.
Formatting, lint, middleware Semgrep checks,
all TypeScript projects, both coverage gates, dead-code analysis, generated binding verification, production
build and the Worker deployment dry run passed. Worker line coverage was **82.94%** and branch coverage
was **71.66%**. An earlier coverage run hit five local runtime timeouts; all eight selected archive/comment
cases passed on rerun, followed by the successful full gate. No test timeout or coverage threshold was changed.

- Digests with 95 unchanged open pages produce one message. Unchanged open work fills unused first-message
  slots only. Changed pages continue in ten-page partitions; frozen retries retain their selected pages and
  eligible late events append change-only partitions. Scheduler ticks preserve pending backoff and counters.
- Consumers and redrive share receipt classification. Suppressed unsent events complete recovery; live claims
  and uncertain sends retain evidence. Paused/blocked work is excluded before the 50-receipt runnable limit.
  Eight successful redrive enqueues exhaust retryable work, including duplicate continuation outbox rows for
  the same receipt. Queue enqueue failures do not consume the budget. Confirmed current or legacy digest
  progress resets it; acknowledgements and reauthorization preserve these receipt counters while legacy scope
  recovery retains its existing reset. Exhaustion records
  delivery health and retires unsent work. Suppressed uncertain channel sends reconcile without reposting.
- Authentication remains installation-level. Missing scope pauses work without adding mapping blocks.
  Reauthorization clears legacy scope blocks and unpauses affected queued work only with the scopes required
  by enabled features. Thumbnails without upload scope remain paused rather than permanently failing. Validation
  clears legacy message-size blocks and wakes eligible retained work, preserving unrelated blocks, mute and
  snooze settings. Oversized channel, bulk and digest deliveries fail independently and record delivery health.
- Each thumbnail attempt renders once and obtains a fresh allocation sized to those bytes. Rejected URLs
  and uncertain completions replace stale private allocations under the artifact claim; abandoned files are
  deleted best-effort. The existing flag gates, claim fencing and eight-attempt limit remain covered.
- Ordinary archives and cross-space moves count active descendants for mutation classification. Archived
  descendants still move where required. HTTP coverage distinguishes ordinary and genuine bulk operations,
  verifies membership-completion enqueueing, and checks one sweep for archive/restore/task broadcasts.
  Pure Activity/share/membership changes skip sweeps with both features disabled; notification producers
  continue to sweep without Slack flags.
- DOCX tables reject excess with `413 docx_tables_too_large` before cell or padding allocation: 256 logical
  columns, 10,000 source rows per table, and 10,000 cumulative expanded cells, including flattened nested
  tables. Exact bounds, merged/padded amplification, multiple tables, import-job errors and editor-schema
  validity are covered. Consecutive Code-style paragraphs join with newlines and mark-free text; prose
  separates code blocks. An independent read-only review found no remaining bypass or regression after the
  nested-table guard was included; its checks included 1,000 bounded layout comparisons against HEAD.
- Migration 0067 is unchanged. Guarded local/remote commands reproduce its first-ten-page assignments and
  stop before any migration for duplicate event assignments. Eighteen guard tests cover overlapping and
  non-colliding windows, bounds, legacy eligibility, empty/fresh/upgraded databases, malformed output and
  query failures. The guard performs no repair. Deployment instructions require quiescing legacy scheduling
  through this upgrade, and CLI deployment and CI both use the guarded command.

All implementation and verification remain local. No production deployment, remote migration, feature
activation or automatic legacy repair was performed. Live Slack/Word checks remain in the existing exit matrix.

The original long-run fixture is essentially unchanged: bounded parsing already splits that workload, and other parsing work dominates. Runs within a section show the improvement from determining opening status once per homogeneous run. These local measurements do not establish live Worker CPU or memory usage.
