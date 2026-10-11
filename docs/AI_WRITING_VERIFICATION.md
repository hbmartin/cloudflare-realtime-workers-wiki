# AI writing implementation verification

This review follow-up is prepared on `codex/ai-writing-refresh-quota`, following merged PR #239 at `main` commit `0611005`. It implements the panel refresh, discard/recovery, authentication alert, paginated history, quota ordering, and catalog cache cleanup fixes below. No database migration, dependency, or production deployment is included.

## Additional race fixes: October 11, 2026

Remote-generation completion now latches the pending saved-history refresh before its first reload, retaining the gate and retrying on ordinary five-second polls until it succeeds. Provider catalog entries count pending independent fetches and remove an empty placeholder only when its last lookup finishes, preserving concurrent successful fills and recreated entries. Both status responses and stream starts reject older timestamped quota samples, retain the newer allowance and monotonic reset anchor, and accept unrelated status fields. Equal timestamps and comparisons involving a missing timestamp preserve arrival-order compatibility.

Focused panel, history, and provider catalog suites passed **156 tests**, including **10 new regressions**. They cover repeated remote-completion reload failures and stopping retries after success; failed placeholders consuming cache capacity; failure after invalidation/recreation; delayed status responses during and after generation; a delayed older stream start; reset timing after an obsolete response; unrelated status field updates; and equal/missing quota timestamps. Existing concurrent success/failure, invalidation, eviction, discard, history, and clock-skew checks remain enabled.

The Chromium writing scenario passed. `pnpm check` passed: format/lint, all five TypeScript projects, middleware policy checks (zero findings and 10/10 fixtures), code analysis, generated Cloudflare bindings, and client/MCP App/offline/Worker dry-run builds. Full unit coverage passed **1,910 tests** with one existing skip and **74.26% line coverage**; full Worker coverage passed **1,669 tests across 24 files** with **84.76% line coverage**. Tests use synthetic documents and mocked provider endpoints.

Repeatable commands:

```sh
pnpm exec vitest run src/client/WritingPanel.test.tsx src/client/WritingHistory.test.tsx src/worker/ai-models.test.ts
pnpm exec playwright test tests/e2e/writing.spec.ts --project=chromium
pnpm check
```

## Comment fixes: October 11, 2026

This follow-up fixes the four panel/history review issues without changing quota refresh behavior, server APIs, dependencies, or the database. Successful access verification during a local generation or application consumes its focus/reveal refresh rather than deferring a result reload. Discard records the latest saved message identity locally and survives passive refreshes of that message. An empty failure after stream start retains its new saved identity and selection target; pre-start failure preserves existing recovery and discard state. Classified opening, generation, application, and terminal stream authentication failures use one access alert.

History revalidation preserves the search element and loaded depth, follows fresh cursors from the first page, deduplicates IDs, and commits the list/cursor together after all requested pages succeed. Tests cover changed titles, deletions, locks, shrinking result sets, a failure on a later page, pagination reset for search/document changes, and obsolete full-refresh/Load more responses after replacement or disposal. Confirmed access loss still clears private history.

The two focused panel/history suites passed **120 tests**, including **31 new regressions**. The Chromium writing scenario passed with added assertions that discard survives focus verification and panel reopen; its existing apply/undo, conflict, private history, and accessibility checks remain enabled. The full unit coverage suite passed **1,900 tests** with one existing skip and **74.25% line coverage**. Tests use synthetic documents and mocked provider endpoints.

`pnpm check` passed on the final implementation: format/lint, all five TypeScript projects, middleware policy checks (zero findings and 10/10 fixtures), both coverage suites, dead-code/type analysis, generated Cloudflare bindings, and client/MCP App/offline/Worker dry-run builds. Worker coverage passed **1,669 tests across 24 files** with **84.77% line coverage**.

Repeatable commands:

```sh
pnpm exec vitest run src/client/WritingPanel.test.tsx src/client/WritingHistory.test.tsx
pnpm exec playwright test tests/e2e/writing.spec.ts --project=chromium
pnpm check
```

## Review follow-up: October 10, 2026

Focused validation passed 168 unit tests across six files, all 42 AI Worker integration tests, and the Chromium writing browser suite. Tests use synthetic documents and mocked provider endpoints.

Panel regressions cover old locked/not-found monitors overlapping a newer opening, superseded and failed openings, request-owned pending cleanup across generation and monitor replacement, and access denial aborting a generation despite content-revision changes. Background history reload failures remain gated until a successful retry. History search, loaded pages, cursor, and component identity survive temporary verification; denial clears retained history and redundant alerts, with authentication feedback preserved for 401.

Recovered drafts retain output, sources, message identity, and application targets after pre-start retry failure and empty remote cancellation. Existing checks retain fresh-opening behavior and invalidation after newer messages, changed/deleted saved drafts, explicit opening, discard, local cancellation, and access loss. The existing Apply-denial and zero-expiration-UPDATE regressions remain enabled.

