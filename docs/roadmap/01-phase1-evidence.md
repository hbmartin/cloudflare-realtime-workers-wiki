# Phase 1 implementation evidence

Baseline: `499af28`. Local verification: 28 September 2026. Production deployment has not been performed, so Phase 1 remains pending in the roadmap.

| Exit scenario                                                         | Evidence                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Editor and shell shortcuts, modes, permissions, focus                 | `src/client/WorkspaceNavigation.test.tsx`, `tests/e2e/phase1-production.spec.ts`             |
| Combobox, keyboard, touch, shortcut help                              | `tests/e2e/phase1-production.spec.ts` desktop and mobile projects                            |
| Math, Mermaid, highlighted code, existing iframe under production CSP | Built app and actual `_headers` in `tests/e2e/phase1-production.spec.ts`                     |
| Provider origin, normalization, sandbox, and open-original link       | `src/shared/embed-providers.test.ts`, `tests/e2e/phase1-production.spec.ts`                  |
| Unsafe URL, private and redirect targets, bounded HTML/images         | `src/shared/embed-providers.test.ts`, `src/worker/link-previews.integration.test.ts`         |
| Failed preview preserves a usable stored link                         | `src/client/editor-blocks.test.ts`, `tests/e2e/phase1-production.spec.ts`                    |
| Disposable cache migration and missing image                          | `src/worker/link-previews.integration.test.ts` migration replay, expiry cleanup, and R2 miss |
| Preview authentication, reuse, and expiry                             | `src/worker/link-previews.integration.test.ts`                                               |

Local gates: 1,121 unit tests, 675 Worker tests, 19 development browser tests, and 6 built-app production-policy browser tests passed. Unit and Worker coverage passed. Type checks, lint, middleware Semgrep rules, dead-code analysis, generated binding check, production build, and Wrangler production dry run passed. The full formatter check reports only the preexisting untracked `IDEAS.md`; it was left untouched.

The implementation adapts provider normalization and iframe URL validation patterns from AFFiNE's `embed-iframe-config.unit.spec.ts`, link fallback behavior from Outline's `DisabledEmbed.tsx`, and share-to-frame transforms from Docmost's `embed-provider.ts`. No comparator source was imported into this application.

## Production rollout

1. Deploy the CSP correction and built rendering proof with `EXPANDED_EMBEDS_ENABLED=false` using `pnpm exec wrangler deploy --env production --var EXPANDED_EMBEDS_ENABLED:false`. Confirm the live response header and the existing math, code, Mermaid, and iframe fixtures.
2. Apply `0049_link_preview_cache.sql` before enabling previews. The table and R2 keys contain only disposable derived data; document URLs remain authoritative.
3. After the exit matrix passes on the deployed Worker, set `EXPANDED_EMBEDS_ENABLED=true` and deploy the expanded catalog. Recheck a preview, all provider origins, and the health endpoint.
4. If a provider or proxy fails, set the flag to `false` and redeploy. Existing links and bookmark URLs remain readable. Delete expired cache entries and R2 objects with scheduled cleanup or purge the derived cache if its fetch policy changes.

Mark Phase 1 shipped in `README.md` and `01-editor-navigation-embeds.md` only after the live rollout is verified.
