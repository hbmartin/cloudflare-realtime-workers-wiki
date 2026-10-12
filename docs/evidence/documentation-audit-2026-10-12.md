# Documentation audit 12 October 2026

## Code and deployment evidence

The documentation refresh starts from `b61dfbda5a693fad1722bc0fe9039d9319e3448a`, merged main on 12 October 2026, with migrations through `0082_digest_reliability.sql`. This is an implementation snapshot, not a production-settings export.

GitHub's [production deploy run](https://github.com/hbmartin/noteflare/actions/runs/38273185452) reports success for that exact SHA (run created 12 October at 15:50:46 UTC). The [preceding deploy](https://github.com/hbmartin/noteflare/actions/runs/38191887502) reports success for `a19edb1`. These records establish Worker deployment; they do not establish hosted ChatGPT registration, owner settings, optional credentials, or each live exit-matrix result.

The [latest nightly run](https://github.com/hbmartin/noteflare/actions/runs/38220768494), created 12 October at 07:58:24 UTC, failed for `a19edb1`. The two preceding nightly runs also failed. This audit does not attribute those failures to an uninspected individual test.

## Capability status

| Area                                   | Audited implementation                             | Deployment and acceptance                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Editor/navigation/expanded embeds      | Phase 1 merged                                     | Worker deployed; expanded embeds off in checked-in production configuration; live exit acceptance unverified.                                                      |
| Slack capture and reminders            | Phases 2–3 merged                                  | Worker deployed; configured Slack/email destinations and signed live capture/due-to-inbox acceptance unverified.                                                   |
| Offline app                            | Phase 4 merged                                     | Production shell is built; offline mutation flag off in checked-in production configuration; multi-device live pilot unverified.                                   |
| Markdown API                           | Phase 5 merged                                     | Worker deployed; Markdown writes off in checked-in production configuration; real SDK/concurrent-edit pilot unverified.                                            |
| OAuth/MCP                              | Phase 6 merged; ten current tools                  | Worker deployed; owner-controlled enablement is not inferred from repository defaults; installed-client acceptance unverified.                                     |
| Tables and views                       | Fixed task Board exists; Phases 7–8 remain planned | Current table leases remain. Saved views and collaborative-table cutover are not implemented.                                                                      |
| Slack Round 2                          | Phase 9 merged, including migrations through 0079  | Worker deployed; activity, strict validation, share refresh, and rich digest controls off in checked-in production configuration; live delivery matrix unverified. |
| Operations incidents                   | Phase 10 planned                                   | No implemented incident-alert surface is claimed.                                                                                                                  |
| AI writing                             | Merged, migration 0080                             | Workspace settings and API credential are not inferred. Hosted connection gate is off; hosted approval and real inference acceptance remain outstanding.           |
| ChatGPT plugin                         | Source package and embedded UI merged              | Registration dependency ID, private installation/publication, and installed-client acceptance remain outstanding.                                                  |
| Block links/live diagrams/diff digests | Phase 11 merged, migrations 0081–0082              | Worker deployed; three production controls off in audited configuration; live exit matrix unverified.                                                              |

## Source checks and remaining gates

Read current routes, environment declarations, configuration defaults, migrations, feature plans, and their evidence records. Updated the API compatibility reference from the current route inventory, including its missing database/data-source endpoints. Reconciled IDEAS and Slack milestone summaries with the canonical [roadmap status](../roadmap/README.md).

No production settings, recipients, feature controls, databases, or provider connections were changed for this audit. Successful CI/deployment is separate from user-visible acceptance. Preserve explicit outstanding gates rather than carrying old statements that a merge automatically deployed or a visible control proves shipping.

Concurrent **Plan one-click deployment** is authoritative. Its local commit `2ae66e2` (not yet merged or published when reconciled) supplies the portable flow, exact origin resolution, secret preservation, fresh-install guard, setup-key labels, and new-install defaults. This documentation PR is a draft dependency on that implementation; its runtime changes are not published by this task. The named-production audit above remains at `b61dfbd`.

The reconciled references preserve the full deployment implementation's instructions and release gate, separate named legacy production from new portable defaults, and keep migration warnings in Upgrading. Its [verification record](ONE_CLICK_DEPLOYMENT_VERIFICATION.md) is archived as evidence without promoting local OAuth checks to native-form acceptance. A separate inventory check against the dependency’s Wrangler configuration, generated interfaces, and local samples identified its new `DELIVERY_DEAD_LETTER_QUEUE` binding; an exact reference table row now covers it. The native GitHub authorization repair and five full editor-flow checks remain pending. The README button stays commented out.

## Documentation validation

Validated in the isolated documentation checkout on 12 October 2026:

- Complete `pnpm check` passed: formatting, documentation coverage, Oxlint, pinned Semgrep policy and fixtures, all TypeScript projects, unit/Worker coverage, Fallow, generated bindings, production build, and Worker deployment dry run. The pipeline reported 2,021 passing unit tests and 1,703 passing Worker tests, with one pre-existing skipped unit test.
- Subsequent HTML-code handling, exact-table-entry matching, required-secret, and short-name checker refinements passed all 14 focused fixtures, the complete documentation check, formatting, and checker lint. Fixtures include reference links, images, GitHub heading duplicates, explicit anchors, encoded traversal, symlink escapes, discovery, missing AI secrets, generated declarations, and named-environment-only bindings.
- Workflow lint passed. No link to the external parity report remains, and every Markdown page under `docs/` is reachable from the documentation index.
- Rendered README, member guide, AI writing guide, and plugin guide reviewed. The screenshot is a 1440×900 light-mode capture from a local synthetic workspace, using [browser-test bootstrap helpers](../../tests/e2e/security-helpers.ts), a persisted/synced document, navigation, and an anchored comment. The optional block-link control is disabled for this capture.
- Fresh local schema initialization and account-protection enrollment exercised with the browser harness. Upgrade ranges and commands reviewed against the migration runner, SQL filenames, and deployment workflow; production migrations and feature activation were not executed.

Live gates in the capability table remain unresolved unless their independent deployed acceptance evidence is recorded. Human review remains responsible for configuration descriptions and product-contract accuracy; the checker enforces coverage and navigation.

## Rebase and preview button update

The documentation branch was rebased onto `3736dcc`, which includes portable deployment commit `2ae66e2`. The dependency described above is now integrated. The verification record is retained only under `docs/evidence/`, migration safeguards remain in Upgrading, and the documentation check is added alongside the existing portable deployment commands. The README deploy button is available as a preview at the owner’s request; native authorization and editor-flow acceptance remain pending.

Rebase validation passed: documentation links/discovery/configuration coverage, all 102 focused documentation-checker/deployment/migration tests, repository formatting and lint, and rendered README inspection. The active button redirects to Cloudflare’s deployment form and its badge returns HTTP 200. Application source, migration SQL, deployment helpers, and production release workflow match the rebased `main`; full application suites and live native deployment were not rerun for this documentation update.
