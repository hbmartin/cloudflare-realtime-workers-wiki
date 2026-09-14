# Voice Analysis AI Research

# Overview Comparison

| **Service** | **What it is** | **Public cost** | **Public latency** | **Emotional / behavioral detail** | **Practical read** |
| --- | --- | --- | --- | --- | --- |
| **Mappa** | Behavioral-reporting and matching engine for hiring / sales / compatibility. | Conduit is $0.79/report; Starter is $9/month for 20 reports, Growth is $49/month for 100 reports; hiring services are custom or quote-driven. | Docs describe an async pipeline with typical duration around 150 seconds; hiring shortlist promises 48 hours; marketing also says “in a matter of seconds,” so public messaging is mixed. | Strong psychometric-style outputs: personality traits, communication style, conflict handling, synergy mapping, decision-making, and sales playbooks. Public docs do **not** expose a low-level emotion ontology or benchmark. | Rich applied outputs, but unusually opaque science for a high-stakes hiring use case. |
| **Nemesysco LVA / LVA-i** | Voice analysis for recruitment, integrity, fraud, and investigations | No public list price for LVA-i or LVA 6.50; InTone uses quote-based monthly/annual/custom pricing. | Publicly framed as real-time in online mode, with every sentence analyzed in real time. | Official pages currently say LVA 6.50 uses **more than 120** uncontrolled vocal parameters, plus an “Emotional Diamond” with 8 main indicators and 14 detectable emotional states; LVA-i adds integrity-risk and personality-style reporting. | More explicit than Mappa about its emotion/stress scheme, but scientifically and legally the riskiest category in this set. |
| **Hume AI EVI / Expression Measurement** | Emotion-aware speech-language model and expression-measurement platform. | Current public EVI 3 pricing runs roughly $0.07/min at lower tiers down to $0.04/min at Business; Expression Measurement audio-only is $0.0639/min. Older Hume materials priced EVI 2 at $0.072/min. | EVI 3 is published as capable of sub-300 ms model response; practical web-app latency was published at 0.9–1.4 s, while case studies reported 140 ms–1.3 s and some infrastructure pairings at 100–300 ms. | Strongest public ontology here: 48+ emotions, 600+ voice descriptors, and “hundreds of dimensions” of expression; public evaluations also describe emotion understanding and emotion/style modulation. | Best public documentation if you want emotionally intelligent real-time speech, not just tagging after the fact. |
| **audEERING devAIce / openSMILE** | Acoustic-first SDK/Web API and on-device analysis stack. | Public prepaid Web API starts at €35/600 min and €250/6,000 min; SDK/on-device licensing is quote-based. | Real-time with minimal latency; many models can run on embedded devices; recent SDK updates reduced result latency and improved concurrent performance. | Public materials show very broad analysis: vocal expression, “Expression Large,” prosody, age, perceived gender, audio quality, acoustic scene, and feature extraction lineage from openSMILE. A 2025 update improved Expression (Large) UAR from 0.65 to 0.70 and reduced resource use from 900 MB to 550 MB. | Best choice if you care about acoustic detail, offline/on-device deployment, or biomarker-style research rather than a speech-to-speech agent. |
| **Affectiva via Smart Eye** | Primarily facial-coding and multimodal human-insight platform, not a standalone voice-native agent. | Affectiva commercial licenses start at $25,000; broader multimodal deployments are quote-based. | Real-time facial analysis is supported; multimodal workflows depend on the iMotions / Smart Eye stack. | Affectiva’s facial SDK documents 7 basic emotions plus confusion and sentimentality, 20+ facial action units, and later additions such as conversational engagement and conversational valence. Voice analysis in the public Smart Eye/iMotions stack is powered by audEERING. | Excellent if you want multimodal research. Weak fit if you want a voice-native emotional conversation model. |
| **Modulate Velma / ToxMod** | Voice-native conversation understanding for moderation, fraud, CX, and safety. | Public API pricing: $0.025/hour English batch STT, $0.03/hour multilingual batch STT, $0.06/hour streaming STT, $0.25/hour deepfake detection; ToxMod enterprise tiers start at $0 with free hours, then $5k/$10k/$20k tiers. | Sub-second streaming transcription; deepfake streaming gives first prediction after 500 ms; broader enterprise voice intelligence is sold as real-time. | Public docs mention 20+ emotions and 20+ accents as enrichments in Transcribe, plus sentiment, intent, fraud signals, compliance risk, policy violations, and conversation understanding; full API voice-intelligence product is still marked “coming soon.” | One of the most compelling operational stacks if you need real-time alerts, safety, fraud, or moderation rather than a “therapeutic” emotional chatbot. |
| **Vapi** | Developer orchestration layer for voice agents. | Public fee is $0.05/min for calls, but Vapi says provider costs for STT/LLM/TTS are separate pass-through charges. | Docs say typical end-to-end latency is around 800 ms. | Public docs confirm an internal emotion-detection module in the orchestration layer that passes emotional tone to the LLM, but Vapi does not publicly document a rich emotion ontology, score schema, or benchmark. | Useful if you want to compose a stack, but it is not the best choice if what you really want is exposed, high-detail emotional analysis. |
| **Talkscriber** | STT / analysis provider; can also be used inside Vapi. | Pre-recorded STT-L3 is $0.0048/min pay-per-use or $0.0044/min at Scale Up; streaming STT-L3 is $0.0060/min or $0.0055/min. Omnix workflow pricing is custom. | Public materials describe real-time transcription and low-latency API access. | Publicly documented emotion set is much narrower than Hume’s or audEERING’s: anger, joy, sadness, surprise, plus utterance-level emotion detection and purchase-intent detection. Public materials also claim WER under 4%. | Great value if you want cheap transcription plus lightweight emotion and intent tags. |
| **AnveVoice** | Subscription website voice agent with sentiment/emotion adaptation. | Free $0/50k tokens, Growth $39/500k, Scale $129/2M, enterprise custom. | Public claim is <700 ms latency. | Public pages emphasize sentiment analysis and emotion-aware adaptation, but they do not publish a detailed emotion taxonomy, confidence schema, or independent benchmark. The docs focus more on website actions, memory, and deployment simplicity. | Attractive for website conversion and support use cases, not for research-grade emotional inference. |

