# Phase 1 implementation evidence

Baseline: `499af28`. Local verification: 28 September 2026. Production deployment has not been performed, so Phase 1 remains pending in the roadmap.

| Exit scenario                                                             | Evidence                                                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Editor and shell shortcuts, modes, permissions, focus                     | `src/client/WorkspaceNavigation.test.tsx`, `tests/e2e/phase1-production.spec.ts`             |
| Combobox, keyboard, touch, shortcut help                                  | `tests/e2e/phase1-production.spec.ts` desktop and mobile projects                            |
| Math, Mermaid, highlighted code, existing iframe under production CSP     | Built app and actual `_headers` in `tests/e2e/phase1-production.spec.ts`                     |
| Provider origin, normalization, sandbox, and open-original link           | `src/shared/embed-providers.test.ts`, `tests/e2e/phase1-production.spec.ts`                  |
| Unsafe URL, private and redirect targets, bounded HTML/images             | `src/shared/embed-providers.test.ts`, `src/worker/link-previews.integration.test.ts`         |
| Failed preview preserves a usable stored link                             | `src/client/editor-blocks.test.ts`, `tests/e2e/phase1-production.spec.ts`                    |
| Disposable cache migration and missing image                              | `src/worker/link-previews.integration.test.ts` migration replay, expiry cleanup, and R2 miss |
| Preview authentication, reuse, and expiry                                 | `src/worker/link-previews.integration.test.ts`                                               |
| Production flag off on bootstrap and preview routes; `/v1` URL round-trip | `src/worker/index.integration.test.ts`, `src/worker/notion.integration.test.ts`              |
| Preview request rate and cache row bounds, concurrent reuse, R2 failure   | `src/worker/index.integration.test.ts`, `src/worker/link-previews.integration.test.ts`       |

The preceding Phase 1 commit passed the full CI matrix. On this review patch, 1,126 local unit tests, 19 preview Worker tests, five preview-route tests, and seven built-app browser tests passed. Type checks, lint, middleware Semgrep rules, dead-code analysis, the production build, and the production Worker dry run also passed. CI must rerun the full suites on the final commit. The built-app suite uses the `notes-checks-e2e` flag value (`true`) to exercise the expanded catalog against the same static `_headers` policy committed for production. It also simulates a flag-off bootstrap response to verify the client choices. The Worker tests cover the actual flag-off binding, and the first live deployment must confirm it. Changed files passed formatting; the owner-supplied uncommitted documents were left untouched.

The implementation adapts provider normalization and iframe URL validation patterns from AFFiNE's `embed-iframe-config.unit.spec.ts`, link fallback behavior from Outline's `DisabledEmbed.tsx`, and share-to-frame transforms from Docmost's `embed-provider.ts`. No comparator source was imported into this application.

## Production rollout

1. Apply pending production D1 migrations, including `0048_unicode_table_search.sql` and `0049_link_preview_cache.sql` through `0051_link_preview_refresh_lease.sql`, before deploying the Worker. The 15-minute cleanup task queries the preview tables even while the flag is off. The tables and R2 keys contain only disposable derived data; document URLs remain authoritative.
2. Deploy the CSP correction and existing rich-block rendering with the committed production `EXPANDED_EMBEDS_ENABLED=false` setting. Confirm `/api/me` reports `expandedEmbeds:false`, both preview routes return `preview_disabled`, and the live response header plus math, code, Mermaid, and existing iframe fixtures work.
3. After the exit matrix passes on the deployed Worker, change the production setting to `EXPANDED_EMBEDS_ENABLED=true`, run `pnpm cf-typegen`, commit the config and generated type together, and deploy. The catalog code and CSP are already present; this step enables the expanded providers and previews. Recheck a preview, all provider origins, and the health endpoint.
4. If a provider or proxy fails, set the flag to `false`, run `pnpm cf-typegen`, commit the config and generated type together, and redeploy. Open tabs retain their bootstrap flag until reloaded, so ask users to reload to stop expanded frames. Existing links and bookmark URLs remain readable. Delete expired cache entries and R2 objects with scheduled cleanup or purge the derived cache if its fetch policy changes.

The owner-supplied roadmap files `docs/roadmap/README.md` and `docs/roadmap/01-editor-navigation-embeds.md` are currently untracked local documents and are deliberately excluded from this branch. Mark Phase 1 shipped in those files only after the live rollout is verified and the owner adds them to the repository.
