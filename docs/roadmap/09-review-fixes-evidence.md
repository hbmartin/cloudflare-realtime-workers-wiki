# Phase 9 review-fix evidence

Local implementation and verification, 2026-10-02. Production release controls remain off. No remote migration,
deployment, Slack installation change, or production activation was performed.

## Review increments

| Increment                     | Scope                                                                                                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery and recovery         | Forward migration 0067; claim ownership, sending checkpoints, authentication/scope handling, uncertain-post reconciliation, and private thumbnail upload phases.                                                                                |
| Digests, Activity and bulk    | Durable partitions of at most ten pages; exact event membership; late-event continuation; Activity eligibility/context; import suppression; one title-free bulk summary per channel, including overlapping mappings.                            |
| Slack settings, shares and UI | Legacy destination/event compatibility; destination state reset; explicit configuration sync; revoked-share replacement; refreshed previews; channel picker reset; workspace/archived Activity choices; persistent scoped paste status.         |
| DOCX and imports              | Package main-part resolution; validated-entry Mammoth adapter; unique image budget; XML sanitation; explicit breaks/tabs; merged cells; list/image ordering; title origin marker; layout traversal; Markdown delimiter and Slack label repairs. |
| Cleanup and documentation     | Shared format capabilities, lightweight MIME metadata and lazy conversion; OAuth query consolidation and deterministic rate-limit boundary; corrected deployment variables, flags and roadmap status.                                           |

Related changes sometimes precede their consuming increment so later changes have their required schema and metadata.
The cumulative branch is the implementation to review and release.

## Local verification

- The full `pnpm check` gate passed with 1,471 unit tests and 943 Worker tests against current `main`. It covers formatting, lint, middleware Semgrep rules/tests, all TypeScript projects, unit and
  Worker coverage, dead-code analysis, binding type generation, the production build and the Worker deployment dry run.
- Chromium: all three `slack-round2.spec.ts` scenarios passed, including refreshed Activity, real cross-space/archived departure filters, and mapping picker reset.
- Chromium built-app tests: all three paste/paragraph scenarios passed, including preservation of the mounted live
  region and rejection of a stale paste choice.
- A final delivery/queue regression run passed 214 tests; the final Activity unit run passed all four tests.
- Targeted regression runs exercised migration of existing receipts/artifacts, real task DELETE receipt replay,
  missing scope/authentication during validation, competing/stolen claims, permission changes during lookup, digest
  partitions at 0/10/11/25 pages, late events, bulk summaries across both cadences, rollback, revoked public-share
  replacement, private upload recovery, and DOCX/Markdown/Slack import compatibility.
- The generated Worker entry dispatches DOCX import/export with dynamic imports of a separate `assets/docx-*.js`
  chunk. Mammoth, DOCX and HTML-parser conversion code is absent from the entry's eager dependency path. DOCX export
  retrieves the document without building discarded Markdown/HTML serializations.

## DOCX memory measurement

A standalone Node benchmark compared the pre-fix converter with the validated-entry adapter. Both used the independent
`rich-text.docx` fixture plus 32 MiB of random unused ZIP media, producing a 32.795 MiB upload. Each variant ran in a
fresh process three times with the same fixture and a 1 GiB heap limit. Peak RSS came from
`process.resourceUsage().maxRSS`; this includes loaded libraries and the input, rather than measuring only conversion
allocations.

| Converter | Peak RSS samples (MiB) | Median peak RSS (MiB) | Median conversion time (ms) |
| --------- | ---------------------- | --------------------- | --------------------------- |
| Before    | 192.78, 197.52, 194.75 | 194.75                | 517.19                      |
| After     | 197.70, 201.58, 201.30 | 201.30                | 505.04                      |

This fixture does **not** demonstrate a peak-RSS reduction. The adapter removes the duplicate upload Buffer and
Mammoth's second ZIP-reader path, and repeated images now share one asset/budget entry; those structural improvements
should not be presented as a measured Worker memory saving. Worker peak memory and CPU still require representative
live import measurements.

## Remaining live verification

Before activation, apply forward migrations in the deployment process, configure a valid IANA default timezone,
run the owner channel-validation report, then call `POST /api/slack/configuration/sync`. Keep activation separate from
this implementation. Verify the Phase 9 live exit matrix with real Slack public/private channels, reconnect and
permission recovery, rate limits and lost responses, private diagram files, bulk summaries and multi-message daily
windows. Check exported DOCX fixtures in Word and a compatible independent reader, and measure realistic Worker
import memory/CPU. Retain the existing scopes and private thumbnail policy.
