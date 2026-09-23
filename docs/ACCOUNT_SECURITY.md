# Mandatory account protection

Every owner, editor, and viewer enrolls an authenticator app or a passkey before accessing private data. There is no opt-out or grace period. Public shares and machine integration credentials retain their existing access rules.

Authenticator users enter a primary factor and a six-digit code. The primary factor is normally their password; a verified, session-bound Slack OpenID sign-in may replace password re-entry for ten minutes during TOTP setup or recovery. It never creates session assurance and never replaces TOTP, passkey, or recovery-code proof. Passkeys replace password entry and require the authenticator to verify a PIN or biometrics. The server checks the verified WebAuthn result, not just the requested browser options. Passkeys are bound to the hostname and exact origin of `BETTER_AUTH_URL`; use `localhost` for local testing, not an IP address. A production hostname change requires a passkey migration strategy or another enrolled factor.

## Sessions and trusted browsers

The server stores assurance for each session. Enrollment flags alone cannot authorize a private request. Password-only sessions and outstanding authentication challenges cannot access the workspace or manage an already enrolled account. A verified factor is required within the last five minutes for security changes. Recovery codes must be saved before initial access.

Trust is an explicit, unchecked-by-default choice. An opaque HttpOnly/SameSite cookie references a hashed, revocable D1 record. Cookies use Secure on HTTPS deployments. The deadline is 30 days from factor verification, and password sign-in/session refresh never extends it. Native Better Auth rolling trust is disabled. Trust grants also expire when their server record is revoked. Authenticator replacement, factor removal, and recovery revoke existing browser trust and other sessions.

Realtime grants last at most five minutes and are capped by session/assurance expiry. Existing sockets may remain connected for up to five minutes after revocation. The client does not load workspace documents until authorization succeeds; this feature does not encrypt or remotely erase previously downloaded IndexedDB data.

## Recovery

Every enrollment method receives ten single-use recovery codes. They are displayed once and stored only as hashes. Replacing an existing batch is staged for 30 minutes: the active codes and normal workspace access remain unchanged until the user acknowledges the displayed receipt, at which point the staged hashes atomically replace the active set. Starting another replacement invalidates the earlier receipt. Recovery use, an operator reset, or an account-security generation change also discards staged replacements. Initial enrollment remains blocked until its first batch is acknowledged.

A password or fresh session-bound Slack primary proof plus an active recovery code creates a ten-minute recovery session. Other sessions, browser trust, and the remaining recovery codes are revoked. The response displays a random recovery resume key once, with a save acknowledgment; only its hash is stored. The user must restore a factor and save new recovery codes before accessing the workspace. If the ten-minute grant expires, the original live recovery session can resume enrollment after primary-factor re-entry. A replacement sign-in requires both a fresh primary factor and that saved one-time key. The key can be claimed by only one replacement session. Both paths expire 24 hours after the original recovery and never grant private access by themselves. Factor restoration, another recovery, or an operator reset revokes the key. Recoveries begun before this key was introduced can resume only in their original live session.

For loss of all factors and codes, a deployment operator must verify identity outside the app, then run:

```sh
pnpm security:reset person@example.com --remote --identity-verified
```

Use `--local` for a local database. The command immediately revokes factors, sessions, trust, and recovery codes in a single database operation, and prints a one-time token that expires in 30 minutes. Deliver it privately. The user signs in with their existing password and uses “Use a recovery code or operator reset,” then enrolls again. Workspace owners cannot issue resets. This does not reset forgotten passwords or add email/SMS recovery.

## Deployment and rollback

1. Complete `pnpm check` and `pnpm test:e2e` and preserve the database backup and `BETTER_AUTH_SECRET`. TOTP secrets are encrypted with this secret; losing it invalidates them.
2. Deploy migration `0028_mandatory_security.sql` and the client/Worker release in one maintenance window. The migration deletes existing sessions and challenges. Every existing user must sign in and enroll; ensure the deployment operator can assist users.
3. Verify owner enrollment, authenticator and passkey sign-in, a blocked password-only API request, a realtime reconnect, and an existing public share against the deployment origin.
4. Monitor `account-security` events and HTTP authentication rejection/rate-limit outcomes. Events contain identifiers and outcomes, never passwords, TOTP secrets, recovery codes, reset tokens, or credential payloads.

