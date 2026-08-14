# Cloudflare Realtime Notes

A private, self-hosted collaborative wiki built entirely on Cloudflare Workers, Durable Objects, D1, and R2.

The editor is BlockNote backed by Yjs. Each document epoch has one hibernating `YServer` Durable Object, a debounced and chunked SQLite update log, an R2 snapshot, browser IndexedDB persistence, presence, and Yjs-backed comments. A second read-only Durable Object distributes workspace metadata events. Page metadata, membership, lean content projections, deletion jobs, search, and structured tables live in D1. Files and immutable versions live in R2.

## What works

- Operator-token bootstrap, Better Auth email/password sessions, one-use invites, and owner/editor/viewer roles.
- Nested pages with fractional ordering, drag-to-reparent, cycle prevention, archive/restore, queued permanent deletion, and FTS5 search.
- Realtime BlockNote editing, awareness, local undo, offline IndexedDB, hidden-tab disconnects, server-enforced viewer read-only access, and five-minute connection reauthorization.
- Merged update chunks, 30-second R2 compaction, structured D1 search/reference projection, 16/24 MiB warnings and limits, automatic versions, comparison, and epoch-safe restore.
- Realtime page-tree metadata, unified page/member mentions, backlinks, authorized hover previews, and a cursor-based mention inbox.
- Private R2 attachments with authorization, all HTTP range forms, conditional ETags, safe disposition, `nosniff`, MIME rejection, and a 10 MiB limit.
- Full-page typed tables with 60-second single-editor leases, revision conflicts, owner force unlock, local filtering/sorting, and a 500-row limit.

This is an early v1 implementation. Production billing-grade hibernation verification and high-concurrency load tests still require a deployed Workers Paid account.

## Local development

Requires Node.js 22+ and pnpm 11.

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm db:local
pnpm dev
```

Set a strong local `BETTER_AUTH_SECRET` and choose a `BOOTSTRAP_TOKEN` in `.dev.vars`. Open `http://localhost:5173`, enter that token on the first-run screen, and create the owner.

Useful checks:

```sh
pnpm test
pnpm build
pnpm cf-typegen
```

## Architecture

```text
Browser
  ├─ React + BlockNote + Yjs
  ├─ IndexedDB (workspace:page:epoch:schema)
  └─ YPartyKitProvider connections
          ├─ authenticated /parties/document/:page~:epoch
          └─ authenticated /parties/workspace-events/:workspace
Hono Worker
  ├─ Better Auth + D1 metadata/FTS/projections/tables
  ├─ authorized R2 attachment/version access
  ├─ queued deletion + hourly retry handler
  └─ PartyServer router
          ├────────────────────────────────────┐
Document Durable Object (hibernating YServer)
  ├─ 1–5 second merged ~1 MiB SQLite update chunks
  ├─ 30-second R2 current snapshot
  ├─ automatic immutable R2 versions
  └─ delayed structured D1 projection
                                               │
WorkspaceEvents Durable Object (read-only) ────┘
  └─ page and projection invalidation events
```

There is intentionally no ORM, Redis, Postgres, custom WebSocket protocol, Hocuspocus adapter, repository layer, or persisted full-document JSON projection.

## Production

See [Deployment](docs/DEPLOYMENT.md), [Backup and recovery](docs/BACKUP_AND_RECOVERY.md), [Security policy](SECURITY.md), and [third-party notices](THIRD_PARTY_NOTICES.md).

## Accepted v1 limits

- One private workspace per installation.
- Workers Paid is the supported production target.
- 30 live connections per document epoch.
- Document warning at 16 MiB; server read-only at 24 MiB.
- 10 MiB single-request file uploads.
- 500 table rows, loaded and sorted in the browser.
- Server durability has a crash-only in-memory window of at most the configured five-second save debounce; IndexedDB resynchronizes surviving client edits.
- Search, backlinks, mentions, and previews follow document compaction rather than every keystroke.
- A workspace location hint affects only first Durable Object placement and is not a residency guarantee.

## License

AGPL-3.0. See [LICENSE](LICENSE).
