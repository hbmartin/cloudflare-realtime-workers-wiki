# Using NoteFlare

NoteFlare is one private workspace with documents, diagrams, and typed tables. Your role and space membership determine what you can read or edit. Optional features may require [operator release controls](FLAGS.md).

## Write and organize

Create nested pages in a workspace or private space, use favorites/pins/tags to return to them, and use the command palette to find pages and actions. Documents collaborate through Yjs with presence and local Undo. Diagrams collaborate through the same room model but require a live connection for edits.

Comments are anchored to document blocks or diagram elements. Watches and notification preferences control in-app, email, and configured Slack delivery. Search, backlinks, and mentions can lag edits until the next compaction.

Use the sidebar branch menu to sort immediate children by title or update time. Sorting is personal; switching back to Manual restores the stored order. **Move to space root** moves a page and its descendants to the root of its space. **Reveal in sidebar** opens and focuses its location, including the containing table for hidden row-detail pages. Template copies retain the template's captured tags.

Document Find searches across formatting and hidden tabs; editors can replace one match or all displayed matches and undo the action. Page information shows creator, last editor and contributors, with labels when historical coverage is partial. If a document cannot render, its recovery controls provide retry, version history and a recovery download.

After an operator enables new block creation, documents can insert status badges, tabs, footnotes and linked table views. Tab selection is personal. Footnotes number themselves by reference order and retain unused definitions. Presentation opens a frozen read-only snapshot; changes to the source do not update its slides. Existing blocks remain readable and exportable when new creation is disabled.

## Tasks and reminders

Task lists offer assignees, due dates, status and row-detail pages. My Tasks gathers your assigned work. Legacy tables retain the single-editor lease and fixed Table/Board toggle until an owner completes the verified collaborative-table migration.

Migrated tables use saved Grid views, with Board and Calendar creation controlled separately. Views share the same rows and properties. Grouped row creation sets the selected group in one action. Property conversions preview converted, empty and invalid values while retaining originals until commit; clearing invalid values requires confirmation. Formula properties are read-only results, and view calculations cover all filtered rows. Linked table views and diagram page cards require access to their source page.

Insert a date mention and choose its reminder settings. Delivery follows the installation's scheduled handler and channel preferences, so it need not arrive exactly at the selected minute. Ask an operator about cron or delivery queues when due reminders remain absent.

## Offline work and app installation

A production build offers an installable app shell and a catalog of opened documents. Offline document mutation requires `OFFLINE_EDITING_ENABLED`; when off, cached documents remain read-only offline. Reconnect and complete sync before AI writing or server-authoritative actions. Diagrams retain a disconnected view but resume editing only after live sync.

## Links embeds and sharing

Page/member mentions and backlinks help connect knowledge. Expanded provider embeds, block-link copy/highlighting, and live diagram viewports each have separate flags. A link conveys no additional permissions. Live diagram viewports are read-only and require authorization and a network connection.

Public document/table share links expose the content explicitly shared through that link. Share only intended material and revoke a link when access should end. Diagram public rendering is outside v1.

## Import export and capture

Import Markdown, sanitized HTML, Word, or a Notion ZIP. Export documents as Markdown, HTML, Word, portable ZIP, or PDF; diagrams export JSON/SVG/PNG/PDF. PDF needs the optional browser service. Long jobs continue through resumable Workflows and appear in activity/job status.

Configured Slack offers Save to Notes and New page from thread with a verified linked identity. Rich channel digests, share refresh, and document comparison summaries require additional controls. Diff digests show comparison unavailable when there is no valid historical baseline.

Use [AI writing](AI_WRITING.md) for drafts with explicit sources and [the ChatGPT plugin](CHATGPT_PLUGIN.md) for an authorized wiki connector. Use [account security](ACCOUNT_SECURITY.md) for recovery and [Troubleshooting](TROUBLESHOOTING.md) for errors.
