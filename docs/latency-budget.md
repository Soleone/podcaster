# Agent latency budget — multi-part turn timing plan

Status: planning estimate (task `mtq`). Numbers below are either measured
(repo benchmarks/evidence), read from code bounds, or marked ESTIMATE. Goal:
short time-to-first-audio, smarter stalling, zero audible gaps between parts.

## 1. Stage latency estimates

### Input: end of user speech → orchestrator acts

| Stage | Estimate | Source |
|---|---|---|
| STT streaming chunk period | 320 ms | Nemotron streaming default (README) |
| Turn-end detection + final transcript | ~0.3–0.6 s | ESTIMATE (VAD + final flush) |

### Text generation (Pi)

| Stage | Estimate | Source |
|---|---|---|
| Stall first delta (hook) | ≤1.5 s target | ESTIMATE; worst case 6.2 s observed in 2026-08-10 evidence |
| Stall full text (≤45 words) | 2–6 s | ESTIMATE (observed ~6.2 s worst case) |
| Body first sentence chunk (no tool calls) | 3–10 s | ESTIMATE; bound: request deadline 180 s |
| Tool call round trip (`web_search`/`webfetch`) | 2–10 s each | ESTIMATE; prompt caps at 3 calls, snippets preferred |
| Planning run (`requestPlan`) | ≤120 s bound | `PLANNING_DEADLINE_MS`, runs out-of-band |

### Playback duration (≈150 wpm ≈ 2.5 words/s, ESTIMATE)

| Content | Words cap | Audio length | Source for caps |
|---|---|---|---|
| Stall (part 0) | ≤45 | up to ~18 s | `PiRequestInput.maxWords` |
| Body part, riff/question | ≤90 words / ≤3 sentences | up to ~36 s | `RESEARCH_PART_LIMITS` |
| Body part, challenge | ≤120 words / ≤3 sentences | up to ~48 s | `RESEARCH_PART_LIMITS` |

### TTS synthesis (warm, measured)

| Model | TTFA p50 / p95 | RTF p50 / p95 | Synthesis time for a 90-word part (~36 s audio) |
|---|---|---|---|
| Kokoro CPU | 978 / 1751 ms | 0.243 / 0.282 | ~9–10 s |
| Qwen CUDA | 299 / 331 ms | 0.309 / 0.345 | ~11–12 s |

RTF = processing seconds / audio seconds (project convention); <1 = faster
than realtime. Source: `artifacts/evidence/2026-08-16-qw5-matched-qwen-kokoro-comparison.md`.

## 2. The no-gap rule

Parts play in cursor order, but TTS for each part starts at text release
(prefetch). A gap-free handoff part i−1 → part i requires:

```
release(text_i) + TTFA(part_i) ≤ playback_end(part i−1)
```

i.e. the headroom available to text generation + synthesis of the next part is
the full playback duration of the current part minus TTFA.

## 3. Deadline budget per transition

| Transition | Deadline | Why it holds (or doesn't) |
|---|---|---|
| Speech end → first stall audio | ≤ ~2.5 s | STT final (~0.5 s) + stall first delta (~1.5 s) + Kokoro TTFA (~0.5 s). Feasible; the 978 ms Kokoro warm TTFA is the risk term — Qwen CUDA's 299 ms gives ample margin. |
| Stall text complete → body part 1 release | ≤ stall_audio − TTFA ≈ **10–16 s** typical | Body request starts when the stall text finishes, while stall audio still plays (~15–18 s typical). Tool calls (≤3 × 2–10 s) consume most of this; tight but workable when calls are short. |
| Stall audio ends → part 1 audio starts | 0 s (by construction, if rule above holds) | Cursor advances as soon as next part's audio is ready. |
| Body part i → part i+1 | 0 s if text streams continuously | With RTF ≈ 0.25–0.35, synthesis of part i+1 (~10 s) finishes long before part i (~30+ s) plays out. Gaps only if Pi's text stream stalls (tool call AFTER sentences were already emitted, or a model pause > part duration). |

### Failure case found: short stalls buy no headroom

The stall prompt caps at 45 words but has no floor. A 5–10 word hook is ~2–4 s
of audio — less than body-part-1 TTFA alone, let alone tool-call time.
Whatever the model generates next arrives to silence. This is the main
"smarter stalling" lever.

## 4. Recommendations (ordered by leverage)

1. **Stall length floor.** Bias `PI_STALL_INSTRUCTION` toward a target range
   (e.g. 20–40 words) so part 0 buys ≥8 s of audio and ~10 s of research
   headroom. Prompt-only; keep the 45-word hard cap and fail-soft untouched.
2. **Tools before sentences.** The body prompt already says keep research
   shallow (≤3 calls, prefer snippets). Strengthen ordering: do all research
   calls before emitting the first sentence, so tool latency never lands
   mid-playback where no prefetch can hide it. Prompt-only.
3. **Adaptive stall when research is planned.** When the planning run flagged
   this turn as tool-heavy, steer the stall longer (closer to 40 words); for
   pure-riff turns a shorter hook is fine. Small pipeline change: pass a
   planning hint into the stall instruction.
4. **Bridge on stall.** If body part 1 has not released within
   `stall_audio_end − 2 s`, emit a short scripted bridge sentence (synthesis
   ~0.5–1 s) instead of silence. Pipeline change; guard against barge-in races.
5. **Watch Kokoro TTFA.** Warm TTFA p50 ≈ 1 s dominates the first-audio
   budget. If first-audio latency regresses, the measured Qwen CUDA path
   (299 ms TTFA) is the documented alternative; keep both numbers fresh in
   benchmark runs.

## 5. Telemetry needed to convert estimates to measurements

Add host-side events (or extend existing ones) recording, per turn:
stall-first-delta, stall-text-complete, each part text release, each part TTS
first-audio, each playback cursor advance, and any gap >200 ms between
consecutive parts. This turns sections 1–3 from estimates into the project's
measured convention and directly feeds the PRD's turn-timing telemetry
requirement.