# 

# Detailed Comparisons

## Streaming latency comparison (published or vendor-claimed)

| **Vendor/product** | **Latency** | **Measurement** |
| --- | --- | --- |
| **Cartesia Sonic Turbo TTS** | ~40ms model, ~199ms P90 TTFA US | Cartesia benchmarks |
| **ElevenLabs Flash v2.5 TTS** | ~75ms model, ~135ms TTFB US | ElevenLabs docs |
| **Hume EVI 4-mini** | ~200ms voice-to-voice | Hume blog |
| **AssemblyAI Universal-Streaming** | ~300ms immutable transcript; 307ms word emission | AssemblyAI vs Deepgram benchmark |
| **Hume EVI 3** | ~300ms voice-to-voice | Hume blog |
| **Deepgram Nova-3** | <300ms P50; ~516ms word emission | Deepgram + AssemblyAI data |
| **Vapi voice-to-voice** | ~500ms all-in | Vapi marketing |
| **OpenAI gpt-realtime** | ~500–800ms end-to-end (WebRTC) | Third-party testing |
| **Modulate Velma / ToxMod** | "sub-second" flagging | Modulate |
| **Cogito behavioral signals** | "milliseconds" qualitative | Cogito/Verint |

### N.b. None of the specialist emotion APIs (Behavioral Signals, Empath, Nemesysco, audEERING devAIce cloud) publishes a numeric latency SLA.

## Pricing comparison

