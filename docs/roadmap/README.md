# NoteFlare phased roadmap

Status audited on **12 October 2026** against `main` at `b61dfbd` (migrations through `0082`). Phases 1–6, 9, and 11 are merged; a successful deployment record covers that SHA. Phases 7–8 and 10 remain planned. Production flags, owner enablement, and live acceptance are separate facts; see [audit evidence](../evidence/documentation-audit-2026-10-12.md).

This directory records implementation contracts, state ownership, recovery and rollout rules, and exit matrices. Complete a phase's exit matrix against the deployed installation before calling it shipped. A merged patch, visible control, or successful CI run alone is insufficient.

## Status definitions

| Status   | Meaning                                                                                       |
| -------- | --------------------------------------------------------------------------------------------- |
| Planned  | Plan written; no implementation merged                                                        |
| Merged   | Implementation and local/CI exit evidence merged to `main`                                    |
| Deployed | The production deploy workflow applied its migrations and Worker; any release flag may be off |
| Shipped  | Live exit matrix passed in production and every release flag for the phase is on              |

`main` is eligible for production deployment after CI; migration guards and workflow failures can stop a release. Check the exact deployed SHA and current controls before updating status.

## Round 1

| Order | Plan                                                             | PRs        | Migrations    | Production release control                     | Status                                |
| ----- | ---------------------------------------------------------------- | ---------- | ------------- | ---------------------------------------------- | ------------------------------------- |
| 0     | [Baseline and dependency map](00-baseline-dependencies.md)       | —          | —             | —                                              | Reference                             |
| 1     | [Editor, navigation, and embeds](01-editor-navigation-embeds.md) | #201       | `0048`–`0052` | `EXPANDED_EMBEDS_ENABLED=false`                | Deployed (flag off)                   |
| 2     | [Slack capture](02-slack-capture.md)                             | #202, #207 | `0053`–`0056` | None; both shortcuts use the new path          | Deployed; live acceptance pending     |
| 3     | [Date mentions and reminders](03-date-mentions-reminders.md)     | #203       | `0057`–`0060` | None; picker and scheduler implemented         | Deployed; live acceptance pending     |
| 4     | [Offline documents](04-offline-documents.md)                     | #204, #208 | —             | `OFFLINE_EDITING_ENABLED=false` (shell is on)  | Deployed (editing flag off)           |
| 5     | [Notion Markdown API](05-notion-markdown-api.md)                 | #205       | `0061`        | `NOTION_MARKDOWN_WRITES_ENABLED=false`         | Deployed (GET implemented, PATCH off) |
| 6     | [OAuth and MCP](06-oauth-mcp.md)                                 | #206, #209 | `0062`–`0065` | `workspaces.mcp_enabled`, owner-set, default 0 | Deployed; owner setting unverified    |
| 7     | [Collaborative table foundation](07-collaborative-tables.md)     | —          | —             | —                                              | Planned                               |
| 8     | [Table views and properties](08-table-views-properties.md)       | —          | —             | —                                              | Planned                               |

#207 and #210 fixed review findings across Phases 1, 2, and task leases. Exit evidence for Phases 1 and 2 is in
[01-phase1-evidence.md](../evidence/01-phase1-evidence.md) and [02-phase2-evidence.md](../evidence/02-phase2-evidence.md). Phases 3–6 record
their verification only in their PR descriptions. Closeout step C1 below moves that evidence into the [evidence directory](../evidence/README.md).

### Round 1 release closeout

These steps involve no new product code. Record the evidence completed by each step; only a completed live exit matrix and enabled controls justify **Shipped** status.

