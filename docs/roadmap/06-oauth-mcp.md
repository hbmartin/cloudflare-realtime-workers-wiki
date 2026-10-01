# Phase 6: member-scoped OAuth and MCP

Status: implementation pending. Depends on shared page operations and Phase 5 Markdown output.

## User contract

A member connects a compatible MCP client to `https://<note-flare-host>/mcp`, signs in, reviews
requested scopes and workspace, and grants access. The client can search accessible pages, fetch
a document, create or update a document, and add a comment. Results show only content the member
can read at call time. Write tools require both the OAuth write scope and the member's current
space/page permission. The member can list connected clients and revoke one without deleting the
client's pages. A revoked client loses access on its next request, including an already open MCP
session. Consent does not create an integration bot principal or expand a member's rights.

## Protocol and interfaces

- Serve MCP Streamable HTTP at `POST /mcp` and `GET /mcp` when needed for the transport, with
  `DELETE /mcp` for session cleanup. Implement protocol version negotiation, initialize,
  `tools/list`, `tools/call`, JSON-RPC errors, origin checks, request-size limits, and session
  lifecycle. Advertise stable tools: `search_pages(query,cursor)`,
  `fetch_page(page_id)`, `create_page(space_id,parent_id,title,markdown)`,
  `update_page(page_id,command)`, and `create_comment(page_id,body,block_id?)`.
  Fetch and update use Phase 5's supported document Markdown rules. Search has bounded pages and
  opaque cursors. Tool schemas include limits and return canonical page IDs/URLs, revision or
  operation receipts, and concise errors. Mutating calls accept a client operation ID so retries
  cannot create duplicate pages or comments.
- Act as an OAuth 2.1 resource server and authorization server for this host. Publish RFC 9728
  protected-resource metadata at `/.well-known/oauth-protected-resource/mcp` (and the correct
  root form if required by the routed resource), identifying the resource URI and authorization
  server. Publish RFC 8414 authorization-server metadata at
  `/.well-known/oauth-authorization-server`, including authorization, token, revocation, and
  registration endpoints, supported scopes, PKCE `S256`, and issuer. An unauthorized `/mcp`
  response includes `WWW-Authenticate: Bearer` with the resource metadata URL and needed scope.
- `GET /oauth/authorize` and `POST /oauth/authorize` validate client, exact redirect URI,
  `resource` audience, state, requested scopes, and `code_challenge_method=S256`. Show an
  account-bound consent screen; issue a short-lived, single-use code. `POST /oauth/token`
  verifies the PKCE verifier and client binding, then returns short-lived audience-bound access
  tokens and rotating refresh tokens. `POST /oauth/revoke` invalidates a grant and token family.
  Token storage uses hashes, not plaintext. Public clients use PKCE without a client secret.
- Support HTTPS Client ID Metadata Documents (CIMD) as the preferred client identity: fetch with
  size/timeout/redirect bounds, require matching `client_id`, validate redirect URIs and metadata,
  and prevent internal-address fetches. Also support pre-registered clients and an RFC 7591
  dynamic registration endpoint for clients still using it; rate-limit registration and restrict
  redirect schemes per the OAuth client profile. Never trust a display name or redirect supplied
  only in an authorization request. This follows the
  [2026-07-28 MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

Use scopes `pages:read`, `pages:write`, and `comments:write`; search/fetch require read,
create/update require write, and comment requires read plus comment write. Store grant identity as
`user_id + workspace_id + client_id + scopes + token family`, not a workspace-wide bot. Every
tool call validates token signature/hash, audience, expiry, revocation, scopes, current membership,
page grant, archive state, and destination role. Extract existing page search/mutation/comment
operations into actor-aware functions so `/mcp` and `/v1` share validation without treating an
integration token as a member. Long-running tool work rechecks access before commit.

## Migration, rollout, and recovery

Add D1 tables for OAuth clients, authorization codes, grants, token hashes, refresh families,
revocation, and operation receipts. Add indexes and TTL cleanup; no page-content migration.
Deploy metadata and authorization endpoints first, verify client discovery and consent in a
staging host, then enable read tools, then write tools. Keep a per-workspace MCP enable switch.
If token or D1 lookup fails, fail closed with an OAuth/MCP error; never fall back to a browser
cookie or integration token. Rotate server signing keys with overlapping verification until old
access tokens expire. Revoke a compromised family, preserve audit receipts, and let the member
reauthorize. Do not log bearer tokens, authorization codes, tool payloads, or page content.

## Exit matrix

| Scenario                                                                  | Required result                                                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Real OAuth MCP client discovery and connection                            | Metadata, PKCE, consent, and Streamable HTTP initialize succeed                         |
| CIMD client and legacy DCR client                                         | Both register safely and bind exact redirects/audience                                  |
| Search, fetch, create, update, comment                                    | Tool schemas and content work with member-scoped permissions                            |
| Scope missing, page revoked, workspace removed, grant revoked mid-session | Next call denied; no stale cached content or write                                      |
| Invalid audience, code reuse, bad PKCE, refresh replay, internal CIMD URL | Rejected without token issuance or network fetch to private address                     |
| Duplicate create/comment call and transport retry                         | One page/comment per operation ID; consistent receipt                                   |
| OAuth schema upgrade, token-store outage, signing-key rotation            | Existing valid grants migrate; outage fails closed; rotation preserves unexpired grants |