| **Vendor/product** | **Streaming price** | **Batch price** | **Notes** |
| --- | --- | --- | --- |
| **Deepgram Nova-3** | $0.462/hr ($0.0077/min) | $0.258/hr | Cheapest streaming at scale |
| **AssemblyAI Universal-Streaming** | $0.15/hr (session-billed) | $0.15/hr | Add-ons stack quickly |
| **Google Chirp 2** | $0.96/hr | $0.24/hr (batch 75% off) | Free sentiment in DFCX |
| **Azure Speech** | $1.00/hr realtime | $0.36/hr batch | $0.50/hr with 50K-hr commit |
| **OpenAI gpt-realtime** | ~$0.06/min in + $0.24/min out ≈ $18/hr combined | n/a | Most expensive realtime |
| **Hume EVI 3 (Pro)** | $0.06/min overage ($3.60/hr) | — | Claimed <$0.02/min at enterprise scale |
| **Hume Expression Measurement** | — | Audio $0.0639/min ($3.83/hr) | Dimensional emotion batch |
| **Symbl.ai** | $0.027/min (then $0.017/min >30k) | Same | Sentiment, not emotion |
| **Vapi all-in** | $0.13–$0.33/min | n/a | Orchestration + components |
| **ElevenLabs Agents** | from $0.10/min | n/a | Emotional TTS output focus |
| **Modulate Velma Deepfake** | $0.25/hr audio | Same | Deepfake scoring only |
| **Cartesia Ink-Whisper** | $0.13/hr on Scale | Same | STT only |
| **Empath Web API** | Free <300 calls/mo | Gated above | Japanese vendor |
| **Behavioral Signals Oliver** | Gated; est. $0.02–$0.08/min | Same | White-label; triangulated estimate |
| **audEERING devAIce** | Gated; est. €15K–€60K/yr SDK | Same | On-device capable |
| **Cogito (Verint)** | Gated; est. $75–$200/agent/mo | — | Enterprise only |
| **Uniphore** | Gated; est. $250K–$5M+/yr | — | Enterprise only |
| **NICE Enlighten** | Gated; est. $30–$100/agent/mo on top of CXone | — | CXone bundled |
| **Verint** | Gated; est. $100K–$2M+/yr | — | 24-month minimum |

### N.b. Estimates flagged as such are triangulated from comparable vendors and industry norms; confirm with sales.

## Emotion taxonomy comparison

| **Vendor** | **Output type** | **Count** | **Taxonomy** |
| --- | --- | --- | --- |
| **Hume EVI 3 / Expression Measurement** | Dimensional + categorical | 48+ dimensions | Semantic-space theory; richest in market |
| **audEERING devAIce** | Categorical + dimensional + biomarkers | ~10 emotions, arousal/valence/dominance, 7,000 acoustic features | Academic SER gold standard |
| **Nemesysco LVA-i** | 8 key states | 8 | Stress, cognitive activity, anticipation, hesitation, etc. (validity contested) |
| **Modulate Velma** | Emotion + intent + behavior | Dozens across 5 layers | Includes deception, social engineering, grooming |
| **Behavioral Signals Oliver** | Categorical + arousal/valence + KPIs | 4 emotions + 8+ KPIs | Contact-center focused |
| **Affectiva (facial)** | Categorical + AUs + valence | 9 emotions + 20+ AUs | Facial-first; voice deprecated |
| **Empath** | Categorical | 5 | Calm, anger, joy, sorrow, energy |
| **Vapi Talkscriber** | Categorical + intent | 4 emotions + purchase intent | Basic |
| **Symbl.ai** | Sentiment polarity | 3 | Positive/negative/neutral only |
| **AssemblyAI/Deepgram/Google/Azure** | Sentiment polarity | 3 | Text-based, not prosodic |
| **OpenAI Realtime** | Implicit | — | No structured labels |
| **ElevenLabs/Cartesia** | Output tags | — | Generation-side only |
| **Receptiviti** | Text-psych | 200+ measures across 12 frameworks | LIWC + proprietary; batch text |

## Deployment mode matrix

