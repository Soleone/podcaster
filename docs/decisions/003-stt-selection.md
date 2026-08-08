# Decision 003 — Select Nemotron 320 ms for the first STT implementation

**Date:** 2026-08-08  
**Milestone:** 3 / T3.2  
**Outcome:** **select Nemotron 320 ms as the pragmatic first implementation**

This file uses `003` because `002-milestone-2.md` already records the accepted Milestone 2 gate. It does not overwrite that decision.

## Scope and stop

T3.2 implemented and independently reviewed the Parakeet Unified challenger and the comparison infrastructure. No TTS adapter, browser microphone path, production sidecar integration, Whisper baseline, conversation loop, or later milestone work started.

## Candidate contracts

### Nemotron reference

- Model: `nvidia/nemotron-3.5-asr-streaming-0.6b`
- Revision: `1c8deaecc64b91f034d73e08dd8b64625eb3395d`
- Weight SHA-256: `9eebdd6590289cb3030f310858f3df93256600a800a3e8200c5993d5f967e174`
- Runtime: Transformers 5.13.0 / PyTorch 2.12.1+cu130
- Precision: float32
- License: OpenMDW-1.1
- Streaming contract: native cache-aware RNNT, 320 ms non-overlapping capture chunks, no external left/right audio buffer (`320/0/0`)

### Parakeet challenger

- Model: `nvidia/parakeet-unified-en-0.6b`
- Revision: `fe53cd885760c96b6a5f51a0bfd362cb4584a98b`
- `.nemo` SHA-256: `ec23ed9150c8fde49072c3e2d61678ab903dbcef389d658db833420cbc1da35b`
- Exercised runtime: NVIDIA NeMo Git revision `58f3dd9250d4c9e0d3e865b78ccd5ea89dc420ba` (reports `3.1.0+58f3dd9250`) / PyTorch 2.12.1+cu130
- Precision: float32, confirmed from the loaded artifact
- Input: mono 16 kHz PCM16, confirmed from the loaded artifact
- License: NVIDIA Open Model License
- Streaming contract: stateful buffered RNNT; encoder left context is recomputed and RNNT decoder state is retained
- Tracked presets: 240 ms = `80/5600/160`, 320 ms = `80/5600/240`, 560 ms = `160/5600/400` (`chunk/left/right`, milliseconds)

The current NVIDIA model card names NeMo 2.7.3, but the published PyPI 2.7.3 runtime cannot instantiate this artifact because its encoder rejects `att_chunk_context_size`. The pinned official NeMo Git revision above loads the artifact and executes NVIDIA's documented buffered algorithm. This is an explicit runtime deviation, not a claim that PyPI 2.7.3 worked.

## Evidence

### Accepted Nemotron decision reference

Full paced run:

- Run ID: `d3fab140-d983-4eab-a781-65b82d46da2a`
- Config: `nemotron-3.5-transformers-fp32-320ms-paced-v1`
- 55/55 passed
- Corpus WER/CER: 3.54% / 0.82%
- p95 RTF: 0.0745
- p95 speech-start to first partial: 1249.52 ms
- p95 endpoint to final: 536.04 ms
- Peak process VRAM: 2,603,898,368 bytes
- Drops: 0

Accepted 30-minute soak `b65ea6b2-8c86-4707-bee8-94935ea3a37a` passed with 88,736/88,736 frames, 5,546/5,546 chunks, 178 resets, and zero drops, underruns, worker leaks, or severe failures. The soak does not cure the first-partial gate failure; that failure is accepted only by the pragmatic override below.

### T3.2 real probes

The final implementation executed retained, paced, one-item probes against the tracked 55-item manifest:

- Parakeet 320 ms: run `6014923b-8ac3-413c-850a-c8431ec68791`, config `parakeet-unified-nemo-buffered-fp32-320ms-paced-v1`. The measured item passed with WER 0, 795.52 ms first partial, 95.93 ms endpoint-to-final, RTF 0.6443, and 2,564,910,592 peak VRAM bytes. Its deliberately short 10.56-second continuity rotation failed with 523/524 chunks, one drop, and one underrun. The overall run status is therefore failed.
- Nemotron 320 ms: run `cdfbb3e1-ded0-4639-bf8d-3c95a8b5e142`, config `nemotron-3.5-transformers-fp32-320ms-paced-v1`. The measured item and 10.74-second short rotation passed with 528/528 frames, 33/33 chunks, and no drops, underruns, leaks, or failures.

Both artifacts validate. They are implementation and failure evidence only, not 55-item corpus or 30-minute decision evidence. The comparison command correctly rejected them:

```text
unmatched comparison semantics: captureChunkMs=320 vs 20,
chunkMs=320 vs 80, leftContextMs=0 vs 5600,
rightContextMs=0 vs 240
```

