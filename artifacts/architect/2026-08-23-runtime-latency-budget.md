# Runtime latency budget manager — design

Status: design (replaces the static plan in `docs/latency-budget.md` at runtime; that
doc's numbers become cold-start priors). Scope: multi-part turn pipeline only —
STT → stall Pi (part 0) → TTS → research Pi (parts 1–7) → part assembler → TTS
prefetch → playback cursor — treated as one timing system. All timing below is
derivable from events the host already receives; **no new sidecar events**.

## 1. State model

One `RuntimeBudget` instance per session (constructed next to `SessionOrchestrator`
in `BrowserSession`, injected through `MultiPartResponseHost`). Pure state + math,
injectable clock, unit-testable. Estimates are EWMA (α = 0.3), clamped, keyed per
producing model; cold-start priors are the measured/estimated numbers from
`docs/latency-budget.md`.

| Estimate | Cold prior | Updated from (existing code point) |
|---|---|---|
| `stallFirstDeltaMs` | 1500 (worst 6200) | `MultiPartResponse.run` stall loop: request start (existing `stallStartedAt`) → first `delta` event |
| `stallTextMs` | 4000 | same start → stall text validated (`reasoning.final` emit point) |
| `bodyFirstPartMs` | 8000 (static 3–10 s + ≤3 tool calls) | `requestBody` start → first `startBodyPart` call. Absorbs tool-call cost; no tool-event surface change needed |
| `ttsTtfaMs` (per `backendId/modelId`) | 1000 (Kokoro p50 978; Qwen CUDA 299 once `tts.started` payload identifies backend) | per part: first `stream.append` → `started` promise resolve (`attachPartTts`) |
| `ttsRtf` | 0.30 | `onGeneratedSamples` progression vs wall time between frames; final at `tts.ended` (`generatedSamples`) |
| `wordsPerSecond` playback | 2.5 (150 wpm) | ledger `delivered` progression (`SessionOrchestrator.playbackProgress`) vs part word count; part audio seconds = `generatedSamples / sampleRate` (24 kHz sidecar) |

Supporting per-turn record (in `MultiPartResponse`, not EWMA): per part
`beginAt`, `firstAppendAt`, `startedAt`, `releasedAt`, `words`, `sampleRate`,
`audibleStartAt` (first `playbackProgress` with `delivered > 0`), and
`stallRemaining()` = `(generatedSamples − delivered) / sampleRate` of the audible
part. `delivered` lags real playback slightly; margins below absorb that.

## 2. Decision points

All checks call `RuntimeBudget`; no check may block the turn machine (synchronous,
timer-armed via the orchestrator's existing `Scheduler`).

**D1 — Stall sizing at turn start** (in `run()` before the stall `pi.request`).
Budget computes the adaptive target and `MultiPartResponse` builds
`instruction = PI_STALL_INSTRUCTION + "\n" + hint` (the `instruction` field already
exists, ≤4096-byte bound enforced by `promptFor`; the 45-word hard cap and
fail-soft stay untouched):

```
needed_s  = bodyFirstPartMs/1000 + ttsTtfaMs/1000 + 1.5   // safety
target    = clamp(ceil(needed_s * wordsPerSecond), 20, 45)
hint      = `Aim for about ${target} words this time (never more than 45).`
```

Cold start: (8 + 1.0 + 1.5) × 2.5 ≈ 26 words — inside the static plan's
recommended 20–40 band. Prompt-only lever; nothing else about the stall changes.

**D2 — Mid-stall body readiness check** (at stall text complete, when
`requestBody` starts, plus a timer re-check while stall audio plays).

```
stallRemaining = stallAudioSeconds − playedSeconds      // exact once tts.ended
bodyEta        = max(0, bodyFirstPartMs − elapsedSinceBodyStart)
if bodyEta + ttsTtfaMs > stallRemaining − 0.5s:
    arm bridge trigger at stallRemaining ≤ bridgeLeadMs
    bridgeLeadMs = ttsTtfaMs + bridgeSynthMs(≈10 words × rtf) + 300
```

Arming is cancelable: if body part 1 releases and its TTS starts before the
trigger fires, disarm. The 007 handoff order (body starts only after stall
validates) is unchanged — D2 does not start research earlier, it pre-positions
the mitigation.

**D3 — Part-handoff deadline check** (on every `playbackProgress` update and part
release while a part is audible; the no-gap rule from the static plan):

```
currentRemaining = (genSamples_i − delivered_i) / sampleRate
nextEta          = ∞ if not released; ttsTtfaMs − elapsedSinceOpen if open;
                   remaining-synth estimate (words-left × rtf / wps) once started
if nextEta > currentRemaining − 0.3s → trigger mitigation (§3)
```

Measured handoff gap (`audibleStart_i − audibleEnd_{i−1} > 200 ms`) is recorded
and reported even when no mitigation fired — that is the outcome metric.

## 3. Mitigations

**Bridge sentence (in-turn).** Scripted host text — never Pi-generated (zero extra
latency, no untrusted content), ~8–12 words, no facts, no question mark (respects
the question posture's one-`?` budget). It enters as a real part of the same
parent response, preserving decision 007's structure: canonical identity stays
`(responseId, partIndex)`, own TTS stream/ledger/recording item, plays in cursor
order, interruptible with the parent.

- `kind: 'bridge'` (additive enum extension in `response-part-started.json` /
  `response-part-final.json`; oneOf keeps stall=0, body/bridge=1–7).
- Index rule: bridge takes `partIndex = releasedParts + 1`; all later research
  parts remap `+1` in `MultiPartResponse` (the `ResearchPartAssembler` itself is
  untouched). Bridge is allowed at most **once per response**, only while
  `releasedParts ≤ 5` and `researchDone === false`, so remapped parts stay ≤ 7;
  if research later overflows the remapped cap, overflow parts are dropped and
  flagged in telemetry (research content loss preferred over failing the turn).
- Preemption: if the real next part's TTS becomes ready before the bridge is
  released/audible, cancel the bridge (`speech.cancel(responseId, bridgeIndex)`);
  once audible it plays out. Barge-in needs no change — provisional pause,
  takeover, and cancel are already response-scoped.
- Bridge text joins the parent context text on completion (it was spoken; 007's
  ordered-join rule and the full-playback context rule stay intact) and renders
  as a paragraph like any part.

**Next-turn adaptation.** A fired bridge or measured gap >200 ms adds a one-time
+2 s penalty to `bodyFirstPartMs` for the next turn's D1 target; the penalty
halves each bridge-free turn. EWMA updates already raise the estimate after slow
turns; the penalty covers underestimation discovered only at playback time.

## 4. Integration surface

| File | Change | Kind |
|---|---|---|
| `apps/host/src/session/RuntimeBudget.ts` (new) | state model, EWMA, D1/D2/D3 formulas, bridge-lead math | new module |
| `apps/host/src/session/MultiPartResponse.ts` | timestamps at existing points; D1 hint into `instruction`; D2 arm/disarm; D3 checks; bridge injection + index remap | pipeline change |
| `apps/host/src/session/SessionOrchestrator.ts` | pass budget through `multiPartHost()`; call `budget.observePlayback(playbackId, delivered)` inside existing `playbackProgress` | wiring |
| `apps/host/src/server/BrowserSession.ts` | construct `RuntimeBudget`, inject into orchestrator options | wiring |
| `apps/host/src/pi/PiClient.ts` | **none** (`PI_STALL_INSTRUCTION` unchanged; hint appended by caller) | prompt-only lever |
| `apps/host/src/session/ResearchPartAssembler.ts` | none (remap lives in MultiPartResponse) | — |
| `services/audio/*` | **none** — `tts.started` already fires at first nonempty chunk (that is TTFA), binary frames give synth progress, `tts.ended` gives `generatedSamples` | — |
| `packages/contracts/schema/events/` | new `budget-mitigation.json`; additive `kind` enum extension + optional `budget` block on the part events; `core-events.json` addition; `pnpm contracts:generate` + `uv run python scripts/generate_contracts.py` | schema, additive, protocolVersion stays 1 |

Observability (feeds PRD turn-timing telemetry; posture/eligibility remain on
`policy.decision`, untouched):
- `budget.mitigation` host event: `{ turnId, responseId, kind: bridge | gap | stall_target, partIndex?, detail: { estimates, trigger } }` — emitted on D1 target selection, bridge arm/fire/cancel, and any measured gap >200 ms.
- Existing `response.part_started/final`, `tts.started/ended`, `playback.*` already
  carry part text release, first audio, and cursor progress; study records read
  the same events as today, so posture/eligibility inspectability is unchanged.
- No new external API paths: events ride the existing host-event stream; the
  bridge is a normal part over the existing TTS pipeline.

## 5. Non-goals

- No sidecar protocol changes; no new TTS timing events (existing surface suffices).
- No change to the 007 handoff order (body still starts after stall validates),
  the 45-word cap, part limits, fail-soft, or the single-part legacy path.
- No cross-session persistence of estimates; session-scoped only.
- No parsing of planning notes for a "tool-heavy" hint (see open questions);
  `bodyFirstPartMs` absorbs tool cost empirically.
- No browser playback-queue changes; bridges are ordinary parts.

### Task list (5 buildable tasks)

1. **T1 `RuntimeBudget` core** — new module: estimates, EWMA, priors, D1/D2/D3
   pure functions. Done: unit tests cover cold start, convergence, clamp bounds,
   and each formula against the static-plan numbers. Deps: none. Parallel-safe.
2. **T2 Instrumentation + `budget.mitigation` event** — timestamps at the code
   points in §1, `observePlayback` hook, schema + contract generation, per-turn
   estimates snapshot in the event. Done: events validate; a scripted fake
   session produces the expected measurements. Deps: T1.
3. **T3 Adaptive stall sizing (D1)** — instruction hint construction and cap
   invariants. Done: tests assert hint range 20–45, 45-word hard cap and fail-soft
   untouched, prompt byte bound respected. Deps: T1. Parallel with T2/T4/T5.
4. **T4 Handoff deadline checks (D2/D3)** — arm/disarm timers via `Scheduler`,
   gap measurement. Done: fake-clock tests fire/never-fire the trigger around the
   threshold; no gap missed in a scripted slow-body scenario. Deps: T1, T2.
5. **T5 Bridge part pipeline** — `kind: 'bridge'`, index remap + cap rule,
   preempt-cancel, context join, schema enum extension. Done: tests for ordering
   (bridge plays before late research part), preemption, ≤7 remap bound, overflow
   drop, barge-in over a bridge. Deps: T2, T4.

Parallelism: T1 → (T2, T3) → T4 → T5; only T5 touches part lifecycle, T3 touches
only stall request construction, so they do not conflict.

## Risks & assumptions

- `playbackProgress` cadence bounds D3 resolution; the 300 ms margin and bridge
  lead assume progress events at least ~4×/s (existing browser behavior).
- Bridge text is flat/scripted; a repeated bridge in a long session may sound
  canned — capped at 1/response, rate visible in telemetry.
- EWMA on few samples is noisy early; priors dominate turns 1–2 by design.
- Index remap is the only structural risk; the ≤5-released gate and overflow-drop
  rule keep it bounded.

## Open questions

- Should planning runs emit a structured tool-heavy flag to bias D1 before the
  first measured body latency exists? (Currently `planningContext` is an opaque
  string; decision 012 owns that surface.)
- Bridge wording/tone per persona — see escalation.

## Escalation

- **Axis:** product judgment (ux/pm), not effort or tier.
- **Requested:** sign-off on bridge aggressiveness: max 1 bridge per response,
  scripted persona-neutral variants (e.g. "Let me pull the right thread on
  that—"), bridge text spoken, shown, and kept in context.
- **Reason:** bridge wording and frequency shape conversational character, which
  belongs to product; the design is otherwise mechanical.
- **Expected gain:** bridges that sound like the persona instead of a system
  noise; calibrated filler frequency in study ratings.
- **Safe fallback (used if no answer):** the defaults above are what T5 builds;
  wording is isolated in one constant table, cheap to re-skin later.
