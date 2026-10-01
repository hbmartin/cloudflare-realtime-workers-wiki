# Phase 5: Notion-compatible page Markdown API

Status: implemented in #205 (merged 30 September 2026) and deployed with
`NOTION_MARKDOWN_WRITES_ENABLED=false`. GET is live; PATCH and async tasks wait on the live SDK
and concurrent-editor pilot. Contract fixture: Notion API version `2026-03-11`.

## User contract and API contract

An integration with a current read grant can call `GET /v1/pages/{id}/markdown` for a document
and receive `{object:"page_markdown",id,markdown,truncated,unknown_block_ids}`. A write grant can
call `PATCH` on the same path with each of Notion's four command variants. These routes live in
the existing `/v1` integration-token surface in `src/worker/notion-api.ts`; they use its version
header, capability, grant, rate-limit, and error envelope behavior. A table, diagram, archived
page, unsupported block ID, or inaccessible page has the documented validation or not-found
result. The contract is for supported document content, not table or diagram conversion.

| PATCH `type`            | Required command body and behavior                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update_content`        | `content_updates: [{old_str,new_str}]`; each nonempty `old_str` must match exactly once unless `replace_all_matches` is true; apply the array atomically |
| `replace_content`       | `new_str`; replace the supported page body as one transaction                                                                                            |
| `insert_content`        | `content` and either `after` selection or `position: {type:"start"                                                                                       | "end"}`; omitted position appends; both targets together are invalid |
| `replace_content_range` | `content_range` ellipsis selection and replacement `content`; reject missing or ambiguous ranges                                                         |

`update_content` and `replace_content` are the preferred commands; the other two remain
compatible. `allow_deleting_content` is honored where the Notion command supports it, but cannot
bypass NoteFlare's page permissions. `allow_async:true` returns HTTP 202 with an `async_task`
object, `status_url`, `poll_after_seconds`, and operation metadata. Omitted/false keeps synchronous
HTTP 200 `page_markdown`. `GET /v1/async_tasks/{id}` reports `queued`, `running`, `retrying`,
`succeeded` with `result`, or `failed` with a standard error. Only the initiating integration can
poll its task. Retain terminal results for a documented bounded period and return 404 afterward.

## Interfaces, conversion, and data flow

- Build a deterministic enhanced-Markdown projection from a consistent document-room snapshot.
  Support paragraphs, headings, lists, checklist items, quotes, code, links, emphasis, inline
  math, and the document blocks already representable in the `/v1` block surface. Keep stable
  block IDs for mapping selections and comments. A supported block round trips without losing
  its type or formatting. Unsupported embeds/bookmarks and other nonrepresentable nodes become
  `<unknown .../>` markers; never silently drop them. Populate `unknown_block_ids` for
  truncated or permission-hidden subtrees according to the Notion response rules; unsupported
  block types need the block API and are not automatically counted as fetchable unknown IDs.
  For a truncated response, return `truncated:true`, at most 100 unknown IDs, and permit GET of
  each retrievable subtree ID. Permission-hidden subtrees still 404.
- Parse and validate the entire PATCH body and Markdown before mutation. Resolve selections
  against one projected revision; reject an empty, missing, or ambiguous match with Notion-style
  `validation_error`. For targeted edits, map the selection to stable affected blocks and replace
  only those blocks. Preserve unaffected blocks, block IDs, comment anchors, and comments. A
  whole-page replacement may remove content only within the requested page and obeys deletion
  guards for child pages or unsupported structures. Refuse an operation that would partially
  overwrite an unknown or unrepresentable node; identify that need with a validation error.
- Submit one atomic `api-mutate` transaction to the document Durable Object with expected
  revision. On concurrent edits, re-evaluate the selection on a fresh snapshot once; if the
  target changed, return `conflict_error` rather than applying to different text. Render the
  committed snapshot for the response. Apply request-size, page-size, and operation-count caps
  before work begins so a large document fails with `validation_error` or `row_limit_exceeded`
  consistently, not a timeout or partial edit.
- For async, persist an integration-scoped job and immutable validated request before returning 202. The job rechecks the current page grant immediately before mutation. A job attempt uses a
  stable operation ID and a committed-result receipt, so worker retries cannot apply the edit
  twice. Poll reads the persisted state and result; revoke or delete a grant before execution and
  the task fails without changing the document.

No document migration is required. Add a D1 async-task receipt table and any block-ID mapping
needed to keep existing comments stable; backfill mapping lazily from the document room. Avoid a
separate mutable Markdown copy. The [Notion GET](https://developers.notion.com/reference/retrieve-page-markdown),
[PATCH](https://developers.notion.com/reference/update-page-markdown), and
[async-task](https://developers.notion.com/reference/retrieve-async-task) references are contract
fixtures, including response and error shapes.

## Rollout and recovery

Ship conversion as read-only first, compare projected Markdown with existing export and `/v1`
blocks, then enable synchronous PATCH for pilot integrations. Enable async after job polling and
retry recovery are verified. The route flag can disable new writes without removing completed
task results. An interrupted synchronous mutation returns its committed receipt or a retryable
conflict; an interrupted async job resumes from its receipt. Never return success before the
document room commits. Record unsupported-node and validation rates without logging page text.

## Exit matrix

| Scenario                                                             | Required result                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Notion SDK `retrieveMarkdown`/`updateMarkdown` for all four commands | Version, HTTP codes, field names, and shapes match the fixtures                   |
| Mixed formatting, comments, unknown embed, child page                | GET marks unknown content; targeted PATCH preserves untouched blocks and comments |
| Missing/duplicate selection, invalid command, oversize page          | Notion-style validation error; zero document mutations                            |
| Read-only token, revoked grant, inaccessible page                    | 403 or 404 as applicable; no content leak or write                                |
| Concurrent browser edit and PATCH retry                              | Targeted change once or 409 conflict; no misplaced edit                           |
| `allow_async`, job retry, polling to success/failure                 | 202 task shape; stable operation; one mutation and correct terminal result        |
| Async-table migration or worker crash after commit                   | Polling receipt recovers the result without repeating the edit                    |
| Browser editor open during API update                                | Committed content and comment anchors converge without reload or duplicate blocks |
