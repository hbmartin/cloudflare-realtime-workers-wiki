# Operator documentation

Cloudflare Realtime Notes is a single-workspace, self-hosted collaborative wiki running entirely on
Cloudflare Workers Paid, D1, R2, and two SQLite-backed Durable Object classes.

## I need to…

| Task                                                    | Document                                              |
| ------------------------------------------------------- | ----------------------------------------------------- |
| Stand up a new installation                             | [Deployment](DEPLOYMENT.md)                           |
| Deploy automatically on every push to `main`            | [Continuous deployment](CONTINUOUS_DEPLOYMENT.md)     |
| Look up a variable, secret, binding, or limit           | [Configuration](CONFIGURATION.md)                     |
| Invite members, rotate secrets, inspect the work queues | [Operations](OPERATIONS.md)                           |
| Import a Notion workspace export                        | [Operations](OPERATIONS.md#importing-a-notion-export) |
| Diagnose an error code, close code, or failed deploy    | [Troubleshooting](TROUBLESHOOTING.md)                 |
| Set up monitoring and alerts                            | [Observability](OBSERVABILITY.md)                     |
| Back up, restore, or recover data                       | [Backup and recovery](BACKUP_AND_RECOVERY.md)         |
| Assess compatibility with the Notion public API         | [Notion API compatibility](API_COMPATIBILITY.md)      |
| Report a vulnerability                                  | [Security policy](../SECURITY.md)                     |
| Understand what the architecture cannot do              | [Limitations](../Limitations.md)                      |

## System model

Three durable planes hold state. Knowing which one is authoritative for a given fact determines every
recovery decision.

| Plane                 | Authoritative for                                                                                                                                         | Recovery source                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| D1                    | Accounts, sessions, membership, page metadata, FTS5 search, backlink/mention projections, attachment and version metadata, structured tables, work queues | `pnpm db:export` (search index rebuilt on import)      |
| R2                    | Current document snapshots, immutable version snapshots, attachment bodies                                                                                | Bucket copy or replication                             |
| Durable Object SQLite | The Yjs update log after the last snapshot, plus room metadata                                                                                            | Not exportable in bulk; the DO itself is the only copy |

A document's current state is the R2 snapshot plus an ordered replay of the Durable Object update log.
Neither half is sufficient alone. Projections in D1 (search, backlinks, mentions, previews) follow
compaction, not keystrokes, so they lag edits by up to the 30-second compaction interval.

`WorkspaceEvents` Durable Objects hold no authoritative state. They only fan out page-tree and
projection-invalidation events; losing one costs freshness, not data.

## The hourly cron is load-bearing

`triggers.crons` in `wrangler.jsonc` is set to `0 * * * *`. The scheduled handler retries document-room
disconnects left behind by archive, and Durable Object and R2 targets left behind by permanent deletion.
Disabling it does not degrade gracefully: archived pages keep live editors connected, and permanently
deleted pages leak Durable Objects and R2 objects indefinitely.

Each tick drains at most 10 deletion jobs and 50 archive-disconnect targets. See
[Configuration](CONFIGURATION.md#cron-drain-rates-and-backoff) for what that means for backlogs.

## Degradation matrix

What survives when a dependency fails. Read this first during an incident.

| Down                 | Still works                                                                                | Breaks                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1                   | Warm and hibernating document rooms keep accepting edits and buffering to their own SQLite | Every API request and WebSocket upgrade fails; a _cold_ Durable Object cannot start; compaction fails, re-dirties the room, and retries every 30 seconds       |
| R2                   | The Durable Object update log is preserved intact                                          | Rooms cannot load; compaction retries; attachments return `attachment_missing`; versions return `version_missing`; restore returns 503                         |
| `WorkspaceEvents` DO | Everything, silently                                                                       | Page-tree, backlink, and mention pushes stop. The UI goes stale until a reconnect triggers a full `/api/pages/tree` reload. **No user-facing error is raised** |
| One `Document` DO    | The rest of the workspace                                                                  | That one page is unavailable. Archive and permanent-delete cleanup land in the retry tables and drain hourly                                                   |

`GET /api/health` only probes D1. It reports healthy during a complete R2 or Durable Object outage. See
[Observability](OBSERVABILITY.md#health-checking).