Quota regressions cover clocks ahead and behind the server, later local-clock changes, a database read spanning server midnight, suspension and resumption, funding switches, legacy Workers, failed focus refreshes, unchanged and changing overdue responses, overlapping refreshes, and the 5/15/60/300-second retry ladder. Cache tests cover cross-key and same-key invalidation, concurrent successful/failed lookups, and eviction/recreation while an older fetch is unfinished. Selection tests span linked diagrams with explicit, default, empty, and missing attributes. SSE checks cover split and combined frames; incremental Worker assertions retain one parser iterator per response and close it after use.

`pnpm check` passed on the final implementation, including format/lint, middleware policy checks, all five TypeScript projects, both coverage suites, dead-code/type analysis, generated Cloudflare bindings, and client/MCP App/offline/Worker dry-run builds.

| Check                                                                | Result                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| Focused unit suites                                                  | 168 tests passed across six files                         |
| AI Worker integration suite                                          | 42 tests passed                                           |
| Chromium writing browser suite                                       | 1 test passed                                             |
| Format, lint, all five TypeScript projects                           | Passed                                                    |
| Middleware policy scan and regression fixtures                       | 0 findings; 10/10 fixtures passed                         |
| Full unit coverage suite                                             | 1,869 tests passed; 1 existing skip; 74.18% line coverage |
| Full Worker coverage suite                                           | 1,669 tests passed across 24 files; 84.77% line coverage  |
| Dead-code/type analysis and generated Cloudflare bindings            | Passed                                                    |
| Client, MCP App, offline shell, and production Worker dry-run builds | Passed                                                    |

Repeatable commands:

```sh
pnpm exec vitest run src/client/WritingPanel.test.tsx src/client/writing-target.test.ts src/shared/ai.test.ts src/shared/ai-writing.test.ts src/shared/document-projection.test.ts src/worker/ai-models.test.ts
pnpm test:worker src/worker/ai.integration.test.ts
pnpm exec playwright test tests/e2e/writing.spec.ts --project=chromium
pnpm check
```

## Earlier recovery follow-up: October 10, 2026

The following evidence was recorded on `feat/ai-writing`, starting at `47eea3d`, before this review follow-up.

Focused validation passed 130 unit tests across six files and 41 AI Worker integration tests. All five TypeScript projects and lint passed. Tests use synthetic documents and mocked provider endpoints; they do not spend API credits or establish hosted ChatGPT eligibility.

The panel regressions cover restored draft output, sources, message identity, and application targets surviving focus, hide/reveal, and foreground refresh. Newer messages, including those returned by the immediate post-failure history read, changed or missing saved drafts, explicit opening, discard, new generation, and access denial invalidate preservation; a fresh panel opens the latest empty failed message. Authenticated saved openings do not re-gate while monitoring is pending. Failed access gates provide manual, five-second automatic, and idle new-conversation recovery, and focus requests coalesce with pending polls while still refreshing saved history.

Model regressions distinguish pending lookup from failed or unavailable lookup and reject stale responses after funding/attempt changes. Catalog tests accept null optional metadata alongside valid entries while still rejecting malformed identifiers, wrong types, and nonpositive context windows. Selection tests match projection whitespace around inline math, adjacent atoms, and hard breaks and reject blank or atom-only selected sources without whole-page fallback.

Worker regressions hold final authorization across interval ticks and a transient retry ladder and observe at most one active authorization check. They distinguish cancellation, deadline expiry, other failure, and deleted-message races between final verification and persistence, preserve terminal database states and partial text, and verify zero expiration UPDATEs for idle or unexpired conversations. Existing immediate abandoned-generation recovery tests remain enabled.

`pnpm check` passed. The final panel refinement was followed by another focused run, full unit coverage run, format/lint/type checks, dead-code analysis, and client/Worker dry-run builds. Final results:

| Check                                                                | Result                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| Format, lint, all five TypeScript projects                           | Passed                                                    |
| Middleware policy scan and regression fixtures                       | 0 findings; 10/10 fixtures passed                         |
| Full unit coverage suite                                             | 1,831 tests passed; 1 existing skip; 73.90% line coverage |
| Full Worker coverage suite                                           | 1,668 tests passed across 24 files; 84.77% line coverage  |
| Dead-code/type analysis and generated Cloudflare bindings            | Passed                                                    |
| Client, MCP App, offline shell, and production Worker dry-run builds | Passed                                                    |

The earlier browser matrix is historical evidence; it was not rerun for this follow-up.

Repeatable focused commands:

```sh
pnpm exec vitest run src/client/WritingPanel.test.tsx src/client/writing-target.test.ts src/shared/ai.test.ts src/shared/ai-writing.test.ts src/shared/document-projection.test.ts src/worker/ai-models.test.ts
pnpm test:worker src/worker/ai.integration.test.ts
pnpm check
```

## Earlier implementation baseline

The evidence below was recorded for the earlier reliability update starting at `d67ae40`. That update addressed comments 1–9 and 11–14, fixed action labels from 15, and added funding-specific model contract coverage for 10. AES-GCM consolidation remains deferred.

## Automated evidence

Local checks use synthetic content and mocked inference/token endpoints. They do not spend API credits or establish hosted ChatGPT plan eligibility.

