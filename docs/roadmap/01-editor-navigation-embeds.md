# Phase 1: editor, navigation, and embeds

Status: implementation pending. Can ship independently of later phases.

## User contract

Cmd/Ctrl-K opens one keyboard-accessible palette containing page results and available actions.
Cmd/Ctrl-P opens it in page-only mode; Cmd/Ctrl-Shift-P opens it in command-only mode. The
shortcuts work while the editor is focused, but never intercept composition, an active modal, or
an existing shortcut owned by the editor. Arrow keys move the active result, Enter runs it, and
Escape closes and restores focus. `?` outside an editable field opens a searchable shortcuts
overlay. A visible palette button remains for pointer and touch users.

Commands are an app-shell registry, not hard-coded rows in the dialog. Start with existing
operations: create document/table/diagram/task list, search, open inbox, toggle theme, export
current page, and move current page. The registry gives each action an ID, label, shortcut,
availability predicate, and callback. Hide actions the member cannot perform or whose target
page is unavailable. Page results use `/api/search/titles`, with recent accessible pages shown
before a query. Keep the existing QuickSwitcher accessibility pattern and add an explicit empty
and failed-search state. Do not persist search text or inaccessible titles in local recents.

Math, code, Mermaid, and embeds must visibly render in a production-policy browser. Code blocks
gain a language picker, copy button, and lazy-loaded local syntax highlighting; unknown languages
show unhighlighted code. Math uses the installed KaTeX renderer. Mermaid stays sandboxed and
shows a source-preserving error when parsing fails. A URL pasted on an otherwise empty line
offers **Link**, **Preview card**, and **Embed** when that provider supports framing. Existing
bookmark blocks become preview cards without changing stored URLs.

## Interfaces and data flow

- Keep provider definitions in one typed registry: accepted source URL patterns, canonical
  transformed iframe URL, expected frame origin, sandbox permissions, and test fixture. The
  first catalog is YouTube, Vimeo, Figma, Loom, Google Docs/Sheets/Slides/Drive, Miro, Spotify,
  and CodePen. Unknown URLs can be links or preview cards, never arbitrary iframes. Reject
  non-HTTPS framing, credentials in URLs, ambiguous hosts, and provider redirects to another
  origin.
- Generate or check the `frame-src` list in `public/_headers` against that registry. Keep
  `object-src 'none'` and `frame-ancestors 'none'`. Test each provider's required sandbox flags;
  do not grant top navigation, popups, or same-origin access by default. Provider refusal to be
  framed is shown as an ordinary link, not an empty block.
- Add authenticated `POST /api/link-previews` with `{url}`. The Worker fetches public HTTPS
  HTML only, with redirect, response-size, and timeout bounds; resolves and checks every redirect
  target against private, loopback, link-local, and metadata addresses. It extracts a bounded
  title, description, site name, and image candidate, never scripts or arbitrary HTML. Cache
  metadata by canonical URL hash in D1 with expiry. Fetch accepted images server-side into a
  bounded R2 cache and expose them through same-origin
  `GET /api/link-previews/:id/image`; the client never loads an external preview image URL.
  A fetch failure produces a plain link card and can be retried.
- Extend the existing editor block schema only where needed for a preview card's metadata ID.
  URL remains the durable content; a stale or deleted preview must not make the link disappear.
  Export, import, public shares, and `/v1` block reads fall back to the canonical URL and title.

No migration is needed for the palette or highlighting. Add a small D1 preview-cache table and
R2 objects with expiry cleanup; existing embed and bookmark content must continue to load. Cache
records are derived data and can be rebuilt or deleted without document loss.

## Failure, rollout, and recovery

Ship the CSP correction and a real rendering test first, then enable the expanded provider
registry and preview-card action. Keep the registry behind one release flag during rollout so
provider-specific failures can be disabled without rewriting documents. A proxy error degrades to
the stored link. CSP reports and browser errors should identify the blocked origin without
logging private page content or whole URLs with query secrets. Purge the preview cache if its
fetch policy changes; no content migration or rollback is required.

## Exit matrix

| Scenario                                                | Required result                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Cmd/Ctrl-K, P, Shift-P from editor and shell            | Correct palette mode; focus restored; only permitted actions shown                |
| Keyboard, screen reader, touch                          | Combobox/option semantics, stable active result, visible button and help          |
| Math, highlighted code, Mermaid, iframe                 | Actual content renders in Playwright with production `_headers`; no CSP violation |
| Every allowlisted provider                              | Canonical frame origin matches CSP; refusal becomes a link                        |
| Untrusted URL or metadata/image redirect                | No internal fetch or iframe; bounded safe fallback                                |
| Offline/failed preview fetch                            | Stored link remains usable; no lost editor content                                |
| Preview-cache migration or proxy outage                 | Existing URLs render as links; rebuilding cache restores cards                    |
| Preview API without access, repeated fetch, stale cache | Denied request leaks no metadata; repeat is bounded; expiry refreshes safely      |
