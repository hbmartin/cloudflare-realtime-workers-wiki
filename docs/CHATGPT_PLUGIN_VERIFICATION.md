# ChatGPT plugin verification — 8 October 2026

## PR #234 expired-create and Markdown follow-up

This follow-up fixes the two confirmed regressions from [PR #234](https://github.com/hbmartin/cloudflare-realtime-workers-wiki/pull/234), based on merged `main` commit `1f8b7e17ccf97f75d2ceccd89fd56d636eaca5b8`. The tested source commit is `d28fbd2dd1b0755f7925bf40ca3300013c2ba47a`. Its implementation fingerprint is `e780696e30079a0052c4db31de56d78401306f281d459a48b382587f9f367580`: SHA-256 of the compact, key-sorted JSON object mapping all 10 changed non-Markdown paths, relative to that base, to their file SHA-256 digests. Source and lockfile hashes remained unchanged through acceptance. The subsequent verification commit changes this document only.

An unacknowledged create that receives `page_creation_expired` now releases the pending request while preserving the current title, Markdown, and destination. The title unlocks and ordinary Save returns. Regression tests cover the original exact-request retry, unchanged and edited drafts saved with fresh operation IDs, adoption of the created page for subsequent updates, and isolation of late responses from abandoned sessions. Acknowledged creates and update requests retain their existing recovery behavior; nonretryable errors are not broadly released. The server's expiration message and cleanup are unchanged.

Only the direct Marked dependency is rolled back, from `18.1.0` to exact `16.4.2`. The lockfile was regenerated with pinned pnpm `11.18.0`, and the two parser/import compatibility changes were restored to their pre-PR implementations. All other dependency upgrades and the existing task-list regressions remain. New parsing, generated-mutation, and rendered-preview tests cover tight, loose, and nested task lists, checked and unchecked markers, literal and escaped brackets, and formatted labels. Real MCP create and update tests assert both stored Durable Object content and the subsequent `fetch_page` result for `- [x] First` followed by `- [ ] [x] = completed`.

The two core expired-create cases failed before the recovery fix. All nine new parser, mutation, and preview cases reproduced the Marked 18 regression before passing with Marked 16; both new MCP cases also reproduced persisted corruption with Marked 18 and passed after the rollback. Existing import, escaped link/image label, inline-math, unsupported-content rejection, uncertain-error, and acknowledged-write coverage remains enabled. An independent subagent reviewed the combined changes after the separate implementation passes.

Runtime: Node `v24.21.0`, pnpm `11.18.0`. These are local results, not a claim of a published CI run.

| Check                                               | Result                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Clean frozen-lockfile installation                  | Passed; application resolution from preview, importer, and write-parser paths is Marked `16.4.2` |
| Complete check pipeline                             | Passed once on the finished source: `VITEST_MAX_WORKERS=1 pnpm check`                            |
| Formatting, lint, middleware Semgrep and rule tests | Passed; zero findings and 10/10 policy tests                                                     |
| All five TypeScript projects                        | Passed                                                                                           |
| Full unit and component coverage                    | 1,716 passed, one existing skipped; 103 passed files and one skipped file; thresholds passed     |
| Full Worker integration coverage                    | 1,614 passed across 22 files, including both new MCP persistence regressions; thresholds passed  |
| Bundled plugin-host Chromium suite                  | Both tests passed on the tested source commit                                                    |
| Production desktop and touch browser suite          | 25 passed in 51.6 seconds on the tested source commit                                            |
| Dead-code analysis and generated Worker bindings    | Passed                                                                                           |
| Production build and Worker dry run                 | Passed; `wrangler deploy --env production --dry-run` exited successfully                         |
| Final scope and original-checkout verification      | Only Marked changed in dependencies; original local dependency edits preserved byte-for-byte     |

Full unit coverage: 73.30% lines, 64.69% functions, 70.52% statements, and 66.30% branches. Full Worker coverage: 84.66% lines, 88.21% functions, 81.17% statements, and 74.34% branches. Unit coverage took 171.94 seconds; Worker coverage took 987.25 seconds. Every coverage and benchmark threshold is unchanged.

No public tool schema, API interface, database migration, or receipt format changes. Existing documents are not rewritten; the rollback prevents future corruption. Deployment, plugin registration, paid evaluations, and installed ChatGPT acceptance were not performed. Broader receipt limitations, cross-space navigation, and persistent drafts remain separate work.

## PR #234 review fixes

The corrections for [PR #234](https://github.com/hbmartin/cloudflare-realtime-workers-wiki/pull/234) are on source commit `5c9584f7722ce161984b286ae5407b8914a382bf`. They retain the upgraded dependencies. The implementation fingerprint is `87f1e35e7266042b5425dce95ea7caf5b342df5cc45b2c75429ddcee83d45b58`, using the same SHA-256 method described below for all 42 changed non-Markdown paths relative to `22593af2dab6aebc8cc092263deb377ca4fb5bb0`. The source commit and all hashes were verified again after the complete acceptance run and remained unchanged. The later verification commit changes this Markdown document only.

Code-block node views construct and own one copy button, filter only that control's non-selection mutations, and clean up their listeners, feedback timers, and late clipboard completions. The real mounted-editor regressions preserve native edits, selection, Dark Reader filtering, language changes, unknown stored languages, and HTML export behavior. Plugin create and update drafts can be corrected after a definite `document_limit` rejection and saved with fresh operation IDs; uncertain outcomes and acknowledged writes retain their existing recovery behavior.

The backend boundary regression constructs a real 9,999-block document whose nested content is not fully represented in Markdown. A two-paragraph append through the guarded Markdown adapter returns `document_limit`, preserves the entire authoritative document envelope, and creates no successful Durable Object or D1 receipt. A smaller corrected draft succeeds with a fresh operation ID and the same revision and epoch guards.

Diagnostics runs through its dedicated client-only Chromium/Vite harness on port 4174 in both PR CI and nightly checks. Main browser discovery excludes that test; diagnostic results and HTML reports have separate directories beneath the existing artifact roots. Both workflows run diagnostics with `!cancelled()` after other checks, and retain failure traces and screenshots. Four offline tests now wait for automatic recovery after connectivity returns while retaining draft, version-quarantine, export, and revoked-access assertions.

Runtime: Node `v24.21.0`, pnpm `11.18.0`. These are local results; no new published CI result is claimed.

Two attempts at `pnpm check` with the default test concurrency failed only the existing near-linear redaction timing benchmark in `src/worker/observability.test.ts`: ratios 8.32 and 12.87 exceeded its limit of 8. Its implementation, tests, and configuration are byte-identical to the PR base. The focused observability suite passed all 76 tests, and five separate measurements of the same workload stayed below the threshold. The complete final acceptance run passed with `VITEST_MAX_WORKERS=1 pnpm check`, keeping every test, assertion, coverage threshold, and benchmark threshold enabled. No timing-test or concurrency configuration change is part of this patch.

| Check                                               | Result                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Complete check pipeline                             | Passed: `VITEST_MAX_WORKERS=1 pnpm check` exited successfully                                 |
| Formatting, lint, middleware Semgrep and rule tests | Passed; no findings, 10/10 policy tests                                                       |
| All five TypeScript projects                        | Passed                                                                                        |
| Full unit and component coverage                    | 1,702 passed, one existing skipped; 102 passed files and one skipped file; thresholds passed  |
| Full Worker integration coverage                    | 1,612 passed across 22 files; thresholds passed                                               |
| Mounted code-block and language regressions         | 8 passed; included in the full unit run                                                       |
| Focused plugin UI and bridge API regressions        | 60 passed; included in the full unit run                                                      |
| Real MCP document-limit boundary regression         | Passed in isolation and in the full Worker run                                                |
| Playwright discovery                                | 24 main Chromium tests; one dedicated diagnostic; 25 built-production desktop and touch tests |
| Main Chromium suite                                 | 24 passed in 2.2 minutes                                                                      |
| Mobile sidebar suite                                | Two passed in 31.9 seconds                                                                    |
| Built-production browser suite                      | 25 passed in 1.1 minutes, including desktop copy/edit/reload and touch code-block editing     |
| Offline reconnect stability                         | All four corrected scenarios passed three times each with retries disabled: 12/12             |
| Dedicated diagnostics under CI settings             | One passed in 2.0 seconds through the port 4174 harness                                       |
| Diagnostic failure artifact retention               | Intentional temporary failure produced a nonempty screenshot, trace archive, and HTML report  |
| GitHub Actions workflow lint                        | Passed with actionlint                                                                        |
| Dead-code analysis and generated Worker bindings    | Passed                                                                                        |
| Production build and Worker dry run                 | Passed; `wrangler deploy --env production --dry-run` exited successfully                      |

The offline stability command was `pnpm exec playwright test --config playwright.production.config.ts tests/e2e/phase4-offline-shell.spec.ts --project=chromium --grep 'opens two visited documents offline|recovers a saved draft when the catalog pending write fails|opens the online workspace from a quarantined offline draft|removes a clean cached copy when live page access is revoked' --repeat-each=3 --retries=0 --output=test-results/offline-reconnect-stability`. Diagnostics ran with `CI=1 pnpm test:e2e:diagnostics`. A temporary artifact probe outside the tracked source imported the real diagnostic configuration, intentionally failed an assertion, and verified nonempty `test-failed-1.png`, `trace.zip`, and HTML report output in separate ignored probe directories.

Full unit coverage: 73.27% lines, 64.66% functions, 70.49% statements, and 66.23% branches. Full Worker coverage: 84.66% lines, 88.21% functions, 81.18% statements, and 74.36% branches. The final unit suite took 108.86 seconds and the final Worker suite took 766.68 seconds with the one-worker limit.

## Earlier save recovery and dependency migration verification

This follow-up implements the save recovery, durable receipt identity, and retry evaluation fixes reviewed in [PR #233](https://github.com/hbmartin/cloudflare-realtime-workers-wiki/pull/233), plus compatibility migrations for the updated dependencies. PR #233 merged during implementation, so the fixes are on branch `codex/plugin-save-recovery`, based on merged commit `22593af2dab6aebc8cc092263deb377ca4fb5bb0`.

The complete `pnpm check` passed on source commit `bb12702431f8c25206c5182bce790312d5a26d5d`. The tested implementation fingerprint is `a800a6d1c6b9d5309c02319d35d4ceb885d108ccf4297967b0906fc222f6aa9d`: SHA-256 of the compact, key-sorted JSON object mapping all 33 changed non-Markdown paths, relative to the base commit above, to their file SHA-256 digests. This includes source, tests, configuration, and the lockfile. All hashes and the source commit were checked again after the full run and remained unchanged. The later verification commit changes documentation only.

Runtime: Node `v24.21.0`, pnpm `11.18.0`, Vitest `5.0.3`, Cloudflare Vitest plugin `1.4.0`, and Wrangler `4.148.0`. These results are local evidence; no new published CI result is claimed.

| Check                                               | Result                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Formatting and lint                                 | Passed                                                                                                                     |
| Worker middleware Semgrep scan and rule tests       | Passed; no findings, 10/10 policy tests                                                                                    |
| All five TypeScript projects                        | Passed                                                                                                                     |
| Full unit and component coverage                    | 1,693 passed, one existing skipped; 101 passed files and one skipped file; thresholds passed                               |
| Full Worker integration coverage                    | 1,611 passed across 22 files; thresholds passed                                                                            |
| Focused editor and bridge API regressions           | 58 passed; included in the full unit run                                                                                   |
| Focused OAuth/MCP and Durable Object recovery       | 112 passed: 79 OAuth/MCP and 33 Durable Object cases; included in the full Worker run                                      |
| Offline evaluator regressions                       | 27 passed; included in the full unit run; mocked requests and isolated reports                                             |
| Built UI in Chromium with a simulated MCP Apps host | Both tests passed on `7733cda1669fd705b9b0a484ff8ed4728cce5a6e`; plugin UI source and SDK dependencies unchanged afterward |
| Dead-code analysis                                  | Passed                                                                                                                     |
| Generated Worker binding consistency                | Passed                                                                                                                     |
| Production build and Worker dry run                 | Passed; `wrangler deploy --env production --dry-run` exited successfully                                                   |

Full unit coverage: 73.11% lines, 64.55% functions, 70.33% statements, and 66.15% branches. Full Worker coverage: 84.64% lines, 88.16% functions, 81.15% statements, and 74.34% branches. Unit coverage used the repository defaults; Worker coverage used the configured two-worker limit. Final documentation formatting and diff whitespace checks also passed.

The editor regressions reproduce interrupted creates and updates during both mutation and saved-page refresh. They verify one create followed by an update to the acknowledged page, retention of newer Markdown, exact original-request retries, fetch-only acknowledged recovery, canonical normalization, the create epoch invariant of 1, changed revisions and epochs, inaccessible or read-only results, title locking, and prevention of concurrent successor writes. Navigation cases cover repeated host intents, Keep editing, explicit discard, Save and continue, unmount, API replacement, and isolation of late state, notices, context, navigation, and save locks. Unverifiable update receipts enter manual reconciliation before a fresh operation can be submitted.

The Chromium tests use the generated bundle, actual MCP Apps SDK handshake and message transport, and a simulated host under strict CSP. The original bridge test preserves a conflicted draft and checks host link opening. The new test presses native Escape while a create response is held, preserves the draft and newer typing, confirms the original create once, then verifies the next explicit save sends one guarded update to that created page.

Receipt regressions remove a new update's D1 receipt and recover the identical input without another mutation, including when writes are disabled or unset. Changed commands, revisions, and epochs fail before receipt completion. Additional cases cover legacy fallback without identity backfill, missing or malformed hashes, both forms of one-sided v2 state without legacy fallback, version restore, compaction, the original committed sequence after later edits, transaction rollback with retained pending work, retry after storage failure, restart durability, and rejected mutations leaving no identity record.

The evaluator keeps partial assertions at the top level and requires deep equality within each asserted value. Regressions cover changed nested values, missing and extra nested keys, array contents and order, equivalent object key order, and unasserted top-level arguments. The retry case asserts its original page ID, complete command, operation ID, revision, and epoch. Tests execute no selected tools and leave `plugins/noteflare/evals/results.json` unchanged.

Dependency compatibility work includes the [Cloudflare Vitest plugin migration](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/) for Vitest 5, shared ProseMirror model/transform/view versions for BlockNote and Yjs class identity, Marked checkbox and escaped-label handling, native dialog focus behavior in the jsdom fixture, the [Notion SDK's documented test-only browser-detection opt-out](https://github.com/makenotion/notion-sdk-js/releases/tag/v5.27.0) under workerd, updated Worker bindings, and the newer formatting, lint, and analyzer contracts. Node support is `^22.22.2 || ^24.15.0 || >=26.0.0`, enforced by the importer guard as well as the package engine. `@better-auth/utils` remains at `0.4.2` because Better Auth/core/passkey `1.7.7` require that exact dependency or peer version; the attempted `0.5.0` upgrade introduces incompatible duplicate core types. The dependency edits in the original checkout were preserved.

New Durable Object identity rows initialize automatically and survive compaction. This follow-up adds no D1 migration and changes no public tool schema. Legacy ID-only receipt replay retains its requested limitation. Identity remains scoped to a document and epoch; reuse on another document after D1 receipt loss and no-op updates' D1-only replay protection remain outside this receipt fix. A restored v2 content receipt without local SQL identity returns nonretryable `operation_receipt_unverifiable` and requires reading and reconciling current content.

Production deployment, live Slack validation, ChatGPT registration, installed ChatGPT acceptance, plugin publishing, and paid model evaluations remain deferred. The earlier paid selection attempt is still recorded as blocked by HTTP 429 `credit_balance_exhausted`; it is not a passing evaluation and was not rerun. Cross-space navigation and broader receipt redesign remain separate follow-ups. See [implementation and rollout instructions](CHATGPT_PLUGIN.md); this local verification does not replace those rollout gates or the existing migration procedure from PR #233.
