# ChatGPT plugin verification — 8 October 2026

Implementation workspace: `noteflare-chatgpt-plugin`, branch `feat/noteflare-chatgpt-plugin`, based on `d632a5a`. Production deployment, ChatGPT registration, installed acceptance, and private publishing were deferred at the user's request.

| Check                                               | Result                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| Formatting and lint                                 | Passed                                                                         |
| Worker middleware Semgrep scan and rule tests       | Passed; no findings, 10/10 policy tests                                        |
| All five TypeScript projects                        | Passed; final Worker-test additions rechecked                                  |
| Unit and component coverage                         | 1,624 passed, one existing skipped; all coverage thresholds passed             |
| Full Worker integration coverage                    | 1,720 passed across 22 files; all coverage thresholds passed                   |
| Final OAuth/MCP suite after the last additions      | 67 passed, including nine plugin contract cases                                |
| Built UI in Chromium with a simulated MCP Apps host | Passed under strict CSP without `unsafe-eval`                                  |
| Dead-code analysis                                  | Passed                                                                         |
| Generated Worker binding consistency                | Passed                                                                         |
| Production build and Worker dry run                 | Passed                                                                         |
| Portable plugin manifest schema                     | Passed against the published Agent Plugins 1.0.0 schema                        |
| Both packaged skill frontmatters                    | Passed skill validation                                                        |
| Archive/linking test                                | Passed in an isolated temporary fixture; no production technical ID fabricated |

The final unit coverage run used `--maxWorkers=2`. An earlier repeat under concurrent machine load hit two existing timing assertions (an App reconciliation timeout and an observability performance ratio); they passed on the final run without changes to those tests.

Worker coverage from the full run: 84.85% lines, 88.90% functions, 81.26% statements, and 74.15% branches. Subsequent focused tests cover the final additions: a mid-request revocation challenge, authorized document versus diagram opening, and staged/table-detail descendant filtering.

The UI tests cover navigation and search, creation in the selected parent, guarded saves, operation-ID reuse after an uncertain response, stale drafts and manual reconciliation, explicit reload/discard, unsaved navigation guards, permission and size limits, rejected protected edits, selection context, and unsafe Markdown. The Chromium test exercises the generated bundle, real SDK handshake and message transport, conflict preservation, host link opening, and draft retention when another tool result arrives.

Model selection evaluation: **blocked, not passed**. The Responses API returned HTTP 429 `credit_balance_exhausted` on the first synthetic case. All 13 cases and the blocked result are saved under `plugins/noteflare/evals`; no returned tool calls were executed. Re-run `pnpm plugin:eval` when API credits are available. Installed ChatGPT selection/acceptance remains a separate rollout gate.

External reachability: terminal probes returned 200 for production OAuth metadata and 401 with a Bearer challenge for unauthenticated MCP. Chrome reported a client block for the Workers domain. No live OAuth consent, refresh, revocation, or installed sidebar/panel acceptance is claimed.

See [implementation and rollout instructions](CHATGPT_PLUGIN.md). The package source is ready for registration; `.app.json` and the install archive are generated only after an actual ChatGPT technical ID is supplied.
