# Phase 11 evidence

Local implementation on 11 October 2026. Production flags are off. Nothing is marked shipped.

## Local validation

The full browser suite ran separately for each configured project with a fresh local E2E server and database:

| Command                                               | Result               |
| ----------------------------------------------------- | -------------------- |
| `pnpm exec playwright test --project=chromium`        | 29 passed            |
| `pnpm exec playwright test --project=firefox`         | 28 passed, 1 skipped |
| `pnpm exec playwright test --project=webkit`          | 28 passed, 1 skipped |
| `pnpm exec playwright test --project=mobile-chromium` | 29 passed            |

Total: 114 passed, two skips. The passkey test uses Chromium's CDP virtual authenticator, so Firefox and WebKit
explicitly skip it. Chromium and mobile Chromium both execute it. All four new document-ideas tests pass in every
project, including live edits from a second browser page and unchanged shared diagram data after zoom/Fit.

`pnpm check` completed with exit code 0 after the final delivery-retention fix. It passed formatting, lint, the ten
Semgrep middleware rules and ten rule tests, all five TypeScript targets, unit coverage, Worker integration coverage,
dependency analysis, generated-binding verification, the client production build, and the production Worker dry run.

| Suite                                           | Result                                                      |
| ----------------------------------------------- | ----------------------------------------------------------- |
| Unit coverage                                   | 2,001 passed, 1 skipped                                     |
| Worker integration coverage                     | 1,682 passed                                                |
| Focused checkpoint/notification integration run | 31 passed, including no redelivery after checkpoint cleanup |

The existing opt-in 10,000-node mention benchmark is skipped unless `MENTION_BENCH=1`. The browser matrix ran after
the final UI changes; subsequent fixes affected digest finalization and test assertions. The Worker dry run confirmed
all three production release controls are false. No deployed verification is inferred from a dry run.

## Review follow-up validation

All repository check stages passed after the follow-up changes: formatting, lint, middleware Semgrep rules/tests,
all five TypeScript targets, unit and Worker coverage, dependency analysis, generated-binding verification, client
build, and production Worker dry run. The existing opt-in mention benchmark remains skipped.

| Suite                             | Result                  |
| --------------------------------- | ----------------------- |
| Unit coverage                     | 2,010 passed, 1 skipped |
| Worker integration coverage       | 1,703 passed            |
| Document-ideas Chromium scenarios | 5 passed                |

Regressions cover malformed personal frozen receipts, valid frozen fallbacks, underscore URL targets, forty mixed
items with ten comparison pages, budget-bound cursor progress, stolen delivery claims, 2,000 inaccessible edits,
checkpoint and GC continuation above their invocation caps, lease contention/loss, failed enqueue recovery, and
failed R2 deletion. Channel tests cover all activity/diff flag combinations and pending duplicate IDs. A valid
channel comparison loads its two R2 inputs once across all three access checks.

D1 `EXPLAIN QUERY PLAN` assertions verify indexed finalization and preservation of 10,000 unrelated notifications.
The feature-off digest budget test also asserts that no checkpoint/recipient query runs. Fresh migrations and
upgrades from before `0081` and `0082` pass. The digest view's suppression lookup uses the recipient primary key.

Editor tests cover native context menus and clipboard fallback, reconnect without a second scroll, stopping scans
for deleted blocks, retrying cached misses after synchronization, and opening History only for complete links to
the current page. Chromium verifies full saved text alongside changed blocks using saved Yjs version fixtures,
including hiding Restore while loading and rejecting a late response for an earlier selection.
The Slack test timestamp fixture now preserves six fractional digits even at exact whole seconds.

Apply `0082_digest_reliability.sql` after `0081` and before deploying the follow-up Worker. Thirty-day checkpoint
coverage still includes documents without digest subscribers. Continuation uses the existing delivery queue;
production feature defaults remain false. No production migration, deployment, or live messages ran.

## Feature evidence

| Area                     | Coverage                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Block links              | Stable ID encoding, locally expanded ancestors, reduced motion, nested targets, viewer controls, keyboard focus/Copy, clipboard denial, missing targets, offline cached misses, and fragment history                                                                                                                                                                        |
| Live diagrams            | Visible/foreground subscriptions, duplicate room sharing and final release, authoritative sync without initialization, remote edits, local zoom/Fit without shared updates, restored epochs, denial clearing, and retained in-memory views                                                                                                                                  |
| Structured comparison    | Adds, removals, own-content edits, moves, nesting, cosmetic-only changes and split text runs, links, attachments, formulas, Mermaid and linked-page properties, edit/revert, and Unicode excerpt bounds                                                                                                                                                                     |
| Checkpoints and delivery | Transactional projection capture, existing baseline retention, actor exclusion, unread coalescing independence, restoration across epochs, frozen personal/channel inputs, more than forty eligible edits on one page, edits arriving during delivery, no duplicate after checkpoint expiration, access loss, oversized/missing/expired fallback, escaping and Slack limits |
| Cleanup                  | Thirty-day expiry, current/referenced projection survival, page-deletion cascades, and retry after R2 deletion failure                                                                                                                                                                                                                                                      |

The comparison cases are in `src/shared/block-diff.test.ts`. New client lifecycle tests cover the embed pool and
visibility behavior. Worker cases live in `document-changes.integration.test.ts`, the authenticated comparison and
read-connection tests in `index.integration.test.ts`, and channel coverage in `slack-round2.integration.test.ts`.
Browser cases live in `tests/e2e/document-ideas.spec.ts`. Email and Slack transports are mocked in integration tests;
the real-recipient pilot remains a separate deployed exit requirement.

The full mobile suite exposed an existing missing Favorite action when the header button is hidden. The page menu
now provides that action at phone widths. Browser helpers also open the mobile drawer before accessing its controls,
use stable page identities, and avoid pointer clicks on nested tree controls. JSDOM's organization test explicitly
selects the header Favorite action because it does not apply responsive CSS.

The block picker uses a native select. Browser automation uses `selectOption` for its native popup, while verifying
keyboard entry, focus transitions and Copy activation. Explicit internal Tab/Shift+Tab transitions also cover
Safari's default button-skipping tab order; focus can still leave the control.

## Deployed release gates

Deployed verification, an approved real-email pilot, and an approved test Slack destination remain pending.
No production deployment or live email/Slack test messages have been sent.

Apply additive migration `0081_document_changes.sql` before the new Worker. Review and enable block links, live
diagrams, then diff digests independently. Their production defaults remain false; local/E2E defaults are true.
Keep IDEAS #17, #65 and #62 marked implemented locally until the deployed exit matrix in Phase 11 passes.

Development browser logs contain React Flow resize-observer notifications and BlockNote's viewport-meta warning.
Functional assertions pass; this evidence does not claim an error-free console. Check rendering and existing client
error telemetry in the deployed pilot. Intentional offline/denied test cases also produce connection-failure logs.

Monitor `document.comparison.unavailable`, `document.comparison.fallback`, and `document.comparison.pruned`, retained
checkpoint counts and R2 storage, existing realtime connection failures, and integration/delivery failure metrics.
Choose the real email recipient and test Slack mapping explicitly before pilot messages, and record deployed results
here before widening activation or marking the features shipped.
