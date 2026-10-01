# Phase 9: Slack digests, share lifecycle, and channel validation

Status: planned (Round 2, Track B). This plan closes Slack roadmap
[Milestone 4](../SLACK_INTEGRATION_ROADMAP.md#milestone-4--rich-digests-and-share-lifecycle) and the channel-validation
gap. It depends only on shipped Slack Milestones 0–2.

## User contract and baseline audit

A channel digest describes what changed: grouped pages, the people who changed them, the kind of change, and the count
of unresolved comment threads, with links that open NoteFlare. A digest about a diagram can include its thumbnail as a
Slack-hosted image. Without a thumbnail, the digest is still delivered as text. Every Slack message that unfurled a
NoteFlare link and received a public share from an owner shows the share's current state. After revocation, the unfurl
says that public access was revoked and no longer presents the old URL as live. An owner can map only a channel that
NoteFlare has verified, and a mapping whose channel later becomes unusable stops delivery and explains why in Slack
Settings.

Baseline, audited 1 October 2026 at `2ef1450`:

- `sendDueSlackChannelDigests` in `src/worker/slack.ts` sends one mrkdwn section listing events. It applies mute and
  snooze (`suppressed_at`, migration `0039`), but has no grouping, actors, or unresolved counts.
- `slack_file_artifacts` (migration `0035`) exists but is never written. The Slack API contract has no `files.*`
  methods, although `files:write` is already granted. Diagram thumbnails are private SVGs in R2, located through
  `diagram_projections.thumbnail_r2_key` (`src/worker/diagram-thumbnail.ts`).
- Owner share creation from an unfurl action works and writes `slack_share_references` (state `observed`).
  `chat.unfurl` runs only for the first unfurl. `revokeShare` in `src/worker/shares.ts` has no Slack hook, and no
  reference ever moves to `updated` or `retired`.
- `upsertSlackChannelSubscription` stores a hand-entered channel ID without `conversations.info`. `validateChannel` in
  `src/worker/slack-threads.ts` runs only when a mirror is enabled or an action, share, or capture executes.

## Interfaces and data flow

- **Channel validation at mapping time.** Call `validateChannel` from the mapping create and update API before the row
  is written. Store `channel_type`, `validation_state`, `validated_at`, and `bot_is_member`, and reject DMs, MPIMs,
  Slack Connect, and private channels the bot has not joined. Add revalidation of active mappings to the scheduled `slack_digests` task, which already runs every 15 minutes. A
  `channel_not_found`, `not_in_channel`, or archived result marks the mapping blocked and surfaces the reason in
  `SlackStatus`, without deleting it. Existing unvalidated mappings get one backfill pass. A mapping that fails the
  backfill becomes blocked rather than silently continuing.
- **Digest content.** Build digests from D1 projections at send time: changed pages grouped by page, distinct actors,
  change types, and the open `comment_threads` count per page. Recheck that the subscription, space, and page are
  still eligible and visible to the mapping. Add a pure `digestBlocks()` builder in `src/worker/slack-blocks.ts` with
  deterministic ordering and truncation under Slack's block and text limits. End a truncated digest with an
  "Open in NoteFlare" continuation link. Today the digest claims `slack_channel_events`, posts, and then sets `delivered_at`. A failure after the post but before the mark reposts the digest once the claim expires. Add a digest receipt keyed by mapping and window so a retry posts once.
- **Diagram thumbnails.** Add `files.getUploadURLExternal` and `files.completeUploadExternal` to `SlackApiContracts`
  with typed results. Add a `slack_file_upload` outbox topic. Claim `slack_file_artifacts` by installation, page,
  epoch, and content hash; upload only on a cache miss; and reference the Slack file ID in the digest image block.
  Slack does not reliably preview SVG, so discovery must confirm the format. If needed, rasterize to PNG with the
  production `BROWSER` binding and hash the PNG. A failed upload records `failed` and the digest sends as text. Never
  expose the R2 object through a public or temporary URL.
- **Share refresh.** Add a `slack_share_refresh` outbox topic, enqueued after commit by both `createShare` and
  `revokeShare` for every `slack_share_references` row of that page and installation generation. The handler
  rechecks owner status and page visibility, renders the active or revoked unfurl, and calls `chat.unfurl` with the
  stored channel and message `ts`. It then advances the reference to `updated` or `retired`, with a rendered-state
  hash so replays are no-ops. Never call `chat.update` on a user-authored message. Discovery must confirm Slack
  accepts a later `chat.unfurl` for an older message. If Slack refuses, post a bot reply in that message's thread
  stating that public access was revoked, and record the fallback.

## Migration, rollout, and recovery

The additive migration adds a rendered-state hash and a last-error column to `slack_share_references`, plus the digest receipt table. File artifacts and references are derived data and can be retired and rebuilt. Ship
in this order: mapping validation (with a backfill dry-run report first), then share refresh, then rich digests behind
`SLACK_RICH_DIGESTS_ENABLED`, then thumbnails behind the same flag. Disabling the flag returns to the current text
digest. Queued refreshes recheck access and either complete or retire.

## Exit matrix

| Scenario                                                                | Required result                                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Map a public, private-joined, private-unjoined, DM, or archived channel | Only the first two are accepted; the rest show a safe reason                        |
| Channel archived or bot removed after mapping                           | Next sweep blocks the mapping; no delivery attempt; Settings explains               |
| Digest with many pages and actors, and open threads                     | Grouped content within Slack limits; deterministic truncation and continuation link |
| Page hidden or subscription muted between enqueue and send              | Hidden page omitted, or digest suppressed; no title leak                            |
| Diagram digest: cache miss, cache hit, upload failure                   | One upload per hash; reuse on hit; text digest on failure with recorded failure     |
| Create a share, then revoke it, with multiple stored unfurls            | Every reference shows active, then revoked; replay changes nothing                  |
| Owner demoted, or page archived, before refresh executes                | Refresh renders the generic unavailable state; no share URL disclosed               |
| `chat.unfurl` rejected for an old message                               | Documented fallback posted once; reference records the fallback                     |
