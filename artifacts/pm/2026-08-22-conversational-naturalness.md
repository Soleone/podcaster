# PM note — Conversational naturalness & multipart effectiveness (2026-08-22)

Grounded in code read on 2026-08-22. Scope: the three reported shortcomings only.
PRD contract (artifacts/pm/index.md) and decisions 007/010/011 treated as constraints.

## 1. Diagnosis

### S1 — Feels "AI", not a curious co-host
- **Base prompt is rule-list/assistant-shaped.** `PODCASTER_SYSTEM_PROMPT` (packages/contracts/src/settings/system-prompt.ts:6–21) opens with one identity line then spends 10 lines on output hygiene ("Return only the response text… No labels, headings, markdown…"). The only personality directive is ":12 Be concise, curious, and respectful." Nothing about spoken register, reacting before informing, building on the user's last point, or having a perspective. Both Pi children use it verbatim (`PiClient.ts` ctor, `PiResearchClient.ts` ctor).
- **Posture selection is content-blind.** `packages/policy/src/index.ts:118–119` picks riff/question/challenge by a SHA-derived bucket over persona weights — deterministic random, no signal from what the user actually said. Challenge gating is pure turn-count (`CHALLENGE_COOLDOWN_TURNS`, :14). So the "posture" frame adds mechanical variety, not conversational intent.
- **Assistant amnesia.** Only fully completed responses enter bounded context (`MultiPartResponse.ts:283 finishMultiPart → addAssistantContext`; decision 007 explicitly drops partial/interrupted responses). Barge-ins — the most natural conversational moments — erase the assistant's own spoken stance, so later replies re-introduce instead of continue.

### S2 — Stall (part 0) doesn't hold the floor
- **The stall is never told it's a stall.** `promptFor` (apps/host/src/pi/PiClient.ts:92–98) sends `Posture / Bounded context / Transcript` with the same system prompt used for full answers. The model produces a complete ≤45-word mini-answer that competes with the body.
- **The body prompt makes this collision explicit.** `promptForBody` (PiResearchClient.ts:80–85): "Answer the user's question in full… You said an acknowledgment aloud already; do NOT restate it." But nothing upstream framed part 0 as an acknowledgment, so the two parts frequently cover the same ground — user hears the answer twice, or a thin answer plus a generic deep-dive.
- **Hard client-side cap can kill the turn mid-sentence.** `PiClient.handle` fails the whole request past 45 words (:364 "Pi response exceeded bound"). Mitigated by fail-soft prefix retention in `MultiPartResponse.run` (~:170–178), but any stall-prompt change must keep chunks valid under `ReasoningSpeechAssembler.isValidChunk` (:164–181).

### S3 — Async insight/web data doesn't become interesting bits
- **Body parts are mechanical slices, not authored segments.** One ordered research stream is split by sentence counts into parts 1–7 (`ResearchPartAssembler.ts:31–37` limits; `MultiPartResponse.startBodyPart`). There is no notion of "lead insight", "surprising fact", or "follow-up hook" — parts are where sentences happened to divide.
- **Preparation notes exist but are static and session-scoped.** `requestPlan` output lands in `<session_preparation>` inside `boundedContext` (SessionOrchestrator.ts:1128–1150, wired via BrowserSession.ts:401) only when a planning run was made. No per-turn enrichment feeds later parts of *this* turn, and nothing carries research leftovers into subsequent turns.
- **Body prompt optimizes for completeness, not interest.** "Answer the user's question in full" + posture word caps (`RESEARCH_BODY_MAX_WORDS`:24–29) yields encyclopedic-but-flat continuations rather than a take plus a tease of what's next.

## 2. Prioritized improvement options

