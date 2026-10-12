# One-click deployment verification

Validation performed on October 12, 2026. The README button remains commented out until the native
Cloudflare deployment and redeployment checklist passes.

## Completed checks

- Deployment, migration, origin, and existing upgrade-guard tests: 123 passing tests. Coverage includes
  explicit target selection, legacy identity detection, saved origins and resource names, Vite output
  selection, stale build metadata, secret reuse, auth-secret recovery, temporary-file cleanup, and
  failed migrations preventing upload.
- Relevant client unit tests passed for block links, offline storage/export, and live diagram embed
  pooling. The isolated Worker API integration suite passed 215 tests.
- Formatting, lint, client/Worker/test/config type checks, generated bindings, and dead-code analysis
  passed. Both legacy and portable builds and Wrangler dry runs passed.
- Cloudflare's default pnpm launcher installed the frozen lockfile using the pinned pnpm 11.18.0.
- A Workers Builds simulation recognized the deployed legacy Worker and its original D1 binding.
  The subsequent deployment dry run reused its build. Named `production` and `e2e` configuration
  sections remain byte-for-byte unchanged. The GitHub Actions release gate remains in place.
- A separate disposable Worker was deployed using local Wrangler OAuth. Preparation reused resources,
  derived the workers.dev origin, generated missing internal secrets, applied all fresh migrations,
  and verified `/api/health` and `/api/install`. The remote preflight explicitly allows D1's reserved
  `_cf_KV` table; unexpected tables still fail closed.
- Live API checks passed owner creation, authenticator enrollment, recovery-code acknowledgment,
  two-client Yjs collaboration, attachment upload/download, and Workflow-backed Markdown export.
  The owner API reported all five new-install feature defaults enabled.
- After creating content, deleting `BOOTSTRAP_TOKEN`, and disabling offline editing in the dashboard,
  portable redeployment passed. D1, R2, queue, Workflow, Durable Object, Analytics, and rate-limit
  bindings and the URL were unchanged. The three internal secret names remained present, with no
  replacement secrets uploaded. The setup key stayed absent; the original owner session and a new
  password-and-MFA sign-in worked. Content, attachments, exports, and the saved feature flag persisted.
- No secret values were inspected from the deployed Worker. Temporary deployment secret files were
  removed after upload. Existing production received no migration or Worker upload.

## Remaining release gate

Cloudflare's actual native deployment form detected the build/deploy commands, portable resource
bindings (including both queues), automatic URL, five feature defaults, and only one private setup
key. Deployment failed at repository setup because the account's existing GitHub authorization had
expired. A retry returned the same error, before native resources or builds were created.

Complete the account reconnect using
[Cloudflare's GitHub repair instructions](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/#reinstall-the-cloudflare-github-app).
Then test the native button with Cloudflare's default authorization, verify the complete editor flows
for the five enabled features, and repeat the content/setup-key-removal redeployment test. The local
OAuth deployment verifies application behavior but does not establish that the native build token has
all required permissions. Uncomment the README button only after those checks pass.

## Preview button availability

On October 12, 2026, the README deploy button was enabled as a preview at the owner’s request after the portable deployment implementation landed on `main`. The README and deployment guide retain the pending native authorization and editor-flow verification status. This change does not establish completion of the remaining release gate above.
