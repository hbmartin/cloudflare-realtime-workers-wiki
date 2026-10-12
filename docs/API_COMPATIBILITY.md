# Notion API compatibility

NoteFlare implements a bounded Notion-shaped `/v1` API for one installation. It is not a complete Notion server. Requests require an integration bearer token and exactly `Notion-Version: 2026-03-11`. Read [Integrations](INTEGRATIONS.md) for connection and webhook setup.

Audited on 12 October 2026 against `b61dfbd` (migrations through `0081`). The implementation sources are [Worker routes](../src/worker/notion-api.ts), [block mappings](../src/shared/notion-blocks.ts), and [integration authorization](../src/worker/integrations.ts). Deployment and live acceptance are tracked separately in the [audit evidence](evidence/documentation-audit-2026-10-12.md).

## Supported resource families

| Resource | Routes under `/v1` | Contract and limits |
| --- | --- | --- |
| Pages | `GET /pages/:id`, `POST /pages`, `PATCH /pages/:id`, `POST /pages/:id/move`, `POST /pages/:id/trash` | Authorized page metadata, creation, property updates, move, and archive operations. One workspace; permissions derive from capability and subtree grants. |
| Page properties | `GET /pages/:id/properties/:propertyId` | Supported NoteFlare page properties; this does not expose Notion's complete property/database model. |
| Blocks | `GET /blocks/:id`, `GET/PATCH /blocks/:id/children`, `PATCH/DELETE /blocks/:id` | Stable mapped document blocks. Writes transact through the authoritative Yjs room; unsupported structures are preserved or rejected rather than silently flattened. |
| Markdown | `GET/PATCH /pages/:id/markdown` | Reads are available independently of the Markdown-write flag. Writes use version/epoch and operation guards; protected blocks, attachments, and comment anchors can restrict changes. |
| Asynchronous Markdown work | `GET /async_tasks/:id` | Poll tasks returned by an accepted Markdown write. Task ownership, access, retention, and retry rules are enforced. |
| Search | `POST /search` | Accessible page search, not a full query over every Notion object type. |
| Users | `GET /users`, `GET /users/:id`, `GET /users/me` | Workspace people and integration bot identities; fields are redacted according to the integration's user-information capability. |
| Comments | `GET/POST /comments`, `PATCH/DELETE /comments/:id` | Capability-checked comments using NoteFlare's server-authoritative thread model. |

## Authentication and authorization

Owners create integrations, select read/insert/update content and comment capabilities, and grant page subtrees. Personal access tokens are shown when issued; only token hashes and identifying prefixes are retained. Revocation, capability changes, and removed grants take effect on subsequent requests and persisted task execution. A token is not a browser session and does not inherit unrestricted owner access.

Browser members use Better Auth sessions with mandatory authenticator or passkey enrollment and account-protection checks. MCP instead uses member-scoped OAuth with PKCE and the live member's permissions. MCP OAuth tokens and `/v1` integration tokens are separate contracts; do not substitute one for the other.

## Pagination errors and release controls

Supported lists use Notion list envelopes with `results`, `has_more`, and `next_cursor`; pass the opaque cursor back as `start_cursor`. `page_size` is 1–100, default 100. Cursors are not a promise of an immutable snapshot across concurrent edits. Errors use Notion-shaped error envelopes and HTTP status codes; inspect `code` and `message`, not status alone.

Source and integration rate limits apply before and after authentication. Consult [Configuration](CONFIGURATION.md#bindings) for deployed limit bindings. Document writes retain the normal size ceilings and protected-structure checks.

`NOTION_MARKDOWN_WRITES_ENABLED=false` rejects PATCH Markdown and pauses queued Markdown tasks. MCP document create/update also require this flag; Markdown reads and MCP comments remain separate. MCP additionally requires an owner to enable workspace access. See [Flags](FLAGS.md).

## Compatibility boundaries

- One workspace per installation; no Notion-style multi-workspace OAuth installation model.
- No `/v1/databases`, `/v1/data_sources`, saved Views, relation/rollup/formula engine, template catalog, or file-upload API. NoteFlare tables and diagrams are readable through dedicated MCP tools, not full Notion database endpoints.
- Supported BlockNote mappings are finite; rich/custom document structures may block a destructive write. This API does not reproduce every Notion block or user-interface behavior.
- Date/reminder and task semantics belong to NoteFlare. Compatibility does not imply every Notion automation or notification behavior.
- Signed integration webhooks use NoteFlare subscriptions and queued delivery. They are not a claim of complete Notion webhook event coverage.
- Notion SDK methods outside the route matrix are unsupported. Test the specific methods your integration needs against a synthetic pilot installation.

The [historical feasibility assessment](research/notion-api-feasibility-2026-08-23.md) preserves the earlier architecture discussion; it is not a current compatibility reference.
