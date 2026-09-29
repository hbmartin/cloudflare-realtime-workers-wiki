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

Local gates on the final review patch: 19 Notion adapter unit tests, the two changed Worker integration cases, type checks, and 7 built-app browser tests passed. Earlier full Phase 1 runs passed 1,122 unit tests with coverage, 675 Worker tests with coverage, and 19 development browser tests. CI will rerun the full suites and now includes the built-app browser suite. The browser suite uses the `notes-checks-e2e` flag value (`true`) to exercise the expanded catalog against the same static `_headers` policy committed for production. It also simulates a flag-off bootstrap response to verify the client choices. The Worker tests cover the actual flag-off binding, and the first live deployment must confirm it. Lint, middleware Semgrep rules, dead-code analysis, generated binding check, production build, and Wrangler production dry run with `EXPANDED_EMBEDS_ENABLED=false` passed on the preceding review patch. The full local formatter check reports only the preexisting untracked `IDEAS.md`; it was left untouched.

The implementation adapts provider normalization and iframe URL validation patterns from AFFiNE's `embed-iframe-config.unit.spec.ts`, link fallback behavior from Outline's `DisabledEmbed.tsx`, and share-to-frame transforms from Docmost's `embed-provider.ts`. No comparator source was imported into this application.

## Production rollout

1. Apply pending production D1 migrations, including `0048_unicode_table_search.sql` and `0049_link_preview_cache.sql`, before deploying the Worker. The 15-minute cleanup task queries the preview table even while the flag is off. The table and R2 keys contain only disposable derived data; document URLs remain authoritative.
2. Deploy the CSP correction and existing rich-block rendering with the committed production `EXPANDED_EMBEDS_ENABLED=false` setting. Confirm `/api/me` reports `expandedEmbeds:false`, both preview routes return `preview_disabled`, and the live response header plus math, code, Mermaid, and existing iframe fixtures work.
3. After the exit matrix passes on the deployed Worker, change the production setting to `EXPANDED_EMBEDS_ENABLED=true`, run `pnpm cf-typegen`, commit the config and generated type together, and deploy. The catalog code and CSP are already present; this step enables the expanded providers and previews. Recheck a preview, all provider origins, and the health endpoint.
4. If a provider or proxy fails, set the flag to `false`, run `pnpm cf-typegen`, commit the config and generated type together, and redeploy. Open tabs retain their bootstrap flag until reloaded, so ask users to reload to stop expanded frames. Existing links and bookmark URLs remain readable. Delete expired cache entries and R2 objects with scheduled cleanup or purge the derived cache if its fetch policy changes.

The owner-supplied roadmap files `docs/roadmap/README.md` and `docs/roadmap/01-editor-navigation-embeds.md` are currently untracked local documents and are deliberately excluded from this branch. Mark Phase 1 shipped in those files only after the live rollout is verified and the owner adds them to the repository.