Production preview URLs are disabled so older or alternate versions cannot be exposed through public preview routes.

Do not roll back to a Worker that lacks the mandatory policy: that would restore password-only access. On a faulty release, keep access closed while deploying a corrected Worker. Restored database backups must invalidate all sessions, verification challenges, session assurance, and browser trust before reopening access.

### Initial rollout verification — 2026-09-13

Production version `14b77bec-d667-4444-9726-c3eb5d721c46` was deployed after a private database export and successful migrations through 0028. Live checks confirmed the sign-in UI, anonymous health/security status, private API and realtime denial, and the canonical passkey RP ID with required user verification. No active public share existed for a live share check; anonymous sharing passed the local integration suite. Production enrollment with a user's own authenticator remains a user action.

Validation passed: 787 unit tests with coverage; the full 325-test Worker coverage suite followed by all 11 updated security tests; all 13 Chromium tests, including concurrent last-factor removal; and a 30-connection authenticated realtime load check. Lint, type checks, dead-code analysis, generated binding checks, application formatting, and production builds passed. The repository-wide `pnpm check` stops at unrelated formatting errors in the pre-existing untracked Notion export; its remaining checks were run separately. Those user files were left unchanged.

## Invitation and authentication limits

Invite acceptance gives a new-account signup a unique ten-minute reservation. Slack signup starts only through the server-owned invite endpoint, and the exact reservation, workspace, and Slack team travel in encrypted OAuth server context. A failed signup releases only that reservation, so another legitimate attempt can proceed without leaving a poisoned claim. Existing local accounts prove their password before the invitation is mutated; existing verified Slack accounts may accept through Slack. Once authentication succeeds, the pending invitation belongs to that account in D1, supersedes its older unused claim for the same workspace, and can complete only after protection enrollment. Completion consumes only a valid claim and clears the account's other unused claims. Existing members do not consume bearer invitations, and removing a member deletes that account's unused claims in the same transaction. Completed invitations cannot recreate revoked membership.

Authentication limits use monotonic, deliberately fail-closed fixed windows. Password sign-in, signup, and two-factor routes use Better Auth's strict limit of three requests per source IP every ten seconds; passkey assertion verification permits 60 per minute and other authentication endpoints permit 100 per minute. Password sign-in and invite acceptance for an existing account also share a normalized-email-and-source bucket of ten password attempts per 15 minutes. A successful password authentication clears only that source's bucket, so one remote source cannot lock the account everywhere. Password-proven TOTP and recovery attempts retain the persistent account budget. Unverified passkey credential IDs never charge that account budget. New rate-limit buckets retire stale predecessors, and the scheduled 15-minute task prunes idle stale buckets and expired staged recovery-code batches.

Deploy migrations `0029_security_lifecycle.sql`, `0030_security_review_followups.sql`, and `0031_rate_limit_retention.sql` before the updated Worker/client, in the same maintenance window. Migration `0029` adds invitation claims and binds passkey persistence to the session and security generation that verified registration. Migration `0030` adds expiring claim leases and staged recovery-code storage, cleans up legacy invitation reservations, indexes rate-limit expiry, hardens membership creation validation, and makes account-security initialization safe when restored rows are loaded before users. Migration `0031` bounds stale rate-limit growth as new distinct buckets arrive. These additive migrations remain compatible with the Worker released alongside `0029` during the migration window.

## Command-line clients

The Notion importer requires an enrolled authenticator and a fresh `NOTES_IMPORT_TOTP_CODE` alongside `NOTES_IMPORT_PASSWORD`. Neither credential is read from command-line arguments. Passkey users can add an authenticator in Security settings to use this client.

The local realtime load check bootstraps and completes real authenticator enrollment against its disposable database. Deployed checks require `NOTES_LOAD_TOTP_CODE` or the enrolled base32 `NOTES_LOAD_TOTP_SECRET` alongside the existing credentials. Store the latter as `STAGING_LOAD_TOTP_SECRET` for nightly staging checks. Protect it like a password and use a dedicated test account.
