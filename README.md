# Cloudflare Realtime Notes

A private, self-hosted collaborative wiki built entirely on Cloudflare Workers, Durable Objects, D1, and R2.

The editor is BlockNote backed by Yjs. Each document epoch has one hibernating `YServer` Durable Object, a debounced and chunked SQLite update log, an R2 snapshot, browser IndexedDB persistence, presence, and Yjs-backed comments. A second read-only Durable Object distributes workspace metadata events. Page metadata, membership, lean content projections, deletion jobs, search, and structured tables live in D1. Files and immutable versions live in R2.

## What works

- Operator-token bootstrap, Better Auth email/password sessions, one-use invites, and owner/editor/viewer roles.
- Workspace and private spaces, nested pages, favorites, pins, tags, templates, archive/restore, queued deletion, and scoped weighted FTS5 search.
- Realtime BlockNote editing, awareness, local undo, offline IndexedDB, hidden-tab disconnects, server-enforced viewer read-only access, and five-minute connection reauthorization.
- Merged update chunks, 30-second R2 compaction, structured D1 search/reference projection, 16/24 MiB warnings and limits, automatic versions, comparison, and epoch-safe restore.
- Realtime page-tree metadata, unified page/member mentions, backlinks, authorized hover previews, and a cursor-based mention inbox.
- Server-authoritative anchored comment threads, watches, in-app notifications, channel preferences, and timezone-aware digests.
- Private R2 attachments with authorization, all HTTP range forms, conditional ETags, safe disposition, `nosniff`, MIME rejection, inline editor media, and chunked direct-to-R2 uploads for large files.
- Full-page typed tables with 60-second single-editor leases, revision conflicts, owner force unlock, server-side paging and sorting, replayable bulk writes, and a 20,000-row limit.
- In-app Markdown, sanitized HTML, and nested Notion ZIP import with staged verification and atomic publication.
- Per-page Markdown, HTML, portable ZIP, and PDF export through resumable Cloudflare Workflows.
- Optional native Slack OAuth, private slash search, access-filtered unfurls, channel mappings, and queued personal/channel notifications.

This is an early v1 implementation. Production billing-grade hibernation verification and high-concurrency load tests still require a deployed Workers Paid account.

## Browser support

The production client supports Chrome and Edge 116+, Firefox 124+, and Safari 17.4+ on macOS and iOS. JavaScript and
CSS builds target that same matrix. Because build targets do not polyfill runtime APIs, the client checks its required
`AbortSignal` cancellation features at startup and shows an upgrade message instead of mounting in an unsupported browser.

## Local development

Requires Node.js 22.18 or later in the Node 22 release line, or Node.js 24.2+, and pnpm 11.18.0.

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm db:local
pnpm dev
```

Set a strong local `BETTER_AUTH_SECRET` and choose a `BOOTSTRAP_TOKEN` in `.dev.vars`. Open `http://localhost:5173`, enter that token on the first-run screen, and create the owner.

Useful checks:

```sh
pnpm check                 # formatting, lint, types, tests, dead code, generated types, Worker dry run
pnpm test:unit             # fast unit and React component tests
pnpm test:worker           # isolated Workers, D1, R2, and Durable Object integration tests
pnpm test:e2e              # Chromium UI integration suite against a fresh local D1 state
pnpm test:e2e:nightly      # Chromium, Firefox, WebKit, and mobile Chromium
pnpm load:realtime         # 30 authenticated local realtime connections
```

`pnpm lint` uses Oxlint with type-aware rules, `pnpm format:check` uses Oxfmt, and `pnpm analyze` uses
Fallow for unused dependencies and dead code. `pnpm analyze:audit` adds a changed-code review of duplication and
maintainability findings without treating the repository's inherited complexity as a new gate. TypeScript is checked
separately for the browser, Worker, unit tests, Worker integration tests, and build configuration. Coverage thresholds are
enforced by `pnpm test:coverage` and `pnpm test:worker:coverage`.

The E2E server deletes only `.wrangler/e2e`, reapplies every D1 migration, and injects dedicated local test bindings. To
run the realtime load check against a deployed environment, set `NOTES_LOAD_BASE_URL`, `NOTES_LOAD_EMAIL`, and
`NOTES_LOAD_PASSWORD`. `NOTES_LOAD_CONNECTIONS` and `NOTES_LOAD_HOLD_MS` tune the connection count and hold time.

Pull requests run static checks, coverage suites, production builds, a Wrangler deployment dry run, and Chromium UI
checks in separate CI jobs. The scheduled workflow adds the full browser/mobile matrix and realtime load checks. Configure
the `STAGING_BASE_URL` repository variable plus `STAGING_LOAD_EMAIL` and `STAGING_LOAD_PASSWORD` secrets to include a
deployed staging target in that load check.

## Architecture

```text
Browser
  ├─ React + BlockNote + Yjs
  ├─ IndexedDB (workspace:page:epoch:schema)
  └─ YPartyKitProvider connections
          ├─ authenticated /parties/document/:page~:epoch
          └─ authenticated /parties/workspace-events/:workspace
Hono Worker
  ├─ Better Auth + D1 metadata/FTS/projections/tables/comments/outbox
  ├─ authorized R2 attachment/version/job-artifact access
  ├─ Cloudflare Workflow jobs + Queue/DLQ deliveries
  ├─ optional Email, Browser Rendering, and Slack integrations
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

There is intentionally no ORM, Redis, Postgres, custom WebSocket protocol, Hocuspocus adapter, or repository layer.

## Production

Start at the [operator documentation index](docs/README.md), which covers deployment, configuration,
day-to-day operations, troubleshooting, observability, and backup and recovery. See also the
[security policy](SECURITY.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Accepted v1 limits

- One private workspace per installation.
- Workers Paid is the supported production target.
- 30 live connections per document epoch.
- Document warning at 16 MiB; server read-only at 24 MiB.
- 10 MiB single-request file uploads; larger files upload in parts.
- 20,000 table rows, read 500 at a time and sorted by the server.
- Server durability has a crash-only in-memory window of at most the configured five-second save debounce; IndexedDB resynchronizes surviving client edits.
- Search, backlinks, mentions, and previews follow document compaction rather than every keystroke.
- A workspace location hint affects only first Durable Object placement and is not a residency guarantee.

## License

AGPL-3.0. See [LICENSE](LICENSE).
