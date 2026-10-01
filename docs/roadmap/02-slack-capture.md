# Phase 2: finish Slack capture

Status: implemented in #202 (merged 30 September 2026) and deployed to production with no
flag, so both shortcuts publish through the new capture path. The live signed-capture checks in
[02-phase2-evidence.md](02-phase2-evidence.md) are still pending. This plan closed the
Milestone 3 contract in `SLACK_INTEGRATION_ROADMAP.md`.

## User contract and baseline audit

**Save to Notes** captures one Slack message as a new NoteFlare document. **New page from
thread** captures the root and all supported replies as one document. Both ask for a writable
space, optional parent, and title; show only eligible destinations; and return a link to the
published page. They may create a task only when the user explicitly changes the form's kind.
No shortcut ends at a placeholder, leaves a visible empty page after failure, or silently
duplicates a page when Slack retries.

First run a signed-interaction audit of `/notes` search, App Home notifications, personal and
channel notification delivery, link unfurls, and both shortcuts. Record pass/fail evidence in
the phase's test results. The current `slack-product.ts` already handles both callbacks and
tests lost-receipt copying. Its page-first, queued-append design does not provide the existing
roadmap's atomic publication guarantee. `slack_captures` already exists but is not used by this
path. Replace that publication path rather than adding another shortcut handler.

## Interfaces and data flow

1. Verify the Slack signature and acknowledge within Slack's deadline. Bind the interaction to
   the installation generation and an OpenID-verified member. Reject Slack Connect, DMs, MPIMs,
   unmapped channels, guests, and inaccessible source channels with a generic ephemeral message.
2. At form open and submit, resolve the member's current NoteFlare role and writable destination.
   Recheck installation, channel membership, source visibility, destination and optional parent
   again before publication. The parent must belong to the selected space.
3. Claim `slack_captures` by installation, channel, root/message timestamp, and kind. Its unique
   key is the durable capture identity; modal session and Slack retry IDs point to that record.
   A repeat returns the current job or completed page. A different requested destination for an
   existing claim is a conflict, not a second capture.
4. Fetch threads with `conversations.replies` cursor pagination, honoring `Retry-After`. Freeze
   the source transcript before staging. Cap at 2,000 messages and 2 MiB normalized Markdown;
   reject oversized content before starting an import. Include permalink, capture time, author,
   timestamp, normalized text, reactions/counts, and attachment names and safe links. Do not
   download Slack file bytes, include bot-authenticated private URLs, or generate a summary.
5. Stage the Markdown in R2 and start the existing verified import Workflow with chosen space,
   parent, actor, and capture ID. Extend import options to carry `parentId`; check it at request
   and final publication. The staged page stays hidden behind `import_job_id` until hash and
   metadata verification succeed. Persist `job_id`, final `page_id`, and state on
   `slack_captures` only after verifying the corresponding job or page receipt. Reconcile a crash
   between the R2/Workflow operation and the D1 receipt by capture ID before retrying.
6. Use the existing outbox for queued/succeeded/failed ephemeral feedback and a safe retry link.
   A retry resumes the same capture record and job; publication is idempotent. On terminal
   failure, clean up staged objects and unpublished pages while retaining the failure receipt.

Reuse the current `slack_product_sessions` for form state and `slack_captures` for source-level
idempotency. Add a migration for destination/parent IDs, request hash, attempt count, error
category, and publication timestamp while retaining the existing unique source key. The
importer must not treat a Slack permalink or stored channel mapping as authorization. No Slack
content is written to observability logs.

## Rollout and recovery

Deploy the parent-aware import and capture receipts before routing shortcuts to them. During
cutover, complete or reconcile existing `slack_product_copy` outbox entries and detect whether
their pages already contain the source block; never recapture them as fresh imports. Switch the
two manifest callbacks together after signed staging tests pass. If the new workflow must be
disabled, return an explicit temporary-unavailable message rather than opening a form that
cannot publish. Search, unfurls, and notification delivery remain available independently.

## Exit matrix

| Scenario                                                      | Required result                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| Message and 3-page thread, public and private mapped channels | One attributed, complete, published page each                       |
| Double submit, Slack retry, lost response, outbox replay      | One capture record, job, and page                                   |
| Source or destination access revoked before publication       | No published page or disclosed content                              |
| Thread >2,000 messages, output >2 MiB, rate limit             | Bounded rejection or retry with no partial page                     |
| Import verification failure                                   | Hidden staging cleaned; durable failed state and useful feedback    |
| Search, unfurl, App Home, notification regression             | Existing permission checks and interactions still pass              |
| Cutover with an old queued copy or interrupted staging        | Existing page reconciled once; no orphaned stage or fresh duplicate |