Separate direct runtime probes are attested rather than retained as benchmark runs: a Parakeet 560 ms probe installed exact encoder context `[70,2,5]` and completed transcription, and a final-flush probe produced the correct terminal text with no surviving worker. Real cancellation after a Parakeet partial completed in 1.591 seconds; the check named `parakeet-stream` and `paced-audio-capture`, with no survivor.

## Fail-closed comparison result

The authority requires the comparison commitment to include raw chunk, left context, and right context, excluding only candidate identity. Nemotron's native cache-aware `320/0/0` semantics and Parakeet's official buffered `80/5600/240` semantics are therefore not matched. Grouping both as 320 ms algorithmic latency would hide materially different buffering and is not permitted.

The implemented `compare --runs` command preserves this rule and refuses the comparison. Under the original authority, no provisional winner existed, so no new 30-minute winner soak was required. The pragmatic override below makes the selection from the strongest retained evidence rather than pretending the raw semantics match.

## Gate table

| Candidate/config | p95 RTF ≤0.70 | p95 first partial ≤500 ms | p95 endpoint-final ≤800 ms | truthful 30-min soak | peak VRAM | Result |
|---|---:|---:|---:|---:|---:|---|
| Nemotron 320 ms | Pass (0.0745) | **Fail (1249.52 ms)** | Pass (536.04 ms) | Pass | Recorded | Fails ideal gate; selected by pragmatic override |
| Parakeet 240/320/560 ms | Not decision-tested | Not decision-tested | Not decision-tested | Not run | 320 ms probe only | Blocked: no matched comparison; short 320 ms rotation also dropped one chunk |

The Parakeet probe's latency, WER, and VRAM are intentionally excluded from selection arithmetic because one item is not the declared corpus. Its short-rotation failure is retained as raw failure evidence but does not replace the required 30-minute soak.

## Selection rule and Whisper trigger

No reversal arithmetic can be applied truthfully without matched corpus runs. Under the original rule, Nemotron failed selection because it missed the 500 ms first-partial threshold, while Parakeet could not be selected from unmatched one-item evidence. The user-authorized override below supersedes that stop for the first implementation.

Whisper large-v3-turbo was not downloaded or scaffolded. The trigger did not fire: accepted Nemotron WER is far below 20%, scoring is not disputed, and Nemotron sustains real time. Latency failure alone is not a Whisper trigger.

## Pragmatic selection override

The original benchmark authority blocked selection because the two architectures cannot share identical raw buffering. On 2026-08-08, the user explicitly authorized a practical first implementation: candidate-specific buffering is acceptable and the choice does not need to be perfect.

Under that authority, **select Nemotron at the tracked 320 ms configuration**:

- it has the strongest retained evidence: a complete 55-item run and a successful 30-minute soak;
- its corpus WER is 3.54%, p95 RTF is 0.0745, endpoint-to-final is within the target, and it dropped no audio;
- reset, cancellation, and worker cleanup passed independent review;
- Parakeet has no full-corpus result and its current short paced rotation dropped one chunk and recorded one underrun;
- Nemotron is therefore the lowest-risk candidate to integrate first, even though its p95 first partial is slower than the ideal target.

This is an explicit exception to the original 500 ms first-partial gate, not a reinterpretation of the measurement. The first implementation should expose the latency honestly and keep the shared adapter boundary so Parakeet or another model can replace it later.

## Decision

**Select `nemotron-3.5-transformers-fp32-320ms-paced-v1` for the first product implementation.** Candidate-specific buffering is accepted for this pragmatic decision. Do not load Parakeet in the normal product runtime.

The next milestone may proceed to TTS selection. Product integration still waits for the TTS gate and the later conversation-loop milestone.

## Validation and review

Automated validation after the review fixes covered:

- 89 combined STT/harness tests;
- contract, service/security, host, build, typecheck, Ruff, and cleanup checks through `pnpm check`;
- both model manifests and the 55-item dataset checksum;
- accepted T2.1 artifacts;
- accepted Nemotron paced and soak artifacts;
- structured soak recomputation and coordinated-tamper rejection.

Fresh-context independent review approved the final current state with no blocker or high-severity findings. Earlier reviews found and caused fixes for encoder attention-context configuration, exact 560 ms buffering, first-inference prefetch latency, prepare/stream lifecycle races, model-path binding, RTF queue-wait accounting, no-Git source provenance, corpus-metric recomputation, and structured soak evidence.

## Residual risks

- The verified LibriSpeech-derived corpus does not cover spontaneous podcast speech, broad conversational accents, live microphones, room echo, or playback echo.
- NeMo logs a supported-lookahead warning for the official `[70,2,5]` context even though the pinned NVIDIA script performs the same context installation and real inference succeeds.
- The current model card/runtime-version contradiction remains an upstream reproducibility risk.
- Nemotron's approximately 1.25-second p95 first-partial latency may feel sluggish and must be observed in the first integrated prototype.
- Parakeet remains a future challenger once its paced drop is fixed and full-corpus evidence is worthwhile.
