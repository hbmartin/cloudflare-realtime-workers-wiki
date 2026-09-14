# Insights Agentification

> @daniel@3ssolutionslsc.com to send sample insights doc with fields names and one example each of good and bad insight
> 

## Session #1 Slides

- Concepts
    - Lethal Trifecta
    - Jagged Edge
        - Sometimes human analogies are useful, sometimes they are wildly wrong
    - You have to iterate
    - AI isn’t magic,  it’s a robot intern to instruct
- Are hallucinations still a problem? How do we address?
    - Checks by QA agent …. What’s your secret agenda? Orient AI transformation around the human processes you want to change… Wardley process mapping, find and fix the rate limiting step
- Organazition Change is the Bottleneck
    - Make it multiplayer
    - AI add-ons to bad core produce is the bottleneck
- AI can help you iterate!
    - Repeatable steps for document transform
    - What is unclear about this prompt
    - How can we break down steps for this goal
    - Interview me about what I want (Common problem!)
        - “Working backwards” is actually just working!
        - We often lack clarity about the specifics for end goal
    - Remember this / save as skill
- Specific tactics
    - “Grill Me”: Interview me relentlessly about every aspect of this <goal or plan> until we reach a shared understanding. Consider every branch of the decision tree, resolving dependencies between decisions one-by-one.
        - You don’t have to answer everything!
        - Cut if off, redirect, be explicit
        - Once questions become irrelevant or overly pedantic, cut if off and tell it to finish (either producing a plan or performing the action)
    - Prompt for a prompt:
        - I want a skill / prompt so I can clearly specify what I want done and what my goal is. You role in this session is to interview me so that we can produce a prompt that I can reuse in future sessions in the following format:
        - System role; goal; success criteria; available actions and data sources; good examples (where applicable); plan of steps to take;
        - + grill me
    - Stepping back: only you can do this (AI narrows; biggest limitation)
    - Give as much (specifics!) context as possible
        - Small set of canonical examples or docs beats “laundry list”
        - Don’t dump a whole document when only section is relevant
        - Avoid multiple documents with slight conflicts (unless you are specifically asking about that)
    - Also, list specific steps especially related to tools / connectors / skills / apps
    - Also, also, give the high level goal
    - Always have multiple sessions open, and a notepad
    - Summarize session and copy to new session to control “focus”
        - Esp. when conversation is getting confused or stuck on wrong path
    - Remember this / save as skill
- Avoid / No longer needed
    - “think step by step”, “try hard”, “be thorough”, “make no mistakes!”
    - Hard-coding every step with `ALWAYS` / `NEVER` / `ONLY` (unless absolutely true or safety related)
    - Contradictory instructions in long prompt libraries (avoid hype)
    - Stuffing all documents and all edge cases into context
    - Adding many global tools / connectors / skills / apps
- Experimenting (e.g. iterating with notes) = evolving >> trend chasing, reading news, etc.
- Building Agents Step 1: “Evaluate our session, make a skill”
- Use voice (WisprFlow) with shortcuts!
- Use a workflow tool (n8n, Make, Zapier) that make agents a step instead of relying on them for everything
- Things are still changing fast! (Mindset shift ⇒ constant upskilling). No magic prompts, think of it like working out (can’t go to a gym for a week then quit and stay healthy).

### Gemini summary of Sorcero criticisms

Perhaps this is a springboard for addressing with agentification?

- **The MLR Bottleneck:** The biggest point of skepticism is whether the AI is actually as accurate as the marketing claims. A common sentiment is that if a tool like Sorcero isn't perfectly accurate in its sourcing, any drafted content or insights will hit an absolute brick wall during the Medical, Legal, and Regulatory (MLR) review process.
- **Fear of Fabricated Citations:** MSLs are hyper-aware of how poorly general LLMs handle citations. There is a deeply ingrained fear that relying on an AI to summarize abstracts or generate congress reports might lead them to use fabricated DOIs, authors, or journal titles. An MSL's entire value is their credibility; presenting an AI hallucination during a Key Opinion Leader (KOL) interaction is a career-limiting event.
- **Loss of Nuance in "Scientific Sentiment":** MSLs pride themselves on reading the room. They gather "soft intelligence" — the tone, the hesitation, the unsaid context behind what a KOL is saying. There is active pushback against the idea that an AI dashboard can accurately ingest messy CRM notes and definitively categorize complex, shifting medical sentiment without flattening that human nuance.

<aside>
🚨

I can easily imagine similar things said about us if our products are not well executed. We will ensure that none of them could apply to us.

</aside>