| **Vendor** | **Streaming** | **Batch** | **On-prem / self-host** | **Cloud** |
| --- | --- | --- | --- | --- |
| **Hume AI** | ✓ (EVI 3/4-mini) | ✓ (Expression Measurement) | ✗ (HIPAA BAA only) | ✓ |
| **audEERING** | ✓ | ✓ | ✓ (on-device devAIce) | ✓ (Web API) |
| **Nemesysco LVA** | ✓ (SDK) | ✓ | ✓ | Limited |
| **Modulate** | ✓ | ✓ | ✗ (cloud) | ✓ |
| **Behavioral Signals** | ✓ | ✓ | ✗ | ✓ |
| **Symbl.ai (Invoca)** | ✓ | ✓ | ✓ (Enterprise) | ✓ |
| **Cogito (Verint)** | ✓ | ✓ | ✓ (hybrid) | ✓ |
| **Uniphore** | ✓ | ✓ | ✓ (private cloud via Rackspace) | ✓ |
| **NICE Enlighten** | ✓ | ✓ | ✗ (CXone cloud) | ✓ |
| **Verint** | ✓ | ✓ | ✓ | ✓ |
| **Empath** | Windowed-batch | ✓ | ✓ (SDK + Beluga Box) | ✓ |
| **Affectiva/Smart Eye** | ✓ (facial SDK) | ✓ | ✓ | ✓ |
| **AssemblyAI** | ✓ | ✓ | ✗ | ✓ |
| **Deepgram** | ✓ | ✓ | ✓ (self-hosted Enterprise) | ✓ |
| **OpenAI Realtime** | ✓ | ✓ (Whisper) | ✗ | ✓ |
| **Vapi** | ✓ | Limited | ✗ | ✓ |
| **ElevenLabs/Cartesia** | ✓ (TTS) | — | ✗ | ✓ |
| **Mappa** | ✗ | ✓ | ✗ | Limited |
| **AnveVoice** | ✓ (no emotion) | ✗ | Enterprise only | ✓ |

## Analysis

### Preliminary Recommendations

Start a startup voice product on Hume EVI 3. It is the fastest path to a working streaming+batch emotion loop with a credible scientific backbone, and the under-$0.02/min enterprise pricing makes it defensible at scale. Layer in a specialist (audEERING or Behavioral Signals) when we need on-device inference or contact-center KPIs like propensity-to-pay.

In practical terms, use EVI 3 or EVI 4-mini for the live conversation (it handles STT, LLM reasoning, TTS, turn-taking, and streaming emotion natively) and the Expression Measurement API for batch post-conversation analytics. This is the only path where one vendor gives a rich 48-dimension taxonomy consistently across both modes, with first-class TypeScript SDKs.

Expected all-in cost at scale: roughly $0.02–$0.06/min streaming plus $0.064/min for audio Expression Measurement on stored calls.

Risk: vendor lock-in, no on-prem option, EU workplace restrictions.

De-prioritize AnveVoice, Krisp, and ElevenLabs/Cartesia from the emotion shortlist. They serve other layers of the stack (website widget, audio hygiene, TTS output) but do not analyze emotion.

Flag acquisition fluidity. Four of the closest fits changed hands in the last 18 months (Cogito→Verint Oct 2024; Symbl.ai→Invoca May 2025; audEERING→Agile Robots 2025; Smart Eye continuing to absorb Affectiva). Contract terms, roadmap continuity, and direct-sale availability should be re-validated with each vendor before signing.

### Alternative: Best-of-breed layered.

Use Vapi (or LiveKit + Pipecat) for orchestration, Deepgram Nova-3 or AssemblyAI Universal-Streaming for low-cost streaming ASR with text sentiment ($0.15–$0.46/hr), Hume Expression Measurement or audEERING devAIce for prosodic emotion scoring on the same audio stream (both streaming via windowed batch and true batch), Cartesia Sonic-3 or ElevenLabs Flash v2.5 for emotional TTS output, and optionally Krisp SDK for input audio cleanup. More complex but gives per-layer flexibility and lets you swap components as the market changes.

### Per Use-case Considerations

Sophisticated emotional speech understanding and generation: Hume. Hume seems to be a leader on richness of emotional ontology, speech-to-speech integration, and real-time empathic interaction.

Research-grade acoustic depth, biomarker-style signals, or on-device processing: audEERING. If we want that wrapped into a broader multimodal lab stack, use iMotions and, where needed, Affectiva/Smart Eye for the facial side.

