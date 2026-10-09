# AI writing and MCP source interoperability

The writing sidebar opens from a document's Writing action, the selected-text formatting toolbar, or `/ai`. It offers drafting, rewriting, summaries, action extraction, shortening, expansion, tone changes, translation, and custom instructions. Fast is the default quality; members see Fast/Best rather than model IDs. An owner configures each provider's model mappings and character limits. A mode with no configured model or no verified model access is disabled.

Readers can generate and copy from pages they currently have permission to read. Applying a complete result requires effective edit permission in the document's space. The preview is formatted, read-only Markdown. Replace and Insert use the live editor transaction and its existing Yjs undo. Changed targets or restored epochs block replacement. Protected attachments, embeds, mentions, custom blocks, and comment anchors block unsafe replacements. Whole-page insertion appends; selected-text insertion follows the selected text; `/ai` inserts after its block. A missing or changed selection anchor requires choosing a new location. Unsupported output formats and cancelled/failed partial results are copy-only.

Writing and saved history require a network connection. Existing offline document editing continues to work. Generation waits until local document changes are synced so server retrieval uses the chosen live content.

## Sources and conversation privacy

Every request includes the current document (or an explicit text/block scope). Members may add explicit referenced documents, tables, and diagrams. There is no automatic workspace retrieval. Table filters select rows, document block choices select blocks, and diagram choices select nodes and their connecting edges. Table data includes types and select options. Diagram data includes textual labels, notes, hierarchy, edges, and reference metadata. Attachment/image bytes are excluded; references do not automatically fetch other pages.

At most 20 pages, including the current document, and 250,000 characters of sources, prompts, and prior conversation text are allowed. The owner-configured model limit can be smaller, and advertised ChatGPT model context limits can reject a request earlier. Sources are complete within the chosen scope. Oversized requests fail before dispatch with guidance to narrow scope, remove references, change quality, or start a new conversation. No source is silently excerpted or summarized by an extra request. Every follow-up reloads current accessible content and reports changed sources. Missing selections or restored source epochs require reselection. Summary/action prompts request inline page citations; other writing shows a linked Sources list. Citations are model-generated and should be reviewed with the draft.

Conversations are private to their author in the document sidebar and searchable My writing library. Opening a library entry navigates to its original document. Individual and bulk deletion are available. History expires after 30 days without an explicit open or a writing request. Listing, searching, access polling, and GET reads do not extend that timer; explicit opening uses POST. Expired history cannot be revived. Scheduled cleanup removes expired records. Removing workspace membership cascades through conversations, messages, connections, OAuth states, preferences, and quota receipts.

The access guard uses the cumulative union of every page ever supplied to a conversation. Losing access to any one of them locks the entire conversation and hides prompts, results, and title excerpts, including from search. Access can be restored; locked conversations can be deleted. Owners receive no UI exception for another member's private history. History is stored in the installation's D1 database; normal operator database access still applies. Prompts, source content, results, and tokens are not added to application logs.

## Workspace API rollout

Apply migration `0080_ai_writing.sql` through the installation's normal D1 migration process. Build/deploy through the existing release procedure when ready. This branch does not deploy or modify production.

Set the operator's API credential through a Worker secret, never a client form:

```sh
pnpm exec wrangler secret put OPENAI_API_KEY --env production
```

In Settings → AI writing, an owner enables writing, enables workspace API funding, sets Fast/Best model IDs available to that credential, chooses conservative per-model context character limits, and sets the daily quota. Blank model IDs disable a mode. A separate model access request verifies the selected provider; no writing quota is charged for discovery.

Workspace API funding is available to all members when enabled. The default allowance is 20 started requests per member per UTC day; the owner can change it. Follow-ups and regeneration are new requests. Atomic D1 reservations enforce the allowance across concurrent requests. Confirmed pre-generation HTTP rejections (400/401/403/404/422/429) release the reservation. Cancelled requests after dispatch, stream failures, transport uncertainty, and 5xx responses retain it. Local validation does not consume quota. Remaining allowance and reset time are displayed in the member's locale. Operation IDs prevent duplicate model calls, including after conversation deletion while the 30-day receipt remains.

Members explicitly select ChatGPT plan or workspace API funding. A connected eligible ChatGPT account is preferred before any saved choice exists; a saved choice takes precedence. The selection is remembered on the server. There is no automatic billing fallback. A plan rejection explains the problem and leaves API selection to the member.

