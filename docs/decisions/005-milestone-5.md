# Decision 005 — Milestone 5 gate: T5.3 approved with bounded-replacement limitation

**Date:** 2026-08-09
**Milestone:** 5
**Outcome:** **Milestone 5 (T5.3 Selected model conversation integration) approved; replacement-TTS race fixed and demonstrated end-to-end**

## Scope and authority

This decision closes the T5.3 checkpoint and the Milestone 5 gate. It records the completion evidence, the independent review verdict, and the accepted residual limitations. The user authorized wrapping up T5.3, including the bounded 5-minute soak (override of the original 30-minute soak, 2026-08-09).

## Selected integration contract (verified)

- Browser transport: authenticated `/ws` (capability in first message, session cookie, stable host origin 127.0.0.1:43127).
- Sidecar: real Nemotron streaming ASR (`nemotron-3.5-transformers-fp32-320ms-paced-v1`) and Kokoro TTS (`kokoro-82m-onnx-fp32-af-heart-cpu-v1`), loopback-only, secret-authenticated.
- Reasoning: real Pi RPC (`pi --mode rpc`, pinned executable/version/model `openai-codex/gpt-5.6-sol`), bounded context, posture-driven.
- Turn lifecycle: stable final → persistence ack → policy decision (riff/question/challenge/silence) → progressive reasoning → streaming TTS (20 ms chunks) → authoritative playback terminal accounting → listening.

## Completion evidence

### Real-stack multi-turn retry (the historical failure)

`scripts/multi-turn-retry.mjs` (with `scripts/fixtures/build-multiturn-audio.py`, LibriSpeech test-clean speech at 16 kHz) drives the built host over the authenticated browser protocol with the real sidecar and real Pi. Evidence: `artifacts/evidence/multi-turn-retry-2026-08-09.json` (status passed, 2026-08-09, ~31 s).

- Turn 0: "Thus idleness is the mother" → question posture → response began.
- Turn 1 (takeover "WHY SHOULD ONE HALT ON THE WAY", fed while turn 0's response was active): epoch advanced 0→1, turn 0's response was replaced cleanly mid-reasoning, capture stayed open.
- Turn 2 (post-replacement sanity): "We have never understood this sort of objections" → challenge posture → response completed.
- Zero `response.failed` / `failure` events; session returned to listening after every turn.

The reviewer verified the evidence JSON is internally consistent (binary frame counts, timeline, epoch 0→1) and the fixtures are genuine, correctly-transcribed LibriSpeech utterances.

### Bounded 5-minute soak

`benchmarks/results/2026-08-09T175017778Z-source-2584e-cd71224a` (run `cd71224a`): 307.7 s, 12,145 chunks consumed, **0 underruns, 0 underrunEpisodes, 0 drops, 0 missedSamples, 0 workerLeaks, 0 deadlineOverruns, deadline lateness p95/max 0 ms, timingConformance true**. Independently validated (`harness validate`/`normalize`); the 5-minute duration is honestly labeled and satisfies the user-override gate. This also closes the M4 "corrected soak not rerun" exception at the bounded duration.

### Test suite (2026-08-09, all green)

- `uv run pytest services/audio/tests benchmarks/harness/tests -q` — 209 passed (re-verified by reviewer)
- `pnpm test` — contracts 1084, policy 10, host 221, web 95
- `pnpm check` — all validations passed (re-verified by reviewer)
- `pnpm exec playwright test` — e2e 4 passed

## Independent review

Reviewer verdict: **PASS** (no findings of severity high or above).

The race fix is structurally correct: the sidecar waits on the prior TTS worker's terminalization fence with `done.set()` in a `finally` (no deadlock, no lock held while waiting), uses identity-guarded stream handoff, establishes the local output cutoff before the remote `tts.cancel`, and single-socket message ordering guarantees cancel-before-replacement. The headline wait-for-terminalization path is covered by unit test `services/audio/tests/test_runtime.py:277` (`test_cancelled_tts_queues_replacement_until_adapter_exits`).

## Findings and follow-up

- **[medium, resolved] Single-replacement bound** — The prior `runtime.py` `open_tts` bound raised "TTS request queue exceeded bound" with `recoverable: false` when a second replacement arrived while the first replacement's worker was terminalizing. `open_tts` now keeps the two-nonterminal-stream bound but waits outside the runtime lock on the oldest terminalization fence for up to 10 seconds before failing closed on an adapter stall. Focused regression coverage is `services/audio/tests/test_runtime_multipart.py:test_rapid_double_replacement_waits_for_oldest_terminalization_fence`.
- **[low] Retry exercised the mid-reasoning replacement path** (`replaced-before-tts`); the post-TTS (worker-live) branch is covered by the unit test above, not the real-stack run. `barge_in.confirmed` provisional path not exercised end-to-end.
- **[low] Evidence untracked** — `artifacts/evidence/`, `scripts/multi-turn-retry.mjs`, `scripts/fixtures/*` should be committed for provenance.
- **[nit] Physical mic/headphone ergonomics** not human-tested; the automated retry exercises the identical real code path (real models, real Pi, real speech, browser protocol).

## Gate

| Requirement | Evidence | Result |
|---|---|---|
| Selected models integrate through sidecar, host session, persistence ack, browser transport | Real-stack retry + suite | Pass |
| Second selected response no longer closes capture | Retry: replacement observed, capture open through turn 2 | Pass |
| Bounded 5-minute soak with corrected telemetry | Run `cd71224a`, 0 underruns/leaks | Pass (user override of 30 min) |
| No regressions | 209 py + 221 host + 1084 contracts + 95 web + 4 e2e + check | Pass |
| Independent review | Reviewer: PASS, no blocker/high | Pass |

**Gate result: passed.** Milestone 5 is closed for the first prototype; residual limitations are documented above and tracked. The double-replacement terminalization race is resolved; an adapter that remains stalled beyond the bounded wait still fails closed by design.

## Decision

Close T5.3. Proceed with the TTS quality track (Qwen3-TTS CUDA evaluation, Kokoro-on-CUDA P0) and the recording-feature integration already in flight. Treat physical-mic ergonomics and long-run playback as observation/follow-up items, not satisfied gates.