Real-time operational voice intelligence: Modulate. It is the most compelling specialized alternative in the current public market. Its strength is not emotional empathy for the sake of empathy; it is identifying conversational states quickly and cheaply.

## EU Concerns

Plan for the EU bifurcation. If this product will touch EU workplace or education users, treat emotion inference as a compliance-gated feature: flip it off, gate it behind explicit medical/safety justification, or rely on consent flows.

The European Commission’s public AI Act materials say prohibited biometric AI practices include emotion-recognition uses in the workplace and education, with narrow medical or safety exceptions. That does not ban every form of voice analytics everywhere, but it means some usage patterns implied by vendor marketing are legally much more constrained in the EU than many buyers assume.

## Leading Platforms and Tools

- **Mappa,** “With proprietary voice AI tech, we decode human behavior and turn compatibility into a predictable science, so each hire you make just fits.”
- **Nemesysco Layered Voice Analysis**. LVA technology analyzes more than 150 vocal parameters and biomarkers, such as changes in pitch, tone, and energy.
    - LVA-i maps eight key emotional parameters
- **Hume AI (EVI series)** is the most frequently discussed foundational speech-language model built for emotional intelligence. EVI (Empathic Voice Interface) integrates transcription, language modeling, TTS, expression understanding/generation, interruptibility, and end-of-turn detection. It links language and speech to respond to tone of voice in real time.
    - EVI 2 (and mentions of EVI 3) is a voice-to-voice model trained specifically for emotional intelligence. Demos show a chat interface that detect and display emotions live, such as interest/confusion/anger, amusement/excitement, or pride/excitement/satisfaction.
    - Integrations appear in projects like Cerebras' speech-to-speech voice interfaces. Try it at app.hume.ai (mentioned repeatedly as a demo/building platform).
- **audEERING (The Signal Processing Powerhouse)** While Hume is "AI-first," audEERING is "Acoustic-first." They are the creators of openSMILE, the most widely used feature extractor in academic SER research.
    - Flagship Product: devAIce® SDK & Web API.
    - Capabilities: Analyzes over 7,000 acoustic parameters. It is highly effective at detecting "vocal biomarkers"—subtle changes in voice that can indicate stress, fatigue, or even early signs of neurological conditions.
- **Affectiva (via Smart Eye)** Since their acquisition by Smart Eye, Affectiva has shifted toward Human Insight AI.
    - **Focus:** Multimodal analysis. They combine voice analysis with facial expression tracking.
- **Modulate**, “Give human or AI agents a set of digital ears that catch hidden meanings, cultural context, and emotional state.”
- **Vapi Talkscriber**
- **AnveVoice**

### Rejected

- Retell - CS focus, minimal sentiment analysis
- [https://anam.ai](https://anam.ai/) - interesting avatars, maybe circle back to this

## Open-Source & Research-Grade Tools

If you are looking to build a proprietary model or avoid high API costs, these are the 2026 benchmarks:

- **SpeechBrain**: A PyTorch-based all-in-one toolkit. It remains the most flexible open-source library for training custom SER models.
- Hugging Face (**Wav2Vec 2.0** / **Hubert**): Most modern SER pipelines now use Self-Supervised Learning (SSL) models. You can find pre-trained "Emotion-Wav2Vec2" models on Hugging Face that outperform traditional feature extraction for general classification tasks.

## Recent Research and Papers Shared on X

X users (including @AudioAndSpeech) frequently post new arXiv papers on SER:

- **Prompt Amplification and Zero-Shot Late Fusion in Audio-Language Models for Speech Emotion Recognition** (Saurabh Kataria, Xiao Hu, Apr 2026) – Explores enhancing audio-language models for better SER.
- **Dual-branch Graph Domain Adaptation for Cross-scenario Multi-modal Emotion Recognition** (Mar 2026).
- **EmotionThinker** (Chinese University of Hong Kong + Microsoft) – Uses prosody-aware reinforcement learning and a specialized dataset for *explainable* SER. Instead of simple labels (e.g., "frustrated"), it reasons step-by-step about pitch/rhythm patterns for transparent, higher-accuracy results.