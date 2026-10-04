# Slack integration roadmap

Status: Milestones 0–3 shipped; Milestone 4 partial; Milestone 5 not started (audited 1 October 2026 against
`main` at `2ef1450`)

Scope: product requirements and phased implementation milestones

## Summary

When this roadmap was written, NoteFlare's Slack integration supported installation, manual identity linking,
slash-command search, link unfurls, personal notifications, and one-way channel notifications. This roadmap turns that
integration into a secure working surface for discussion, search, capture, sharing, and operations. The
[implementation status](#implementation-status) section records what has since shipped.

The roadmap covers seven related capabilities:

1. Bidirectional comment-thread mirrors.
2. Block Kit interactions, richer search, and an App Home inbox.
3. Slack-to-Notes page capture.
4. Content-rich channel digests.
5. Public-share lifecycle updates that remain accurate in Slack.
6. Slack OpenID identity and real mentions.
7. A separate Slack destination for operational incidents.

The work is deliberately phased around a single bot-scope expansion and workspace reauthorization. New inbound
features remain disabled until the installation has the required scopes, a member has an explicitly verified Slack
identity, and an owner opts an existing mapping into the relevant behavior.

## Implementation status

Audited on 1 October 2026 against `main` at `2ef1450`. Milestones are listed in their implementation order.

| Milestone                               | Status                     | Evidence and remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Secure foundation                   | Shipped                    | Better Auth Slack OIDC with implicit linking and signup disabled (`src/worker/auth.ts`). Invite-gated signup, team matching, and the MFA handoff are in place. The schema foundations are in migration `0035_slack_secure_foundation.sql`. Typed `SlackApiContracts` and scope health live in `src/worker/slack.ts`. The manifest already requests every scope below. **Remaining:** deprecate `/notes link`, which still issues legacy links.                                                                                                                                         |
| 1 — Bidirectional threads               | Shipped                    | Owner mirror opt-in (`PATCH /api/slack/channels/:id/mirror`). `slack_thread_links` and `slack_thread_deliveries` handle outbound delivery. Inbound replies go through `slack_inbound_receipts`, mrkdwn conversion, mention translation, and source suppression (`src/worker/slack-threads.ts`, `slack-thread-fanout.ts`). Migrations `0036`–`0046` add delivery ordering, recovery, and redrive.                                                                                                                                                                                       |
| 2 — Interactive workspace               | Shipped                    | `POST /api/slack/interactions` acknowledges within a 2.7-second deadline. It handles Resolve/Reopen, Watch, Mute, Snooze (1, 8, or 24 hours), and owner share actions; the search modal (ten-result paging); and the App Home Mentions inbox (`src/worker/slack-workspace.ts`, `slack-blocks.ts`). Interaction receipts are in `slack_interaction_receipts` and `slack_action_commits`.                                                                                                                                                                                                |
| 3 — Atomic capture                      | Shipped (#202)             | Both shortcuts claim `slack_captures` and publish a hidden staged import only after verification (`src/worker/slack-capture.ts`, `slack-capture-content.ts`; migrations `0053`–`0056`). Live signed-capture verification is tracked in [roadmap Phase 2](roadmap/02-phase2-evidence.md). The shipped modal can also create a **task**; this roadmap describes documents only.                                                                                                                                                                                                          |
| 4 — Rich digests and share lifecycle    | Implemented locally; gated | Round 2 adds validated channel selection, saved daily schedules, canonical Activity/Open work, multiple digest messages with persisted page/event partitions, one-summary bulk moves/archives, import channel suppression, private PNG uploads with phase-aware retries, transactional share refreshes and delivery reconciliation. Forward migration `0067` adds review fixes; activation uses scheduled maintenance or the owner configuration-sync endpoint. Production controls remain off pending the [Phase 9 live exit matrix](roadmap/09-slack-digests-shares.md#exit-matrix). |
| 5 — Operations channel and GA hardening | Not started                | `slack_operations_destinations` and `slack_incidents` exist only as tables from `0035`. Nothing produces incidents, and there is no `slack_ops_alert` topic. No queue consumer reads the delivery DLQs configured in `wrangler.jsonc`, and there is no ops-channel API, UI, or `SlackStatus` field. **Partial:** delivery-health endpoints (`slack_delivery_failures`, `0043`) and mirror disable without uninstalling.                                                                                                                                                                |

Open gaps outside the milestone list:

- **Channel validation at mapping time.** `upsertSlackChannelSubscription` stores a channel ID without calling
  `conversations.info`. Validation runs only when mirroring is enabled or an action, share, or capture executes, so
  one-way notifications can target an unvalidated mapping. This contradicts
  [§2](#2-channel-and-permission-boundaries).
- **Durable topics as built.** `slack_thread_reply`, `slack_interaction_response`, and `slack_home_publish` match
  this plan. The implementation added `slack_inbound_reply`, `slack_thread_action`, `slack_workspace_action`,
  `slack_unfurl`, `slack_search_update`, `slack_share_response`, `slack_controls_expire`, `slack_capture`,
  `slack_capture_feedback`, `slack_product_copy` (legacy reconciliation only), and `slack_channel`.
  `slack_share_refresh` and `slack_file_upload` are implemented behind their release flags.
  Only `slack_ops_alert` remains to be built.
- **Undocumented surface.** `/notes` also supports `new`, `task`, `tasks`, and `task-list`, and capture can target a
  task. Those flows are covered by `docs/CONFIGURATION.md` rather than this roadmap.

The remaining Milestone 4 and 5 work is scheduled as Round 2 phases in [the phased roadmap](roadmap/README.md).

## Goals and success criteria

- A permitted reply in a linked Slack thread creates exactly one NoteFlare comment, and a NoteFlare reply appears
  exactly once in the canonical Slack thread.
- Every inbound action identifies an explicitly Slack-authenticated NoteFlare member and re-derives current
  workspace, space, page, and thread permissions before reading or writing content.
- Slack identity is never linked by matching email addresses.
- Interactions acknowledge within Slack's deadline while durable work remains retryable and idempotent.
- A Slack message or thread can become a verified, atomically published NoteFlare page without AI summarization or
  partially visible imports.
- Digests describe actual changes and unresolved work rather than reporting event counts alone.
- A Slack unfurl always reflects whether its NoteFlare public share is active or revoked.
- Operational failures reach a destination distinct from content channels without leaking content or creating an
  alert loop.

## Product and security principles

### Server-authoritative access

Stored Slack links locate NoteFlare resources; they never grant access. Event ingestion, interaction handling,
outbox delivery, capture publication, and share refreshes must all re-check the current installation, identity,
workspace membership, effective space role, page visibility, and action-specific permission.

A permission check performed when work is enqueued is not sufficient. The same access boundary must be checked when
delayed work executes so membership removal, mapping removal, archiving, and role changes take effect immediately.

### Explicit identity

Slack user IDs are bound to NoteFlare accounts through Slack OpenID Connect. Email is requested as part of the
standard `openid profile email` identity response and may populate a newly invited account, but it must never be
used to discover, match, or merge an existing NoteFlare account.

Bot installation OAuth and user sign-in OAuth are separate flows. Bot tokens remain encrypted in
`slack_installations` and are the only tokens used for channel, message, file, and view APIs. Slack identity tokens
must not be used for bot operations.

### Durable, idempotent effects

Every Slack retry-prone input has a stable receipt, and every delayed output has a durable outbox or workflow record.
Slack event IDs, interaction identifiers, message timestamps, and capture source keys must prevent duplicate
comments, captures, shares, and operational alerts.

### Conservative activation

Existing channel mappings stay one-way after migration. An owner must explicitly validate the channel and enable
thread mirroring. Missing scopes, an unverified identity, a disconnected installation, or an invalid mapping disables
the affected capability without breaking existing notification delivery.

## Product requirements

### 1. Identity and authorization

#### Requirements

- Configure Better Auth's Slack OpenID provider with `openid profile email` and disable implicit account linking.
- Existing users connect Slack from NoteFlare Settings after completing protection and verifying TOTP/passkey within five minutes. Callback completion rechecks the authorizing session and protection generation. The connection must bind the Slack team ID and
  user ID returned by OpenID to the current Better Auth account and the active NoteFlare Slack installation.
- A valid, unused NoteFlare invitation may initiate Slack signup. The invite is reserved before redirect, carried in
  protected OAuth state, and consumed only after the callback establishes the new account.
- Public Slack signup remains closed. Slack signup without a valid invitation fails without creating an account.
- If a Slack profile's email already belongs to an account that has not explicitly linked that Slack identity, signup
  fails and directs the user to sign in normally and connect Slack from Settings. It must not merge the accounts.
- Slack sign-in is a primary factor only. Existing mandatory TOTP/passkey enrollment, verification, and fresh
  assurance requirements remain unchanged.
- The OpenID team ID must match the workspace's active Slack installation. A member cannot attach an identity from a
  different Slack workspace.
- Continue honoring authorized legacy `slack_user_links` for existing outbound personal notifications during migration. Installation disconnect/reconnect, protection changes, or lost membership revoke access and require explicit relinking; Settings shows delivery as paused until authorization is restored.
  Require an OpenID-verified link for interactions, inbound comments, capture, and Slack login.
- Deprecate `/notes link` once members have had a migration window. Do not silently upgrade legacy links to verified
  OpenID links.
- Slack Settings shows whether the current member is unlinked, legacy-linked, or OpenID-verified and provides the
  appropriate connect or migration action.

#### Failure behavior

- Unlinked and legacy-only users receive an ephemeral authentication prompt for interactive actions.
- Wrong-team, disabled, guest/external, or no-longer-member identities fail closed.
- Responses must not reveal the title or location of an inaccessible page, space, or thread.

### 2. Channel and permission boundaries

#### Supported conversations

The first release supports mapped public channels and mapped private channels. DMs, MPIMs, unmapped channels, Slack
Connect conversations, and external Slack identities are rejected.

Channel configuration must verify the channel type, bot membership, and current installation rather than trusting a
manually entered channel name. The bot must be present in a private channel before that channel can be mapped.

Private-space content may appear only in an explicitly mapped channel whose mapping remains active. Removing a
mapping prevents new roots, notifications, digests, captures, and share actions from relying on that mapping. Existing
Slack messages remain in Slack, but their actions must re-check current access and fail when the mapping is gone.

### 3. Bidirectional comment threads

#### Canonical mapping selection

- Add owner-controlled `mirror_enabled` state to channel mappings. It defaults to false for existing and newly created
  mappings until explicitly enabled.
- Permit at most one enabled space-wide mirror mapping for an installation and space, and at most one enabled
  page-specific mirror mapping for a page.
- A page-specific mirror overrides the space-wide mirror for that page. Other mappings may continue receiving
  one-way notifications or digests.
- Each NoteFlare comment thread has at most one active Slack thread link.

#### Notes to Slack

- The first eligible comment-thread event sent to the selected mirror mapping creates a bot-authored root message.
- Parse and persist the `chat.postMessage` response, including `channel` and `ts`, before treating the root as linked.
- Subsequent NoteFlare replies use the stored `ts` as `thread_ts` and are delivered through a
  `slack_thread_reply` outbox topic.
- A NoteFlare user mention becomes `<@U123>` only when that member has a verified identity for the same installation.
  Otherwise render a non-pinging, escaped `@Display Name`.
- Resolve and reopen events update the bot-authored root and retain the reply history.

#### Slack to Notes

- Accept only ordinary user replies whose `thread_ts` matches an active `slack_thread_links` row. Ignore bot messages,
  the NoteFlare bot's own messages, unsupported subtypes, edits, and deletions.
- Resolve the Slack author through an OpenID-verified identity link, then reconstruct a fresh `MemberContext` and
  re-check the mapped channel, workspace membership, page visibility, and thread access.
- Convert the supported Slack mrkdwn subset into a bounded, validated ProseMirror `CommentBody` before calling
  `addCommentReply`.
- Convert `<@U123>` to a NoteFlare mention only if that Slack identity belongs to a current member who can access the
  page. Preserve an escaped plain-text label when it cannot be resolved safely.
- Record the Slack event ID, channel, message `ts`, thread `ts`, resulting comment ID, and origin before acknowledging
  durable completion. A retry returns the existing result.
- Mark Slack-authored comments as Slack-originated so regular NoteFlare notifications and projections still run but
  the reply is not sent back to its source Slack thread.
- Slack message edits and deletions do not mutate NoteFlare comments in this release.

#### Pause semantics

`Mute this mapping` and `Snooze` are owner-only shared controls. They stop new channel notifications, digests, and
mirror roots. Replies under already linked Slack roots continue to write to NoteFlare while the mapping exists. Snooze
offers 1-hour, 8-hour, and 24-hour durations; mute remains active until an owner restores the mapping.

### 4. Block Kit, App Home, and search

#### Interaction endpoint

- Add `POST /api/slack/interactions`.
- Read and verify the raw form body with the existing Slack signing-secret, timestamp, and replay protections before
  parsing the `payload` field.
- Acknowledge within Slack's three-second window.
- Call `views.open` synchronously while its trigger ID is valid. Queue only work that does not require the live trigger,
  such as message refreshes, App Home publication, and durable mutations.
- Add stable interaction receipts for actions and modal submissions so retries cannot repeat a mutation.

#### Contextual actions

Blocks display only actions meaningful to the message context and current member:

- Resolve or reopen a comment thread using the existing NoteFlare permission rule.
- Watch or unwatch the referenced page for the acting member.
- Mute, unmute, or snooze a mapping for a workspace owner.
- Create or view an active public share for a workspace owner.

Authorization or validation failures are ephemeral and use generic resource language when the resource is no longer
visible.

#### Search modal

- `/notes <query>` opens a search modal rather than returning a five-line ephemeral result.
- Inputs map directly to the current `SearchFilters`: query, space, tags, page kind, and archive state.
- Return ten results per modal page. Keep the filters and bounded offset in modal state and use `views.update` for
  Next/Previous navigation.
- Re-run the server-authoritative search and visibility predicates on every page request.

#### App Home

- Subscribe to `app_home_opened` and publish a Home view with `views.publish`.
- Use the existing cursor-based Mentions inbox, not the offset-based generic notification feed.
- Display ten items at a time with Next/Previous controls, unread state, the actor and page context, and safe actions or
  links for the referenced page.
- Re-publish after relevant inbox actions and on explicit pagination; tolerate a stale page by returning a generic
  unavailable state.

### 5. Slack-to-Notes capture

#### Entry points and modal

- Add the message shortcut **Save to Notes**.
- Add the thread shortcut **New page from thread**.
- Open a modal containing the target space, optional parent page, and page title.
- Show only destinations where the verified member currently has write access. Revalidate the destination at modal
  submission and again before publication.
- Restrict capture sources to supported, actively mapped public or private channels.

#### Transcript format

Create deterministic Markdown containing:

- The source Slack permalink and capture timestamp.
- Each message's author, timestamp, and normalized text.
- Reactions and counts.
- Attachment names, metadata, and safe Slack links or message permalinks.

Do not download Slack file bytes, embed bot-authenticated private URLs, or generate a summary. Fetch full threads using
cursor pagination, observe `Retry-After`, and impose documented message and output-size bounds before starting the
import.

#### Publication and provenance

- Stage the generated Markdown in R2 and invoke the existing import workflow.
- Treat a valid Slack modal submission as confirmation, but retain all existing staging, hash verification, metadata
  verification, and atomic publication behavior.
- Extend import options with an optional target parent. The parent must be in the chosen space and writable at request
  time and publication time.
- Persist a `slack_captures` record keyed by installation, channel, source/root timestamp, and capture kind. Store the
  initiating Slack and NoteFlare identities, job ID, eventual page ID, state, and timestamps.
- Repeated shortcuts or Slack retries return the existing job or page rather than creating another import.
- Report queued, succeeded, and failed states ephemerally to the initiating user. A failed workflow exposes no partial
  pages.

### 6. Content-rich digests and honest shares

The approved Round 2 contract and exit matrix are in [Phase 9](roadmap/09-slack-digests-shares.md). Operations alerts
remain Phase 10.

#### Channels, schedules, and workspace Activity

- Owners choose joined, unarchived public/private channels with a searchable paginated picker. Reject all shared
  channels, DMs and MPIMs, including existing mappings. Slack supplies canonical names. Validate create/update and
  delivery, then revalidate every 15 minutes. Successful checks automatically resume delivery while preserving
  owner mute/snooze and mirror opt-in; Settings shows specific health reasons.
- Save an editable daily time, IANA timezone and open-work toggle per digest mapping. Migrate to 09:00 in the
  operator-supplied `SLACK_DIGEST_DEFAULT_TIMEZONE`; persist the default so later operator changes affect new mappings
  only. Missing/invalid configuration prevents new digest activation. Include weekends and use existing DST
  resolution: earlier repeated occurrence, first valid minute after a gap.
- Send the latest scheduled window only, on the first scheduler tick after the boundary. Drop older missed windows;
  schedule edits begin at the next future boundary. Mute/snooze discards paused channel activity while retaining
  canonical workspace history.
- Add page creation, moves, archives and task status changes to the five existing channel selections, enabled on
  migration and by default on new mappings. Owners may deselect them in either cadence. Personal notification
  preferences stay separate. Continue suppressing comment activity already mirrored into the channel.
- Activity is a workspace-member sidebar destination independent of Slack. Its chronological cursor-paginated feed
  defaults to seven days and filters by space/page/event. Open work shows current unresolved comments and unfinished
  tasks regardless of age. Record successful mutations from every publication path after activation, deduplicate
  retries, retain metadata for 30 days and enforce current access on every request.

#### Digests

- Group qualifying activity by page, showing link, distinct actor names without pings, change types, current task
  status, unresolved-comment count and a current plain-text excerpt. Default bounds are 240 excerpt characters,
  five actors plus the remaining count, and ten pages in one message with escaped bounded Slack text.
- With open-work enabled by default, include unchanged pages with unresolved comments or tasks in To do/In progress,
  marked “No new activity.” Send nothing on quiet days with no open work. Changed pages sort by newest activity,
  then unchanged open work by unresolved count; page ID breaks ties deterministically.
- Archived/moved-out pages receive departure notices with authorized current titles or generic wording; omit
  excerpts and thumbnails. End every digest with the deployed Activity mapping-filtered continuation link. That
  live overview includes recent activity and current open work with access to both tabs; mapping IDs grant no access.
- Prepare private diagram SVG projections asynchronously as PNG using `BROWSER`, then upload privately through typed
  `files.getUploadURLExternal` and `files.completeUploadExternal`. Ready images use `slack_file.id`. Cache by
  installation generation, page, epoch and content hash, allowing multiple revisions per epoch. Missing/failed
  images send text immediately; never edit posted digests later or expose R2 objects publicly.
- Durable digest receipts fence installation generation, mapping and boundary. Use claims, message metadata and
  history reconciliation after uncertain posts/checkpoint failures. Unresolved uncertainty stays blocked and
  visible; retries honor Slack Retry-After and cannot blindly duplicate delivery.

#### Share lifecycle

- Only current workspace owners may perform share actions; reuse NoteFlare's shared share service. Track both page
  links and direct public-share URLs in valid mapped channels, with observer/provenance and lifecycle revision.
- Queue initial tracked unfurls and all share/availability transitions transactionally. Create/revoke from Slack or
  NoteFlare, page archive/delete/move, mapping changes, membership/role changes and space-access changes trigger
  refreshes. Preserve cleanup targets before cascades. No periodic lifecycle sweep; recover already queued work.
- Serialize effects per message/reference and reread current state. Active previews keep existing share actions.
  Revoked previews retain authorized title/excerpt, state revocation, remove active URLs and offer owner-only Create
  share. Access loss renders generic unavailable text without actions, including cleanup after mapping removal or
  owner demotion while the bot retains channel access.
- Old direct public-share URLs stay revoked after replacements; page-link previews may show the replacement.
  Repeated [`chat.unfurl`](https://docs.slack.dev/reference/methods/chat.unfurl/) updates attachments. Never use
  `chat.update` on the original user message. Permanent rejections for existing accessible messages produce one
  bot thread fallback per transition; missing/deleted originals do not. Use durable fallback receipts and reconcile
  uncertain post outcomes before retries.

### 7. Separate operations channel

#### Configuration

- Allow a workspace owner to configure one operations channel per Slack installation.
- Store it separately from content subscriptions and verify its channel type and bot membership.
- Removing the operations destination stops new Slack alerts but does not delete incident records.

#### Incidents

Post one message for every distinct durable incident:

- Each import or export job that reaches a terminal failed state.
- Each primary delivery message that reaches the configured DLQ.
- Each document transition across the 16 MiB warning threshold.
- Each document transition across the sticky 24 MiB read-only threshold.

Use a stable source key per job failure, DLQ message, or threshold transition. Retries of the same incident must not
duplicate the Slack alert, but distinct failures must not be coalesced or reduced to a digest.

Messages contain safe resource identifiers, the error category, occurrence time, retry state, and a remediation link.
They must not contain document bodies, comment bodies, imported content, Slack tokens, raw exception strings, or
other unbounded user data.

Add a consumer for the delivery DLQ that records an incident before scheduling its alert. If a `slack_ops_alert`
delivery itself reaches the DLQ, record telemetry and stop; never generate an operational alert about that alert.

## Interfaces and data model

Names below describe the intended contracts; migrations may consolidate closely related receipts when the same
uniqueness and retention guarantees are preserved.

### Routes and events

- Expand `POST /api/slack/events` for `message.channels`, `message.groups`, and `app_home_opened`.
- Add `POST /api/slack/interactions` for block actions, shortcuts, modal submissions, and view navigation.
- Use Better Auth's Slack social sign-in and account-link callbacks for user identity; keep the bot installation routes
  under `/api/slack/oauth/*`.
- Expand Slack Settings status and mapping APIs with identity verification, scope health, channel validation, mirror
  state, pause state, and operations destination.

### Durable delivery topics

Add dispatch and recovery support for:

- `slack_thread_reply`
- `slack_interaction_response`
- `slack_home_publish`
- `slack_share_refresh`
- `slack_file_upload`
- `slack_ops_alert`

`views.open` is explicitly excluded because it must run synchronously with the interaction trigger.

### Identity and installation records

Extend `slack_user_links` with the Better Auth account identity, OpenID verification method/time, and migration state.
The installation/team remains part of every uniqueness boundary. Existing unverified rows remain usable only for
legacy outbound personal delivery.

Update the shared `SlackStatus` and client settings types to expose:

- Installation connection and granted/missing scopes.
- Current member identity state.
- Channel type and validation health.
- Mirror, mute, and snooze state.
- Operations destination health.

### Channel mappings

Extend `slack_channel_subscriptions` with:

- Validated channel type and validation timestamp.
- `mirror_enabled`.
- `muted_at` and `snoozed_until`.
- Any installation/channel membership health needed to explain why delivery is disabled.

Enforce the one-space and one-page mirror constraints and preserve page-specific precedence.

### Thread and inbound receipts

Add `slack_thread_links` with the installation, subscription, workspace, page, NoteFlare thread, channel, root
`message_ts`, state, and timestamps. Enforce uniqueness for both the NoteFlare thread and Slack root.

Add per-event/message receipts that relate Slack event/message identity to the resulting NoteFlare comment and record
the origin needed for source suppression. Retain receipts as long as the linked thread exists.

### Capture, share, file, and operations records

- `slack_captures`: source identity, capture kind, member, workflow job, result page, state, and idempotency timestamps.
- Slack share references: unfurl message/link identity, page/share identity, and last rendered lifecycle state.
- Slack file artifacts: installation, page/epoch/hash, Slack file ID, upload state, and timestamps.
- Operations destination and incident records: safe source key, category, resource IDs, delivery state, and timestamps.

### Slack API client

Replace the current response-discarding wrapper with typed method results. Callers must be able to consume message
timestamps, view hashes, file IDs, pagination cursors, `Retry-After`, granted scopes, and structured Slack error codes.
Token refresh remains centralized and all logs pass through existing error redaction.

## Slack app manifest and reauthorization

Status: complete. `slack-app-manifest.yaml` and `SLACK_BOT_SCOPES` in `src/worker/slack.ts` already request all eleven
scopes and four events below, and Slack Settings offers **Reauthorize Slack** when stored scopes are missing. The lists
are kept as the reference contract.

Request one bot-scope expansion after backward-compatible code is deployed.

Original bot scopes:

- `commands`
- `chat:write`
- `links:read`
- `links:write`

New bot scopes:

- `channels:read`
- `channels:history`
- `groups:read`
- `groups:history`
- `users:read`
- `reactions:read`
- `files:write`

Do not request `users:read.email`, `files:read`, `im:history`, or `mpim:history`.

Subscribe to:

- `link_shared`
- `message.channels`
- `message.groups`
- `app_home_opened`

Enable interactivity, the App Home tab, **Save to Notes**, and **New page from thread**. Retain token rotation and
`org_deploy_enabled: false`.

The application must compare stored and required scopes and show an owner-facing reauthorization prompt. Existing
features continue operating when old installations have only the original scopes; each new capability remains gated
on its required scopes.

## Phased milestones

### Milestone 0 — Secure foundation and single reauthorization

Status: Shipped.

#### Deliverables

- Better Auth Slack provider with implicit linking disabled.
- Invite-gated Slack signup, existing-account connection, team matching, and MFA handoff.
- Legacy-link migration state and identity visibility in Slack Settings.
- Backward-compatible schema foundations for mappings, receipts, threads, captures, shares, files, and operations.
- Typed Slack API responses and scope-health reporting.
- Manifest update and one workspace reauthorization.

#### Exit gate

Slack login and connection work without email matching; invite creation remains closed; MFA remains mandatory; scope
health is visible; and existing unfurls, search, and notification delivery continue to work for installations that have
not yet reauthorized.

### Milestone 1 — Canonical bidirectional threads

Status: Shipped.

#### Deliverables

- Owner mirror opt-in and deterministic mapping selection.
- Root `message_ts` persistence and `slack_thread_reply` delivery.
- Inbound reply receipts, identity/permission reconstruction, mrkdwn conversion, real mentions, and source
  suppression.
- Resolve/reopen support and ephemeral denial responses.

#### Exit gate

Duplicate or retried Slack events create one NoteFlare comment; NoteFlare replies appear once in the canonical Slack
thread; Slack-originated replies never echo; and membership or permission revocation blocks queued and subsequent
writes.

### Milestone 2 — Interactive Slack workspace

Status: Shipped.

#### Deliverables

- Reusable Block Kit builders and `/api/slack/interactions`.
- Resolve/Reopen, Watch/Unwatch, Mute, Snooze, and share actions.
- Filtered search modal with ten-result paging.
- Cursor-based App Home Mentions inbox.

#### Exit gate

All actions enforce current permissions, modal and App Home navigation remain stable across retries, interaction
receipts prevent duplicate mutations, and handlers acknowledge within Slack's deadline.

### Milestone 3 — Atomic Slack capture

Status: Shipped in #202; live verification pending.

#### Deliverables

- Message and thread shortcuts with the destination modal.
- Cursor-paginated transcript retrieval and deterministic Markdown conversion.
- Capture provenance and idempotency.
- Parent-aware import options and automatic verified publication.
- Ephemeral queued, success, and failure status.

#### Exit gate

Double submissions return one job/page; inaccessible destinations are unavailable; long threads paginate correctly;
and a workflow failure leaves no published partial page.

### Milestone 4 — Rich digests and share lifecycle

Status: implemented locally behind production controls initially off; deployed validation and live exit gates remain.

#### Deliverables

- Strict channel picker/validation, saved daily schedules, and canonical workspace Activity/Open work.
- Content-rich, bounded Block Kit digests with unresolved-thread and unfinished-task context.
- Slack-hosted diagram thumbnails with content-hash caching and text fallback.
- Owner-only share creation and stored unfurl lifecycle references.
- Unfurl refresh on share creation and revocation.

#### Exit gate

Digests stay within Slack limits; image failure degrades to text; revoked shares are visibly marked in every stored
unfurl; private thumbnails never traverse a public endpoint; and all scheduling, activity, permissions and delivery
recovery scenarios in the [Phase 9 exit matrix](roadmap/09-slack-digests-shares.md#exit-matrix) pass against the deployed
Worker. Review increments: channel settings/validation, activity recording/feed, queued share lifecycle, then rich
digests/thumbnails. Run a channel backfill dry-run and configure the operator timezone before strict activation.
Separate controls gate Activity, strict validation, share refresh and rich rendering. Disabling rich rendering retains
text digests, scheduling, validation and receipts.

### Milestone 5 — Operations channel and GA hardening

Status: Not started.

#### Deliverables

- Separate operations-channel configuration.
- Job failure, DLQ, and document-size incident producers.
- Idempotent, non-recursive operations delivery.
- Metrics, owner-facing health, runbooks, and disable/rollback controls.
- Implementation-time updates to `docs/CONFIGURATION.md`, `SECURITY.md`, and operations/troubleshooting documentation.

#### Exit gate

Every distinct configured incident is posted once; sensitive content is redacted; an operations-alert failure cannot
loop; and an owner can disable inbound mirroring without uninstalling Slack.

## Test plan

### Migration and compatibility

- Verify table/index constraints, cascades, migration from existing installations, and `mirror_enabled = false` for
  every existing mapping.
- Verify an old-scope installation continues current functionality and reports each unavailable new capability.
- Verify disconnect/reinstall preserves no stale identity, thread, capture, or delivery authority.

### Authentication and authorization

- Cover invited Slack signup, explicit existing-account linking, same-email refusal, wrong-team refusal, OAuth
  state/replay expiry, legacy-link restrictions, and mandatory MFA.
- Revoke workspace, space, page, thread, owner, and mapping access after ingestion but before execution; every delayed
  operation must fail closed.
- Verify errors do not reveal inaccessible titles, spaces, channel mappings, or member identities.

### Slack contracts

- Cover request signatures, timestamps, retries, duplicate event IDs, bot/self filtering, unsupported subtypes,
  public/private boundaries, token rotation, Slack rate limits, and typed error responses.
- Cover mrkdwn conversion, mention translation in both directions, bounded comment bodies, canonical-root uniqueness,
  source suppression, and resolution-state updates.
- Assert interactions acknowledge in under three seconds in integration tests even when downstream work is delayed.

### Search and App Home

- Cover every `SearchFilters` field, ten-result navigation, stale modal state, permission changes between pages, Mentions
  cursor navigation, read state, and unavailable resources.

### Capture

- Cover message and long-thread capture, cursor pagination, reactions, attachments as links, title/space/parent
  validation, transcript bounds, rate-limit retry, workflow failure, atomic publication, and duplicate submissions.

### Digests, files, and shares

- Cover content grouping, unresolved counts, Block Kit limits, deterministic truncation, thumbnail caching, upload
  failure fallback, and permission changes before send.
- Cover owner-only share creation, an existing active share, revocation, multiple stored unfurls, and `chat.unfurl`
  refresh failures.

### Operations

- Cover each incident source, one-alert-per-source idempotency, distinct repeated failures, safe field allowlisting, DLQ
  consumption, Slack delivery retries, and recursion prevention for failed `slack_ops_alert` messages.

## Rollout and rollback

1. Deploy additive migrations, typed Slack API handling, feature gates, and code that remains compatible with old
   installations.
2. Update the Slack app manifest and have the workspace owner reauthorize once for the bundled bot scopes.
3. Invite members to connect or migrate their Slack OpenID identity. Legacy outbound notifications continue during the
   migration window.
4. Have an owner validate channels and explicitly enable one canonical mirror mapping per intended page/space.
5. Enable milestones sequentially, observing authorization failures, duplicate suppression, delivery latency, Slack
   rate limits, workflow outcomes, and outbox/DLQ growth at each exit gate.
6. Configure the operations destination before declaring general availability.

Rollback is additive: disable new inbound and mirror modes, stop new capture/interactivity entry points, and leave the
schema and expanded scopes in place. Queued work continues to re-check authorization and either completes safely or
retires. Rolling back must not require deleting receipts, thread links, or OAuth records.

## Observability

Measure without logging content:

- Slack event and interaction acknowledgement latency.
- Authorization rejection counts by safe reason code.
- Inbound receipt duplicates and comment creation outcomes.
- Outbox delivery latency, retries, rate limits, and terminal failures by Slack topic.
- Active verified identities and remaining legacy links.
- Active mirror mappings and thread-link creation failures.
- Capture workflow duration and terminal state.
- Digest size/truncation and thumbnail upload/fallback counts.
- Share refresh success/failure.
- Operations incidents created, delivered, and terminally failed.

Use correlation IDs, installation/workspace IDs, and opaque resource IDs only. Do not emit Slack message bodies,
comment bodies, page titles, import content, OAuth codes, tokens, response URLs, or raw unbounded exceptions.

## Assumptions and explicit non-goals

- One Slack installation per NoteFlare workspace and one NoteFlare workspace per Slack team remain unchanged.
- Slack Connect, Enterprise Grid org deployment, and multiple installations require a later schema and trust-model
  project.
- DMs and MPIMs are not read, captured, mirrored, or used as notification destinations.
- Each NoteFlare comment thread has one canonical Slack mirror. Other mappings remain eligible for one-way
  notifications or digests.
- Mapping mute and snooze affect shared outbound traffic only; replies under an existing linked thread remain active.
- Slack message edits and deletions do not edit or delete NoteFlare comments.
- Capture copies transcript data and safe links, not Slack file bytes.
- Share creation remains owner-only.
- Operational alerts send every distinct failure rather than coalescing failures or producing a scheduled digest.
- No Workers AI, Vectorize, generated summaries, semantic search, or other model-backed processing is introduced.
