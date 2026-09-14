# Beta (Individual)

#### **Beta goal:** Prove the core product loop with a closed cohort. A user can take a baseline assessment, get a personalized report, practice an AI-simulated HCP interaction, receive a scored feedback report, and follow up with Ivy (the AI coach). SparkEd can monitor the platform via an internal analytics view.

#### **Beta is not a reduced version of the product. It is the product's critical path — end-to-end — scoped to 1 competency.**

### In Scope

| Area | Description |
| --- | --- |
| Baseline Assessment | SJT quiz + learning style inventory + 2 audio exercises |
| Assessment Report | Full scored report with competency radar, narrative, recommended plan |
| Simulation | Live AI HCP conversation (Gemini Native Audio), 1 competency (Situational Awareness), 12 scenarios (4 tactics × 3 variants) |
| Post-Simulation Report | Scored feedback with narrative, transcript callouts, star rating, Ivy-accessible |
| Ivy Sidebar | Per-report AI coaching chat, full conversation persistence |
| User Dashboard | Personal home — quick jump, journey map preview, performance snapshot, recent activity |
| SparkEd God Mode | Internal analytics: usage, health scores, product signals |

### Explicitly Out of Scope for Beta

- Client onboarding self-serve UI (frameworks manually loaded by SparkEd Admin for beta)
- Scenario assembly pipeline UI (scenarios pre-built for beta)
- Education journey map & content library (didactic content not required to unlock scenarios for beta **CONFIRM**)
- Manager/director dashboard
- Co-ride log
- KPI correlation / reporting / Ivy document generation
- Gamification (stars, badges, leaderboard) — infrastructure can be built, UI is deprioritized
- CRM/Veeva/IQVIA integrations
- Video analysis / non-verbal cues scoring
- Multi-language support

**Content scale:** 1 competency (Situational Awareness), 4 tactics, 3 scenario variants per tactic = **12 scenarios total** at beta launch.

---

## 3. Core User Flow (Beta)

```
Registration / SSO
    ↓
First Login → Ivy-led onboarding → Profile completion
    ↓
Baseline Assessment (mandatory for MSL/Rep role)
  - Component 1: SJT + Likert quiz (all 8 competencies)
  - Component 2: Learning style inventory (42 items)
  - Component 3: 2 audio exercises ("Sell me this pen", open story)
    ↓
Assessment Report
  - Competency radar chart + per-competency narrative
  - Learning style profile (7-dimension)
  - Recommended plan of action
  - Ivy available for report Q&A
    ↓
User Dashboard (home base)
    ↓
Select Scenario → Pre-simulation brief (auto-generated, read-only)
    ↓
Simulation (Gemini Native Audio, Situational Awareness tactic)
  - HCP speaks first, VAD turn-taking, no pause
  - Runtime-randomized HCP personality/emotional state
  - End → Analyze / Discard / Resume dialog
    ↓
Post-Simulation Report (< 90s analysis target)
  - Narrative arc → strengths → development areas → score reveal
  - Star rating, performance tier, CTA buttons
  - Transcript with 3–5 moment callouts
  - Ivy sidebar (persistent, conversation saved)
    ↓
User Dashboard (updated with new session data)
```

---

## 4. Key Components

### 4.1 Baseline Assessment

Three independent components, all auto-saved, fully resumable mid-session.

**Component 1 — SJT + Likert Quiz**

- Covers all 8 competencies. Forward-only navigation (no back). Questions randomized within competency blocks; block order randomized.
- SJT: 4-option scenario-based questions, one correct answer
- Likert: 5-point self-perception items
- Approximate item counts per competency: Active Listening (8+8), Rapport (8+8), Objection Handling (10+10), Storytelling (8+8), Presentation (20+20), Effective Questioning (8+8), Influence (9+9). Situational Awareness needed? **CONFIRM**

**Component 2 — Learning Style Inventory**

- 42 items, 5-point Likert
- 7 dimensions: Active/Reflective, Sensing/Intuitive, Visual/Verbal, Sequential/Global, Structured/Improvisational, Emotional/Logical, Social/Independent
- Output: percentage lean per dimension (e.g., Active 70% / Reflective 30%)
- Feeds Ivy coaching style calibration and module sequencing

**Component 3 — Audio Exercises**

- Browser mic required (MediaRecorder API).
- Exercise 1: "Sell me this pen" — 3-min guideline, timer counts up, one re-record option before submit
- Exercise 2: "Tell me a story you're passionate about" — 2-min guideline, same flow
- MVP analysis: speech pattern metrics only (WPM, filler words, pause patterns, talk ratio)
- Video/facial analysis is Phase 2

