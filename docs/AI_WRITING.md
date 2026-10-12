# AI writing

Use Writing to draft, rewrite, summarize, translate, and extract actions from sources you explicitly select. Writing requires a network connection, synced document content, and operator/owner activation. Ask your operator about [setup](OPERATIONS.md#ai-writing-setup) if the action or a quality mode is unavailable.

## Start a draft

1. Open a document and choose Writing, select text and choose the writing action in its formatting toolbar, or enter `/ai`.
2. Choose an action, add instructions, and select Fast or Best quality. Disabled modes have no usable configured model.
3. Review the source selection. The current document or selected scope is included; you can explicitly add accessible documents, tables, and diagrams.
4. Choose the available funding source and Generate. A saved funding choice is remembered. A rejection never silently switches to API billing.
5. Review the formatted preview and linked sources before applying or copying it.

There is no automatic workspace search or retrieval. Image and attachment bytes are excluded. Requests that exceed the source/context limits ask you to narrow scope rather than silently dropping content. Writing can use pages you may read; applying a result requires permission to edit the destination.

## Apply or keep a result

Replace updates the original selected target; Insert follows the selected text, the `/ai` block, or the end of a whole-page source. Application uses the normal collaborative editor and Undo. If the target changed, its epoch was restored, or protected structures would be damaged, choose another insertion point or copy the result.

Review model-generated citations with the draft. Unsupported output and cancelled/failed partial output remain copyable but cannot be applied as a completed result. Regenerate and follow-ups are new requests and can consume allowance.

Closing Writing retains the panel's draft, sources, and active work on that document. Leaving the document cancels its local stream. Discard hides the result locally; it does not delete saved history. Confirmed source-access loss hides private content.

## Funding and allowance

Workspace API funding uses an operator credential and the owner's daily allowance. The default is 20 started requests per member per UTC day; the UI displays remaining allowance and reset time locally. Cancellation after dispatch and uncertain/provider failures can retain the reservation.

ChatGPT plan funding is a separate hosted connection. It is offered only after operator approval and configuration. Connecting it does not replace NoteFlare sign-in or account protection. You choose funding explicitly; there is no automatic billing fallback.

## Find and delete history

Conversations are private to their author. Use My writing to search and open your saved library; opening navigates to the original document. Delete individual conversations or use bulk deletion.

History expires after 30 days without an explicit open or writing request. Listing, searching, and background access checks do not extend it. Losing access to any source previously supplied locks the conversation until access is restored; locked entries can still be deleted. Operator database backups can contain history.

See [Troubleshooting](TROUBLESHOOTING.md#ai-writing) for failed or expired generation and [the behavior specification](specs/ai-writing.md) for detailed limits, privacy, recovery, and quota contracts.
