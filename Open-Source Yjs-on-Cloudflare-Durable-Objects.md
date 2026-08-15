# Open-Source Yjs-on-Cloudflare-Durable-Objects Note/Wiki Apps — Landscape & Porting Assessment

## TL;DR

- **No production-grade, full open-source Notion/wiki app runs natively on Cloudflare Workers + Yjs-on-Durable-Objects today.** What exists is a mature _sync-infrastructure_ layer (Cloudflare's own `y-partyserver`, `napolab/y-durableobjects`, `TimoWilhelm/yjs-cf-ws-provider`) plus non-Yjs full-app precedent (tldraw sync). The full apps you shortlisted (AFFiNE, Outline, Docmost) are all Node/NestJS/Postgres/Redis monoliths that do **not** run on workerd.
- **The single most important 2025 development: Hocuspocus v4 (April 2025) dropped its Node `ws` dependency and now officially supports Cloudflare Workers** — per Tiptap's stable-release notes, _"We swapped the Node-only ws library for crossws, a universal WebSocket adapter. Hocuspocus now runs on… Bun, Deno, Cloudflare Workers, and Node with uWebSockets."_ This makes the Docmost/Outline collab layer _theoretically_ portable to Workers — but nobody has published a Durable Objects + WebSocket Hibernation adapter for it, so you'd be first.
- **Recommended path: build the app yourself on a Yjs-on-DO sync layer (`y-partyserver`) + BlockNote/TipTap, OR run a hybrid** (app server on Cloudflare Containers/Fly.io + only the Yjs sync layer on Durable Objects). Porting AFFiNE is impractical (Rust/NAPI native modules, BlockSuite complexity); porting Docmost/Outline wholesale to pure Workers is a large, unproven effort.

## Key Findings

### Category A — Reusable Yjs-on-DO sync infrastructure (mature, use these)

1. **`y-partyserver` (Cloudflare-owned, part of `cloudflare/partykit`)** — The most credible option. Maintained by Cloudflare (Sunil Pai / threepointone), ISC license. Release `y-partyserver@2.1.0` (PR #341, by @threepointone) explicitly _"Fix[ed] Yjs hibernation support and awareness propagation"_ by _"Replace[ing] in-memory WSSharedDoc.conns Map with connection.setState() and getConnections() so connection tracking survives Durable Object hibernation"_ and _"Disable[d] awareness protocol's built-in \_checkInterval… to prevent timers from defeating hibernation."_ A `withYjs` mixin applies Yjs to any Server subclass. This is the closest thing to an officially-blessed Yjs-on-DO backend, though it is still relatively niche (~28,600 weekly npm downloads per Socket.dev).
2. **`napolab/y-durableobjects`** — MIT, 250 stars / 12 forks, 70 commits, actively maintained through 2025/2026. Hono-based, "eliminating Node.js dependencies," inspired by y-websocket. Supports JS RPC (`getYDoc`/`updateYDoc`) plus WebSocket sync. Uses DO transaction storage; note the 128 KiB per-key limit forces chunking. WebSocket connections must be handled via `fetch` due to a current JS-RPC limitation (workerd issue #2319). Solid small library; single-maintainer risk.
3. **`TimoWilhelm/yjs-cf-ws-provider`** — Compatible with the standard Yjs WebSocket provider; **explicitly uses the DO WebSocket Hibernation API** to avoid idle duration charges, and periodically vacuums Yjs state to an **R2 bucket**. Per its README: _"It also periodically saves the Yjs document state to a Cloudflare R2 storage bucket and clears the partial updates from the Durable Object storage. The vacuum interval can be configured with the YJS_VACUUM_INTERVAL_IN_MS environment variable. The default is 30 seconds."_ Ships a TipTap demo. Author's own cost caveat: _"Keep in mind that every WebSocket message counts as a request towards your Cloudflare Workers plan."_ Best reference implementation of the snapshot-to-R2 + update-log-compaction pattern.
4. **`@mininjin/y-durable-objects`** — Based on y-websocket + y-leveldb; splits updates into chunks to fit the 128 KiB DO key limit. Niche.
5. **`hellopivot/y-workers`** — Ports y-websocket to DO with a Lexical example. Explicitly labeled _"WORK IN PROGRESS… do NOT work yet"_ and _"very early work"_; flags ~150 connection max per DO and 128 KiB value limit. **Treat as abandoned/demo.**

### Category B — Full apps that already run on CF Workers + DO

- **tldraw sync (`tldraw/tldraw-sync-cloudflare`)** — The gold-standard _production_ precedent, but **not Yjs** (tldraw uses its own store, `@tldraw/sync-core`). Production-ready (powers tldraw.com), per-room DO with **SQLite-backed storage** (`new_sqlite_classes`), WebSocket Hibernation (`ctx.acceptWebSocket()`, `clientTimeout: Infinity`, session snapshots persisted to WS attachment), assets to **R2**, served as SPA via Workers Static Assets. ~30 simultaneous collaborators per room. Worth cloning as an architectural template even though it's a whiteboard, not a note app.
- **No mature full-featured Notion/wiki-style Yjs note app on Workers+DO was found.** The `notion-clone` GitHub ecosystem (BlockNote + Convex/Clerk/Liveblocks, e.g. Zotion) overwhelmingly targets Convex/Vercel/Liveblocks, not Workers+DO. Small PartyKit demos exist (`amirrezasalimi/note` — React+Vite collaborative note on PartyKit/DO) but are toy-grade.

### Category C — y-sweet: explicitly moving AWAY from Cloudflare

- **`jamsocket/y-sweet`** (~1k stars, Rust, S3-backed) once had a Cloudflare Workers path but **added a Cloudflare deprecation notice** (PR #368, Dec 2024). The root cause is documented in issue #203, verbatim: _"since y-sweet server is build on rust, the rust porting api for Cloudflare worker Durable Object doesn't have a the latest Hibernatable WebSockets API… The origin accept function… would causing long-span Cloudflare durable object runtime fee and is not suitable for large-scale usage (actually even single WebSocket connection would cause large runtime fees, which I tested on my personal Cloudflare account, triggering the next-tier pricing charge very easy)."_ y-sweet is now positioned as S3-backed, self-hosted-on-Jamsocket. **Do not target the CF path.**

### Editor stacks (client-side, all framework-agnostic to the backend)

- **BlockNote** — Notion-style, built on TipTap/ProseMirror, batteries-included collaboration via Yjs. Documented providers: PartyKit, y-sweet, Hocuspocus, y-websocket, Liveblocks. Easiest to ship a Notion-like UX; less deeply customizable. Advanced features (AI, PDF/Word/ODT export, multi-column) are dual-licensed GPL-3.0/commercial.
- **TipTap/ProseMirror** — Maximum control; what Docmost and Outline use. Steeper (schemas/plugins).
- **BlockSuite** — AFFiNE's editor; powerful (page + edgeless canvas) but heavy (60+ packages) and tightly coupled to AFFiNE's Yjs data model.
- **Lexical/Slate/Milkdown** — Viable but less common with Yjs-on-DO precedent.

### Cloudflare platform facts relevant to a doc-sync workload (2025–2026)

- **DO SQLite storage**: up to **10 GB per object** (Paid), unlimited storage per account (Paid) / 5 GB (Free); 100 DO classes (Free) / 500 (Paid); WebSocket received-message size raised to **32 MiB** (effective 2025-10-25; runtime enforces 33,554,432 bytes else closes with code 1009 "Message is too large"). Key+value combined ≤ 2 MB on the KV-style API.
- **SQLite storage billing starts Jan 7, 2026** (per DO changelog: _"target date of January 7, 2026 (no earlier)"_). Pricing per the DO docs: **stored data 5 GB-month included, then $0.20/GB-month**; rows read — first 25 billion/month included, then $0.001/million; rows written — first 50 million/month included, then $1.00/million. Before Jan 2026, SQLite storage is effectively free during beta.
- **Compute/duration billing**: 400,000 GB-s/mo included (Paid), then $12.50/M GB-s; duration billed in wall-clock while the object is active and *ineligible for hibernation*. Requests: 1M/mo included, then $0.15/M. **Incoming WebSocket messages billed 20:1** (20 msgs = 1 request); outgoing messages and protocol pings free; each new WS connection = 1 request.
- **WebSocket Hibernation** is the make-or-break cost lever: use `ctx.acceptWebSocket()` + `webSocketMessage`/`webSocketClose`/`webSocketError` handlers and `serializeAttachment`/`deserializeAttachment` to persist session state, so idle rooms stop accruing duration charges. Getting this wrong (using the non-hibernation WS API, as y-sweet's Rust binding did) blows up cost.
- **Cloudflare Containers** (public beta June/July 2025): run any Docker image, scale-to-zero. **Active-CPU pricing since 2025-11-21**, per the changelog: *"Containers and Sandboxes pricing for CPU time is now based on active usage only… CPU-time is priced at $0.00002 per vCPU-second."* Initial concurrency limits were 40 GiB RAM / 40 vCPU account-wide, since raised substantially. Caveats: **no built-in autoscaling/load balancing (scale manually in code), ephemeral storage, not for long-lived stateful services.** Requires Workers Paid ($5/mo).

## Details

### AFFiNE — porting feasibility: **LOW / impractical**

- **Current collab stack**: BlockSuite editor → Yjs, with `y-octo` (a Rust/NAPI native Yjs CRDT implementation) and historically OctoBase (Rust). Backend is a **NestJS monolith** (GraphQL API + Copilot AI + realtime sync), **Postgres (with pgvector)** + **Redis** + **S3-compatible blob storage**, Node.js 22, plus **Rust modules compiled to NAPI bindings** for perf-critical paths. Client is React + Jotai; desktop is Electron; mobile via Capacitor.
- **Blockers on workerd**: NestJS + native NAPI Rust modules will not run on Workers. Postgres-specific features + pgvector, Redis pub/sub, and background sync/merge (AFFiNE's own docs note merging a 10k-modification doc can peak at ~1 GB RAM) all assume a long-lived Node process with real memory. The 128 MB DO memory ceiling alone kills the merge path.
- **Verdict**: Do not attempt a Workers port. If you want AFFiNE, run its container (Cloudflare Containers/Fly.io/VPS). MIT-licensed, so forkable, but the Rust+NestJS+BlockSuite surface is enormous.

### Outline — porting feasibility: **LOW–MEDIUM**

- **Current stack**: Node.js + **ProseMirror + Yjs**, realtime via **Hocuspocus**, **Postgres + Redis + S3-compatible storage**, OAuth/OIDC-only auth (no built-in username/password by design)
- **Blockers**: Redis is used both for websocket coordination and caching; Postgres is central; S3 required for attachments (local storage added ~2026). The monolith expects a long-lived process. Even with Hocuspocus v4's Workers support, the surrounding app (Sequelize/Postgres, background jobs) is not Workers-shaped.
- **Verdict**: Hybrid only. Keep Outline's app server on a container, optionally move just the Hocuspocus/Yjs layer to DO later. A pure-Workers port is a rewrite.

### Docmost — porting feasibility: **MEDIUM (best of the three), hybrid recommended**

- **Current stack**: **NestJS 11 on Node 22 with Fastify**, **TipTap 3 + Yjs**, realtime via a **separate Hocuspocus collaboration process (port 3001)** backed by **Redis pub/sub** for multi-instance scaling; **Postgres via Kysely**; **BullMQ + Redis** job queues; **Socket.io** for non-doc realtime; **S3-compatible or local** attachments; JWT auth via Passport. AGPL-3.0 core (+ paid EE modules) — **AGPL is a serious consideration for a proprietary SaaS**.
- **Why it's the most portable**: The collaboration server is already a _separate deployable_ using **Hocuspocus**, which as of **v4 (April 2025) officially supports Cloudflare Workers** (dropped Node `ws` → `crossws`, hooks use web-standard `Request`, app-level ping/pong, `handleConnection(ws, request, context)` instead of a Node HTTP server). Hocuspocus is MIT, ~2.5k stars, actively maintained (npm `@hocuspocus/server` 4.6.0 as of ~Aug 2026, ~751k weekly downloads).
- **The key unresolved gap**: Tiptap documents Workers support at the API level and ships examples for Bun/Deno/Express/Hono/Koa — but there is **NO official Durable Objects + WebSocket Hibernation example/adapter**. On Cloudflare, stateful long-lived WS realistically _requires_ a DO, and cost-efficiency _requires_ Hibernation. So porting Docmost's collab server to DO means writing the DO glue (accept WS via `ctx.acceptWebSocket()`, route messages into `hocuspocus.handleConnection`, persist Yjs state to DO SQLite/R2) yourself — plus replacing Redis pub/sub (a single DO per document is the natural coordination point, so Redis becomes unnecessary for the sync layer). The main app (NestJS API + BullMQ + Postgres) still needs a container.
- **Verdict**: Best hybrid candidate. App server + Postgres on a container; Yjs/Hocuspocus sync layer on Durable Objects (you build the DO adapter). Watch the AGPL license.

### Can Hocuspocus run on Cloudflare Workers/DO at all? — **YES at the API level, but no turnkey DO adapter exists**

Confirmed via primary sources: Hocuspocus v4.0.0 release notes and Tiptap's "Hocuspocus 4 stable" blog explicitly list Cloudflare Workers as a supported runtime, enabled by `crossws`. v1–v3 could NOT run on Workers (they depended on the Node `ws` package and a mandatory HTTP server — Tiptap: _"The previous versions depended on the ws package, which meant you couldn't run Hocuspocus on Bun, Deno, or Cloudflare Workers."_). No maintainer statement contradicts Workers support. But: no published `@hocuspocus/server`-inside-a-Durable-Object-with-Hibernation reference project was found; official runtime examples cover Bun/Deno/Express/Hono/Koa/PHP only. `TimoWilhelm/yjs-cf-ws-provider` proves the DO+Hibernation+R2 pattern works for Yjs, but it's a from-scratch y-websocket-compatible relay, **not** Hocuspocus. If you go this route you are the first to publish it.

### Hybrid architecture precedent

The "app server elsewhere, only the Yjs sync layer on Durable Objects" pattern is exactly what tldraw does in production (DO per room + R2), and what `TimoWilhelm/yjs-cf-ws-provider` implements generically. This split is the pragmatic sweet spot: DO gives you the single-writer-per-document coordination and cheap hibernating WebSockets; your existing Node app keeps Postgres/auth/search/jobs.

### Auth options on Workers

Cloudflare Access (Zero Trust), Clerk, Auth.js, WorkOS, or self-rolled JWT all work in front of Workers. tldraw's template deliberately omits auth (you add it). For a solo-founder SaaS, Clerk or self-rolled JWT validated in the Worker before the DO upgrade is the common pattern.

### Search / features at the edge

- **Search**: D1 (SQLite FTS5) for full-text at the edge, or Vectorize for semantic; alternatively external (Typesense/Meilisearch on a container). No Workers-native wiki ships this out of the box — you build it.
- **Nested pages/backlinks**: application-level (store hierarchy in D1/DO SQLite; derive backlinks on write). None of the sync libraries give you this — it's app logic.
- **File/image uploads**: R2 (tldraw and yjs-cf-ws-provider both do this).
- **Offline**: Yjs gives you CRDT offline-merge for free client-side (IndexedDB provider); y-sweet notably added offline support (v0.7).
- **Mobile**: web-responsive is straightforward; native apps are a separate effort (AFFiNE/AppFlowy have native apps; Outline/Docmost are web-only on mobile).

## Recommendations

**Stage 1 — Prototype the sync layer (1–2 weeks).** Clone the **tldraw-sync-cloudflare** template for its DO+SQLite+R2+Hibernation architecture, but swap the store for **Yjs via `y-partyserver`** (Cloudflare-maintained, hibernation-correct as of 2.1.0). Wire **BlockNote** on the client (fastest Notion-like UX; it speaks Yjs natively). Persist Yjs state as an **update log in DO SQLite with periodic snapshot compaction to R2** (the yjs-cf-ws-provider pattern). Benchmark: hibernation actually kicking in (watch GB-s in the dashboard), and per-document size staying well under the 10 GB DO cap.

**Stage 2 — Build the app shell (2–4 weeks).** Add nested pages, backlinks, and permissions as app logic backed by **D1** (with **FTS5** for search) and R2 for blobs. Serve the frontend via **Workers Static Assets** (or Hono/TanStack Start on Workers). Auth via Clerk or self-rolled JWT validated before the WS upgrade.

**Decision thresholds:**

- **Build-it-yourself (recommended default)** if you value a clean edge-native architecture, want to own the data model, and are comfortable that hierarchy/backlinks/search are _your_ code. Given your TS depth, this is ~4–8 weeks to a solid MVP and avoids AGPL/BSL entanglements.
- **Hybrid-port Docmost** if you need Confluence-grade features (spaces, permissions, comments, diagrams) _now_ and can accept: (a) a container for the NestJS app + Postgres, (b) writing the Hocuspocus-on-DO adapter yourself, (c) AGPL-3.0 obligations. This is faster to feature-parity than building, but the DO adapter is unproven work.
- **Do not** attempt to port AFFiNE to Workers, and do not build on y-sweet's Cloudflare path.
- **Cloudflare Containers changes the calculus** for the _app server_ half only: it lets you keep AFFiNE/Docmost/Outline's Node monolith on Cloudflare's network next to your DOs, but it is **not** a home for the always-on stateful collab process (ephemeral storage, no autoscaling, scale-to-zero) — that still belongs in Durable Objects. Reassess if Cloudflare ships stateful/always-on container support.

**Re-evaluate the "adopt existing" option if**: Tiptap publishes an official Hocuspocus + Durable Objects + Hibernation adapter (removes the biggest unknown for the Docmost hybrid), or a mature Yjs Notion-app on Workers+DO appears (none as of Aug 2026).

## Caveats

- **Recency**: Hocuspocus v4 Workers support (Apr 2025) and y-partyserver hibernation fixes (Feb 2025) are recent; verify against current releases before committing. y-sweet's CF deprecation is Dec 2024. Cloudflare Containers pricing/limits are evolving fast (active-CPU pricing landed Nov 2025).
- **Cost risk**: The dominant DO cost driver for chatty CRDT sync is WebSocket message volume (20:1 billing) and duration when hibernation isn't achieved. Yjs is efficient, but presence/awareness updates are frequent — throttle awareness and confirm hibernation empirically. Note the ongoing public debate about DO cost at scale (Ryan Dahl's `celld` claimed 100 resident objects ≈ $415/mo continuously active; Cloudflare countered that idle/hibernating objects would be ~$20.65/mo — underscoring that hibernation is everything).
- **`hellopivot/y-workers` and `amirrezasalimi/note` are demos/toys**, not production bases. `@mininjin/y-durable-objects` is niche.
- **Single-maintainer risk** on `napolab/y-durableobjects`; prefer Cloudflare-owned `y-partyserver` for longevity.
- **No first-party Cloudflare "Yjs wiki" template exists** — Cloudflare's collaborative-editing examples are primitives (chat, the DO WebSocket-hibernation how-to) and y-partyserver, not a finished app.