| # | Change | Why | Scope | Risk/tradeoff | Type |
|---|--------|-----|-------|---------------|------|
| P1 | **Give the stall its own job (prompt-only).** Extend the stall request so part 0 is instructed as a reaction/hook — react, take a quick position, or say what you'll dig into — not an attempt at a full answer; keep ≤45 words and all validation unchanged. | Directly fixes S2: stall buys attention, body stops duplicating it. | packages/contracts/src/settings/system-prompt.ts (or a stall-specific instruction appended to the message in `promptFor`, PiClient.ts:92); tests pinning prompt text. | Low. Model may still drift long — existing fail-soft path covers it. | Prompt-only |
| P2 | **Rewrite the base prompt toward co-host voice (prompt-only).** Keep every hard rule (no markdown, word caps, untrusted-data block, persona guard) but replace the rule-list framing with spoken-register behavior: react before informing, build on the user's last point, short breath-length sentences, curiosity default, hold one idea per turn. | Root cause of S1; cheapest lever. | packages/contracts/src/settings/system-prompt.ts; UI shows this text read-only; update pinned-text tests. | Low-medium: prompt regression risk — needs a handful of live transcript spot-checks; PRD concision rules must remain literal. | Prompt-only |
| P3 | **Make the body a continuation, not a Q&A (prompt-only).** Rework `promptForBody`: frame the stall as "you just said X"; instruct lead-with-the-most-interesting-point, end with one genuine follow-up thread when it earns it; keep untrusted-content and no-citation rules intact. | Fixes S3's "generic filler" half and S2's redundancy without pipeline work. | apps/host/src/pi/PiResearchClient.ts:80–85. | Low. Word caps stay; challenge's 360-word budget may need rebalancing if hooks add length. | Prompt-only |
| P4 | **Carry spoken partials into context (small pipeline change).** On barge-in/interrupt of a multipart response, add the already-spoken part texts (bounded) to context — optionally tagged — instead of dropping everything; amend decision 007's "partials never enter context" clause to permit spoken-content-only carryover. | Fixes S1 amnesia and sets up S3 across turns: threads opened survive interruption. | MultiPartResponse.finishMultiPart/cancelMultiPart; SessionOrchestrator.addContext; docs/decisions/007 amendment; context-trim budget already handles size. | Medium: changes conversation-memory semantics; must verify InterruptionIntentClassifier and echo/barge-in paths don't double-count context; risk of stale partials polluting next answers — bound to spoken text only, drop unspoken prefetch. | Pipeline change |
| P5 | **Content-aware posture nudge (defer unless cheap).** Bias the policy's weighted pick using lightweight transcript signals (factual/current-events ask → favor riff+research; stated opinion → allow challenge sooner), keeping selection deterministic and inspectable. | Addresses S1's mechanical feel at the decision layer. | packages/policy/src/index.ts decide(); reasonCodes stay inspectable per PRD. | Medium-high: PRD requires posture policy be inspectable and validated in a blinded study; PRD open question #2 says this evidence doesn't exist yet. Ship only behind the existing study plan. | Policy change |

Recommended sequence: P1+P2+P3 together (one prompt-release, all three are text edits with shared test updates), evaluate in real sessions, then P4, then P5 pending study evidence.

## 3. What NOT to do
- **Don't raise the 45-word stall cap or soften client-side bounds** (`PiClient.handle`, assembler validation) — PRD concision contract; removing them reintroduces the class of bug fixed by the 2026-08-10 fail-soft change.
- **Don't let tool/webfetch output be spoken verbatim or URLs cited aloud** — decision 011; keep "untrusted content" framing in every prompt edit.
- **Don't split the stall into a separate pre-response lifecycle** — decision 007 fixes stall as part 0 of one parent response.
- **Don't make silence/challenge LLM-judged or non-inspectable** — PRD requires posture and eligibility observable in study records.
- **Don't auto-edit the persona file from conversation** — PRD non-goal (persona is user-owned).
- **Don't add a search backend or API-key path** to fix S3 — out of scope per decision 011; webfetch + planning notes are the sanctioned surfaces.
- **Don't feed unspoken prefetched body text into context on interruption** — it was never heard; carrying it would produce "as I was saying" ghosts.

## Open questions (for researcher, ranked)
1. Do real-session transcripts show stall/body duplication (S2) at the rate the prompt analysis predicts? A small log sample would confirm P1's wording.
2. Does the blinded-study plan have room to evaluate the P2 voice rewrite, or does it need its own mini-study?
