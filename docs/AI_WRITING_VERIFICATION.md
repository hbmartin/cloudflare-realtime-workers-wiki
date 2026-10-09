# AI writing implementation verification

This reliability update is prepared for review on `feat/ai-writing`, starting at commit `d67ae40` (the existing AI writing implementation). It addresses comments 1–9 and 11–14, fixes action labels from 15, and adds funding-specific model contract coverage for 10. AES-GCM consolidation remains deferred. No additional database migration is included.

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

Worker regressions cover discovery and inference credential rejection, actual session failure, refresh failure with 424, quota refunds/counting, immediate stale recovery during read/open/access/follow-up, concurrent follow-ups, cancellation/expiry completion races, saved running cancellation, membership/session/source revocation, and transient checks that withhold deltas. Model unit tests preserve ChatGPT `models[].slug`, reject the API shape for that funding, and exercise funding/workspace/credential isolation, concurrent deduplication, TTL expiry, bounded eviction, invalidation, and uncached failures.

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
