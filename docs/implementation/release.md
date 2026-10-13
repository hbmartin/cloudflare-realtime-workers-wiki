# NoteFlare implementation and release evidence

The implementation baseline is `9c06454a828e5d30092769675d831a2789d3a4cd`, which includes the prior Slack and deployment changes. This implementation is prepared for review against `main`, including the merge of those changes in `48c2239b00a8657a09181bff4dd9d5c9bff57880`. Deployment, production migrations and live feature enablement require separate release closeout.

## Implementation increments

| Increment | Main integration                                                                                     | Release control                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A         | Editor recovery, native API tables, Worker document validation, owner integrity API                  | Metadata integrity checks before and after D1 migration; content checks remain owner initiated |
| B         | Complete canonical MCP chunks and snapshot guards; plugin snapshot assembly; exact patch diagnostics | Partial plugin snapshots remain read-only                                                      |
| C         | Batched contributor identities, version accumulator, contributor records and page information        | Historical coverage is explicitly partial                                                      |
| D         | Captured template tags, personal branch sorting, root moves and repeatable reveal                    | Sorting writes browser preferences, not page positions                                         |
| E         | Find and replace, status, tabs, footnotes and presentation                                           | Schema readers precede `EDITOR_BLOCKS_V2_ENABLED` insertion                                    |
| F         | Deferred expensive rendering, incremental heading index and typo title fallback                      | Rendering acceptance uses identical fixtures and browser profiles                              |
| G         | Table DO commands, receipts, seeding fences and projection repair                                    | Per-table explicit migration gated by `TABLE_AUTHORITY_ENABLED`; retain leases until closeout  |
| H         | Saved views, unique property names, staged conversions and atomic grouped insertion                  | G must pass before cutover; conversions retain originals until commit                          |
| I         | Shared formulas, calculations, linked views and diagram cards                                        | Host and source access enforced separately; table authority owns results                       |

## Forward migrations

Migrations `0083` through `0089` add contributors, table authority, saved views and properties, title trigrams and Unicode normalization queue, table deletion cleanup, computed cell projections and downstream attribution. They preserve original IDs and applied migration history. Integrity failures and incomplete coverage stop Worker upload; they never roll back migrations or automatically modify pages.

The owner API accepts metadata or canonical content mode at `/api/admin/integrity`. Follow every continuation until complete; findings from intermediate batches are part of the scan. A stale fingerprint, incomplete content coverage or failed request cannot pass. The metadata deployment check uses the configured Cloudflare credentials and does not require an owner browser session.

Use the integrity script with the same local or remote database configuration as migration tooling. Deep content scans require `INTEGRITY_BASE_URL` and `INTEGRITY_SESSION_COOKIE`. Keep the cookie private; the script never writes page content.

## Provenance

[Third-party notices](../../THIRD_PARTY_NOTICES.md) pin Docmost `c1305f002e47ece4d40f0aebba75d8d0f762d8ea`, AFFiNE `0b69a6da21e8fd35beb85667bb8496d9b3852238`, and the Outline behavior reference `b4bef2c0141c73ba260040bbbdba3ee1add6d752`. Docmost formula and portable editor code remains AGPL; its find and replace code retains the explicit MIT notice. AFFiNE frontend algorithms retain MIT provenance. No commercial Docmost code or Outline BSL source is included.

## Acceptance coverage

| Contract                                                                     | Representative acceptance                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict writes, native API tables, capabilities and contributors              | [Document validation](../../src/shared/document-validation.test.ts), [Worker document integration](../../src/worker/index.integration.test.ts), [Page information](../../src/worker/page-info.integration.test.ts), [contributor and integrity contracts](contributors-integrity-release.md) |
| Read-only integrity and deployment gates                                     | [Shared integrity](../../src/shared/integrity.test.ts), [Worker integrity](../../src/worker/integrity.integration.test.ts), [deployment](../../scripts/deploy.test.mjs), [integrity tooling](../../scripts/integrity.test.mjs)                                                               |
| Complete MCP snapshots, continuation authorization and exact Markdown errors | [OAuth/MCP integration](../../src/worker/oauth.integration.test.ts), [Markdown mutation mapping](../../src/shared/notion-markdown-mutations.test.ts), [plugin snapshot assembly](../../src/plugin-ui/api.test.ts)                                                                            |
| Template tags, sort/reveal/root moves                                        | [Import and clone jobs](../../src/worker/jobs.integration.test.ts), [tree order](../../src/shared/tree-model.test.ts), [workspace tree](../../src/client/WorkspaceTree.test.tsx)                                                                                                             |
| Editor features, identity, export and rendering                              | [Editor feature integration](../../src/client/editor-features.test.ts), [canonical projections](../../src/shared/document-projection.test.ts), [browser acceptance](../../tests/e2e/editor-features.spec.ts), [measurements and limits](editor-release.md)                                   |
| Authority, conversion, typed filters and projection parity                   | [Table authority](../../src/worker/table-authority.integration.test.ts), [Grid/Board/Calendar filtering](../../src/worker/table-filters.integration.test.ts), [table browser collaboration](../../tests/e2e/table-authority.spec.ts)                                                         |
| Formulas, calculations and linked permissions                                | [Browser formula goldens](../../src/shared/formula/formula.test.ts), [Worker formula goldens](../../src/worker/formula.integration.test.ts), [typed calculations](../../src/shared/table-computed.test.ts), [host/source access](../../src/worker/linked-data.integration.test.ts)           |
| Task authority and linked task adapters                                      | [Task authority and linked commits](../../src/worker/task-authority-linked.integration.test.ts), [linked task UI and stable retries](../../src/client/LinkedTaskTable.test.tsx)                                                                                                              |

