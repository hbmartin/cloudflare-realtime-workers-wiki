# Login rollout diagnosis — 2026-09-14

The production failure was reproduced in the Codex built-in browser and correlated with `wrangler tail` at 21:58:33 UTC:

```text
GET /api/install - Ok
GET /api/security/status - Ok
ERROR [Better Auth]: D1_ERROR: no such column: claimed_by at offset 51: SQLITE_ERROR
```

The request outcome is `Ok` because the exception is handled; this does not mean the HTTP response succeeded. Search error-level Better Auth logs, not only warning-level logs or uncaught Worker exceptions.

Read-only production D1 checks found migration history ending at `0028_mandatory_security.sql`. The `claimed_by` and `claimed_email` columns, `pending_passkeys` table, and lifecycle triggers from `0029_security_lifecycle.sql` are absent. All existing users have an `account_security` row (`users_missing_security = 0`).

## Results

| Check                         | Result                                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing migration             | Confirmed in production by schema inspection and the live SQL error.                                                                                                                                                                                                                  |
| Bad response/network failure  | Browser failure injection reproduced generic errors for HTML, empty responses and rejected fetches. The Worker trace identifies a database error for the production incident.                                                                                                         |
| Missing account security rows | Ruled out in production. A deliberately removed local row is detected and causes HTTP 403 with `Sign in again.`                                                                                                                                                                       |
| Restricted storage            | Both storage probes passed on the local diagnostic origin. Deliberately blocking session storage reproduces the generic error before any API request. Production retries reached both startup endpoints, ruling out this failure in the observed session.                             |
| Legacy-user upgrade           | A real password account was created before migration 0028. After the full migration history, its old session was rejected, first login required enrollment, TOTP and recovery acknowledgment completed, and `/api/me` returned the original workspace and role.                       |
| Missing-0029 reproduction     | Anonymous status succeeds and password sign-in succeeds, but authenticated status returns HTTP 500 with an empty body. This reproduces the production UI error.                                                                                                                       |
| Logging gap                   | Empty HTTP 500, network failure, and blocked storage produce no startup console error in the tested code. The trust-completion helper consumes both expected 403 and unexpected 500 responses. These are recorded as current behavior, not assertions that the behavior is desirable. |

No production schema, account protection, membership, or deployment was changed by this investigation. The corrective change is to apply the missing **0029** migration to the production database, then retry the existing browser session. Review pending migrations before using a general migration-apply command: this working tree also contains an independent observability migration, 0030.

## Repeat the read-only deployment preflight

Run from the repository root:

```sh
node scripts/check-account-security.mjs --remote --env production
```

The command uses the installed Wrangler CLI. Exit 0 means schema, migration records, and account backfill pass; exit 1 means a failed check; exit 2 means incorrect usage or unavailable CLI/database access. It outputs schema names and aggregate counts, never user identifiers or credentials. It failed against production as expected and passed against a fully migrated disposable local D1 database.

## Repeat the regression checks

```sh
pnpm exec vitest run src/client/login-diagnostics.test.tsx src/client/api.test.ts
pnpm exec vitest run --config vitest.worker.config.ts src/worker/login-diagnostics.integration.test.ts
```

Both suites passed: 29 client/API tests and 3 Worker tests. The new diagnostic tests characterize the current failure signatures and should be updated when startup error handling is improved.

Formatting and lint checks passed for the added code. Repository type checks encountered existing in-progress observability errors: an unused `errorLogFields` import in `index.ts` and unresolved `node:async_hooks` types in `observability.ts`.

## Repeat the built-in browser checks

```sh
pnpm exec vite --config tests/diagnostics/vite.config.mjs
```

Open `http://127.0.0.1:4174/tests/diagnostics/login.html` in the built-in browser. Run the storage probe, then each scenario. The harness renders the real App with simulated startup responses and reports request path, status, content type, and body length. It uses no backend bindings or production credentials. Storage probes touch only newly generated disposable keys. All seven scenarios were exercised: normal startup, HTML, empty 200, empty 500, JSON 500, network failure, and blocked storage.
