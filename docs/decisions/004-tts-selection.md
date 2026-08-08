# Decision 004 — Select Kokoro `af_heart` pragmatically for the first TTS implementation

**Date:** 2026-08-08  
**Milestone:** 4  
**Outcome:** **select Kokoro ONNX with stock voice `af_heart`, with explicit prototype exceptions**

`004` is used because `003` already records the accepted STT decision. No existing decision is overwritten.

## Scope and authority

This decision stops Milestone 4. It does not start browser audio, the conversation loop, production sidecar integration, policy/persona/history work, or any later milestone.

The original bake-off called for two candidates, repeated 30-minute soaks, at least three listeners, and a co-resident benchmark. After the Kokoro baseline proved functional, the user explicitly requested a pragmatic completion rather than more hours of benchmark work. Under that authority, Qwen3-TTS was not downloaded or implemented, no human panel was recruited, and no further 30-minute soak was run. This selects a replaceable first prototype voice; it does not claim the original ideal comparison gate passed.

## Selected contract

- Candidate/model: `hexgrad/Kokoro-82M`
- Canonical revision: `f3ff3571791e39611d31c381e3a41a3af07b4987`
- ONNX release: `thewh1teagle/kokoro-onnx` `model-files-v1.0` at `6843c53fc280ab130b7a8d206ebd3407e094efdc`
- Runtime: `kokoro-onnx==0.5.0` at `98ea02a5692534c2ba496708e2f19de25028412b`; `onnxruntime==1.22.1`
- Provider/precision: `CPUExecutionProvider`, float32
- Voice/language: stock `af_heart`, `en-us`
- Output: signed PCM16LE mono, 24 kHz, 20 ms adapter chunks, fixed gain 0.9, no resampler
- Model SHA-256: `7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5`
- Voices SHA-256: `bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d`
- Canonical model license: Apache-2.0
- Runtime license: MIT

The upstream ONNX release publishes no checksums. The recorded hashes are locally computed acquisition checksums and are verified before prepare. Exact paths, bytes, runtime origin/revision, voice, provider, format, and sample rate fail closed.

## Comparison contract

- Prompt manifest: `tts-prompts-v1`
- Prompt count: 24 English prompts
- Manifest SHA-256: `fdec8cd7e7c73b1bb920bd2faa71844f5a3b82e71284190ccdd2f7f235eb1b5f`
- Timing: harness-owned monotonic request-to-first-nonempty-audio and synthesis-completion boundaries
- RTF: harness processing seconds / generated audio seconds
- Listening package: generated as an unrevealed single-candidate baseline only; rating and paired reveal were deferred

## Evidence

### Final short machine run

- Run directory: `benchmarks/results/2026-08-08T053005817Z-source-44fa4-72d369ad`
- Run ID: `72d369ad-7cff-4ef2-bcfb-3e817fb929da`
- Status: passed, 24/24 prompts, zero failures
- TTFA p50/p95/p99: 848.51 / 1582.17 / 2139.74 ms
- RTF p50/p95/p99: 0.2062 / 0.2499 / 0.2859
- Audio: 2,721,280 samples / 113.3867 seconds
- Synthesis-window whole-process peak RSS: 921,186,304 bytes
- Candidate VRAM: not applicable/unmeasured because Kokoro runs on CPU

### Real cancellation

Durable evidence is retained as `cancellation-probe.json` plus its checksum in the final run directory.

- Outcome: cancelled after the first 480-sample chunk
- Elapsed: 1.824 seconds
- Accepted late chunks: zero
- Checked prefixes: inference, output, runtime executor, playback, and RSS sampler
- Surviving workers before/after close: zero
- Backend poisoned: false

### Long-soak evidence

Earlier run `341f9898-183d-49f0-a255-2f8f5679939c` lasted 1800.399 seconds and consumed all 36,237,312 samples and 75,651 chunks with 320 resets, zero drops, zero worker leaks, and zero severe backend failures. It nevertheless reported 131 polling-derived underruns and a 573.9 ms maximum scheduling stall, so it remains a failed artifact and is not relabeled.

Review subsequently required a more rigorous deadline/arrival-based underrun definition and independent telemetry recomputation. That implementation and focused tests were completed, but the user declined another 30-minute rerun. Therefore the corrected soak gate is **not rerun**, not passed.

## Gate

| Requirement | Evidence | Result |
|---|---|---|
| p95 TTFA ≤750 ms | 1582.17 ms | **Fail — accepted prototype exception** |
| p95 RTF ≤0.70 | 0.2499 | Pass |
| Valid local PCM output | 24/24, checksummed PCM/WAV | Pass |
| Bounded cancellation/cleanup | durable real probe, zero survivors | Pass |
| Truthful 30-minute soak | prior failed run; corrected rerun skipped | **Not passed — accepted prototype exception** |
| Naturalness/intelligibility ≥3.5 | no ratings fabricated | Not measured |
| Qwen paired preference | Qwen intentionally skipped | Not measured |
| Nemotron co-residency | Kokoro is CPU-only; bounded concurrent probe skipped | Not measured; low GPU-memory risk, CPU scheduling remains a risk |

**Gate result: passed with explicit pragmatic exceptions for a first prototype only.**

## Rationale

Kokoro is local, reproducible, intelligible enough for engineering use, CPU-resident, fast relative to generated audio, correctly framed, resettable, cancellable, and protected by fail-closed model/runtime binding. It is sufficient to unblock the first integrated prototype. Continuing the Qwen implementation, listener recruitment, and repeated 30-minute tests would add hours before the product has a basic end-to-end conversation loop.

The selected adapter boundary remains replaceable. Voice quality and latency should be evaluated in actual Milestone 5 interaction before investing in another bake-off.

## Validation

- `uv run pytest services/audio/tests/tts benchmarks/harness/tests/test_tts_runner.py -q` — 42 passed
- `uv run pytest services/audio/tests/stt services/audio/tests/tts benchmarks/harness/tests -q` — 131 passed
- `uv run python scripts/verify-models.py docs/model-manifest.json` — 3 model entries verified
- Accepted Nemotron full and soak artifacts still validate
- Final Kokoro run validates: 24 items, 72 events, zero ratings

## Residual risks

- p95 first audio is about 1.58 seconds and may feel slow.
- No human quality ratings exist; `af_heart` is a stock voice, not a custom or enrolled voice.
- Corrected 30-minute playback telemetry has not been rerun.
- CPU scheduling may interact with Nemotron and host workloads even though Kokoro consumes no candidate GPU memory.
- Qwen may ultimately sound better, but there is no local matched evidence and no preference claim.

## Decision

Use `kokoro-82m-onnx-fp32-af-heart-cpu-v1` as the first TTS implementation. Proceed next to Milestone 5 integration with the accepted Nemotron STT and Kokoro `af_heart`. Treat latency, listening quality, and long-run playback as prototype-observation items, not satisfied production gates.