**Scoring output feeds:** personalized learning path order, Ivy coaching style, manager dashboard baseline (post-beta), data flywheel.

**Retake rules:** unlimited, no waiting period. Best score per competency always wins; all attempts stored.

---

### 4.2 Assessment Report

Delivered immediately after analysis completes. No email, no "check back later."

**Report sections (in order):**

1. Your Communication Profile: narrative paragraph, second person, describes dominant communication style
2. Competency Radar Chart: all 8 competencies, interactive hover, 4-tier color coding (0–59 red / 60–74 amber / 75–89 green / 90–100 teal)
3. Competency Breakdown: 3–5 sentence paragraph per competency, field-context framing
4. Your Learning Style: 7-dimension horizontal bar chart + 2–3 paragraph narrative
5. Recommended Plan of Action: "Start here" + "Why this matters for you" + "What this journey looks like"

**Report generation:** AI-generated narrative (structured prompt with competency scores + learning style + speech metrics as inputs). Radar chart and competency scores.

---

### 4.3 Simulation

**Entry:** User selects a scenario from the Situational Awareness module. Pre-simulation brief auto-generated and displayed (read-only, minimizable reference during sim).

**Pre-simulation brief contains:** scenario objective, HCP background, setting, clinical context, anticipated challenges, key messaging guidance, tactic focus.

**Interface:**

- HCP Orb: center screen, pulses with AI voice
- Scenario Objective: one line, always visible top of screen
- User self-view? **CONFIRM**
- Running timer: elapsed, glanceable, bottom corner
- End button: always visible
- Brief reference: tap-to-reveal overlay, does not pause sim

**Key behaviors:**

- HCP always speaks first
- Voice Activity Detection (VAD) for natural turn-taking (no push-to-talk)
- No pause function; recovery is part of the skill
- HCP response driven dynamically by archetype, MBTI, emotional state, rubric, compliance guardrails
- HCP naturally winds down at 7–10 minutes
- 10s silence: "Still there?" dialog. 30s no response: auto-end

**Session artifact package (on Analyze):** full timestamped transcript, user audio recording, session metadata (scenario ID/version, tactic, competency, MBTI, emotional state, duration, timestamp), rubric version reference, framework versions, compliance flag events.

**Scenario construction (three layers):**

- Layer 1 (fixed at assembly): HCP name/type, therapeutic area, clinical product info, company messaging, compliance guardrails, tactic being practiced, rubric mapping
- Layer 2 (agent-decided at assembly): HCP archetype, education continuum stage, anticipated objection type, setting, conversation challenge type — selected to create a learning arc across the 3 variants (easy → challenging)
- Layer 3 (runtime-randomized every session): full MBTI type, HCP emotional starting state, time pressure, filler words/natural language imperfections, interruption moments, emotional mood progression pattern

---

### 4.4 Post-Simulation Report

**Analysis pipeline target: under 90 seconds.**

Processing steps and time estimates:

- Transcript finalization (~5s)
- Speech metrics: WPM, filler words, pause analysis, talk ratio (~10s)
- Behavioral tagging: empathy markers, persuasion, tailoring, compliance flags (~15s)
- Rubric scoring: structured JSON output against behavioral anchors (~20–30s)
- Top 3–5 moment selection (~10s)
- Narrative generation (~15–20s)
- Report assembly (~5s)

**Report structure (score revealed last):**

| Section | Content |
| --- | --- |
| Header | HCP name, scenario, tactic, date, duration |
| What Happened | 2–3 paragraph interaction arc narrative |
| What You Did Well | 1–2 paragraph summary + 2–3 positive callout cards |
| What to Work On | 1–2 paragraph summary + 2–3 developmental callout cards. Compliance flags in red. |
| Category Breakdown | Visual bar per rubric category — score, max points, one-line coaching note |
| Score Reveal (animated) | Count-up to final score → stars appear sequentially → performance tier label → personal best badge if applicable |
| Your Next Step | Ivy's recommended action + 2–4 CTA buttons (logic varies by score range) |
| Transcript | "View Full Transcript" — opens timestamped modal with called-out moments highlighted |

**Transcript callout format (3–5 per report):** timestamp, what was said (direct quote), how HCP likely received it, coaching judgment, suggested alternative language.

**Star scoring:** 1–9 → 1★, 10–19 → 1.5★, ... 90–100 → 5★ (9 bands total).

**Performance tiers:** Needs Development (0–59) / Developing (60–74) / Proficient (75–89) / Advanced (90–100).

**CTA logic by score:**

- 0–59: Try Again + Back to Lesson
- 60–74: Try Again + Next Scenario
- 75–89: Next Scenario + Next Lesson
- 90–100: Next Lesson + celebratory Ivy message

