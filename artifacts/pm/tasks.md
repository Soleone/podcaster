# Qwen3-TTS task set

## Recommended route decision
Start with the **official Qwen3-TTS Python implementation and the 0.6B CustomVoice checkpoint on CPU**, then compare it with the already-selected Kokoro baseline. This is the shortest dependable route to the requester’s goal: it is license-clean, exercises the PRD’s named quality candidate, and avoids adopting a young Rust runtime with a restrictive rider, unproven x86/WSL performance, a 2-GB artifact, and a sidecar/80-ms-packet integration burden. CPU speed is a feasibility measurement, not a promise; the current WSL environment has no usable CUDA route. Treat franken_tts only as a separately cleared future experiment.

## Task list

### Wave 1 — Decide and prove the CPU route

| ID | Title | Why | Size | Dependencies | Done artifact / verification |
|---|---|---|---|---|---|
| QW-1 | Pin and acquire official Qwen CustomVoice CPU candidate | The PRD requires Qwen3-TTS 0.6B CustomVoice after Kokoro; Decision 004 deliberately did not download or implement it. | S | None | A tracked candidate/config and model-manifest entry recording official source, immutable revision, license URL, exact runtime lock, local paths and SHA-256s; `scripts/verify-models.py` passes before load. |
| QW-2 | Run an official CPU feasibility spike | The requester wants Qwen actually used/tested; this WSL box has no CUDA execution, while local Qwen latency/RSS are unknown. | S | QW-1 | Dated spike record with command/environment, successful CustomVoice PCM output at 24 kHz, prepare/cold time, request-to-first-audio time, total processing/RTF, peak RSS, and failure logs if it cannot complete. No latency target is claimed. |

### Wave 2 — Make Qwen a replaceable first-class candidate

| ID | Title | Why | Size | Dependencies | Done artifact / verification |
|---|---|---|---|---|---|
| QW-3 | Add the official-Qwen streaming adapter and candidate contract | The current protocol requires `prepare / synthesize_stream / reset / close` and 20-ms (480-sample, 24-kHz) chunks; Kokoro already establishes bounded queues, cancellation backpressure, provenance verification, and worker-poisoning behavior. | M | QW-2 succeeds | Adapter tests cover pinned provenance/runtime fail-closed behavior, ordered 20-ms PCM framing, first audio before completion, cancellation after first chunk with no late chunks/workers, reset/close, and poisoned-worker refusal. Reuse the established patterns; do not copy franken_tts code or add a subprocess. |
| QW-4 | Admit Qwen to the existing TTS benchmark harness | The harness currently explicitly accepts only `kokoro`, but already supplies verified manifests, monotonic TTFA/RTF/RSS measurement, cancellation probes, soak evidence, and blinded comparison projection. | S | QW-3 | Harness/config tests accept a pinned Qwen candidate and reject contract/hash/semantic mismatches; a validated single-candidate Qwen run uses the existing `tts-prompts-v1` manifest. |

### Wave 3 — Reach the decision-quality comparison

| ID | Title | Why | Size | Dependencies | Done artifact / verification |
|---|---|---|---|---|---|
| QW-5 | Run matched CPU Qwen-versus-Kokoro machine comparison | Decision 004 has a valid 24-prompt Kokoro reference but no Qwen comparison; franken_tts M4 figures do not answer this x86/WSL question. | S | QW-4 | Two harness-validated, same-prompt/config-semantics run directories plus a concise comparison recording TTFA (request to first accepted 20-ms chunk), RTF, peak RSS, failures, and cold/prepare time separately. CPU-only results are labeled non-4090/non-co-resident. |
| QW-6 | Run bounded Qwen reliability checks | Qwen may only become a candidate if it preserves the barge-in/reliability contract; Kokoro's accepted long soak has a known un-rerun corrected telemetry exception. | M | QW-4 | Validated real cancellation probe and a 5-minute bounded Qwen soak (user override 2026-08-09: replaces the original 30-minute requirement; same telemetry) reporting drops, underruns, reset failures, scheduling lateness, and worker leaks. Do not call an unrun or failed gate passed. |
| QW-7 | Conduct blinded paired listening and record the TTS selection | The PRD makes human listening and measured reliability the selection gate; Decision 004 has no ratings or paired Qwen preference. | M | QW-5, QW-6 | Existing harness’s blinded comparison package, complete ratings from at least three listeners, revealed paired preference/counts, and a decision update: retain Kokoro, select Qwen, or keep Qwen evaluation-only. No superiority claim without this evidence. |

### Wave 4 — Keep franken_tts unblocked but non-critical

| ID | Title | Why | Size | Dependencies | Done artifact / verification |
|---|---|---|---|---|---|
| FT-1 | Obtain a narrow legal disposition on franken_tts’s source rider | Research identifies its MIT-with-rider as a dependency/copying blocker; this should not stall official Qwen testing. | S | None | Written counsel/authorized-owner decision covering invocation, hosting, redistribution, and derivative adapter code: approved scope or prohibited. Until then it remains excluded. |

## Deferred / Non-goals

- **Adopt, vendor, link, or redistribute franken_tts:** deferred pending FT-1; it is not ordinary MIT and is not a product dependency recommendation.
- **Build a franken_tts sidecar or translate its 80-ms packets:** deferred; it adds supervision, framing, cancellation, and restart work before official Qwen is measured.
- **Zero-shot voice cloning/enrollment:** deferred; requires consent and abuse-policy decisions, and is outside the PRD’s custom-voice productization scope.
- **Claim Qwen is faster/better from upstream or M4 numbers:** out; only target-machine matched measurements and blinded listening can support selection.
- **CUDA/RTX-4090 or Nemotron co-residency validation on this WSL box:** deferred to a machine with usable CUDA; do not fabricate a GPU result here.
- **Other TTS candidates (Chatterbox/Orpheus):** out unless Qwen and Kokoro leave a material measured gap, per the PRD.

## Anything needed from the user

None to begin. QW-1 will download roughly 2 GB of ignored model artifacts; stop only if local disk/network policy prohibits that acquisition.

## Escalation

None. The first two S tasks resolve the only material local uncertainty before adapter investment; if QW-2 cannot produce valid CPU audio, retain Kokoro and record Qwen as infeasible on this machine rather than pursuing franken_tts.
