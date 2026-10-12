# ChatGPT plugin

The NoteFlare plugin lets an authorized ChatGPT user find wiki pages, read selected sources, and create or update documents and comments. It uses the installation's OAuth/MCP connector. The source package is available, but registration, private installation, and installed-client acceptance are operator rollout steps; ask your operator for access.

## Connect and find sources

1. Connect the installation's plugin through your administrator-provided ChatGPT entry.
2. Sign in to NoteFlare, complete account protection if required, and review OAuth consent.
3. Search for a page or browse available spaces. Results follow your current NoteFlare access.
4. Open a page or select explicit table/diagram sources. Large results offer continuation or direct opening in NoteFlare.

Tables and diagrams are read-only source readers in the plugin. Rich collaborative editing, uploads, and realtime diagram/table editing use the main NoteFlare app.

## Edit a document

The embedded editor has a Markdown draft and preview. Edit the draft, review it, then choose Save. Saves are explicit; navigation and Cancel guard unsaved changes. Stale revisions require reading the current document and reconciling your draft before retrying.

After an uncertain save, preserve the editor's recovery state and retry the same operation. Do not create a second operation merely because the response was lost. A confirmed expired staged creation can start a new create while retaining its draft and destination. Oversized or protected rich documents open in NoteFlare for editing.

Copying text does not grant access to another page. Markdown HTML is displayed as escaped source, image previews are placeholders, and external links open after a click. Only page identity and explicitly selected text enter model context; the remaining editor draft stays in the active UI and can be lost when the host closes it.

## Permissions and connection recovery

Read-only members can browse permitted sources but cannot save edits. OAuth scopes, current membership, source permissions, version/epoch guards, and the installation's Markdown-write control all apply. Revoking the connection or disabling workspace MCP stops further access. Reconnect after an owner re-enables it.

This wiki connection is separate from ChatGPT-funded inference inside NoteFlare's [Writing panel](AI_WRITING.md). See [operator setup](OPERATIONS.md#chatgpt-plugin-setup), [integration contracts](INTEGRATIONS.md), and [the behavior specification](specs/chatgpt-plugin.md).
