# AI writing implementation verification

This change is prepared for review on `feat/ai-writing`, based on main commit `18ff7eba566d669ad1ec218dd27436f5528854a7`. It adds document writing, private conversation history, owner funding/model controls, a gated hosted ChatGPT connection, and typed MCP table/diagram reads. The original checkout's existing package changes are untouched.

## Automated evidence

Local checks use synthetic content and mocked inference/token endpoints. They do not spend API credits or establish hosted ChatGPT plan eligibility.

| Check                                                                | Result                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Format, lint, all five TypeScript projects                           | Passed                                                                |
| Middleware policy scan and its regression fixtures                   | 0 findings; 10/10 fixtures passed                                     |
| Dead-code and exposed-type analysis                                  | Passed                                                                |
| Generated Cloudflare bindings consistency                            | Passed                                                                |
| Full unit coverage suite                                             | 1,735 tests passed; 1 existing skip; 72.57% line coverage             |
| Full Worker coverage suite                                           | 1,639 tests passed across 24 files; 84.60% line coverage              |
| Final source-reader/MCP regression run                               | 97 tests passed, covering writing/source reads and OAuth/MCP protocol |
| Browser matrix                                                       | 16 tests passed across Chromium, Firefox, WebKit, and mobile Chromium |
| Client, MCP App, offline shell, and production Worker dry-run builds | Passed                                                                |

The browser matrix covers page actions, the selection formatting toolbar, `/ai`, formatted read-only previews, actual Yjs application and Undo, target conflicts, safe insertion, draft persistence across closing the sidebar, private history navigation, accessibility, and existing page-panel responsiveness. It also exercises the bundled MCP App host bridge and its existing create/update/retry behavior.

Worker tests cover quotas and concurrent/idempotent dispatch; explicit cancellation and incomplete streams; private history, retention, and access locking; effective viewer permissions; source scope and context limits; current content on follow-ups; membership deletion; typed bounded table/diagram pagination; cursor actor/query/revision/epoch binding; and current OAuth authorization. Signed-token tests validate OIDC issuer/audience/nonce/expiry, browser-bound single-use state, granted inference scopes, encrypted member-bound credentials, serialized refresh, and disconnect.

The application repair also reconnects BlockNote 0.55's retained Yjs undo manager after a view remount. Browser tests verify that an AI replacement can be undone as one editor operation. Replacement remains bound to its generation target; changing source selection retains the draft but requires regeneration before replacing that new selection.

An existing observability timing assertion narrowly exceeded its ratio threshold during a concurrent coverage run. Its code and threshold were unchanged; the final unit coverage run passed with workers limited to two to reduce competing work.

Commands used for repeatable verification:

```sh
pnpm format:check
pnpm lint
pnpm check:middleware
pnpm typecheck
pnpm test:coverage --maxWorkers=2
pnpm test:worker:coverage
pnpm analyze
pnpm cf-typegen:check
pnpm build
pnpm build:worker
pnpm exec playwright test tests/e2e/writing.spec.ts tests/e2e/plugin-ui.spec.ts tests/e2e/workspace.spec.ts --grep 'writing streams|MCP App|native Escape|documents and the page panel'
```

## Rollout work requiring the deployment environment

Follow [AI writing setup](AI_WRITING.md) and the [private plugin setup](CHATGPT_PLUGIN.md). Migration `0080_ai_writing.sql` is included. No production migration, deployment, ChatGPT registration, private installation/publication, or paid model-selection evaluation was performed.

Workspace API writing needs the operator's `OPENAI_API_KEY` Worker secret and owner-enabled writing/funding/model settings. Defaults keep writing and API funding disabled until configured.

Hosted ChatGPT connections remain disabled in every checked-in environment. OpenAI must provision the hosted `oaiapp_…` client and approve its exact scopes, callback, authentication method, resource, and inference contract before the gate is enabled. Actual hosted OAuth, model access, generation, allowance exhaustion, refresh, disconnect, and private ChatGPT plugin acceptance remain live rollout checks. Link the plugin package only with its actual environment-specific `plugin_asdk_app_…` technical ID.
