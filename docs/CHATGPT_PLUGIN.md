# NoteFlare ChatGPT plugin

Implementation: `plugins/noteflare`. The source package contains the portable root manifest, NoteFlare assets, setup skill, and document workflow skill. Registration, installation, live acceptance, and private publishing are deferred at the user's request. Production has not been changed by this work.

Local checks and outstanding acceptance gates are recorded in [verification evidence](CHATGPT_PLUGIN_VERIFICATION.md).

## Server and editor

The existing OAuth authorization server and `/mcp` endpoint remain the integration boundary. There are eight tools: `search_pages`, `fetch_page`, `create_page`, `update_page`, `create_comment`, `list_spaces`, `list_pages`, and `open_noteflare`. Successful calls return both JSON text and validated structured content. Tool scopes and behavior annotations are declared individually; OAuth metadata now advertises existing client metadata document support.

`list_spaces` returns the workspace, granted scopes, accessible spaces, and effective write capability. `list_pages` returns up to 50 children with an opaque cursor bound to the space and parent. Omit the parent for roots. Private-space membership, templates, archived and staged pages, and hidden table detail pages follow the existing authorization and navigation rules. Diagrams and tables link to NoteFlare.

`fetch_page` includes `revision`, `contentEpoch`, destination IDs, and `canEdit`. Version-aware `update_page` calls provide both `expected_revision` and `expected_content_epoch`. Existing clients may omit both. Receipts are checked before these guards, and the Durable Object still checks the sequence atomically on commit. A stale write returns `page_changed` before changing content. Use the same operation ID and arguments for an uncertain retry; new input needs a new ID.

`NOTION_MARKDOWN_WRITES_ENABLED` must equal `"true"` for new MCP `create_page` and `update_page` writes, including resuming a staged create. When disabled or unset, these calls return retryable `markdown_writes_disabled` and the UI reports read-only capability. Completed operations can still return their OAuth receipt or recover a completed Durable Object update receipt without another content mutation, subject to current authorization and permissions. Read tools and comment creation retain their existing scope requirements. Production currently disables the flag; existing MCP clients need it enabled before making new document writes.

The resource is `ui://noteflare/v1/editor.html`, with MIME type `text/html;profile=mcp-app`. It is attached only to `open_noteflare`, with global and thread entrypoints and inline/fullscreen display modes. Data tools work independently. The Worker fetches the bundled HTML through its assets binding rather than embedding the main application.

The dedicated React UI uses the MCP Apps bridge for tools, context updates, and opening links. It supports browsing, search, creation, and Markdown drafts. Save is explicit; navigation and Cancel guard unsaved changes. Errors retain the draft and operation ID. Conflicts disable saving until the user reads the current version and manually reconciles the draft. The server preserves existing rich-block, attachment, and comment-anchor protections. Truncated or oversized documents open in NoteFlare for editing.

The preview renders Markdown elements through React. HTML is displayed as escaped source, images are placeholders, and links open only after a click. No external connections, frames, or resource domains are declared. Only page identity and explicitly selected text are sent to model context. Selection is capped at 8,000 characters; other draft content stays in the active UI and is lost if the host destroys it.

## Build and verify

`pnpm dev` builds the UI before starting Vite and watches its imports for rebuilds. `pnpm build`, Worker tests, and local browser tests also build it. Generated `public/plugin-ui/noteflare.html` is ignored by Git and copied into production assets.

```sh
pnpm check
pnpm exec playwright test --project=chromium tests/e2e/plugin-ui.spec.ts
pnpm plugin:eval
```

The browser test exercises the actual bundle in a simulated host under a strict CSP without `unsafe-eval`. It verifies the bridge handshake, guarded writes, conflict preservation, navigation guard, and absence of automatic external resources. It is distinct from installed ChatGPT acceptance.