The D1 migrations are forward-only `0083`–`0089`; Durable Object migration `v3` adds the SQLite `TableAuthority`. Production defaults keep `EDITOR_BLOCKS_V2_ENABLED`, `TABLE_AUTHORITY_ENABLED`, `TABLE_BOARD_ENABLED` and `TABLE_CALENDAR_ENABLED` false. The E2E profile enables table migration and the three view layouts; editor acceptance explicitly enables new insertion for its fixture. Find, page information, recovery, personal navigation and existing-content readers are available independently of those insertion controls.

## Final local verification — 2026-10-13

`pnpm check` completed successfully: formatting, documentation, lint, middleware/deployment structural rules, all five TypeScript projects, both coverage suites, Fallow dead-code analysis, generated binding verification, application/plugin/offline builds and production Worker dry-run. The Worker dry-run exited without uploading or applying migrations.

| Suite                     | Result                                                             | Coverage: statements / branches / functions / lines |
| ------------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| Unit                      | 2,376 passed; one existing skipped test; 132 passing files         | 71.93% / 67.06% / 64.98% / 74.80%                   |
| Worker                    | 1,952 passed; 32 passing files                                     | 82.05% / 75.22% / 88.49% / 85.50%                   |
| Chromium, Firefox, WebKit | 24/24 editor and table scenarios passed in one final aggregate run | Includes two distinct authenticated table writers   |

The browser command was `pnpm exec playwright test tests/e2e/editor-features.spec.ts tests/e2e/table-authority.spec.ts --project=chromium --project=firefox --project=webkit`. A test-only interception race was corrected and repeated nine times before the final aggregate run. Background teardown and workflow fixture warnings remain in Worker logs; viewport, canceled-request and selection warnings remain in browser logs. Passing assertions do not claim warning-free runtime logs.

After the aggregate checks, the task adapter's filtered-row visibility result was forwarded to its UI so a successful task insertion hidden by other filters explains how to find it. Final focused acceptance passed 23 table/task UI tests and eight task authority/linked Worker tests, including the authoritative hidden-row result and its message. All five TypeScript projects, formatting and lint were rechecked; application and Worker bundles were rebuilt. These focused checks are separate from the coverage totals above.

The rendering experiment kept all native blocks mounted. At 10,000 blocks, edit median fell from 39 ms to 22 ms, while mount median increased from 527 ms to 591 ms. See [the complete fixture, measurement limits and raw evidence](editor-release.md). The benchmark compares controlled eager/deferred behavior on the same working tree, rather than two historical commits.

Local run logs: `/tmp/noteflare-full-check.log` and `/tmp/noteflare-browser-final2.log`. These are temporary execution evidence. Preserve them with the recorded implementation commit when preparing a release. No production deployment or migration application was performed.

## Required closeout

Record the implementation SHA, deployment SHA, migration application results, creation flags and per-table authority generations before declaring this release shipped. Keep CI results, browser acceptance, rendering measurements and live acceptance distinct. Reader capability deployment must complete before insertion flags are enabled.

Table cutover requires ordered two-writer convergence, idempotent command and seeding retries, stable ID and hash parity, task and Slack publication receipts, projection failure and repair, permission revocation and deletion cleanup. Retire legacy lease endpoints only after all table writers are routed through the authority and normal projection lag stays within the Phase 7 service bound.

Trash retention, editable virtualization, relation columns, relation storage, cross-table subscriptions and rollups are excluded.
