# QW-6 Qwen reliability gate

**Date:** 2026-08-16  
**Gate result:** **failed**  
**Candidate:** `qwen3-0.6b` using Qwen3-TTS 0.6B CustomVoice and the pinned faster-Qwen Torch CUDA-graph adapter

This is a real hardware result on the WSL RTX 4090. The cancellation probe passed. The required five-minute playback-paced soak completed, but recorded one underrun and 2,391 missed samples, so the reliability gate did not pass. The failed run remains failed and is not relabeled.

## Provenance

| Field | Value |
|---|---|
| Model | `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` |
| Model revision | `85e237c12c027371202489a0ec509ded67b5e4b5` |
| Model SHA-256 | `bc3c7e785eb961179c25450d1acff03f839e0002f2f3a5aeb67b5735c0fa2adb` |
| Runtime | `faster-qwen3-tts==0.3.2`, commit `a70afc0f81f7f5f8801c3227968f1102f43f211c` |
| Torch/CUDA | `2.12.1+cu130` / CUDA 13.0 |
| GPU/driver | NVIDIA GeForce RTX 4090 / 610.47 |
| Config | `benchmarks/configs/tts/qwen3-0.6b.yaml` |
| Config SHA-256 | `b240604744566bdf26cf04bf5c672ee7ae1ab88c7e767ff31ca11ce7b4c4421c` |
| Prompt manifest | `tts-prompts-v1`, SHA-256 `fdec8cd7e7c73b1bb920bd2faa71844f5a3b82e71284190ccdd2f7f235eb1b5f` |

## Cancellation probe

The probe was attached to the same run directory as the soak and is retained at:

`benchmarks/results/2026-08-16T204530510Z-source-a1f39-f83d1719/cancellation-probe.json`

Command:

```sh
/tmp/qwen-env/bin/python -m benchmarks.harness probe-cancel \
  --candidate qwen3-0.6b \
  --config benchmarks/configs/tts/qwen3-0.6b.yaml \
  --prompts benchmarks/datasets/tts-prompts-v1.manifest.json \
  --run benchmarks/results/2026-08-16T204530510Z-source-a1f39-f83d1719
```

| Check | Observed | Result |
|---|---:|---|
| Outcome | `cancelled` | Pass |
| Accepted chunks at cutoff | 1 | Pass |
| Cutoff samples | 480 | Pass |
| Accepted late chunks | 0, implied by exactly one accepted callback after cancelling in that callback | Pass |
| Surviving workers before close | `[]` | Pass |
| Surviving workers after close | `[]` | Pass |
| Backend poisoned | `false` | Pass |
| Probe elapsed | 8.687 s | Informational |

The probe JSON SHA-256 is `62c86d719300648db28fa06992456939afa52dc80777cc2f1d751f02c6ad92ac`.

## Five-minute bounded soak

Command:

```sh
/tmp/qwen-env/bin/python -m benchmarks.harness run --kind tts \
  --candidate qwen3-0.6b \
  --config benchmarks/configs/tts/qwen3-0.6b.yaml \
  --prompts benchmarks/datasets/tts-prompts-v1.manifest.json \
  --soak-minutes 5
```

Run directory:

`benchmarks/results/2026-08-16T204530510Z-source-a1f39-f83d1719`

Validation:

```sh
/tmp/qwen-env/bin/python -m benchmarks.harness validate \
  benchmarks/results/2026-08-16T204530510Z-source-a1f39-f83d1719
# valid: items=1 events=47 ratings=0
```

The runner uses a fresh prepared adapter for the soak, rotates prompts, resets before every iteration, feeds a bounded queue, and consumes at 24 kHz playback pace. Raw chunk telemetry is in `events.jsonl`; validation recomputes the aggregate from that telemetry.

| Metric | Observed | Gate interpretation |
|---|---:|---|
| Requested duration | 300 s | Required |
| Observed soak duration | 305.215 s | Pass |
| Iterations | 39 | Informational |
| Expected/consumed chunks | 14,168 / 14,168 | Pass |
| Expected/consumed samples | 6,800,640 / 6,800,640 | Pass |
| Dropped frames | 0 | Pass |
| Underrun episodes | 1 | **Fail** |
| Missed samples | 2,391 | **Fail** |
| Successful resets | 39 | Informational |
| Reset failures | 0 | Pass |
| Severe soak/close failures | 0 | Pass |
| Worker leaks | 0 | Pass |
| Deadline overruns (>20 ms) | 4 | Informational |
| Scheduling lateness p95 | 0 ms | Pass |
| Scheduling lateness maximum | 99.025628 ms | Pass, under the 100 ms conformance ceiling |
| Timing conformance | `true` | Pass |

The only non-zero iteration was iteration 7: 512 chunks, one underrun episode,
2,391 missed samples, four deadline overruns, and 99.025628 ms maximum arrival
lateness. All other iterations reported zero missed samples and zero underruns.

The run record is `status: failed`; its summary has `soak.passed: false`. The artifact was validated in that state. No failed or unrun gate was converted to `passed`.

## Runtime notes

The isolated Qwen environment printed non-fatal warnings that were retained as
run-time deviations: `sox` is not installed, the runtime reports the deprecated
`torch_dtype` argument, and it defaults the base model sample-rate inference to
24 kHz. The adapter's explicit contract and the validated PCM outputs remained
24 kHz mono PCM16.

## Decision

Qwen cancellation and cleanup are reliable in this probe, but this QW-6 run does
not satisfy the zero-underrun bounded-soak requirement. Keep the Qwen reliability
gate failed and do not use this artifact as evidence that Qwen passed selection.