## Hosted Sign in with ChatGPT rollout gate

The connection is an AI connection on an already authenticated, protected NoteFlare account. It does not replace sign-in, registration, invitations, or account recovery. One connection is allowed per member; disconnect before replacing it.

`CHATGPT_CONNECTION_ENABLED` is `false` in every checked-in environment. Workspace API writing can ship independently. Enable plan connections only after OpenAI approves the hosted application and provisions its exact client contract. Do not use `dynamic_agent_client`, a loopback callback, or a local OSS identity in a Cloudflare Worker deployment.

Configure:

- `CHATGPT_CONNECTION_ENABLED=true` after hosted approval.
- `CHATGPT_CLIENT_ID`: the actual provisioned `oaiapp_…` client ID.
- `CHATGPT_TOKEN_AUTH_METHOD`: the provisioned `none` or `client_secret_basic` method.
- `CHATGPT_CLIENT_SECRET`: a Worker secret when the provisioned method requires it.
- `CHATGPT_SCOPES`: the exact approved hosted inference scope set. This implementation requires `openid offline_access resource.invoke chatgpt.tokens.use.direct` and can also request `profile email` when provisioned. Identity-only scopes do not enable inference.
- `AI_TOKEN_ENCRYPTION_KEY`: an independent high-entropy Worker secret used for AES-GCM token/state encryption. Preserve it across releases; rotation requires a migration or reconnection.
- Exact registered callback: `https://YOUR_NOTEFLARE_ORIGIN/api/ai/chatgpt/callback` (replace the illustrative host with your actual origin). It is derived from `BETTER_AUTH_URL`, never an inbound Host header.

The authorization flow uses OpenAI OIDC discovery, Authorization Code with S256 PKCE, single-use short-lived state tied to the NoteFlare member/session and an HttpOnly SameSite=Lax browser cookie, and a nonce. ID tokens are checked against discovery JWKS, issuer, audience, expiration, issued-at, authorized party, subject, and nonce. Returned access/refresh tokens must carry plan inference scopes; an ID token alone grants no writing access. Credentials remain encrypted on the server with member-bound authenticated encryption. Refresh uses a D1 lease and conditional rotation to serialize concurrent requests; disconnect wins over a late refresh. Secrets and tokens are absent from status/model/generation payloads.

Both funding paths use streaming Responses requests with `store:false`, an input array, and `instructions`; they do not use hosted retrieval tools, previous-response chaining, or unsupported local-sharing parameters. Application retrieval supplies the explicit sources. Only `response.completed` releases an applicable result. Identity-only login, local mocked OAuth, and protocol tests do not prove hosted plan eligibility.

Before enabling the gate, verify the provisioned scopes, resource (`https://api.openai.com/v1`), token authentication method, and public inference contract with OpenAI. Run actual hosted connection, nonce/state/expiry rejection, disconnect, refresh, model access, streamed generation, and allowance-limit acceptance against the provisioned environment. These live tests are separate from the local signed-token and mock-provider harness.

## MCP and private ChatGPT plugin

The existing eight tools and embedded browser/Markdown editor remain, with `fetch_table` and `fetch_diagram` added. See [plugin setup and protocol](CHATGPT_PLUGIN.md). These tools share the actor-aware source readers used by writing. They enforce OAuth scopes, live page permissions, bounded responses, encrypted actor/query-bound cursors, and snapshot revision/epoch checks. Tables and diagrams are read-only through these tools.

The source package is `plugins/noteflare`, version 0.2.0. ChatGPT is the launch client. Client-managed write confirmations retain the existing scope, revocation, version-guard, and receipt protections. Local protocol/browser tests do not certify installation in ChatGPT or other clients. Registration, private installation/publication, and live acceptance remain rollout steps. Only link the package with an actual environment-specific `plugin_asdk_app_…` technical ID using `pnpm plugin:link`; no registration ID is invented or committed.

Official contracts: [SIWC quickstart](https://developers.openai.com/siwc/quickstart), [hosted website flow](https://developers.openai.com/siwc/website), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [sharing preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), and [ChatGPT plugin registration](https://developers.openai.com/plugins/deploy/connect-chatgpt).
