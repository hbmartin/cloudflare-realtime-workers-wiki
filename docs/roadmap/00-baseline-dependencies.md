# Baseline and dependency map

Status: Round 1 planning baseline, completed on 28 September 2026 at app commit `499af28`. Rows below
describe that baseline; for current status see [README.md](README.md).
Reference: [PARITY.md](../../../PARITY.md), dated 25 September 2026. Refresh this audit if the
checkout changes before a phase begins; the parity report alone is not an implementation ticket.

## What already works, and what remains

| Capability    | Current checkout evidence                                                       | Gap to close                                                                           |
| ------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Navigation    | `WorkspaceUI.tsx` has `QuickSwitcher`; `App.tsx` binds Cmd/Ctrl-K               | Commands, other shortcuts, help, availability checks                                   |
| Rich content  | `editor-blocks.tsx` contains math, Mermaid, code, and three frame providers     | Production rendering proof, highlighting, expanded safe providers, CSP and image proxy |
| Slack         | `slack-product.ts` routes both manifest shortcuts; Slack tests cover copy/retry | Finish Milestone 3 staging, provenance, atomic publication, full audit                 |
| Offline       | `collaboration.ts` uses Yjs IndexedDB by page and epoch                         | Installable shell, cached navigation, guarded reconnect and sign-out cleanup           |
| Notifications | Inbox/preferences and 15-minute cron exist                                      | Date tokens, reminder lifecycle and delivery receipt                                   |
| Public API    | `notion-api.ts` supports versioned `/v1` pages, blocks, comments, search        | Page Markdown GET/PATCH commands and async polling                                     |
| Tables        | D1 tables, five types, revision checks, 60-second lease                         | DO collaboration first; shared views and core property types afterward                 |

`docs/IDEAS.md` and `docs/SLACK_INTEGRATION_ROADMAP.md` are now tracked alongside this plan. The
latter's Milestone 3 contract set the Slack capture target, which Phase 2 implemented. Existing buttons
and routes count as partial implementation only when their complete user flow has been verified.

## Comparator evidence

| Source  | Concrete reference                                                                                                   | Adopted lesson                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Outline | `shared/editor/components/DateMentionPicker.tsx`, `shared/editor/embeds/`, `server/routes/mcp/index.ts`              | Date chooser, explicit provider descriptors, authenticated MCP transport                                   |
| AFFiNE  | `blocksuite/affine/data-view/src/` kanban/calendar tests and presets; `tests/affine-local/e2e/local-first-*.spec.ts` | Multiple views over one data model; explicit local reopen/sync tests                                       |
| Docmost | `packages/editor-ext/` and `apps/server/src/ws/base-realtime.bridge.ts`                                              | Editor behavior reference; Bases realtime implementation is an enterprise module absent from this checkout |

These are behavior references, not code to transplant. NoteFlare's Cloudflare D1/DO/R2 authority,
permissions, and current task/Slack paths determine the implementation. Calendar here is a table
view; AFFiNE's external calendar account code is outside scope. Relations, rollups, formulas,
broad embed catalogs, and offline table/diagram editing are outside the roadmap.

## Delivery graph and cross-phase interfaces

```text
Editor/CSP ───────────────┐
Slack capture ────────────┤ independent releases
Date/reminders ───────────┤
Offline documents ────────┘
Notion Markdown API ──────→ OAuth + MCP
Collaborative table DO ───→ Views + properties
```

The Markdown API feeds MCP document fetch/update, but MCP authorization stays member-scoped and
does not reuse the integration bot token. The table DO becomes the only table write authority;
D1 remains a repairable read projection for tasks, search, import, and Slack. Phase 8 must wait
until those paths have moved through Phase 7. Each phase can start discovery independently, but
the arrows are release gates.

## Baseline acceptance and upkeep

| Check                   | Evidence required before implementation starts                                   |
| ----------------------- | -------------------------------------------------------------------------------- |
| Current source          | Recheck named paths and migrations against the target commit                     |
| PARITY gap              | Mark shipped, partial, or absent with a working behavior test, not a label alone |
| Permissions and retries | Identify actor, current access check, authority, and stable operation ID         |
| Data migration          | Identify source of truth, verification hash/revision, replay, and rollback rule  |
| Phase completion        | Record the phase exit-matrix evidence and change its status in `README.md`       |
