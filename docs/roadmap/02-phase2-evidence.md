# Phase 2 implementation evidence

Baseline: the verified Phase 1 implementation on branch `feat/phase2-slack-capture`. Local verification: 29 September 2026. The code shipped to production through automatic deployment after #202 merged on 30 September 2026. Phase 2 stays pending until the live checks below pass.

| Exit scenario                                                                          | Evidence                                                                                  |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Signed `/notes` search, App Home, notifications, unfurls, and both shortcuts           | `src/worker/slack-threads.integration.test.ts` signed-interaction tests                   |
| Public message and private three-page thread                                           | `src/worker/slack-threads.integration.test.ts` capture publication tests                  |
| Slack repeat, lost response, and outbox replay                                         | `src/worker/slack-threads.integration.test.ts` repeated submission and lost-enqueue tests |
| Source, channel, destination, parent, and assignee access                              | `src/worker/slack-threads.integration.test.ts` revocation and task tests                  |
| More than 2,000 messages, more than 2 MiB, and one reply in a large thread             | `src/worker/slack-threads.integration.test.ts` bounded fetch tests                        |
| Rate limit, deleted source, failed import, cancellation, and retry                     | `src/worker/slack-threads.integration.test.ts` recovery tests                             |
| Installation reconnect and identity re-verification                                    | `src/worker/slack-threads.integration.test.ts` generation and latest-session tests        |
| Existing queued copy and interrupted staging                                           | `src/worker/slack-threads.integration.test.ts` legacy copy and lost-enqueue tests         |
| Hidden parented import until verification; atomic task row and assignment notification | `src/worker/jobs.integration.test.ts`, `src/worker/slack-threads.integration.test.ts`     |
| Migration replay                                                                       | `src/worker/migrations.integration.test.ts`                                               |
| Web retry link and job controls                                                        | `src/client/App.test.tsx`, `src/client/ActivitiesTray.test.tsx`                           |

The signed interaction suite exercises the existing search, App Home, notification, and unfurl paths alongside the two routed shortcuts. Capture output uses the existing Markdown importer and import Workflow, with one source receipt and a hidden staged page until final verification. Task capture writes its row and assignment notification with the publication transaction. Generation-specific R2 inputs keep a pre-reconnect transcript from replacing a reverified one. The source timestamp remains the durable identity, so a different destination for the same source returns a conflict as specified in the Phase 2 roadmap.

The local unit suite passed 1,150 tests in 81 files; the Worker suite passed 741 tests in 16 files. The Slack integration file passed all 232 tests, including malformed pagination, receipt-link races, job collisions, interrupted cleanup, and duplicate delivery. Type checks, lint, changed-file formatting, middleware Semgrep rules, dead-code analysis, the production client build, and the production Worker dry run also passed. The full Worker run took about five minutes and printed Miniflare Durable Object reset warnings, but reported no failed tests. The owner-supplied uncommitted documents were left untouched.

The code reuses NoteFlare's verified Slack identity, import, notification, job, and outbox paths. The Phase 1 evidence records the AFFiNE, Outline, and Docmost comparator patterns used for the editor and embed work. No comparator source was imported into the app.

## Release and recovery

1. Apply migrations `0053_slack_capture_receipts.sql`, `0054_slack_capture_generation.sql`, `0055_slack_capture_job_attempt.sql`, and `0056_reconcile_slack_capture_attempts.sql`, in that order, after the Phase 1 migrations and before deploying this Worker.
2. Confirm the pending old-copy outbox is drained or reconciled. Both shortcut callbacks switch together in the deployed Worker.
3. Exercise a signed message capture, a private thread capture, a failed job retry through `/?activity=1`, and existing search, App Home, notifications, and unfurls against the deployed Worker. Check that the source receipt and final page IDs agree.
4. If capture publication fails, disable the two shortcut callbacks with an explicit temporary-unavailable response while leaving search, unfurls, and notifications enabled. Failed jobs retain their receipt for retry after the cause is fixed; staged content is hidden and cleaned on terminal failure.

Status, 1 October 2026: the deploy workflow applied migrations `0053`–`0056` and both shortcut callbacks now use the capture path in production. Step 3 still needs live verification and is tracked in [README.md](README.md#round-1-release-closeout). Mark Phase 2 shipped there once it passes.
