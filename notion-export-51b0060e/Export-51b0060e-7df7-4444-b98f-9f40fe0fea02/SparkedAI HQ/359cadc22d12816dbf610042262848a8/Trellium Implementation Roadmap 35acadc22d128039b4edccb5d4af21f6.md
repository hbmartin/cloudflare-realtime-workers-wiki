# Trellium Implementation Roadmap

# OLD DRAFT: Will completely rewrite once PRD approaches completion and beta requirements are defined. See:

# Trellium Implementation Roadmap

## 1. Executive Summary

Trellium is a multi-tenant, AI-driven behavioral training platform. The PRD is broad — twelve user flows, six personas, three storage tiers, a real-time simulation surface, a multi-LLM AI orchestration layer, and a longitudinal data flywheel. Trying to build all of it in parallel will fail.

The PRD itself names the right strategic compression: **the paid pilot only requires Simulation + Feedback + Manager Dashboard, with frameworks loaded manually by SparkEd.** Everything else — Frameworks Engine automation, KPI correlation, God Mode analytics, the flywheel — can ship after pilot revenue is in.

This roadmap stages the build accordingly:

| **Stage** | **Goal** | **Gating Outcome** |
| --- | --- | --- |
| **0. Foundations** | Cross-cutting architecture in place before product code | Multi-tenancy, auth, content repo, eval harness, observability |
| **1. Pilot Core Loop** | Sellable to pilot clients with manually-loaded frameworks | First user completes assessment → simulation → report end-to-end in a real client tenant |
| **2. Frameworks Engine** | Move from consulting motion to software motion | New client onboards in 2–3 weeks (Scenario A) without manual framework authoring |
| **3. Manager/Director Depth + KPI Correlation** | Make the buyer (Director / VP) renewal-confident | Skill-to-Performance dashboard live; Ivy report generation live |
| **4. God Mode + Flywheel** | Internal product intelligence + Stage 1 of the data moat | De-identified aggregate store live; SparkEd Analytics dashboard usable for CS triggers |
| **5+. Phase 2 Features** | Per PRD §4.2 | Video analysis, CRM integrations, adaptive engine, etc. |

Stages 1 and 2 should run **partially in parallel** under agentic development — Stage 1 is the consumer of frameworks, Stage 2 is the producer; the contract between them is the framework JSON schema (a Stage 0 deliverable). Harold should expect Stage 1 to ship before Stage 2 in client-visible terms even though most of Stage 2 work happens during the Stage 1 build window.

## 2. Three Major Challenges

