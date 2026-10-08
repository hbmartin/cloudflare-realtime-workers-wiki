# ChatGPT plugin verification — 8 October 2026

Implementation workspace: `noteflare-chatgpt-plugin`, branch `feat/noteflare-chatgpt-plugin`. Verification covers the review fixes based on PR #232 head `53b565932bfc96176b72789b766dbf9f4d4db915`, including all eight findings and server enforcement of the Markdown write flag. Production deployment, ChatGPT registration, installed acceptance, private publishing, and paid model evaluations remain deferred.

The tested implementation fingerprint is `1ec895fc827641cd9719e0575b48d373eb1fd79a6d6f92c6658d57b44b557d49`. It is SHA-256 of the compact, key-sorted JSON object mapping the 15 changed source/test paths under `src/` and `scripts/` to their file SHA-256 digests. No source/test file changed between fingerprint capture and the completed checks. Runtime: Node `v24.21.0`, project pnpm `11.18.0`.

| Check                                                | Result                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| Formatting and lint                                  | Passed                                                                         |
| Worker middleware Semgrep scan and rule tests        | Passed; no findings, 10/10 policy tests                                        |
| All five TypeScript projects                         | Passed                                                                         |
| Unit and component coverage                          | 1,660 passed, one existing skipped; all coverage thresholds passed             |
| Full Worker integration coverage                     | 1,582 passed across 22 files; all coverage thresholds passed                   |
| Focused OAuth/MCP write-gate suite                   | 75 passed, including eight new write-gate cases                                |
| Focused editor, bridge API and Slack Settings suites | 58 passed                                                                      |
| Offline evaluator regression suite                   | 24 passed; mocked requests and isolated reports                                |
| Built UI in Chromium with a simulated MCP Apps host  | Passed under strict CSP without `unsafe-eval`                                  |
| Dead-code analysis                                   | Passed                                                                         |
| Generated Worker binding consistency                 | Passed                                                                         |
| Production build and Worker dry run                  | Passed                                                                         |
| Portable plugin manifest schema                      | Previously validated against Agent Plugins 1.0.0; file unchanged by fixes      |
| Both packaged skill frontmatters                     | Previously validated; files unchanged by fixes                                 |
| Archive/linking test                                 | Passed in an isolated temporary fixture; no production technical ID fabricated |

The complete `pnpm check` command and Chromium plugin-host test passed. Final documentation formatting and diff whitespace checks also passed. Full unit coverage used the repository defaults; Worker coverage used the configured two-worker limit.

Coverage from the full run: unit 72.97% lines, 64.47% functions, 70.19% statements, and 65.95% branches; Worker 84.60% lines, 88.20% functions, 81.08% statements, and 74.23% branches.

The UI tests cover navigation and search, creation in the selected parent, guarded saves, operation-ID reuse after an uncertain response, stale drafts and manual reconciliation, explicit reload/discard, unsaved navigation guards, permission and size limits, rejected protected edits, selection context, and unsafe Markdown. The Chromium test exercises the generated bundle, real SDK handshake and message transport, conflict preservation, host link opening, and draft retention when another tool result arrives.

New permanent regressions cover Cancel → Save and continue → Edit; superseded initial, host, and local navigation; stale error/loading/context results; unmount; and interrupted-save operation-ID retention. Settings tests prove rejected cursors clear only one mapping and transient failures preserve continuation. MCP tests cover false/unset flags, blocked staged-create resumption, completed OAuth and Durable Object receipt recovery, current access and operation-ID checks, and unaffected reads/comments.

Slack regressions verify oldest-due batch selection across workspaces with fifty authentication-paused roots, root ordering within a selected batch, temporary history/replies errors across all five recovery streams, and obsolete-generation completion without changing receipts, outboxes, or history evidence. Mixed generations advance to current work; eleven obsolete candidates terminate in batches of five, five, and one without rewinding or Slack calls. Uncertain messages are never resent by verification.

The evaluator tests cover a successful synthetic run, incomplete responses/tool calls, truncated argument JSON, malformed response shapes/JSON, unknown tools, invalid schemas, unexpected selections, argument mismatches, API failures, transport failures, and fresh report checkpoints. They execute no selected MCP calls and leave the checked-in paid-run evidence unchanged.

Model selection evaluation: **blocked, not passed**. The Responses API returned HTTP 429 `credit_balance_exhausted` on the first synthetic case. All 13 cases and the blocked result are saved under `plugins/noteflare/evals`; no returned tool calls were executed. Re-run `pnpm plugin:eval` when API credits are available. Installed ChatGPT selection/acceptance remains a separate rollout gate.

External reachability: terminal probes returned 200 for production OAuth metadata and 401 with a Bearer challenge for unauthenticated MCP. Chrome reported a client block for the Workers domain. No live OAuth consent, refresh, revocation, or installed sidebar/panel acceptance is claimed.

See [implementation and rollout instructions](CHATGPT_PLUGIN.md). The combined PR requires its existing `0079_slack_verified_recovery.sql` and any earlier pending migrations before the Worker; the review fixes add no migration. Follow the [Slack migration pause and forward recovery procedure](DEPLOYMENT.md#slack-review-follow-up-migration). The package source is ready for registration; `.app.json` and the install archive are generated only after an actual ChatGPT technical ID is supplied.
