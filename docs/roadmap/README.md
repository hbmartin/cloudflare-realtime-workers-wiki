# NoteFlare phased roadmap

Status: plans complete; implementation pending. Baseline: `499af28` on 28 September 2026.

This directory is the implementation handoff for the capabilities selected from the
[25 September parity report](../../../PARITY.md). That report describes an older checkout. Recheck
the baseline below before using a gap as an implementation task. Each phase has a user contract,
interfaces and state ownership, recovery and rollout rules, and an exit matrix. Complete a phase's
exit matrix before marking it shipped; a merged patch or visible control alone is insufficient.

| Order | Plan                                                             | Depends on                                      | Baseline state | Implementation |
| ----- | ---------------------------------------------------------------- | ----------------------------------------------- | -------------- | -------------- |
| 0     | [Baseline and dependency map](00-baseline-dependencies.md)       | Current checkout audit                          | Complete       | Reference      |
| 1     | [Editor, navigation, and embeds](01-editor-navigation-embeds.md) | None                                            | Partial        | Pending        |
| 2     | [Slack capture](02-slack-capture.md)                             | Existing Slack installation and import workflow | Partial        | Pending        |
| 3     | [Date mentions and reminders](03-date-mentions-reminders.md)     | Existing document rooms and delivery pipeline   | Absent         | Pending        |
| 4     | [Offline documents](04-offline-documents.md)                     | Existing Yjs IndexedDB storage                  | Partial        | Pending        |
| 5     | [Notion Markdown API](05-notion-markdown-api.md)                 | Existing `/v1` block mutations and jobs         | Absent         | Pending        |
| 6     | [OAuth and MCP](06-oauth-mcp.md)                                 | Markdown API and shared page operations         | Absent         | Pending        |
| 7     | [Collaborative table foundation](07-collaborative-tables.md)     | Existing D1 table model                         | Absent         | Pending        |
| 8     | [Table views and properties](08-table-views-properties.md)       | Collaborative table cutover                     | Absent         | Pending        |

Orders 1–4 are independent release units. Order 5 precedes 6 so MCP tools can expose the
document Markdown contract. Order 7 must precede 8: new views and properties must be built on
the collaborative table authority rather than the expiring single-editor lease. No plan requires
an external calendar account, a desktop client, or Notion data-source API compatibility.

## Verified starting point

- `src/client/WorkspaceUI.tsx` has a `QuickSwitcher`, and `src/client/App.tsx` binds Cmd/Ctrl-K.
  It searches pages and recent items; it is not yet a command palette or shortcut help system.
- `src/worker/slack-product.ts` handles both manifest shortcuts. Current tests cover attributed
  message and thread copying and retry after a lost receipt. The current path creates a page,
  then queues a document append. `slack_captures` exists in migration 0035 but is unused by the
  capture handler. The [Slack roadmap](../../SLACK_INTEGRATION_ROADMAP.md) Milestone 3 gate is
  therefore still open.
- `src/client/collaboration.ts` persists opened documents through `y-indexeddb`. There is no
  service worker or installable shell, and startup requires live account and page metadata.
- `src/client/editor-blocks.tsx` frames YouTube, Vimeo, and Figma; `public/_headers` has no
  `frame-src` and limits `img-src` to local/blob/data. Code blocks have no syntax highlighter.
- `src/worker/notion-api.ts` pins `2026-03-11` and already serves pages, blocks, search, and
  comments with integration tokens and page grants. It has no page Markdown routes.
- Tables are authoritative in D1, expose five property types, and require a 60-second edit lease.
  `src/worker/tasks.ts` and the Slack task workflows read this D1 model directly.

The current checkout also contains untracked `IDEAS.md` and `SLACK_INTEGRATION_ROADMAP.md`.
Implementation work must preserve them and recheck the Git status before editing related files.
Older operator documentation, including `docs/API_COMPATIBILITY.md`, contains historical
architecture claims and is not a substitute for current source inspection.

## Comparator lessons and limits

- **Outline:** Use its date mention picker, action registry, provider descriptors, and Streamable
  HTTP MCP route as behavior and interface references. Its source lives in the sibling `outline/`
  checkout; do not import its BSL code into NoteFlare.
- **AFFiNE:** Its BlockSuite kanban/calendar view presets and local Yjs-backed editing show how
  multiple views can share data and how an opened document can reopen locally. Use the patterns,
  not its application code or unrelated calendar-account integration.
- **Docmost:** Its editor and Community edition provide comparison points for blocks and offline
  persistence. Its richer Bases implementation is in a private paid module, so property behavior
  here is specified from NoteFlare's needs rather than presumed to be available source.

## Cross-phase rules

Every write must use a stable operation or receipt ID where retries can repeat an effect. Access
is checked when work is requested and when delayed work executes. D1 projections must say which
Durable Object or R2 state is authoritative, how to detect lag, and how to rebuild. Each release
must include migration verification, a recovery path, and tests at the user-visible boundary.
No new capability is counted shipped merely because a menu item or API route exists.
