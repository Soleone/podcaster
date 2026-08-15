# QW-2 — Qwen3-TTS CUDA feasibility spike

**Date:** 2026-08-15  
**Task:** QW-2 / `yzc`  
**Machine:** WSL2, NVIDIA GeForce RTX 4090  
**Result:** **Feasible for local CUDA synthesis**

## Scope

This spike exercises the official `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
checkpoint directly on the RTX 4090. It is a feasibility result, not a latency
target or a product selection. No `franken_tts` code, runtime, or subprocess was
used.

The accepted run is retained locally at:

```text
benchmarks/results/qwen-cuda-spike-20260815T154500Z/
```

The directory is ignored with benchmark payloads and contains `result.json`,
`console.log`, `cold.wav`, `cold.pcm`, `warm-1.wav`, and `warm-1.pcm`.

## Reproduction

The model assets were verified against the tracked immutable manifest before
loading:

```sh
uv run python scripts/verify-models.py docs/model-manifest.json
# verified 4 model file(s)
sha256sum services/audio/qwen-requirements.lock
# 1855d1a144fdde4fb026a16302e73203d832fccae8155a6f77d40196d40142ab
```

The Qwen environment was isolated from the host audio environment because the
official package requires Transformers 4.57.3 while the host uses Transformers
5.x:

```sh
uv venv /tmp/qwen-env --python .venv/bin/python
uv pip sync --python /tmp/qwen-env/bin/python services/audio/qwen-requirements.lock
/tmp/qwen-env/bin/python scripts/qwen-cuda-spike.py \
  --output-dir benchmarks/results/qwen-cuda-spike-20260815T154500Z \
  --warm-repetitions 1
```

The tracked runner is `scripts/qwen-cuda-spike.py`. It independently checks all
13 asset hashes listed for the Qwen manifest entry, writes signed PCM16LE and a
WAV container, reopens the WAV with the standard library, and records the raw
JSON evidence.

## Pinned runtime and hardware

| Field | Observed value |
|---|---|
| Model | `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` |
| Revision | `85e237c12c027371202489a0ec509ded67b5e4b5` |
| Runtime | `qwen-tts==0.1.1` |
| Transformers | `4.57.3` |
| Accelerate | `1.12.0` |
| PyTorch | `2.12.1+cu130` |
| CUDA reported by PyTorch | `13.0` |
| Device | `cuda:0`, RTX 4090, compute capability `sm_89` |
| Dtype | `torch.bfloat16` |
| Attention | `eager` |
| Speaker / language | `Ryan` / `English` |
| Ambient `nvidia-smi` memory before load | 1,920 MiB used, 22,223 MiB free |

The runtime printed that `flash-attn` was not installed. The pinned spike uses
the explicit `eager` attention implementation, so this is a known runtime
condition rather than an unrecorded optimization.

## Timing and resource results

The prompt was:

> Signed PCM sixteen, mono, at twenty-four kilohertz must remain correctly framed.

`prepareSeconds` is the `from_pretrained` call through CUDA synchronization.
`processStartToPrepareReadySeconds` includes Python/import startup. The official
Qwen wrapper returns a complete waveform and does not yield audio chunks, so
request-to-first-audio is necessarily observed at `generate_custom_voice` return
and equals total processing for this run.

| Measurement | Cold first request | Warm repeat |
|---|---:|---:|
| Prepare | 1.4846 s | model already prepared |
| Process start to prepare ready | 6.3562 s | n/a |
| Request to first observable audio | 29.5842 s | 27.8742 s |
| Total processing | 29.5842 s | 27.8742 s |
| Generated audio | 8.8800 s | 8.8800 s |
| RTF | 3.3316 | 3.1390 |

Peak resource readings for the whole spike process:

- Peak VRAM: **2,533,359,616 bytes** reserved by the PyTorch CUDA allocator
  (2,359,540,736 bytes allocated).
- Peak RSS: **2,818,576,384 bytes**, taking the maximum of the 10 ms `/proc` RSS
  sampler and Linux `RUSAGE_SELF.ru_maxrss`.

These are process/allocator measurements, not ambient `nvidia-smi` memory
claims. The raw source fields and phase readings are in `result.json`.

## Audio validity

The cold output was validated as:

- signed PCM16LE, mono, 24,000 Hz;
- 213,120 samples, 8.88 seconds, 426,240 raw PCM bytes;
- finite, non-empty waveform within the PCM range;
- WAV container reopened successfully with matching payload and header.

Checksums for the accepted cold output:

```text
cold.pcm  86c3071041dbed36226fd2e87206cea098ea687365cd1352ac4dcb5ff680b555
cold.wav  6bbdb8056de2cf8641f8b65f9a022987e6f2d6590b63a051b1c3df031d595b2a
```

## Decision

Qwen is **not infeasible** on this machine: the official checkpoint loads on
CUDA and produces valid 24 kHz PCM. Keep Kokoro as the current selected TTS
backend while later Qwen adapter, matched-comparison, reliability, and listening
gates remain outstanding. The measured official API is complete-waveform and is
slower than real time for this prompt, but this spike makes no latency claim and
does not pre-judge those later gates. If a later integration requires streaming
chunks that the official API cannot provide, record that limitation rather than
introducing `franken_tts` as a fallback.
