# Documentation audit 12 October 2026

## Code and deployment evidence

The documentation refresh starts from `b61dfbda5a693fad1722bc0fe9039d9319e3448a`, merged main on 12 October 2026, with migrations through `0081_document_changes.sql`. This is an implementation snapshot, not a production-settings export.

GitHub's [production deploy run](https://github.com/hbmartin/noteflare/actions/runs/38273185452) reports success for that exact SHA (run created 12 October at 15:50:46 UTC). The [preceding deploy](https://github.com/hbmartin/noteflare/actions/runs/38191887502) reports success for `a19edb1`. These records establish Worker deployment; they do not establish hosted ChatGPT registration, owner settings, optional credentials, or each live exit-matrix result.

The [latest nightly run](https://github.com/hbmartin/noteflare/actions/runs/38220768494), created 12 October at 07:58:24 UTC, failed for `a19edb1`. The two preceding nightly runs also failed. This audit does not attribute those failures to an uninspected individual test.

## Capability status

| Area | Audited implementation | Deployment and acceptance |
| --- | --- | --- |
| Editor/navigation/expanded embeds | Phase 1 merged | Worker deployed; expanded embeds off in checked-in production configuration; live exit acceptance unverified. |
| Slack capture and reminders | Phases 2–3 merged | Worker deployed; configured Slack/email destinations and signed live capture/due-to-inbox acceptance unverified. |
| Offline app | Phase 4 merged | Production shell is built; offline mutation flag off in checked-in production configuration; multi-device live pilot unverified. |
| Markdown API | Phase 5 merged | Worker deployed; Markdown writes off in checked-in production configuration; real SDK/concurrent-edit pilot unverified. |
| OAuth/MCP | Phase 6 merged; ten current tools | Worker deployed; owner-controlled enablement is not inferred from repository defaults; installed-client acceptance unverified. |
| Tables and views | Fixed task Board exists; Phases 7–8 remain planned | Current table leases remain. Saved views and collaborative-table cutover are not implemented. |
| Slack Round 2 | Phase 9 merged, including migrations through 0079 | Worker deployed; activity, strict validation, share refresh, and rich digest controls off in checked-in production configuration; live delivery matrix unverified. |
| Operations incidents | Phase 10 planned | No implemented incident-alert surface is claimed. |
| AI writing | Merged, migration 0080 | Workspace settings and API credential are not inferred. Hosted connection gate is off; hosted approval and real inference acceptance remain outstanding. |
| ChatGPT plugin | Source package and embedded UI merged | Registration dependency ID, private installation/publication, and installed-client acceptance remain outstanding. |
| Block links/live diagrams/diff digests | Phase 11 merged, migration 0081 | Worker deployed; three production controls off in audited configuration; live exit matrix unverified. |

## Source checks and remaining gates

Read current routes, environment declarations, configuration defaults, migrations, feature plans, and their evidence records. Updated the API compatibility reference from the current route inventory, including its missing database/data-source endpoints. Reconciled IDEAS and Slack milestone summaries with the canonical [roadmap status](../roadmap/README.md).

No production settings, recipients, feature controls, databases, or provider connections were changed for this audit. Successful CI/deployment is separate from user-visible acceptance. Preserve explicit outstanding gates rather than carrying old statements that a merge automatically deployed or a visible control proves shipping.

Concurrent one-click deployment work takes precedence for portable configuration, local samples, build/deploy commands, setup labels, and new-install defaults. Reconcile those references before this documentation PR is finalized. The named production installation and new-install defaults must remain distinguishable.
