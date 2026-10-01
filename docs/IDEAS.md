# Product ideas backlog

Written on 25 September 2026 against a checkout with 34 migrations. Each item's status was last audited on
**1 October 2026** against `main` at `2ef1450` (migrations through `0065`). Item numbers are stable; cite them as
`IDEAS #n`.

Status key: **Done** means the capability shipped. **Partial** means part of the item exists, and the note says what
remains. **Planned** means the item has a phase plan in [the phased roadmap](roadmap/README.md). **Open** means
nothing has been built. The body text below each status is the original 25 September proposal; where it describes
code that has since changed, the status note takes precedence.

## Status at a glance

| Status     | Items                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| Done       | 11 palette · 15 toggle headings · 16 date reminders · 42 MCP · 45 PWA shell · 63 Slack thread capture |
| Planned    | 2, 3, 4 (subset), 9 → roadmap Phases 7–8                                                              |
| Partial    | 1, 3, 10, 14, 18, 19, 20, 23, 26, 27, 38                                                              |
| Unverified | 22 (BlockNote defaults only)                                                                          |
| Open       | Everything else                                                                                       |

Done and partial items came mostly from roadmap Round 1 (#201–#210). The [roadmap README](roadmap/README.md#round-2)
lists the open items proposed for Round 2.

## Where the product stood on 25 September

Genuinely strong already: realtime docs + diagrams, anchored comments, notifications/digests/Slack, versions + restore, share links, attachments with range/ETag handling, a real `/v1` Notion-compatible API with PAT tokens + per-page grants + signed webhooks, FTS5 search with BM25 across title/body/comments/tags/attachments, Notion ZIP import, and PDF/ZIP export through Workflows. That's well past "toy wiki."

The one structural hole: **tables are not databases.** `ColumnType` is `text | number | checkbox | date | select` (`src/shared/types.ts:7`), edits go through a 60-second single-editor lease, and there's exactly one view — a grid. No filters, sorts-as-config, grouping, relations, rollups, or formulas anywhere in the codebase. Row detail pages exist in schema (`table_row_pages`) but are only ever written by the Notion importer (`src/worker/importer.ts:1413`) — you can't create one in the app. For most Notion users, databases _are_ Notion, so this is the gap that decides whether the project reads as "a nice wiki" or "a Notion replacement."

---

# Part 1 — The database gap (highest leverage, staged)

Each stage is independently shippable and each one is visible to users.

1. **Row pages for real (S).** _Status: Partial — task-list rows create row pages (`src/worker/tasks.ts`), but generic `POST /api/tables/:pageId/rows` still writes only `table_rows`._ Wire `table_row_pages` into `POST /api/tables/:pageId/rows` so every row has a document behind it, and make "Open row details" open a real editable page whose properties are the row's cells. This is the single change that turns a table into a database. The read path already joins it (`src/worker/index.ts:5128`).
2. **Saved views (M).** _Status: Planned — roadmap Phase 8 (saved Grid/Board/Calendar views), after Phase 7._ A `table_views` table: `kind` (grid/board/gallery/calendar/list), filter JSON, sort JSON, group-by column, visible columns, per-view page size. Server-side filter/sort already exists in the paging code — views are mostly a config surface plus a compiler from filter JSON to SQL.
3. **Board / calendar / gallery renderers (M each).** _Status: Partial — task lists have a fixed Table/Board toggle (`TasksView.tsx`); no saved views or calendar/gallery. Board and Calendar are planned in Phase 8._ Board groups by a `select` column and drag-drops between groups (one cell write). Calendar groups by a `date` column. Gallery is cards keyed off a cover attachment. These reuse one data layer; the cost is UI, not backend.
4. **More column types (M).** _Status: Planned (subset) — Phase 8 adds multi-select, person, URL, status, and created/edited metadata. Email, phone, files, and unique ID are open._ `multi_select`, `person` (FK to `user`), `url`/`email`/`phone` (text + validation + render), `files` (FK to `attachments`), `status` (select with todo/doing/done semantics for boards), `created_time`/`created_by`/`last_edited_time`/`last_edited_by` (free — the columns exist on rows), and `unique_id` (an auto-increment with a prefix; teams use it as a ticket number).
5. **Relations and rollups (L).** _Status: Open — explicitly outside Round 1 and Round 2._ A `table_relations` join table plus a rollup evaluator. Do rollups on read first (they're cheap at 20k rows if indexed), and only add materialization if profiling demands it.
6. **Formulas (L).** _Status: Open — explicitly outside Round 1 and Round 2._ A small, total expression language — no recursion, typed, evaluated server-side on read and cached per-row. Resist shipping Notion's formula language wholesale; ship 20 functions that cover 95% of use.
7. **Inline databases (M).** _Status: Open._ A `database` block in the BlockNote schema that renders a view of a table page inside a document. Notion users expect this constantly and its absence is very visible.
8. **Linked views (S, after 7).** _Status: Open._ The same block pointed at another table page with its own filter — "my tasks" on a personal dashboard.
9. **Kill the lease, or make it invisible (M–L).** _Status: Planned — Phase 7 adopts option (a): one Table Durable Object per table, with D1 kept as a read projection._ The 60-second single-editor lease is the most un-Notion-like thing in the product. Two paths: (a) put each table behind its own Durable Object and make cells a Yjs map — realtime and offline for free, same architecture as documents; (b) keep D1 authoritative and get optimistic concurrency via cell-level revisions plus `WorkspaceEvents` fan-out. (a) is more work and much better.
10. **CSV import → table page (S).** _Status: Partial — CSV parsing and type inference exist only inside Notion ZIP import (`src/shared/import-content.ts`); the import dialog does not accept `.csv`._ `POST /api/tables/:pageId/bulk` already does replayable bulk writes with idempotency. A CSV parser plus a column-type-inference step is a weekend, and it's the #1 "get my data in" ask after Notion import.

---

# Part 2 — Practical wins

### Editor and page

11. **Cmd+K command palette / quick find (S, high impact).** _Status: Done — #201: ⌘/Ctrl-K, P, and Shift-P palette with a command registry and `?` shortcut help._ There is no global keyboard handler anywhere in the client. Cmd+K search-and-jump, Cmd+P page jump, Cmd+Shift+P command menu (create page, move, export, toggle theme). Nothing else in this list changes daily feel as much per line of code.
12. **Comment reactions (S).** _Status: Open — `server-thread-store.ts` still throws `Comment reactions are not enabled.`_ `src/client/server-thread-store.ts:230` literally throws `"Comment reactions are not enabled."` The thread store already carries an empty `reactions: []`. Finish it, and add reactions on blocks too.
13. **Page covers (S).** _Status: Open — no cover column; `/v1` returns `cover: null`._ `pages` has `icon` but no cover. Add `cover_attachment_id` + `cover_position`, an unsplash-or-upload picker, and render in the page header and gallery cards.
14. **Page display options (S).** _Status: Partial — full width shipped (migration `0047`). Small text and the page-info popover are open, and `updated_by` is still unused in the UI._ Full-width, small text, and a page-info popover (created by / last edited by / word count / contributors). `updated_by` already exists in schema and is unused in the UI.
15. **Toggle headings (S).** _Status: Done — provided by BlockNote's default heading spec and slash menu, and probably already present when this was written. Notion import maps `is_toggleable`._ BlockNote supports them; they're a Notion staple for long wiki pages.
16. **Date mentions and reminders (M).** _Status: Done — #203: `dateMention` tokens, private reminders, and migrations `0057`–`0060`._ No `reminder` exists anywhere. `@tomorrow 9am` inline, backed by a `reminders` table and the existing `*/15` cron + `DELIVERY_QUEUE` + notification preferences. Almost all the plumbing is already built and unused for this.
17. **Copy link to block + deep-link highlight (S).** _Status: Open — no `#block=` deep links._ Anchoring already exists for comments; reuse the anchor to build `?page=X#block=Y` with a flash highlight on arrival.
18. **Wider embed allowlist (S).** _Status: Partial — #201 added Loom, Google Docs/Sheets/Slides/Drive, Miro, Spotify, and CodePen behind `EXPANDED_EMBEDS_ENABLED` (off in production). Google Maps, Excalidraw, and a generic oEmbed fallback are open._ `allowedEmbedUrl` permits only YouTube, Vimeo, and Figma. Add Loom, Google Docs/Sheets/Slides/Drive, Google Maps, CodePen, Excalidraw, Miro, Spotify, and a generic oEmbed fallback. You already have unfurl infrastructure for Slack — point it inward.
19. **Smart paste (S).** _Status: Partial — #201 offers Link, Preview card, or Embed when a URL is pasted, with server-fetched cached previews. Smart table and Markdown paste rely on BlockNote defaults._ Paste a URL alone on a line → bookmark block with a server-fetched OG card (reuse the unfurl fetcher, cache in D1). Paste a table → table block. Paste Markdown → parsed blocks.
20. **Code block polish (S).** _Status: Partial — #201 added Shiki highlighting, a language picker, and a copy button. A wrap toggle is open._ `editorOptions` in `EditorPage.tsx` passes no `codeBlock` config, so there's no highlighter or language picker. Add Shiki lazily, plus a copy button and a wrap toggle.
21. **Suggest edits / review mode (L).** _Status: Open._ Notion shipped this; for a wiki it's arguably more valuable than for Notion. A `suggestions` Y.Map overlay on the same doc, rendered as decorations, accept/reject by editors.
22. **Simple-table improvements (M).** _Status: Unverified — no application work; any resize or header-row behavior comes from BlockNote defaults._ Column resize, header-row toggle, cell background, and paste-from-spreadsheet.

### Navigation, search, structure

23. **"Recently visited" and an Updates feed (S).** _Status: Partial — per-user recent pages shipped. A workspace "what changed" feed is open._ `ActivitiesTray` today is background-job status, not activity. A per-user recents list (client-side is fine) plus a workspace "what changed" feed from `document_projections` timestamps.
24. **Search operators (S).** _Status: Open — search has dropdown filters persisted in the URL, but no `in:`/`by:` operators and no saved searches._ The search API already takes space/kind/author/date filters; expose them as `in:`, `by:`, `tag:`, `kind:`, `before:`/`after:` in the query box, and let people save searches.
25. **Typo tolerance (M).** _Status: Open._ BM25 over FTS5 has none. Add a second FTS5 index with the trigram tokenizer for fallback matching when the main query returns nothing, plus prefix matching on titles.
26. **Sidebar drag-and-drop with drop-into (M).** _Status: Partial — pointer drag-and-drop before, after, and inside works (`WorkspaceTree.tsx`). Multi-select and drag-to-favorite are open._ Fractional indexing and the move API exist; the alt+arrow keyboard path is already tested. Pointer DnD with nesting, multi-select, and drag-to-favorite.
27. **A real "Move to" dialog (S).** _Status: Partial — the Move dialog is a plain select that follows remote moves (#210). Fuzzy search and recent destinations are open._ Fuzzy page picker, recent destinations, keyboard-driven.
28. **Graph view (M).** _Status: Open._ `page_references`, `transclusion_references`, and `member_mentions` already exist. A force-directed graph of the workspace plus an "orphan pages" report is mostly a rendering exercise on data you already compute.

### Permissions, admin, trust

29. **Guest role + per-page human grants (M).** _Status: Open._ `integration_grants` already models "this principal can see this page subtree" for tokens. Give users the same table and you get guests and page-level sharing in one move.
30. **Member groups (M).** _Status: Open._ `space_members` scales as n². Groups make 30+ person workspaces manageable.
31. **Audit log (M).** _Status: Open._ Nothing today. An append-only D1 table (actor, action, target, ip hash, request id) written from the same middleware that already stamps `x-request-id`, with CSV export and retention. This is table-stakes for any org that would self-host.
32. **Page lock (S).** _Status: Open — `/v1` rejects `is_locked` and always reports `false`._ Notion's "lock page" — prevents accidental edits without changing anyone's role. One column plus a check in the DO's write path.
33. **SSO (OIDC first, SAML later) + SCIM (L).** _Status: Open — the only `genericOAuth` provider is Slack sign-in._ Better Auth already supports OIDC providers; this is the single biggest unlock for the "self-hosted for a company" buyer.
34. **Trash that works at scale (S).** _Status: Open — trash still offers only single-item restore and delete forever._ Search within trash, bulk restore, restore-to-original-parent, configurable retention, and a "permanently empty" with confirmation.
35. **Admin health dashboard (M).** _Status: Open — `oversized` is written by the document room but never surfaced._ Storage per space, oversized pages (the `oversized` flag already exists and is invisible to users), stale pages, pages with no owner, largest attachments, DO hot spots from the Analytics Engine dataset you already write to.

### Sharing and publishing

36. **Share-link hardening (M).** _Status: Open — no password or expiry. The text's "views unexposed" was already wrong: `ShareControl.tsx` shows the view count._ Password protection, expiry dates, "revoke all," and per-link view analytics (`share_links.views` is already counted and unexposed).
37. **Custom domain + site chrome for published spaces (M).** _Status: Open — a sitemap exists; RSS, custom domain, and chrome are open._ Navigation, logo, theme, custom CSS, OG images rendered through the `BROWSER` binding, and an RSS feed of updated pages alongside the sitemap you already generate.
38. **Diagram public shares and diagram import (M).** _Status: Partial — diagrams linked from a shared document render as public thumbnails; direct diagram shares still throw, and diagram import is open._ Both are listed as explicit v1 gaps in the README; diagrams are one of the project's best features and currently can't be shown to anyone outside the workspace.

### Interop

39. **In-app Notion import via API token (M).** _Status: Open._ `@notionhq/client` is already a dependency and `notion-import.mjs` is a CLI. Making it a self-serve button is the difference between "an operator procedure" and a migration path — and the Workflow/staging/verification machinery for it already exists.
40. **More importers (M each).** _Status: Open — import accepts Markdown, HTML, and Notion ZIP._ Confluence space export, Obsidian vault (Markdown + wikilinks map cleanly onto your page-reference model), Google Docs, `.docx`, Evernote ENEX.
41. **Workspace-wide export + scheduled backups (S).** _Status: Open — export is still per page, and there is no scheduled backup task._ Per-page export exists; a full-workspace ZIP plus a cron-driven backup into R2 with retention would complete `BACKUP_AND_RECOVERY.md`.
42. **An MCP server for the workspace (S–M, disproportionate payoff).** _Status: Done — #206 and #209: member-scoped OAuth 2.1 plus a stateless MCP endpoint. A workspace owner must enable it._ You have a `/v1` REST API, PATs, capability scoping, and per-page grants. Wrapping that as MCP makes the wiki directly usable by Claude and other agents, with the access control already enforced server-side. Very little new code for a large capability.
43. **Web clipper extension (M)** _Status: Open._ and **Zapier/n8n/Make connectors (S)** on the same PAT + webhook foundation.
44. **Email-to-page (M).** _Status: Open._ Cloudflare Email Workers routes inbound mail; `notes@yourdomain` appends to an inbox page or creates a row in a table. Natural fit for the platform you're already on.

### Platform

45. **PWA + installable app (S).** _Status: Done — #204: service worker, manifest, and cached shell. Offline editing is behind `OFFLINE_EDITING_ENABLED` (off in production)._ No service worker exists. Documents already work offline via IndexedDB — an app shell, icons, and a manifest would make that visible instead of accidental.
46. **Diagram offline parity (M).** _Status: Open — diagrams show an online-required state offline._ Diagrams currently require a live authoritative connection; an IndexedDB + reconciliation path brings them level with documents.
47. **i18n scaffolding (M)** _Status: Open._ — worth doing before the string count doubles again.
48. **Multi-workspace (L).** _Status: Open — `install_state` still has `CHECK (id = 1)`, and `getMember()` has no workspace filter._ `install_state` carries `CHECK (id = 1)` and `getMember()` resolves membership with no workspace filter. This is the root blocker behind most of `docs/API_COMPATIBILITY.md` and behind ever running this as anything but single-tenant.

---

# Part 3 — Imaginative ideas

These use the architecture as an _advantage_ rather than apologizing for it.

49. **Ask-the-workspace, built on the compaction hook.** _Status: Open._ Add the `AI` and `Vectorize` bindings. `Document.compactOnce()` already runs ~30 seconds after the last edit and already produces a text projection — that is a perfect, free embedding trigger. Chunk, embed, upsert on compaction; you get semantic search with zero new scheduling machinery.
50. **Hybrid ranking.** _Status: Open._ Blend BM25 (which you have, tuned, with snippets) and vector similarity. This directly answers the "search is the weakest link" verdict in `Limitations.md` without leaving Cloudflare.
51. **AI table autofill.** _Status: Open._ "Summarize this row's page into the Summary column," "categorize from the description." The bulk-write API already supports replayable batch writes, so backfilling 2,000 rows is a Workflow away.
52. **Page-level agents.** _Status: Open._ `@claude` as a first-class mention identity that dispatches a Workflow, writes back as a comment or a block, and shows up in the activity feed with a bot avatar. Your integrations model already distinguishes bot principals from people.
53. **Scrub the document like video.** _Status: Open._ The Yjs update log in DO SQLite _is_ a recording. A timeline scrubber that replays a page's construction — and a `git blame` view attributing paragraphs to authors via Yjs client IDs — is something Notion cannot do, and you already store everything required.
54. **Branch and merge a page.** _Status: Open — `block-diff.ts` is still used only for version comparison._ Fork a page into a draft epoch, edit freely, then merge back with Yjs's own merge semantics; reviewers see a block-level diff. You already have epochs and `src/shared/block-diff.ts`. Pull requests for wiki pages is a real differentiator for engineering-adjacent teams.
55. **Regional reader replicas.** _Status: Open._ The sharpest complaint in `Limitations.md` is permanent DO placement. Readers don't need the authoritative object: a per-region replica DO that subscribes to the primary and serves snapshot + read-only awareness fixes transatlantic _reading_ without touching the write path.
56. **Publish a space as a static site.** _Status: Open._ Render a shared space to R2 on change and serve it from the CDN. Public docs become globally fast and effectively free, sidestepping single-DO geography entirely for the read-heavy case.
57. **Forms (M).** _Status: Open._ A share-link type backed by a table page; each submission appends a row. Turnstile for spam, and your rate limiters are already in place. Notion Forms is one of its most-used recent additions and you're one table away.
58. **Charts and dashboards.** _Status: Open._ A chart block over a table view or a saved search; server-rendered to PNG through the `BROWSER` binding for exports. Pairs naturally with database views.
59. **Automations.** _Status: Open._ "When Status → Done: post to Slack, set Completed date, create a page from template." You already have Queues, Workflows, Slack OAuth, and webhooks — what's missing is a rules table and an evaluator. This is the highest ratio of user-visible power to new infrastructure in the whole list.
60. **Wiki verification and freshness.** _Status: Open._ Owner + "verified until" date, a badge that decays, auto-unverify on substantive edit, and a stale-page sweep on the cron that's already load-bearing. This is what makes a wiki trustworthy rather than a junk drawer, and Notion charges enterprise money for it.
61. **Template variables and recurring templates.** _Status: Open._ `{{date}}`, `{{me}}`, `{{parent.title}}`; plus "create a Weekly Sync page every Monday at 9am" driven by the existing cron. Add in-page template buttons.
62. **The diff digest.** _Status: Open — digests are still roll-ups. See also Slack Milestone 4._ Your weekly email today is a notification roll-up. Make it a _rendered block diff_ of what actually changed in a space — `block-diff.ts` exists and is currently used only for version comparison.
63. **Save a Slack thread to the wiki.** _Status: Done — #202: **Save to Notes** and **New page from thread** publish through the verified import workflow._ You have a Slack app with OAuth, slash commands, and access-filtered unfurls. A message action that turns a thread into a page (or a row) closes the loop from chat to knowledge, which is where most wikis die.
64. **Voice notes → transcript → page** _Status: Open._ via Workers AI Whisper, with the audio kept as an R2 attachment and the transcript as blocks. Meeting notes without a meeting bot.
65. **Live diagram viewports inside documents.** _Status: Open — `linkedDiagram` is still a picker plus a link._ `linkedDiagram` is a link today; make it a live, synced region of the diagram rendered inline. Two Yjs rooms on one screen is a genuinely novel document experience and you already run both.
66. **Per-page cost and latency HUD.** _Status: Open._ You write to Analytics Engine already. Show operators which pages are hot, which DOs are expensive, which documents approach the 16 MiB warning. A self-hosted app that honestly reports its own unit economics is a distinctive stance — and it makes the accepted limits feel like transparency rather than excuses.
67. **Semantic "related pages"** _Status: Open._ in the existing `BacklinksPanel`, from the embeddings in #49 — the backlinks panel is currently empty for most pages, which makes it feel broken.
68. **End-to-end encrypted private spaces.** _Status: Open._ The DO stores only ciphertext Yjs updates; search index lives client-side. It breaks server search and export, so it must be scoped to spaces that opt in — but "the server literally cannot read my private space" is a claim no hosted competitor can make, and self-hosting is exactly the audience that wants it.
69. **A local-first desktop client** _Status: Open._ (Tauri) speaking the same Yjs protocol with a local full-text index — turning the offline story from a fallback into a feature.
70. **Read heatmaps, privacy-guarded.** _Status: Open._ Aggregate dwell/scroll depth per section, k-anonymized, shown to page owners: "nobody reads section 4." Wikis rot because nobody knows what's dead.

---

# Part 4 — Original sequencing

_Status note, 1 October 2026: the original sequencing is kept below for reference. Round 1 shipped the palette, date reminders, wider embeds, smart paste, and code highlighting from the first line; the [roadmap README](roadmap/README.md#round-2) holds the current plan._

**Next two weeks (feel):** Cmd+K palette · comment reactions · page covers + full-width · date mentions & reminders · recently-visited · wider embeds + smart paste · code highlighting · trash improvements.

**Next quarter (the gap):** row pages → saved views → board/calendar → more column types → inline databases → CSV import. Ship them in that order; each is usable alone.

**The two bets worth making early because they're expensive to retrofit:** (a) decide now whether tables become DO-backed CRDTs, because every view you build on the lease model gets rewritten if you switch later; (b) add the `AI` + `Vectorize` bindings and start embedding on compaction, because the index is only useful once it's backfilled, and backfill gets more expensive every week.

**The enterprise unlock, when you want buyers:** audit log → guests + per-page grants → groups → OIDC SSO. Multi-workspace only if you actually want to be multi-tenant; if not, say so in the README and close the question.

One editorial note (still true on 1 October 2026; scheduled in Round 2 closeout): `docs/API_COMPATIBILITY.md` is now stale in a way that undersells the project — it says there are no queues, no webhook table, no bearer tokens, and no passkeys, all four of which now exist. Worth a refresh, since it's the doc an evaluator is most likely to read. It also predates
the `/v1` Markdown API, OAuth, and MCP.
