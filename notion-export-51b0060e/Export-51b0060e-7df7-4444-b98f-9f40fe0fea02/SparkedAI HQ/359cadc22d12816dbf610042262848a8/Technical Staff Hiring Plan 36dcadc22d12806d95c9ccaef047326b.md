# Technical Staff Hiring Plan

Principle: Identify key challenges and hire world class engineers to address specific risks or needs.

Rationale: We face difficult technical challenges in key cornerstone features that define our product. The problems that gate key product features must be addressed at a high bar from the foundation, on compressed timelines, and require specialists capable of work that even strong generalists cannot deliver.

Every hire is therefore tied to a specific, high-leverage technical risk or need. The result is a small, deliberately expensive team that is disproportionately capable for its size.

Budget: ~$30k until next raise. All else equal, prefer candidates who will accept equity comp.

Advisory pct: 0.5% - 2%

Note: Currently, the only urgent hire to address roadblocks is audio expertise. Other hires may be somewhat deferred as CTO fractionally undertakes initial implementation of other items.

## Order of Hires

1. Audio expert (text-to-speech, speech-to-text, emotional intelligence)
    1. Trigger: ASAP
    2. Cost: $20k
    3. Engagement: Temporary, one-off (future hire if suitable)
    4. Criteria: Ideally publicly demonstrated expertise (e.g. published arxiv papers, published open source code, conference talks, product in market). LI network augmented search.
    5. Deliverables:
        1. 15 minute situationally aware conversations (e.g. across character types and settings), demonstrated reliability with statistical tests
        2. Reliable conversational audio handling: interruptions, turn taking, vad,noise, etc. demonstrated with statistical tests
        3. Outputs transcript and emotional structured data. Feeds into rubric based AI grader, demonstrated reliability with statistical tests
2. Integrator for CRM platform (“close the loop” data gathering powers ROI dashboard)
    1. Trigger: End of beta
    2. Cost: $10k
    3. Engagement: Temporary
    4. Criteria: Substantial prior experience with pilot partner’s preferred platform
    5. Deliverables:
        1. One-way sync from the sales platform to ours.
        2. Authentication and security: OAuth, SSO, audit trails, and access controls.
        3. Data complexity: field mapping, validation, deduping, and error handling.
        4. Compliance: validation, documentation, and regulated-process support.
3. ML Engineer (ROI intervention, agentic behavior, and audio output => scoring rubric)
    1. Trigger: End of pilot phase
    2. Cost: $150-$250 / hr. Dependent on our confidence on grading, agent, and ROI.
    3. Engagement: Part-time (ramping to full time as needed+fundable)
    4. Criteria: Experience with causal decomposition and intervention analysis, substantial experience with AI evals
    5. Deliverables:
        1. Provable system for intake of audio analysis data to structured rubric
        2. Statistical evaluation framework for agentic behavior (Ivy and characters)
        3. Intervention modelling for ROI dashboard
4. ~~~~~ *Post-launch / post-funding below, lower priority for discussion prior to Q4* ~~~~~
5. Penetration Testing (SOC II / ISO 27001 readiness)
    1. Trigger: around launch
    2. Cost: $15k-$20k
    3. Engagement: Annual
    4. Deliverables: Red team report.
6. Scalability and Security Auditor (growth readiness and SOC II / ISO 27001 readiness)
    1. Trigger: post-launch or > 100 users or sooner if large customer requires
    2. Cost: $20k-$25k
    3. Engagement: Annual
    4. Deliverables:
        1. Report analyzing infrastructure and code with projections for cost and stability in platform growth
        2. Report analyzing infrastructure and code for substantive SOC II / ISO 27001 compliance
7. Multi-tenant deployment systems engineer (aka “DevOps”)
    1. Trigger: >10 customers or large customer with specialized requirements e.g. on-prem
    2. Cost: $100-$150 / hr. 10 simple customers => 10 hrs / wk => $4k / mo
    3. Engagement: Part-time (ramping to full time as needed+fundable)
    4. Deliverables: Automated platform for managing data and auth across heterogeneous environments.
8. UI and Agent "black box" tester and automator
    1. Trigger: available funding
    2. Cost: $2k / mo
    3. Engagement: Part-time (ramping to full time as needed+fundable)

Deliverables: discovery of unknown / unreported issues, manual testing framework, automated testing infrastructure