| Check                                                                | Result                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Format, lint, all five TypeScript projects                           | Passed                                                                |
| Middleware policy scan and its regression fixtures                   | 0 findings; 10/10 fixtures passed                                     |
| Dead-code and exposed-type analysis                                  | Passed                                                                |
| Generated Cloudflare bindings consistency                            | Passed                                                                |
| Full unit coverage suite                                             | 1,770 tests passed; 1 existing skip; 73.08% line coverage             |
| Full Worker coverage suite                                           | 1,659 tests passed across 24 files; 84.74% line coverage              |
| Writing contract and regression suites                               | 93 tests passed across seven files                                    |
| Browser matrix                                                       | 16 tests passed across Chromium, Firefox, WebKit, and mobile Chromium |
| Client, MCP App, offline shell, and production Worker dry-run builds | Passed                                                                |

The expanded browser matrix covers closing/reopening a pending generation, repeated Writing launches, `/ai` while busy, retained instructions, quota guards for Regenerate, and navigation without replayed conversation opens. It retains application/Undo, stale-target refusal, insertion, selection launches, private history, accessibility, responsive page panels, and the MCP App host/create/update/retry flows.

Worker regressions cover discovery and inference credential rejection, actual session failure, refresh failure with 424, quota refunds/counting, immediate stale recovery during read/open/access/follow-up, concurrent follow-ups, cancellation/expiry completion races, saved running cancellation, membership/session/source revocation, and transient checks that withhold deltas. Model unit tests preserve ChatGPT `models[].slug`, reject the API shape for that funding, and exercise funding/workspace/credential isolation, concurrent discovery, TTL expiry, bounded eviction, invalidation, and uncached failures.

Parser and target tests cover 250,000-character ASCII and multibyte prose, supplementary Unicode, the UTF-8 byte boundary, formatted output beyond 4,096 delimiters, total/per-block budgets, nested container/depth boundaries, unchanged general Markdown limits, mention/date and atom-only selections, protected replacement, and changed/restored targets. Panel tests cover provider failures before and after stream start, retained result/application identity, funding switching, operation guards, remote running work, access gating and expiry, and hidden/background behavior.

Measured checks use synthetic data:

| Scenario                                      | Observed result                                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Final live authorization check                | Two SQL queries: live session/protection, then joined membership/page access/message status                    |
| Healthy five-minute authorization polling     | Approximately 600 queries, plus two for successful completion (extrapolated from the measured two-query check) |
| Fifty streamed deltas                         | No formatted parse at 99 ms; one at 100 ms; immediate terminal flush uses the complete buffer                  |
| Copy between preview updates                  | Includes the latest received delta                                                                             |
| Hidden panel for 60 simulated seconds         | Zero timer-driven API requests and zero preview parses; active stream remains un-aborted                       |
| Background document for 10 simulated seconds  | No conversation polling; foregrounding checks access                                                           |
| Retained readiness callbacks                  | Two subscriptions across visible → hidden → visible; no resubscription from instruction edits                  |
| Unchanged history while instruction changes   | No additional parse                                                                                            |
| Library open, hide/show, and document revisit | One POST `/open`; revisit does not reopen Writing                                                              |

`pnpm check` passed, including format/lint, middleware policy scan (zero findings and 10 regression fixtures), all five TypeScript projects, unit/Worker coverage, dead-code/type analysis, generated bindings consistency, client/MCP App/offline builds, and the production Worker dry run. The final parser/panel refinements were followed by another unit coverage run, format/lint/type checks, and the full browser matrix. Mock fixtures use valid conversation UUIDs so follow-up/regeneration tests exercise dispatch rather than local UUID rejection.

One repeated matrix run reached a WebKit selection-toolbar timeout immediately after document navigation. Its isolated retry passed. The test now waits for the restored document's actual content before selecting text; the final full matrix passed with that readiness assertion.

Repeatable commands:

```sh
pnpm check
pnpm test:coverage --maxWorkers=2
pnpm exec playwright test tests/e2e/writing.spec.ts tests/e2e/plugin-ui.spec.ts tests/e2e/workspace.spec.ts --grep 'writing streams|MCP App|native Escape|documents and the page panel'
```

## Rollout work requiring the deployment environment

Follow [AI writing setup](AI_WRITING.md) and the [private plugin setup](CHATGPT_PLUGIN.md). The feature already includes migration `0080_ai_writing.sql`; this reliability update adds no migration. No production migration, deployment, ChatGPT registration, private installation/publication, or paid model-selection evaluation was performed.

Workspace API writing needs the operator's `OPENAI_API_KEY` Worker secret and owner-enabled writing/funding/model settings. Defaults keep writing and API funding disabled until configured.

Hosted ChatGPT connections remain disabled in every checked-in environment. OpenAI must provision the hosted `oaiapp_…` client and approve its exact scopes, callback, authentication method, resource, and inference contract before the gate is enabled. Actual hosted OAuth, model access, generation, allowance exhaustion, refresh, disconnect, and private ChatGPT plugin acceptance remain live rollout checks. Link the plugin package only with its actual environment-specific `plugin_asdk_app_…` technical ID.
