# Integrations

Use an integration token for the `/v1` API, member OAuth for MCP, and signed webhooks for queued change notifications. Each path enforces current permissions. Begin with a synthetic pilot space and the smallest required capabilities.

## Bearer API setup

In Settings, an owner creates an integration, selects capabilities, issues a personal access token, and grants the required page subtree. Store the token securely when shown. A token without a grant cannot browse the workspace. Revoke or rotate it in Settings when the integration is retired or compromised.

For a read-only synthetic example, supply your own HTTPS installation origin and token through process environment variables:

```sh
curl --fail-with-body "$NOTEFLARE_ORIGIN/v1/search" \
  -H "Authorization: Bearer $NOTEFLARE_TOKEN" \
  -H 'Notion-Version: 2026-03-11' \
  -H 'Content-Type: application/json' \
  --data '{"query":"Team handbook","page_size":10}'
```

Only grant synthetic pages during initial testing. See the [compatibility matrix](API_COMPATIBILITY.md) before choosing an SDK method. Markdown writes require the [release control](FLAGS.md); reads can be piloted independently.

## OAuth and MCP

An owner enables MCP in workspace Settings. Register the HTTPS `/mcp` URL in a compatible client. Discovery is published at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp`; an unauthenticated MCP request returns a Bearer challenge.

The client follows member consent with Authorization Code and S256 PKCE. Supported scopes are `pages:read`, `pages:write`, and `comments:write`. Tokens are scoped to the MCP resource, current member, grants, and protection generation. Refresh rotation and revocation are enforced. Disabling workspace MCP revokes existing grants and pending codes; clients reconnect after it is re-enabled.

Tools are `search_pages`, `fetch_page`, `fetch_table`, `fetch_diagram`, `create_page`, `update_page`, `create_comment`, `list_spaces`, `list_pages`, and `open_noteflare`. Table and diagram tools expose bounded read-only sources. Document writes require Markdown-write activation and stable operation IDs; retries must reuse the same operation and payload after uncertainty. Consult [plugin contracts](specs/chatgpt-plugin.md) for bounded cursors, revision guards, and save recovery.

The [ChatGPT plugin guide](CHATGPT_PLUGIN.md) covers the installed user experience. Operator registration and private pilot acceptance are in [Operations](OPERATIONS.md#chatgpt-plugin-setup). This connector is independent of hosted ChatGPT inference funding in [AI writing](AI_WRITING.md).

## Signed webhook setup

An operator configures `WEBHOOK_ENCRYPTION_KEY`, an exact 32-byte key encoded as unpadded base64url. An owner creates a subscription for an integration, an allowed public HTTPS destination, and supported event types. The receiver gets a verification request containing `verification_token`; use that token to complete the subscription verification in NoteFlare. Store it securely as the signing secret. A verified destination is locked; create a new subscription when changing its URL.

Deliveries carry `X-Notion-Signature: sha256=<hex HMAC>`, computed with the verification token over the exact UTF-8 request body. Verify the raw bytes before parsing JSON. For example, in a Node receiver:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function authenticWebhook(rawBody, signature, verificationToken) {
  const expected = `sha256=${createHmac("sha256", verificationToken)
    .update(rawBody).digest("hex")}`;
  const received = Buffer.from(signature ?? "", "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}
```

A valid signature authenticates bytes; it does not make duplicate delivery unique. Persist the event `id` before applying an effect, acknowledge duplicates, and use the same ID across retries. The envelope includes timestamp, subscription/integration/workspace IDs, event type, entity, data, and attempt number. Queues retry delivery, and permissions/capabilities are checked again before delayed work executes. Handle current timestamps and event types according to your receiver's policy; do not infer exactly-once transport.

Inspect subscriptions and delivery records in Settings. See [Configuration](CONFIGURATION.md#secrets), [Operations](OPERATIONS.md#inspecting-the-work-queues), and [Troubleshooting](TROUBLESHOOTING.md) for operator recovery.
