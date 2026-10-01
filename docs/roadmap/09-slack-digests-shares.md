# Phase 9: Slack digests, share lifecycle, and workspace activity

Status: implemented locally; release controls remain off in production. Deployment verification and the live exit
matrix below are required before marking this phase shipped. Round 2, Track B closes Slack roadmap
[Milestone 4](../SLACK_INTEGRATION_ROADMAP.md#milestone-4--rich-digests-and-share-lifecycle). Operations alerts remain
Phase 10. This document incorporates the approved product interview decisions.

## Channel settings and schedules

Owners choose canonical Slack channel names through a searchable, paginated directory. Search follows every directory
page. Only joined, unarchived public/private channels qualify; shared channels, DMs and group DMs are rejected,
including existing mappings. Validation runs on create/update, immediately before delivery, and every 15 minutes.
Settings explains validation failures. Successful revalidation resumes delivery without changing mute, snooze or
mirror opt-in. The directory uses the existing `channels:read` and `groups:read` scopes.

Every digest mapping stores a daily time, IANA timezone and open-work toggle. The operator must supply a valid
`SLACK_DIGEST_DEFAULT_TIMEZONE` before activation/migration. Existing mappings migrate to 09:00 in that timezone;
new mappings use the same defaults. The approved operator default is `America/Los_Angeles` (Pacific). Changing the operator default does not change saved mappings. A schedule edit
starts at the next future boundary. Delivery runs every day, including weekends, on the first scheduler tick after
the time. Local-time resolution chooses the earlier repeated occurrence or first valid minute after a DST gap.

A digest covers the interval between the previous and latest scheduled boundaries. Older missed windows are dropped;
there is no catch-up delivery. Mute/snooze prevents channel delivery and discards activity during the pause. Canonical
workspace activity remains available.

Channel selections are separate from personal notification preferences. The existing five selections—mentions,
replies, resolved threads, reopened threads and edits—gain page creation, moves, archives and task status changes.
The four additions are selected on migration and all nine are selected by default for new mappings. Owners can
change them in either immediate or digest cadence. Comment activity already mirrored into the Slack channel is
suppressed from channel notifications and digests.

## Workspace Activity

Workspace members have an Activity sidebar destination regardless of Slack installation or mappings. Activity is a
chronological cursor-paginated feed, initially showing seven days, with space/page/event filters. Open work shows
current unresolved comments and unfinished tasks of any age. Recording begins at activation; historical events are
not fabricated. Lightweight event metadata is retained for 30 days and pruned by the scheduled maintenance task.

Slack continuation links use the deployed NoteFlare origin and open `?view=activity&mapping=<id>`, with recent activity
and current open work, plus access to both tabs. This is a live overview, not a historical digest. Mapping IDs confer
no permission: every request rechecks workspace membership and current space/page access.

## Digest contents

Read current D1 projections at delivery and group qualifying events by page. Display a page link, distinct actor names
without pings, change types, current task status, unresolved-thread count and a current plain-text excerpt. Bounds are
240 excerpt characters, five actors plus an additional-actor count, and ten pages in one message. Escaping and output
bounds keep sections and the aggregate message within Slack limits. Changed pages sort by newest qualifying event,
then page ID; unchanged open work sorts by unresolved-thread count, then page ID.

Open-work reminders default on and include unchanged pages with unresolved comments or tasks in To do/In progress,
marked “No new activity.” Nothing qualifying means no message. Archived/moved-out pages get departure notices;
authorization controls whether their current title can appear. Departure notices omit excerpts and thumbnails.
Every digest ends with the Activity continuation link.

Eligible diagram projection changes prepare thumbnails asynchronously. Read private SVGs from R2, rasterize to PNG
through `BROWSER`, privately upload with typed `files.getUploadURLExternal`/`files.completeUploadExternal`, and render
ready images through `slack_file.id`. Cache identity includes installation generation, page, content epoch and
projection content hash, allowing multiple revisions in an epoch. A missing/failed upload sends text immediately.
Never edit a posted digest later to add an image or expose an R2 URL.

## Share lifecycle and recovery

Track observed NoteFlare page links and direct public-share URLs in valid mapped channels, including the observing
member and reference provenance. Transactional hooks queue refreshes from share creation/revocation and availability
changes: archive/delete, moves, mapping changes, membership/role changes and space access/visibility changes. Targets
are copied before cascades remove pages or references. Initial tracked unfurls also use the refresh queue so stale
captured blocks cannot overwrite a newer lifecycle state. There is no periodic share-lifecycle sweep; existing
outbox recovery redispatches already queued work only.

Serialize refresh effects per message and reread current state before rendering. Active previews retain the existing
owner-only share action. Revoked previews retain authorized title/excerpt, explicitly state revocation, remove active
public URLs and offer owner-only Create share. Unavailable previews are generic and have no actions; cleanup is
allowed after mapping removal or owner demotion while the bot can still access the channel. Direct old public URLs
remain pinned to the revoked share after a replacement is created; page links may show the replacement.

Repeated [`chat.unfurl`](https://docs.slack.dev/reference/methods/chat.unfurl/) updates attachments; never use
`chat.update` on user-authored messages. A permanent unfurl rejection for an existing accessible message posts one
bot thread reply per rendered lifecycle transition. Missing/deleted originals have no fallback; transient failures
retry and honor `Retry-After`.

Digest and fallback receipts use durable claims and Slack message metadata. A lost response or failed post-delivery
checkpoint requires history reconciliation before another post. Unresolved uncertainty remains blocked and visible
in Settings. Owner recovery checks evidence again; it never blindly reposts. Immediate channel events use the same
reconciliation rule. Installation generations fence stale jobs, and failures at one destination do not stop other
destinations.

## Implementation increments and rollout

Migration `0066_slack_round2.sql` adds canonical activity, saved schedules, digest receipts, share refresh snapshots,
reference lifecycle metadata, thumbnail revision keys and transactional triggers. Source comments/edits retain stable
operation identifiers and existing epoch/transaction guards. Lifecycle triggers cover successful browser, Slack,
API/MCP, task, import and template-copy publication; staged and failed publication emit nothing.

Review and validate these increments against the deployed Worker separately:

1. Channel validation/settings: directory, mapping updates by ID, operator timezone, saved schedules and health.
2. Activity recording/feed: canonical events, current-access filtering, Activity and Open work.
3. Queued share lifecycle: provenance, transactional availability hooks, attachment cleanup and fallback recovery.
4. Rich digests/thumbnails: grouping, open-work reminders, receipts, asynchronous private PNG uploads.

The implementation can be reviewed in that order:

| Increment                   | Main implementation                                                                                                              | Local verification                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Channel settings/validation | `slack-channels.ts`, `slack-schedule.ts`, mapping APIs, `SlackChannelPicker.tsx`, `SlackSettings.tsx`                            | Directory pagination, unsupported channels, repair, operator defaults, schedule edits and DST                                          |
| Activity recording/feed     | Canonical events and publication/task triggers in `0066_slack_round2.sql`, `notifications.ts`, `activity.ts`, `ActivityView.tsx` | Publication guards, retry deduplication, current permissions, pagination, historical open work                                         |
| Queued share lifecycle      | Refresh triggers/snapshots, `slack-shares.ts`, observed-reference capture and owner actions                                      | Reversed jobs, replacement shares, access-loss cascades, current observers, permanent rejection fallback and reconciliation            |
| Rich digests/thumbnails     | `slack-digests.ts`, `slack-channel-events.ts`, `slack-files.ts`, `slack-recovery.ts`, `slack-blocks.ts`                          | Bounded grouping, mirrored suppression, quiet days, concurrent claims, lost responses/checkpoints, private uploads and cache revisions |

Shared schema and queue wiring support the four increments; deployment verification remains a separate gate for
each.

Release controls are `WORKSPACE_ACTIVITY_ENABLED`, `SLACK_CHANNEL_VALIDATION_ENABLED`,
`SLACK_SHARE_REFRESH_ENABLED` and `SLACK_RICH_DIGESTS_ENABLED`, initially off in production. Before activating strict
validation, an owner runs `POST /api/slack/channels/validate` for a read-only backfill report and resolves rejected
channels/scopes. Configure the timezone before schedule migration. Enable workspace activity and strict validation
before rich digests. Share refresh can be enabled separately. Turning rich digests off removes image rendering while
retaining grouped text, scheduling, validation and receipts. Release-paused queued work preserves recovery markers.
See [Flags](../FLAGS.md) and [Configuration](../CONFIGURATION.md).

## Exit matrix

Local automated coverage is in `slack-round2.integration.test.ts`, the Activity/picker client tests and
`tests/e2e/slack-round2.spec.ts`. These do not replace the live Slack/Worker matrix.

| Scenario                                                                                    | Required result                                                                                             |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Paginated search; public/private joined; shared/archived/DM/MPIM                            | Only valid joined channels selectable; canonical names; later-page matches found                            |
| Bot removal, missing scopes, automatic repair                                               | Specific Settings health; no delivery; repair preserves mute/snooze/mirror                                  |
| Timezone migration/edit, weekends, DST gap/repeat, midnight, delayed tick                   | Saved defaults, next-future edits, latest window only, one logical send per boundary                        |
| Browser/Slack/API/MCP/tasks/import/template publication and retries                         | Canonical metadata once, only successful publication, no fabricated history                                 |
| Activity permissions, filters, cursor, 30-day retention and Open work                       | Current access on every request; old unfinished work visible; valid deployed continuation                   |
| Grouped events, mirrored suppression, many actors/pages, quiet days                         | Deterministic ten-page cap, escaped bounded text, no duplicated mirrored activity, no empty post            |
| Unchanged unfinished tasks/comments, archives and moves                                     | “No new activity”; current status/counts; authorized departure titles; no departure excerpts/images         |
| Concurrent consumers, rate limits, lost post response or checkpoint                         | Durable claims; Retry-After; history reconciliation; blocked visible uncertainty; no blind duplicate        |
| Private/public channels, cache revisions, stale projections and upload failure              | Private PNG upload, ready-file reuse, multiple revisions per epoch; immediate text fallback; no later edits |
| Page/direct-share URLs, create/revoke on both surfaces, reversed queues, replacement shares | All references reflect current state; old public URLs remain revoked                                        |
| Access loss after mapping/member/page changes and deletions                                 | Generic unavailable attachment, no actions/URLs, cleanup survives cascades                                  |
| Permanent old-message rejection, deleted originals, transient failure                       | One thread fallback per transition; none for missing originals; retry transient failures                    |

Do not mark Phase 9 shipped until repository checks, relevant Worker/client tests, cross-browser verification and the
live exit matrix all pass. Record deployed evidence with each increment. Phase 10 operations alerts are excluded.

## Local validation evidence — 1 October 2026

- Client/unit coverage: `pnpm test:coverage` — 1,432 passed, one existing skipped test; coverage thresholds passed.
- Full Worker coverage: 912 passing tests across 20 files; coverage thresholds passed with one Worker.
- Focused Round 2 Worker suite: 53 passing tests. This includes the final regression for older fallback reconciliation
  after a newer transition, alongside lost responses/checkpoints, concurrent consumers, current observers and revoked URLs.
- Slack acknowledgment deadline regressions: five passing tests.
- Formatting, lint, middleware checks, all TypeScript projects, dead-code analysis and generated binding checks passed.
- Production client build and `wrangler deploy --env production --dry-run` passed.
- Eight browser cases passed across Chromium, Firefox, WebKit and mobile Chromium, including accessibility checks.
  Activity uses real local mutations; owner picker/schedule verification uses mocked Slack responses.

Run the full Worker coverage suite with `pnpm test:worker:coverage --maxWorkers=1` when other local browser/runtime
jobs contend for resources. Cross-browser command:
`NODE_OPTIONS=--dns-result-order=ipv4first pnpm exec playwright test tests/e2e/slack-round2.spec.ts`.
The IPv4 setting is needed where `localhost` resolves to IPv6 but the local test server binds IPv4.

Production migrations, deployment, channel-backfill execution, feature activation and the live Slack exit matrix
have not been performed. The test workspace/channels must be identified before posting digests or changing test
share/channel access. Production release controls remain off; local automated results do not mark Phase 9 shipped.
