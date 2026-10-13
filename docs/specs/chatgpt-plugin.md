# ChatGPT plugin behavior specification

The source package is `plugins/noteflare`; remote OAuth and `/mcp` form the integration boundary. Operator registration and installation are in [Operations](../OPERATIONS.md#chatgpt-plugin-setup).

Local checks and outstanding acceptance gates are recorded in [verification evidence](../evidence/CHATGPT_PLUGIN_VERIFICATION.md).

## Server and editor

The existing OAuth authorization server and `/mcp` endpoint remain the integration boundary. There are ten tools: `search_pages`, `fetch_page`, `fetch_table`, `fetch_diagram`, `create_page`, `update_page`, `create_comment`, `list_spaces`, `list_pages`, and `open_noteflare`. Successful calls return both JSON text and validated structured content. Tool scopes and behavior annotations are declared individually; OAuth metadata advertises existing client metadata document support.

`fetch_table` returns schema, select options, typed rows, total row count, the explicit filter, revision, epoch, `complete`, and `nextCursor`. It accepts an optional column subset when a schema or row exceeds the bounded response budget. `fetch_diagram` returns textual nodes and edges, labels, notes, hierarchy, reference metadata, totals, revision, epoch, sequence, and continuation. Both exclude attachment/image bytes and editor lease/session information. Each response is bounded to 48,000 bytes of data plus its envelope. Cursors are authenticated and encrypted, expire after 15 minutes, and bind the workspace, member, OAuth grant, page, and query. A changed revision or epoch (or diagram sequence) rejects continuation with `source_changed`; callers must restart rather than combine snapshots. These actor-aware readers also supply in-app writing sources. Table and diagram writes remain outside these tools.

Write confirmations belong to ChatGPT. There is no NoteFlare approval queue. Current OAuth scopes, access, revocation, version guards, and idempotent receipts still govern every write. ChatGPT is the launch client; other MCP clients receive protocol support without launch certification.

`list_spaces` returns the workspace, granted scopes, accessible spaces, and effective write capability. `list_pages` returns up to 50 children with an opaque cursor bound to the space and parent. Omit the parent for roots. Private-space membership, templates, archived and staged pages, and hidden table detail pages follow the existing authorization and navigation rules. Diagrams and tables link to NoteFlare.

`fetch_page` reads canonical document content, including blocks beyond the bounded Notion API projection. It accepts `offset` (default 0), `limit` (default 16,000, maximum 32,000 UTF-16 code units), and an opaque `cursor`. The result includes `offset`, `nextOffset`, `textLength`, `complete`, `nextCursor`, `revision`, `contentEpoch`, `sequence`, destination IDs and `canEdit`. The legacy `truncated` field remains. Escaping and both MCP content representations count toward the 48,000-byte serialized result budget, so an actual chunk can be smaller than the requested limit. Chunks never split a surrogate pair.

Document cursors expire after 15 minutes and bind the member, workspace, OAuth grant, page, limit and exact revision/epoch/sequence snapshot. Access is checked on every read. Explicit nonzero offsets require `expected_revision`, `expected_content_epoch` and `expected_sequence`; a changed snapshot requires a restart. Do not concatenate different snapshots. The plugin assembles every continuation before enabling replacement editing, with local request and memory bounds. A partial result remains read-only.

Version-aware `update_page` calls provide both `expected_revision` and `expected_content_epoch`. Existing clients may omit both. Receipts are checked before these guards, and the Durable Object still checks the sequence atomically on commit. A stale write returns `page_changed` before changing content. Use the same operation ID and arguments for an uncertain retry; new input needs a new ID.

Markdown replacements match exact fetched Markdown, including empty paragraph separators. Missing matches return `old_str_not_found`; multiple matches return `old_str_ambiguous`, with a match count. Bounded exact-Markdown suggestions can help correct a near miss, but they are advisory and never applied automatically. Unrelated text or excessive comparison work produces no suggestion. Writes resolve against complete canonical content while retaining comment, rich-block and revision protections.

New MCP updates that mutate content bind their internal `mcp:v2` receipt to the original MCP input hash and committed sequence in Durable Object SQL, atomically with the content update log. Recovery after a missing D1 receipt checks this identity before completing the original receipt. A changed command or version guard returns `operation_id_reused`. If the content receipt and SQL identity are not both present, recovery returns nonretryable `operation_receipt_unverifiable`; read the current document and reconcile before submitting a new operation. The SQL table initializes automatically and survives compaction; these fixes require no D1 migration. A restored receipt without its local SQL identity is also unverifiable. Identity remains scoped to the document and epoch; detecting an operation ID reused on a different document after D1 receipt loss requires a broader receipt design. No-op updates have no Durable Object mutation receipt and retain D1-only replay protection.

Legacy internal receipts retain ID-only replay when no v2 receipt or identity exists. This explicitly retained compatibility behavior cannot verify the original MCP input after its D1 receipt is lost. Legacy identity is never inferred from retry arguments. Current authorization and permissions are still checked before either receipt is recovered.

`NOTION_MARKDOWN_WRITES_ENABLED` must equal `"true"` for new MCP `create_page` and `update_page` writes, including resuming a staged create. When disabled or unset, these calls return retryable `markdown_writes_disabled` and the UI reports read-only capability. Completed operations can still return their OAuth receipt or recover a completed Durable Object update receipt without another content mutation, subject to current authorization and permissions. Read tools and comment creation retain their existing scope requirements. Production currently disables the flag; existing MCP clients need it enabled before making new document writes.

The resource is `ui://noteflare/v1/editor.html`, with MIME type `text/html;profile=mcp-app`. It is attached only to `open_noteflare`, with global and thread entrypoints and inline/fullscreen display modes. Data tools work independently. The Worker fetches the bundled HTML through its assets binding rather than embedding the main application.

The dedicated React UI uses the MCP Apps bridge for tools, context updates, and opening links. It supports browsing, search, creation, and Markdown drafts. Save is explicit; navigation and Cancel guard unsaved changes. Markdown remains editable while a save is pending, while another save is disabled and a new document's title stays locked until its create is resolved. Recovery preserves the original request and any newer local edits: **Retry previous save** replays an uncertain request exactly, and **Refresh saved document** fetches an acknowledged write without submitting it again. A successful create supplies the page ID for later updates. The saved revision and epoch must match the acknowledgement baseline before another write; creates begin at epoch 1. Newer edits remain dirty for another explicit Save. Keep editing, Escape, and explicit discard remain available; discarding cannot undo an already submitted save. Abandoning the draft isolates its late results from subsequent documents and navigation.

If staged-page cleanup returns `page_creation_expired` for an unacknowledged create, the editor releases that failed operation while retaining the current draft, title, and destination. The title becomes editable again, and the next explicit Save starts a fresh create with a new operation ID, including when the draft is unchanged. Uncertain failures and acknowledged saves retain their existing recovery behavior.

Conflicts disable saving until the user reads the current version and manually reconciles the draft. Save and continue navigates only after the relevant draft is confirmed saved and that navigation intent remains current. The server preserves existing rich-block, attachment, and comment-anchor protections. Incomplete, oversized or protected documents open in NoteFlare for editing.

The preview renders Markdown elements through React. HTML is displayed as escaped source, images are placeholders, and links open only after a click. No external connections, frames, or resource domains are declared. Only page identity and explicitly selected text are sent to model context. Selection is capped at 8,000 characters; other draft content stays in the active UI and is lost if the host destroys it.

## Verification boundary

The embedded bundle is exercised in a simulated host under a strict CSP without `unsafe-eval`; this covers the bridge handshake, guarded writes, conflict preservation, navigation guards, and absence of automatic external resources. Installed ChatGPT acceptance is separate. Contributor commands and evaluation behavior are in [Contributing](../../CONTRIBUTING.md#plugin-verification); dated results remain in [verification evidence](../evidence/CHATGPT_PLUGIN_VERIFICATION.md).

## Installed acceptance

Complete [operator registration and acceptance](../OPERATIONS.md#chatgpt-plugin-setup) with an actual dependency ID before private publication. Local protocol tests do not certify installation in ChatGPT.

## References

- [Plugins and packaging](https://developers.openai.com/plugins/build/plugins)
- [MCP server concepts](https://developers.openai.com/plugins/concepts/mcp-server)
- [Tool planning](https://developers.openai.com/plugins/plan/tools)
- [Embedded UI](https://developers.openai.com/plugins/build/chatgpt-ui)
- [Extension entrypoints](https://developers.openai.com/plugins/build/extensions)
- [OAuth guidance](https://developers.openai.com/plugins/build/auth)
- [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Function selection evaluations](https://developers.openai.com/api/docs/guides/function-calling)
