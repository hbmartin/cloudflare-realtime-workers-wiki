# NoteFlare phased roadmap

Status, audited 1 October 2026 against `main` at `2ef1450`: Round 1 Phases 1–6 are merged and deployed, with live
exit-matrix verification pending. Phases 7–8 are not started. Round 2 is drafted [below](#round-2) and awaits owner
selection.

This directory is the implementation handoff for the capabilities selected from the
[25 September parity report](../../../PARITY.md), which lives outside this repository. Each phase has a user contract,
interfaces and state ownership, recovery and rollout rules, and an exit matrix. Complete a phase's exit matrix
**against the deployed Worker** before marking it shipped; a merged patch, a visible control, or a green CI run alone
is insufficient.

## Status definitions

| Status   | Meaning                                                                                       |
| -------- | --------------------------------------------------------------------------------------------- |
| Planned  | Plan written; no implementation merged                                                        |
| Merged   | Implementation and local/CI exit evidence merged to `main`                                    |
| Deployed | The production deploy workflow applied its migrations and Worker; any release flag may be off |
| Shipped  | Live exit matrix passed in production and every release flag for the phase is on              |

`main` deploys automatically after CI (`.github/workflows/deploy.yml` applies D1 migrations, deploys, and health-checks),
so every merged phase is also deployed. The last production deploy was `d96d722` (#209) on 30 September; #210 deploys
when its CI run completes.

## Round 1

| Order | Plan                                                             | PRs        | Migrations    | Production release control                     | Status                         |
| ----- | ---------------------------------------------------------------- | ---------- | ------------- | ---------------------------------------------- | ------------------------------ |
| 0     | [Baseline and dependency map](00-baseline-dependencies.md)       | —          | —             | —                                              | Reference                      |
| 1     | [Editor, navigation, and embeds](01-editor-navigation-embeds.md) | #201       | `0048`–`0052` | `EXPANDED_EMBEDS_ENABLED=false`                | Deployed (flag off)            |
| 2     | [Slack capture](02-slack-capture.md)                             | #202, #207 | `0053`–`0056` | None; both shortcuts use the new path          | Deployed (live)                |
| 3     | [Date mentions and reminders](03-date-mentions-reminders.md)     | #203       | `0057`–`0060` | None; picker and scheduler are live            | Deployed (live)                |
| 4     | [Offline documents](04-offline-documents.md)                     | #204, #208 | —             | `OFFLINE_EDITING_ENABLED=false` (shell is on)  | Deployed (editing flag off)    |
| 5     | [Notion Markdown API](05-notion-markdown-api.md)                 | #205       | `0061`        | `NOTION_MARKDOWN_WRITES_ENABLED=false`         | Deployed (GET live, PATCH off) |
| 6     | [OAuth and MCP](06-oauth-mcp.md)                                 | #206, #209 | `0062`–`0065` | `workspaces.mcp_enabled`, owner-set, default 0 | Deployed (off per workspace)   |
| 7     | [Collaborative table foundation](07-collaborative-tables.md)     | —          | —             | —                                              | Planned                        |
| 8     | [Table views and properties](08-table-views-properties.md)       | —          | —             | —                                              | Planned                        |

#207 and #210 fixed review findings across Phases 1, 2, and task leases. Exit evidence for Phases 1 and 2 is in
[01-phase1-evidence.md](01-phase1-evidence.md) and [02-phase2-evidence.md](02-phase2-evidence.md). Phases 3–6 record
their verification only in their PR descriptions. Closeout step C1 below moves that evidence into files in this
directory.

### Round 1 release closeout

These steps involve no new product code. Each one ends by setting the phase to **Shipped** in the table above.

| Step | Phase | Remaining live work                                                                                                                                                                                                                                                                                              |
| ---- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | 3–6   | Write `03-phase3-evidence.md` through `06-phase6-evidence.md` from the PR verification sections, mapping each exit-matrix row to a test, as in Phases 1 and 2.                                                                                                                                                   |
| C2   | 1     | Confirm the live CSP header, rich-block rendering, and that `/api/me` reports `expandedEmbeds:false`. Flip `EXPANDED_EMBEDS_ENABLED=true`, run `pnpm cf-typegen`, deploy, and recheck a preview, every provider origin, and health ([steps 2–4](01-phase1-evidence.md#production-rollout)).                      |
| C3   | 2     | Live signed message capture, a private thread capture, a failed-job retry through `/?activity=1`, and a regression pass over search, App Home, notifications, and unfurls. The source receipt and final page IDs must agree.                                                                                     |
| C4   | 3     | Observe a reminder's due-to-inbox lag under the 15-minute cron. Confirm email and Slack delivery honor preferences, and that a cron retry yields one logical event.                                                                                                                                              |
| C5   | 4     | Two-device and two-tab pilot of offline edit, refresh, reconnect, epoch change, and sign-out, then flip `OFFLINE_EDITING_ENABLED=true`.                                                                                                                                                                          |
| C6   | 5     | Notion SDK `retrieveMarkdown`/`updateMarkdown` against production with a pilot integration, plus a concurrent browser edit during PATCH. Then flip `NOTION_MARKDOWN_WRITES_ENABLED=true`.                                                                                                                        |
| C7   | 6     | Enable MCP on one workspace. Connect a real MCP client through discovery, consent, and PKCE. Exercise all five tools, refresh rotation, and revocation mid-session. Confirm that disabling MCP revokes grants.                                                                                                   |
| C8   | all   | Get the nightly cross-browser workflow green. It has failed every night since at least 27 September: the passkey enrollment test needs CDP and must be scoped to Chromium, a WebKit nested-page search test fails, and a mobile Activities tray test times out. Firefox, WebKit, and mobile run only in nightly. |
| C9   | docs  | Refresh `docs/API_COMPATIBILITY.md`. It still says there are no queues, webhooks, bearer tokens, or passkeys, and it predates `/v1` Markdown, OAuth, and MCP.                                                                                                                                                    |

## Round 2

Draft; the owner must confirm scope. Round 2 runs on two independent tracks after closeout:

```text
Closeout C1–C9 ──┬─→ Track A: Phase 7 table authority ──→ Phase 8 views + properties
                 └─→ Track B: Phase 9 Slack digests + shares ──→ Phase 10 operations incidents
```

| Order | Plan                                                                     | Source                                    | Depends on                                                                   | Status  |
| ----- | ------------------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------- | ------- |
| 7     | [Collaborative table foundation](07-collaborative-tables.md)             | IDEAS #9                                  | Round 1 closeout                                                             | Planned |
| 8     | [Table views and properties](08-table-views-properties.md)               | IDEAS #2–4                                | Phase 7 cutover                                                              | Planned |
| 9     | [Slack digests and share lifecycle](09-slack-digests-shares.md)          | Slack Milestone 4, channel-validation gap | Slack Milestones 0–2 (shipped)                                               | Planned |
| 10    | [Operations incidents and Slack ops channel](10-operations-incidents.md) | Slack Milestone 5                         | None for the incident ledger; Phase 9's file and refresh topic patterns help | Planned |

Phases 7 and 8 were planned in Round 1 and remain valid. Recheck them against these changes since their baseline:

- Task lists now write row-detail pages (`src/worker/tasks.ts`) and offer a fixed Table/Board toggle
  (`src/client/TasksView.tsx`).
- #207 and #210 changed task-lease and archive receipts.

The Phase 7 cutover must move these writers, and Phase 8's Board must replace the fixed toggle rather than sit beside
it. The Phase 8 property work should also cover IDEAS #1: give generic `POST /api/tables/:pageId/rows` row pages too,
not only task lists.

### Round 2 candidates awaiting selection

These open [IDEAS](../IDEAS.md) items are small or medium, have no dependency on Tracks A and B, and close visible
gaps. None has a plan yet. Pick the ones to plan as Phases 11 and later:

| Candidate                                      | IDEAS | Why now                                                                                                                 |
| ---------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| Comment reactions                              | #12   | The client still throws `Comment reactions are not enabled.`, and the thread store already models `reactions`           |
| Copy link to block and deep-link highlight     | #17   | Comment anchors already exist; this pairs with MCP and `/v1` block IDs                                                  |
| Workspace export and scheduled R2 backups      | #41   | Completes `docs/BACKUP_AND_RECOVERY.md`; per-page export and Workflows already exist                                    |
| Audit log                                      | #31   | Table stakes for a self-hosted org. OAuth/MCP grants and Slack actions now add actors worth auditing                    |
| Trash at scale                                 | #34   | Trash offers single-item restore only                                                                                   |
| Share-link password and expiry                 | #36   | View counts are already shown; expiry and revoke-all are missing                                                        |
| CSV import to a table                          | #10   | Parser and type inference already exist inside Notion ZIP import. Do it after Phase 7 so it writes through the table DO |
| Embedding on compaction (`AI` and `Vectorize`) | #49   | IDEAS flags it as expensive to retrofit, because the backfill grows weekly. It needs an explicit product decision       |

## Cross-phase rules

Every write must use a stable operation or receipt ID where retries can repeat an effect. Access
is checked when work is requested and when delayed work executes. D1 projections must say which
Durable Object or R2 state is authoritative, how to detect lag, and how to rebuild. Each release
must include migration verification, a recovery path, and tests at the user-visible boundary.
No new capability is counted shipped merely because a menu item or API route exists.

Because `main` deploys automatically, every new capability that is not additive and invisible must merge behind a
release control (an environment flag or an owner setting, listed in [FLAGS.md](../FLAGS.md)) that is off in production. It is enabled only after its live
exit matrix passes. Run `pnpm test:e2e:nightly` locally for client UI changes; per-PR CI covers Chromium only.

## Comparator lessons and limits

- **Outline:** Use its date mention picker, action registry, provider descriptors, and Streamable
  HTTP MCP route as behavior and interface references. Its source lives in the sibling `outline/`
  checkout; do not import its BSL code into NoteFlare.
- **AFFiNE:** Its BlockSuite kanban/calendar view presets and local Yjs-backed editing show how
  multiple views can share data and how an opened document can reopen locally. Use the patterns,
  not its application code or unrelated calendar-account integration.
- **Docmost:** Its editor and Community edition provide comparison points for blocks and offline
  persistence. Its richer Bases implementation is in a private paid module, so property behavior
  here is specified from NoteFlare's needs rather than presumed to be available source.

## Round 1 starting point (28 September 2026, `499af28`)

Historical: this is the baseline the Round 1 plans were written against. Each item is resolved by the phase noted.

- `QuickSwitcher` searched pages and recents but was not a command palette (Phase 1).
- Slack shortcuts created a page and then queued an append; `slack_captures` was unused (Phase 2).
- `y-indexeddb` persisted opened documents, but there was no service worker or installable shell (Phase 4).
- Three frame providers existed, with no `frame-src` in `public/_headers` and no syntax highlighting (Phase 1).
- `/v1` pinned `2026-03-11` and had no page Markdown routes (Phase 5).
- Tables were D1-authoritative with five property types and a 60-second lease. This remains true and is Phase 7's
  starting point.