1. Extracting Necessary Feedback Data from Audio
    
    Derisk: Prioritize testing of the platforms in [Voice Analysis AI Research](https://docs.google.com/document/d/1G9dGksjEXv1FFnzpy4d_XZLsXuZXAQW_v0KoY_WXNIw/edit?tab=t.0)
    
    Recommendation: Implementation must include evals from day 1.
    
    Downside: Constrained by provider ability prior to building our own models
    
2. Multi-Tenant Isolation (see below)
    
    Derisk: maximize architectural isolation from the ground up
    
    Recommendation: Individual app deploy and database per tenant
    
    Downside: meaningful increase in operational complexity. This is acceptable given low tenant count.
    
3. ROI “closed loop” data gathering
    
    Derisk: VERY CONCERNED ABOUT CHALLENGES HERE. NEED TO WORK WITH TEAM TO IDENTIFY SPECIFIC INTEGRATIONS FOR INITIAL CUSTOMERS
    

## 3. Cross-Cutting Architectural Decisions

These decisions are made once and shape everything. They sit in Stage 0 because every later stage assumes them.

### 3.1 Multi-Tenancy: Schema-per-Tenant on Shared Cluster

The PRD says "isolated client tenant per organization — dedicated data environment." We have two viable interpretations, given Postgres on RDS:

| **Approach** | **Isolation Strength** | **Operational Cost** | **Migration Pain** | **Cost Per Tenant** |
| --- | --- | --- | --- | --- |
| **Database-per-tenant** | Strongest. Separate logical DB. Backup/restore per tenant. Easiest legal story. | Highest — every migration must run N times. Connection pooling complicated. Cross-tenant analytics requires logical replication or ETL. | Each migration is a coordinated job. Tooling exists (Atlas, Sqitch) but it's real ops work. | Highest — RDS bills per DB, and connection limits become a real constraint past ~30 tenants. |
| **Schema-per-tenant** (recommended) | Strong. Each tenant has its own schema; search_path sets isolation per connection. Compromised tenant cannot read another's data. | Moderate — single migration runs across all schemas via a loop, scriptable. | Manageable. | Low — single DB, single connection pool. Scales to hundreds of tenants on one RDS instance. |
| Row-level (tenant_id column + RLS policies) | Weakest of the three. One bug in a query = cross-tenant leak. | Lowest. | Lowest. | Lowest. |

**Recommendation: schema-per-tenant.** The PRD's promise of isolation, combined with "well protected, not HIPAA" data sensitivity, lands here. It gives a clean tenant story to security-conscious pharma buyers without the per-tenant ops tax of separate databases. The Aggregate Behavioral Data Store (per your answer: logical separation inside Postgres) lives in a dedicated analytics schema, populated by triggers/CDC from tenant schemas with de-identification applied at write time.

**Implication for code:** every database connection is scoped via SET search_path at the start of the request. We use Drizzle (Next.js native) and wrap the connection acquisition in a tenant-scoped helper. Row-level tenancy bugs become impossible by construction because no query can see schemas it isn't pointed at.

**Open question deferred to Stage 0:** how we handle the SparkEd Analytics user (God Mode) reading across all tenant schemas. Likely a privileged role that can SET search_path to any tenant, with audit logging on every cross-tenant read.

### 3.2 Content as Data — Git-Style Repo, UI-Managed

Per your answer: a git-style content repo managed from within the UI. Concretely:

- **Storage:** Postgres content schema (global, not per-tenant) holds versioned JSON blobs for: tactic rubrics, FDA guidelines, behavioral library, prompt templates, scenario briefs, framework templates. Each row is (content_id, version, parent_version, content_jsonb, author, created_at, status) where status ∈ {draft, in_review, published, archived}.
- **Branching model:** linear history per content_id with explicit parent_version pointers. No merge conflicts because edits are serialized through SparkEd Admin UI.
- **Per-tenant pinning:** a tenant's content_pin table maps (content_id) → version. When SparkEd publishes a new global version, tenants do **not** auto-upgrade. Tenant updates happen via explicit "refresh" action with diff preview.
- **Historical scoring integrity:** every session record stores pinned_versions snapshot at session start. Re-scoring six months later uses the version active at the time of the original session, not current.

This is the single most cross-cutting decision in the whole stack — the version model has to be right before frameworks, scenarios, rubrics, or prompts ship, because retrofitting versioning is brutal.

> **Ambiguity flagged here:** PRD §3.2 calls frameworks both "globally templated and instantiated per-client" (your answer 5) and "client-uploaded raw materials." Reconciling: SparkEd authors **framework templates** (the schema/structure of an Education Continuum, an Excellence Model, etc.). The client uploads **source documents**. The Frameworks Engine fills the template using the source documents. The filled framework instance is pinned to the tenant. Global template updates do not propagate without explicit tenant action. Confirm this interpretation in Stage 0.
> 

### 3.3 Authentication: WorkOS

Replaces both the in-house JWT and the direct Okta integration described in the PRD. WorkOS handles SAML, OIDC, magic links, and OTP — all behind one API. Per-tenant SSO config sits in WorkOS.

> **Ambiguity flagged:** PRD §5.1 lists "in-house JWT-based (AuthProvider interface for future enterprise SSO)" while §3.2 and §3.3 treat Okta SSO as a launch feature. WorkOS resolves this — both paths covered, no in-house identity to maintain. Drop the in-house JWT plan from §5.1.
> 

Roles are bundles of permissions (your answer 23). Concrete shape:

Role := named bundle of capabilities

Capability := atomic permission ("read:team_dashboard", "write:scenario", "admin:user_invite", ...)

User := has 1..N roles per tenant

ActiveRole := user-selected role for current session (drives UI, not auth)

Adding the inevitable seventh role ("Coach," "MLR Reviewer," whatever) means defining a new bundle of existing capabilities — no schema migration, no code changes in middleware.

### 3.4 AI Orchestration

**One Ivy, many context bundles** (your answer 6). A single persona/voice prompt with composable context modules:

- IvyContext.UserProfile — assessment scores, learning style, history
- IvyContext.Report — single session report + transcript
- IvyContext.TeamDashboard — manager-scoped team data
- IvyContext.Org — Super Admin / Director scoped org data
- IvyContext.AssessmentReport — narrative generation context

Vellum owns: framework generation pipeline, scenario assembly, scoring, narrative generation, Ivy report Q&A (your answer 7). Vellum does **not** own real-time simulation — that's a direct streaming connection to whichever realtime audio provider we land on.

**RAG layer:** vector store (your answer 8). Pinecone or pgvector. Recommend **pgvector** for v1 — already on Postgres, no new SaaS, embeddings co-located with the data they're describing. Migrate to a dedicated vector DB only if scale or query complexity demands it.

What gets embedded:

- Per-user: every session transcript chunk, every assessment report
- Per-tenant: framework documents, scenario briefs, custom KPI definitions
- Global: tactic rubrics, behavioral library, FDA guidance

Retrieval is tenant-scoped by default. Cross-tenant retrieval is reserved for the global content namespace.

**Multi-provider** (your answer 9): OpenAI, Anthropic, Gemini, plus realtime audio TBD. We need an abstraction layer — recommend Vercel AI SDK as the unifying client, with Vellum as the workflow layer above it. Vellum gives us prompt versioning + eval; AI SDK gives us provider portability inside one Vellum step.

### 3.5 Realtime Simulation Provider

Not Gemini (your answer 10). The viable candidates as of now, ordered by current latency:

| **Provider** | **Time-to-First-Audio (typical)** | **Notes** |
| --- | --- | --- |
| OpenAI Realtime (gpt-4o-realtime) | ~400–800ms | Mature WebRTC + WebSocket, function calling, server-side tool use |
| Cartesia + Anthropic / OpenAI text | ~600ms (TTS only) | Lowest TTS latency but requires us to orchestrate ASR + LLM + TTS ourselves |
| ElevenLabs Conversational AI | ~700–1000ms | Built-in turn-taking, but less control over the LLM step |
| Deepgram Voice Agent | ~600–900ms | New, comparable to OpenAI Realtime, ASR is best-in-class |

**Recommendation for Stage 1:** start with OpenAI Realtime. Single vendor, mature SDK, good enough latency for the 1.5s aspirational target. Re-evaluate at Stage 3 when we have real session volume and can measure perceived quality.

> **Ambiguity flagged:** PRD aspirational target of 1.5s end-of-speech to start-of-HCP-response is achievable on a good network with any of the above. **Hard SLA territory begins around 800ms** — we will not promise that to clients. The 1.5s number stays aspirational, surfaced as a measured metric in observability.
> 

### 3.7 Eval, Observability, Audit

- **Backend evals:** Braintrust (your answer 18).
- **LLM observability:** Braintrust unified for both eval and trace (your answer 28). Single source of truth, simpler than running Langfuse alongside.
- **Application/infra observability:** Datadog (your answer 29). Reasoning: better APM than Honeycomb for our shape (request-response traces dominate; we don't have many high-cardinality distributed traces). Honeycomb is the right call later if we end up debugging realtime simulation distributed issues at scale.
- **Audit logs:** every authentication event, role change, framework approval, content version publish, scoring decision, report generation, cross-tenant access (God Mode) — 90-day retention (your answer 34). Stored in a separate audit schema in Postgres with append-only constraints. Beyond 90 days, archived to S3 Glacier with a 7-year retention if any client contract demands it.

### 3.8 Buy vs. Build Catalog

You said "prefer buy over build" (your answer 39). Concrete buy decisions:

| **Capability** | **Vendor (Recommendation)** | **Stage** |
| --- | --- | --- |
| Auth / SSO | WorkOS | 0 |
| Document ingestion (PDF/DOCX/XLSX/PPT) | Reducto or LlamaParse | 2 |
| Realtime audio | OpenAI Realtime (initial) | 1 |
| Workflow orchestration | Vercel Workflows | 0 |
| LLM eval + observability | Braintrust | 0 |
| Application monitoring | Datadog | 0 |
| Vector DB | pgvector (start) | 0 |
| Feature flags | LaunchDarkly or Statsig | 0 |
| Email / notifications | Resend or Postmark | 1 |
| File storage | AWS S3 + CloudFront | 0 |
| Video streaming (didactic content) | Mux | 1 |
| CRM data sync (Phase 2) | Nango | 5+ |
| Embedded analytics for managers (if we hit limits) | Sigma or Metabase Embedded | 3 |

> **Ambiguity flagged for Stage 2:** PRD doesn't specify document-ingestion fidelity. Charts inside PPT, tables in PDF, embedded images — what's required? Reducto handles tables and structured layouts well; LlamaParse is cheaper but weaker on tables. Recommend Reducto if any framework source documents contain meaningful tables (Excellence Models often do).
> 

## 4. Risks Worth Naming

- **Realtime simulation quality.** OpenAI Realtime is excellent but voice/persona consistency over a 7–10 minute conversation is not guaranteed. Eval rigor in Braintrust matters here — we want session-level eval (does the HCP stay in character?) before claiming the simulation works. Plan for at least 2 weeks of Stage 1 dedicated to simulation tuning, separate from feature build.
- **Scoring determinism.** PRD §3.8 mandates "All rubric scoring via structured LLM output... Scoring prompt is versioned." LLM scoring drift between prompt versions is real. Recommend Braintrust as the gating mechanism: no scoring prompt change ships unless eval against canonical session library shows < 5 point variance vs. previous version (per PRD §7.2 spot-check target).
- **Document ingestion** (Stage 2) — already flagged. Real client documents will be worse than test fixtures.
- **Onboarding scope creep.** Pilot clients will ask for things outside the spec. Frameworks-only deliverable ($10K/framework per PRD) is one well-defined upsell; everything else needs a clear "pilot v0 / Phase 2" line drawn before client conversations.
- **Stage 0 invisibility.** As noted — pressure to skip foundations will be real. Resist.