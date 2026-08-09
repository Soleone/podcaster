# PRD — Near-realtime thinking companion (authoritative)

## Problem
A solo thinker needs a conversational partner while working ideas aloud, but ordinary voice assistants interrupt too readily, cannot be naturally barged into, and create uncertainty about ownership of private thought.

**Promise:** During an explicit web session, help one person develop a thought with a concise riff, useful question, respectful challenge, or deliberate silence—while always yielding immediately when they speak.

## Target users & jobs-to-be-done
**Target user:** A solo reflective knowledge worker or creator thinking aloud at a desk (assumption; validate in prototype).

**JTBD:** When I am working through an idea aloud, help me clarify, extend, and test it without taking over the conversation or making me surrender control of my private history and persona.

## Scope (in)
### MVP
- A single-user web UI with an explicit, user-started and user-stopped listening session.
- Near-realtime two-way voice interaction: hear the user, retain local transcript/history, and produce concise spoken responses.
- Natural barge-in is core: detected user speech stops current/queued assistant audio and returns the floor to the user.
- Per eligible turn, select exactly one observable posture: **riff** (briefly extend/reframe), **question** (one consequential question), **challenge** (specific, respectful pressure-test), or **silence** (no spoken reply). Silence is intentional, not a failure.
- A user-owned, local AGENTS.md-like persona configuration controlling personality, tastes/interests, and posture tendencies. Provide a supported default and validation; conversation does not autonomously rewrite it.
- Local-by-default transcript/history and persona configuration, with user delete and export.

### Product behavior contract
Responses must be concise, grounded in the current thought, and avoid a generic assistant agenda. A challenge identifies a real assumption, trade-off, contradiction, or evidence gap; it is never contrarianism for its own sake. The chosen posture and response eligibility must be inspectable in prototype study records. The companion may remain silent for unfinished, low-value, or invitation-only thought.

### Enabling prototype milestone: local speech evaluation
The MVP is contingent on a bounded local speech feasibility prototype on an **RTX 4090 (24 GB)**. It evaluates streaming English ASR first: Nemotron 3.5 ASR Streaming 0.6B versus Parakeet Unified EN 0.6B; Whisper large-v3-turbo is a mature baseline if useful. Nemotron starts as the integration candidate because its cache-aware streaming controls are a lower-risk path to observable partials; this is not an accuracy claim.

Evaluate TTS in sequence: Kokoro ONNX as fast baseline, then Qwen3-TTS 0.6B CustomVoice as primary quality candidate. Advance Chatterbox Turbo or Orpheus only if those candidates leave a material measured gap. Use blinded human listening ratings plus machine latency/reliability measurements. This milestone ends in a selection or a kill/pivot decision; it is not open-ended model research.

## Non-goals (explicitly out)
- Ambient/background listening, multi-user sessions, accounts, sync, shared memory, or an app-hosted history store.
- Native mobile/desktop apps, autonomous follow-ups, tasks, search, long-term profiling, or productivity-suite features.
- Persona marketplace, custom-voice productization, free-form executable configuration, or autonomous persona editing.
- Claims of fully local inference, production privacy/compliance certification, or provider portability.
- Ordinary OpenAI API-key billing or silent fallback to any metered API.

## Success metrics (primary + guardrail)
**Primary:** In a blinded prototype study, at least 70% of participants judge the calibrated posture policy more helpful to their active thought than an always-respond control, with fewer than 20% of responses rated premature/disruptive.

**Guardrails:** Median barge-in cancel-to-silence is ≤300 ms; no severe unrecoverable audio failure in the defined test set; and selected local ASR/TTS sustains the interactive prototype on the RTX 4090 without dropped audio in a bounded 5-minute continuous run (user override 2026-08-09: the original 30-minute guardrail is excessive; telemetry unchanged: drops, underruns, resets, worker leaks, lateness). Record turn timing, partial/final transcription behavior, audio cancellation, posture, and failures.

**Kill/pivot:** Do not advance if the policy is not preferred, disruptive responses reach 35%, reliable barge-in misses the guardrail, local speech cannot sustain the 4090 prototype, or the privacy/auth disclosure below cannot be truthfully made. Select speech models only when they meet the measurements and blinded listening threshold defined for the milestone; otherwise stop or test the next explicitly named candidate.

## Key risks & assumptions
### Privacy and authentication truth
Text/reasoning is cloud-based initially through **Pi**, using the user’s ChatGPT Plus/Pro Codex subscription where available. The product launches Pi in RPC mode as an authenticated reasoning subprocess. It must not extract, retain, or reuse OAuth tokens. Subscription quotas, terms, access, model availability, and provider data handling remain provider-controlled. No ordinary OpenAI API key is requested or used, and no metered fallback may occur silently.

Transcript/history and persona configuration are local by default; that does not make cloud reasoning local. The live context sent to Pi and the provider’s current retention/data-use terms must be disclosed and verified before privacy claims. Browser-local data may be evicted and is not protection from same-origin compromise.

**Assumptions to validate:** calibrated silence/challenge improves thinking; the persona file is understandable and valuable; and users accept the disclosed subscription/provider boundary.

## Open questions (ranked)
1. **None blocking implementation.** Start with the confirmed defaults and resolve the speech selection through the bounded RTX 4090 milestone.
2. Which contexts and persona tendencies make proactive challenge helpful rather than disruptive? Resolve in the blinded policy study.
3. Do current Pi/Codex subscription availability and provider terms support the exact disclosure at pilot time? Verify before inviting users.
