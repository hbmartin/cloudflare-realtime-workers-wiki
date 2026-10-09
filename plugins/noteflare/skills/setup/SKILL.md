---
name: setup
description: Set up the NoteFlare plugin and verify the connected wiki account and accessible spaces after installation.
---

Call `list_spaces` to identify the linked workspace and available destinations. If authentication is required, use the host's OAuth connection flow. The user signs in to NoteFlare and completes its account protection and consent requirements; never request credentials or tokens in chat.

Show the workspace name and accessible space names. Help the user choose a destination for the task when necessary; this does not create a permanent default. Call `list_pages` for a chosen space and offer `open_noteflare` to browse it visually.

Explain that documents can be read and edited, while `fetch_table` and `fetch_diagram` provide paginated typed data and text relationships. The embedded Markdown editor links tables and diagrams to NoteFlare for editing. Follow continuation cursors to obtain a complete read. Write confirmation belongs to the host client.

If no spaces are accessible, explain that an owner must grant access. If MCP is disabled, direct the owner to NoteFlare's workspace MCP settings. Describe only capabilities actually returned by the connected tools.