The evaluation command uses `OPENAI_API_KEY` and optional `NOTEFLARE_EVAL_MODEL` (default `gpt-5.4-mini`). It uses the same schemas/descriptions as the server and the workflow skill, sends only synthetic cases, sets `store:false` for API responses, and never executes returned MCP calls. The 13 cases cover positive selections, revision guards and operation-ID reuse, unrelated prompts, local-only drafts, source instructions, and unsupported table edits. Results are checkpointed in `plugins/noteflare/evals/results.json` for each processed case. Malformed or incomplete responses are recorded as failures with a reason and available raw arguments, and later cases continue. API and transport failures are recorded as blocked with remaining cases not run. The initial attempt on 8 October 2026 was blocked by HTTP 429 `credit_balance_exhausted`; no case is recorded as passed. Offline evaluator tests use an isolated report and do not replace this paid-run evidence.

## Resume private rollout

1. Recheck external reachability from the ChatGPT connection environment: `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp` must return JSON; unauthenticated `POST /mcp` must return 401 with a Bearer challenge. The configured production origin is `https://cloudflare-realtime-notes.harold-martin.workers.dev`. Terminal checks on 8 October 2026 returned 200 for metadata and 401 for MCP; Chrome blocked navigation to this Workers domain. Earlier documentation probes returned Cloudflare 403. Resolve any client/network block before interactive OAuth.
2. Run checks, then apply this PR's existing `0079_slack_verified_recovery.sql` and any earlier pending migrations before deploying the reviewed Worker and assets. Follow the [Slack review follow-up migration procedure](DEPLOYMENT.md#slack-review-follow-up-migration): pause queue delivery, disable validation, wait 16 minutes, export D1, confirm the migration guard, and keep delivery paused through deployment and verification. Use the documented forward-only recovery procedure if deployment fails. The review fixes add no further migration. Production currently sets `NOTION_MARKDOWN_WRITES_ENABLED=false`; enable it for the writing pilot, including direct MCP writes. Enable workspace MCP through its owner-controlled switch. Keep PKCE, exact audience validation, rotating refresh tokens, revocation, and account verification intact.
3. In an administrator workspace with developer/plugin creation access, register the remote MCP URL using OAuth. Create a dedicated private NoteFlare test space, visible to the test member, and use only synthetic content for acceptance. Capture the generated `plugin_asdk_app_...` technical ID from ChatGPT.
4. Link that actual ID and create the install archive:

   ```sh
   pnpm plugin:link plugin_asdk_app_<actual-generated-id>
   ```

   This writes environment-specific `plugins/noteflare/.app.json` and creates `dist/noteflare-plugin.zip`. Neither is fabricated before registration. Upload the package through the workspace plugin admin UI and install it for pilot users.

5. Complete OAuth consent, refresh, and revocation; confirm revoked connections cannot read or write. Open the sidebar, conversation panel, and inline UI. Exercise search → read → create → update → comment, private-space filtering, read-only permissions, failed saves, stale revisions, restored epochs, duplicate retries, and rich-block/comment-anchor rejection. Confirm only selected text and identity enter model context.
6. Re-run model selection evaluations with API credits available and record installed ChatGPT positive/negative selections. Publish privately to the intended workspace roles after acceptance. Public directory submission is outside V1.

The source package cannot be installed as a linked ChatGPT plugin until registration supplies its `.app.json` dependency ID. Realtime collaboration, rich diagram/table editing, uploads, composer mentions, and file handlers remain outside V1.

## References

- [Plugins and packaging](https://developers.openai.com/plugins/build/plugins)
- [MCP server concepts](https://developers.openai.com/plugins/concepts/mcp-server)
- [Tool planning](https://developers.openai.com/plugins/plan/tools)
- [Embedded UI](https://developers.openai.com/plugins/build/chatgpt-ui)
- [Extension entrypoints](https://developers.openai.com/plugins/build/extensions)
- [OAuth guidance](https://developers.openai.com/plugins/build/auth)
- [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Function selection evaluations](https://developers.openai.com/api/docs/guides/function-calling)
