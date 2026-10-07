# Flags and release controls

Every switch that turns behavior on or off, as of `main` at `2ef1450`. For other variables, secrets, and limits, see
[Configuration](CONFIGURATION.md).

## Environment flags

These are set in the `vars` block of each environment in `wrangler.jsonc`. Only the exact string `"true"` enables a
flag; any other value or an unset variable disables it.

| Flag                               | Local / E2E  | Production | When off                                                                                                                                                                                                                                    |
| ---------------------------------- | ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXPANDED_EMBEDS_ENABLED`          | `true`       | `false`    | Only YouTube, Vimeo, and Figma frame; other provider URLs render as links. `POST /api/link-previews` and `GET /api/link-previews/:id/image` return 404 `preview_disabled`. Stored URLs are unchanged, and preview cache cleanup still runs. |
| `OFFLINE_EDITING_ENABLED`          | `true`       | `false`    | The service worker, installable shell, and offline catalog still work, but cached documents open read-only while offline.                                                                                                                   |
| `NOTION_MARKDOWN_WRITES_ENABLED`   | `true`       | `false`    | `PATCH /v1/pages/:id/markdown` returns 404 `object_not_found`, and queued async Markdown tasks are neither run nor recovered. `GET /v1/pages/:id/markdown` is unaffected.                                                                   |
| `WORKFLOW_INLINE`                  | E2E only     | unset      | Import and export jobs run on the `NOTES_WORKFLOW` Workflow. When it is `true`, jobs run inline instead, so the E2E environment needs no Workflows. **Never set it in production.**                                                         |
| `WORKSPACE_ACTIVITY_ENABLED`       | off / E2E on | `false`    | Hides Activity/Open work and disables canonical event recording. Recorded metadata still expires after 30 days.                                                                                                                             |
| `SLACK_CHANNEL_VALIDATION_ENABLED` | `false`      | `false`    | Uninitialized mappings retain legacy delivery. Disabling pauses initialized mappings and their legacy-ID events; backlog resumes when enabled. Configure the operator timezone before activation.                                           |
| `SLACK_SHARE_REFRESH_ENABLED`      | `false`      | `false`    | Stops queued attachment refresh effects and new lifecycle hooks; preserves recovery markers for paused queued work.                                                                                                                         |
| `SLACK_RICH_DIGESTS_ENABLED`       | `false`      | `false`    | Sends grouped text without images; saved scheduling, validation and receipts continue when strict validation is enabled.                                                                                                                    |

The Worker reports `EXPANDED_EMBEDS_ENABLED` and `OFFLINE_EDITING_ENABLED` to the client as
`features.expandedEmbeds` and `features.offlineEditing` in `GET /api/me`. Open tabs keep the old values until they
reload.

To change a flag:

1. Edit `wrangler.jsonc`.
2. Run `pnpm cf-typegen`.
3. Commit both files together and merge. `main` deploys automatically.

Flip a production flag only after that phase's live exit matrix passes. The pending flips are steps C2, C5, and C6 in
the [roadmap closeout](roadmap/README.md#round-1-release-closeout). To roll back, set the flag to `"false"` and deploy
again; none of these flags deletes data.

## Owner settings

These live in D1 and are changed at runtime by a workspace owner. They require no deploy.

| Setting                | Storage                                                 | API                                                                                         | Default | Behavior                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MCP access             | `workspaces.mcp_enabled`                                | `GET`/`POST /api/oauth/workspace`                                                           | off     | Gates OAuth consent and `/mcp`. Disabling bumps `mcp_generation`, revoking every grant and pending code; clients must reconnect after re-enabling.                       |
| Slack thread mirroring | `slack_channel_subscriptions.mirror_enabled`            | `PATCH /api/slack/channels/:id/mirror`                                                      | off     | At most one space-wide and one page-specific mirror is allowed, and a page mirror wins. Disabling retires that mapping's thread links (trigger `slack_mirror_disabled`). |
| Slack mute and snooze  | `slack_channel_subscriptions.muted_at`, `snoozed_until` | `PATCH /api/slack/channels/:id/pause` (`mute`, `unmute`, or `snooze` for 1, 8, or 24 hours) | off     | Stops new channel notifications, digests, and mirror roots. Replies under existing linked threads still sync.                                                            |

## Implicit gates

These capabilities have no switch of their own. Each one turns on when its prerequisites are present.

| Capability                  | Enabled when                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Slack integration           | All four of `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, and `SLACK_TOKEN_ENCRYPTION_KEY` are set                                                                     |
| Each Slack capability       | The installation has been granted that capability's scopes (`SLACK_CAPABILITY_SCOPES` in `src/worker/slack.ts`). Slack Settings lists the missing scopes and offers **Reauthorize Slack**. |
| Slack interactions, capture | The acting member has an OpenID-verified Slack link. A legacy `/notes link` covers outbound personal notifications only.                                                                   |
| Integration webhooks        | `WEBHOOK_ENCRYPTION_KEY` is set and valid                                                                                                                                                  |
| Offline app shell           | It is a production client build (`import.meta.env.PROD`). The service worker is not registered in the Vite dev server.                                                                     |

## Test-only switches

| Switch            | Where                     | Effect                                                                          |
| ----------------- | ------------------------- | ------------------------------------------------------------------------------- |
| `MENTION_BENCH=1` | Process environment       | Runs the skipped 10,000-node benchmark in `mention-targets.performance.test.ts` |
| `TEST_MIGRATIONS` | `vitest.worker.config.ts` | Injects the D1 migrations into the Worker test pool; not a runtime binding      |

## Planned

These flags are proposed by Round 2 plans and do not exist yet:

- `SLACK_OPS_ALERTS_ENABLED`, from [Phase 10](roadmap/10-operations-incidents.md).
- `slack_operations_destinations.enabled`. The column exists from migration `0035` but nothing reads it yet.

Add every new flag to this file in the PR that introduces it.

## Slack Round 2 activation

Before setting strict validation to true, an owner calls `POST /api/slack/channels/validate` for a read-only report of
all mappings in their workspace. Resolve shared/unsupported/unjoined channels and missing scopes. Set the deployment
variable `SLACK_DIGEST_DEFAULT_TIMEZONE` to a valid IANA timezone before migration/activation. The initial migration
persists 09:00 in that zone; subsequent operator-default changes affect new mappings only. Apply forward migration
`0067_review_delivery.sql`, then call owner-only `POST /api/slack/configuration/sync` to initialize eligible mappings.
Scheduled maintenance also synchronizes configuration. Authentication and Slack acknowledgment requests do not.
A missing or invalid default produces a clear activation error; existing saved schedules remain intact and
uninitialized mappings continue legacy digest delivery.

Enable and validate increments in order: strict channel settings, Activity/feed, share refresh, rich digests/images.
Workspace activity and strict validation must both be enabled before rich digests. Each increment requires the
[deployed Phase 9 matrix](roadmap/09-slack-digests-shares.md#exit-matrix). These controls remain off in production until
that verification is recorded. Operations alerts remain Phase 10.

Slack mapping initialization persists across validation rollback. Once initialized, a mapping and all its channel events use Round 2 ownership even when event IDs use the legacy format. Setting `SLACK_CHANNEL_VALIDATION_ENABLED=false` holds their backlog and recovery markers. Held work is excluded from runnable outbox health counts. Re-enable validation and synchronize configuration to resume delivery with the same retry budgets. Uninitialized mappings continue legacy delivery and recover only pending, never-attempted events; uncertain checkpoints remain available for Round 2 reconciliation.
