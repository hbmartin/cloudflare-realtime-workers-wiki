# Cloudflare Realtime Notes

A private, self-hosted collaborative wiki built entirely on Cloudflare Workers, Durable Objects, D1, and R2.

The editor is BlockNote backed by Yjs. Each document epoch has one hibernating `YServer` Durable Object, a chunked SQLite update log, an R2 snapshot, browser IndexedDB persistence, presence, and Yjs-backed comments. Page metadata, membership, search, and structured tables live in D1. Files and immutable versions live in R2.

## What works

- Operator-token bootstrap, Better Auth email/password sessions, one-use invites, and owner/editor/viewer roles.
- Nested pages with fractional ordering, drag-to-reparent, cycle prevention, archive/restore, permanent deletion, and FTS5 search.
- Realtime BlockNote editing, awareness, local undo, offline IndexedDB, hidden-tab disconnects, server-enforced viewer read-only access, and five-minute connection reauthorization.
- Durable update chunks, 30-second R2 compaction, delayed D1 search projection, 16/24 MiB warnings and limits, automatic versions, comparison, and epoch-safe restore.
- Private R2 attachments with authorization, ranges, ETags, safe disposition, `nosniff`, MIME rejection, and a 10 MiB limit.
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
  └─ YPartyKitProvider
          │ authenticated /parties/document/:page~:epoch
Hono Worker
  ├─ Better Auth + D1 metadata/FTS/tables
  ├─ authorized R2 attachment/version access
  └─ PartyServer router
          │
Document Durable Object (hibernating YServer)
  ├─ immediate ~1 MiB SQLite update chunks
  ├─ 30-second R2 current snapshot
  ├─ automatic immutable R2 versions
  └─ delayed D1 plain-text projection
```

There is intentionally no ORM, Redis, Postgres, custom WebSocket protocol, Hocuspocus adapter, repository layer, or workspace-wide realtime service.

## Production

See [Deployment](docs/DEPLOYMENT.md), [Backup and recovery](docs/BACKUP_AND_RECOVERY.md), [Security policy](SECURITY.md), and [third-party notices](THIRD_PARTY_NOTICES.md).

## Accepted v1 limits

- One private workspace per installation.
- Workers Paid is the supported production target.
- 30 live connections per document epoch.
- Document warning at 16 MiB; server read-only at 24 MiB.
- 10 MiB single-request file uploads.
- 500 table rows, loaded and sorted in the browser.
- Search follows document compaction rather than every keystroke.
- A workspace location hint affects only first Durable Object placement and is not a residency guarantee.

## License

AGPL-3.0. See [LICENSE](LICENSE).
