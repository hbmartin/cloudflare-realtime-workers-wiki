# Using NoteFlare

NoteFlare is one private workspace with documents, diagrams, and typed tables. Your role and space membership determine what you can read or edit. Optional features may require [operator release controls](FLAGS.md).

## Write and organize

Create nested pages in a workspace or private space, use favorites/pins/tags to return to them, and use the command palette to find pages and actions. Documents collaborate through Yjs with presence and local Undo. Diagrams collaborate through the same room model but require a live connection for edits.

Comments are anchored to document blocks or diagram elements. Watches and notification preferences control in-app, email, and configured Slack delivery. Search, backlinks, and mentions can lag edits until the next compaction.

## Tasks and reminders

Task lists offer Table and Board views, assignees, due dates, status, and row-detail pages. They retain a single-editor lease; a Board view is not a saved collaborative database view. My Tasks gathers your assigned work.

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