| Step | Phase | Remaining live work                                                                                                                                                                                                                                                                                     |
| ---- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | 3–6   | Write `03-phase3-evidence.md` through `06-phase6-evidence.md` from the PR verification sections, mapping each exit-matrix row to a test, as in Phases 1 and 2.                                                                                                                                          |
| C2   | 1     | Confirm the live CSP header, rich-block rendering, and that `/api/me` reports `expandedEmbeds:false`. Flip `EXPANDED_EMBEDS_ENABLED=true`, run `pnpm cf-typegen`, deploy, and recheck a preview, every provider origin, and health ([steps 2–4](../evidence/01-phase1-evidence.md#production-rollout)). |
| C3   | 2     | Live signed message capture, a private thread capture, a failed-job retry through `/?activity=1`, and a regression pass over search, App Home, notifications, and unfurls. The source receipt and final page IDs must agree.                                                                            |
| C4   | 3     | Observe a reminder's due-to-inbox lag under the 15-minute cron. Confirm email and Slack delivery honor preferences, and that a cron retry yields one logical event.                                                                                                                                     |
| C5   | 4     | Two-device and two-tab pilot of offline edit, refresh, reconnect, epoch change, and sign-out, then flip `OFFLINE_EDITING_ENABLED=true`.                                                                                                                                                                 |
| C6   | 5     | Notion SDK `retrieveMarkdown`/`updateMarkdown` against production with a pilot integration, plus a concurrent browser edit during PATCH. Then flip `NOTION_MARKDOWN_WRITES_ENABLED=true`.                                                                                                               |
| C7   | 6     | Enable MCP on one workspace. Connect a real MCP client through discovery, consent, and PKCE. Exercise all ten current tools, refresh rotation, and revocation mid-session. Confirm that disabling MCP revokes grants.                                                                                   |
| C8   | all   | Get the nightly cross-browser workflow green. The latest inspected run (12 October, `a19edb1`) failed; inspect current job evidence instead of assuming the older failure causes still apply.                                                                                                           |
| C9   | docs  | Current API documentation is refreshed as part of this audit. Keep its route matrix and integration examples aligned with future API changes.                                                                                                                                                           |

## Round 2

Phases 7–8 and 10 remain planned. Phase 9 is implemented and deployed with production controls off; its live exit matrix remains pending. The dependency model is:

```text
Closeout C1–C9 ──┬─→ Track A: Phase 7 table authority ──→ Phase 8 views + properties
                 └─→ Track B: Phase 9 Slack digests + shares ──→ Phase 10 operations incidents
```

| Order | Plan                                                                     | Source                                    | Depends on                                                                   | Status                 |
| ----- | ------------------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------- | ---------------------- |
| 7     | [Collaborative table foundation](07-collaborative-tables.md)             | IDEAS #9                                  | Round 1 closeout                                                             | Planned                |
| 8     | [Table views and properties](08-table-views-properties.md)               | IDEAS #2–4                                | Phase 7 cutover                                                              | Planned                |
| 9     | [Slack digests and share lifecycle](09-slack-digests-shares.md)          | Slack Milestone 4, channel-validation gap | Slack Milestones 0–2 (implemented)                                           | Deployed; controls off |
| 10    | [Operations incidents and Slack ops channel](10-operations-incidents.md) | Slack Milestone 5                         | None for the incident ledger; Phase 9's file and refresh topic patterns help | Planned                |

Phases 7 and 8 were planned in Round 1 and remain valid. Recheck them against these changes since their baseline:

- Task lists now write row-detail pages (`src/worker/tasks.ts`) and offer a fixed Table/Board toggle
  (`src/client/TasksView.tsx`).
- #207 and #210 changed task-lease and archive receipts.

The Phase 7 cutover must move these writers, and Phase 8's Board must replace the fixed toggle rather than sit beside
it. The Phase 8 property work should also cover IDEAS #1: give generic `POST /api/tables/:pageId/rows` row pages too,
not only task lists.

### Round 2 candidates awaiting selection

These open [IDEAS](../IDEAS.md) items are small or medium, have no dependency on Tracks A and B, and close visible
gaps. None has a plan yet. Pick the ones to plan as Phases 12 and later:

| Candidate                                      | IDEAS | Why now                                                                                                                 |
| ---------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------- |
| Comment reactions                              | #12   | The client still throws `Comment reactions are not enabled.`, and the thread store already models `reactions`           |
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

## Round 1 starting point (28 September 2026, `499af28`)

Historical: this is the baseline the Round 1 plans were written against. Each item is resolved by the phase noted.

- `QuickSwitcher` searched pages and recents but was not a command palette (Phase 1).
- Slack shortcuts created a page and then queued an append; `slack_captures` was unused (Phase 2).
- `y-indexeddb` persisted opened documents, but there was no service worker or installable shell (Phase 4).
- Three frame providers existed, with no `frame-src` in `public/_headers` and no syntax highlighting (Phase 1).
- `/v1` pinned `2026-03-11` and had no page Markdown routes (Phase 5).
- Tables were D1-authoritative with five property types and a 60-second lease. This remains true and is Phase 7's
  starting point.

## Phase 11 and writing integrations

[Phase 11](11-document-ideas.md) implements block links, live diagram embeds, and document diff digests. All three are deployed with checked-in production controls off, pending their independent live exit matrices. [AI writing](../AI_WRITING.md) and the [ChatGPT plugin](../CHATGPT_PLUGIN.md) have merged implementations; owner settings, hosted provider approval, plugin registration, and installed-client acceptance are separate rollout gates.

The Phase 11 release order is IDEAS #17, #65, then #62. Verification/freshness and workspace export/backups remain outside that increment.