**Scoring determinism:** all rubric scoring via structured LLM output (JSON, not extracted from free text). Scoring prompt is versioned. Historical sessions always scored against prompt version active at time of session. Non-verbal cues scoring (10pts) is built into the backend but **switched off at beta**.

---

### 4.5 Ivy Sidebar

Persistent on the right side of the post-simulation report. Collapses to a floating button on mobile.

**Context window per report conversation:** full report, full session transcript, user competency profile and assessment history summary, user learning style profile, tactic rubric, pre-simulation brief, prior Ivy conversation thread for this report.

**Persistence:** one conversation thread per report, enforced at data model level. Historical reports retain their Ivy conversation; "Continue this conversation" reopens Ivy with that report as context and appends new messages to the existing thread. All Ivy conversations searchable from a Chats section.

**Tone:** warm, direct, concise (2–4 sentences default). Always grounds responses in the specific report; no generic advice when specific evidence exists. Will not sugarcoat poor performance. Guardrails: only responds to questions about the report, soft skills, and related learning; redirects out-of-scope warmly.

**Escalation:** every out-of-scope question generates a silent auto-ticket (anonymized user ID, exact question, context, timestamp). Aggregated into a weekly SparkEd analytics report. Product gap signals identified when many users ask the same off-scope question.

---

### 4.6 User Dashboard

User's home base after onboarding and after every session.

**Zones:**

**Zone 1: Welcome & Quick Jump:** Personalized greeting (time-aware), one contextual Ivy line, one prominent CTA that reflects last user state (e.g., "Pick up where you left off → [lesson]", "Ready to practice → [scenario]", "Complete your assessment").

**Zone 2: Journey Map Preview:** Condensed current position on the module path — current node, last completed, next recommended. "View Full Map" expands.

**Zone 3: Performance Snapshot:** Competency radar (live, updates after every session), cumulative stars, current badges strip, active streak.

**Zone 4: Recent Activity Feed:** Last 5 activities, chronological. Activity type icon, name, context, date/time, score/stars. "View All Activity" opens full session history.

**Zone 5: Leaderboard Peek:** User's rank, 2 above and below (anonymized by default), star comparison. **Confirm with PM: is leaderboard required for beta or deprioritized?**

**Zone 6: Notifications & Ivy Access:** Notification bell + Ivy access button always visible. Ivy in general context opens with user's full performance profile.

---

### 4.7 SparkEd Internal Analytics

Read-only. Architecturally isolated from all client-facing interfaces. No ability to modify client data.

**Client Health Panel:**

- All active orgs: name, industry, seat count, onboarding status, days since first user session
- Per org: DAU/WAU/MAU, scenario completion rate, avg session score, manager dashboard engagement
- Health score per org: Green (healthy) / Amber (declining) / Red (at-risk churn)
- Configurable alert thresholds — e.g., WAU drops below 30% of seat count for 2 consecutive weeks → alert
- At-risk client list auto-generated from engagement pattern analysis

**Product Analytics Panel:**

- Drop-off points in user journey across all orgs
- Features with lowest engagement
- Avg time from account creation to first simulation
- Analysis pipeline performance — avg latency, error rate, timeout frequency
- Ivy usage patterns — most common questions, most common out-of-scope redirects (product gap signals)

**Data Flywheel Panel:**

- Total behavioral events logged (all time, by month)
- De-identified dataset size by competency, role type, industry vertical
- Coverage gaps

---

## 5. Tech Stack (from PRD)

| Component | Technology |
| --- | --- |
| Cloud | Vercel / CloudFlare |
| Backend | TypeScript / TanStack |
| Database | PostgreSQL |
| Blob storage | TBD |
| Queue | Upstash / Bull |
| Auth | Auth0 |
| Simulation AI | Hume |
| Frontend | Browser-based, mobile-browser optimized. No native app. |

**Key architectural constraints:**

- Monolith-first for MVP; clear internal boundaries for future decomposition
- All content (scenarios, rubrics, prompts) treated as versioned data (not code)
- All content and data contracts defined by versioned, structured schemas
- Historical sessions always scored against the prompt/schema version active at time of session
- Non-verbal cues scoring exists in backend infrastructure but is disabled at beta

---

## 6. Additional Items for Clarification

| Question | Impact |
| --- | --- |
| Situational Awareness SJT + Likert item bank. **These need to exist before assessment can be built.** | Assessment completeness |
| Is the leaderboard required for beta, or can the leaderboard peek zone on the dashboard show a placeholder? | Dashboard scoping |
| Gamification (stars, badges) needed? | Dashboard scoping |