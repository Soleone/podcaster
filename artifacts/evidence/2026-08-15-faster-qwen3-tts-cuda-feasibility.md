# Task 9mm: faster-qwen3-tts CUDA feasibility

**Date:** 2026-08-15  
**Machine:** WSL2, NVIDIA GeForce RTX 4090  
**Result:** **Pinned CUDA path runs and provides true chunked output, but the upstream README claim is not reproduced at its comparable chunk size.**

## Scope and decision

This spike tests the Torch backend from `andimarafioti/faster-qwen3-tts`
against the already pinned official Qwen3-TTS 12Hz 0.6B CustomVoice model. It
uses the exact `technical-01` prompt from
`benchmarks/datasets/tts-prompts-v1.manifest.json`, speaker `Ryan`, English,
`torch.bfloat16`, eager attention, and the CUDA device. It does not change the
production runtime, add an adapter, use the optional GGML/qwentts.cpp backend,
or use `franken_tts`.

The accepted local artifact is retained at:

```text
benchmarks/results/faster-qwen3-tts-cuda-spike-20260815T232500Z/
```

It contains `result.json`, `console.log`, and validated PCM/WAV outputs. The
benchmark result directory is ignored by the repository's payload rules; the
runner and this evidence are tracked.

The pinned environment ran without a compatibility deviation. Keep Kokoro
CUDA as the production fallback. The faster implementation is an evaluation
candidate only. It still imports the official `qwen-tts` model/runtime, so this
spike does not replace the official dependency or establish a production
license/provenance decision.

## Source, model, and license identity

| Field | Observed value |
|---|---|
| Repository | `https://github.com/andimarafioti/faster-qwen3-tts.git` |
| Repository commit | `a70afc0f81f7f5f8801c3227968f1102f43f211c` |
| Tag / package | `v0.3.2` / `faster-qwen3-tts==0.3.2` |
| Repository worktree | clean at measurement time |
| Implementation license | MIT; `LICENSE` SHA-256 `442472a518bf71e371f2581aa0fcaf6ee2ef6854f78c340fdbe87c099950ea82` |
| Qwen model | `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` |
| Qwen model revision | `85e237c12c027371202489a0ec509ded67b5e4b5` |
| Qwen model license | Apache-2.0, as recorded in `docs/model-manifest.json` |
| Qwen lock | `services/audio/qwen-requirements.lock`, SHA-256 `1855d1a144fdde4fb026a16302e73203d832fccae8155a6f77d40196d40142ab` |

The source review at this commit shows `TalkerGraph` using Transformers
`StaticCache` and a captured `torch.cuda.CUDAGraph` for the talker decode, a
separate captured graph for the code predictor, and
`generate_custom_voice_streaming()` yielding decoded chunks from a Python
generator. The default Torch path was tested; no GGML package or native
qwentts library was installed.

## Runtime and hardware

| Field | Observed value |
|---|---|
| Python | `3.12.11` |
| PyTorch | `2.12.1+cu130` |
| PyTorch CUDA | `13.0` |
| cuDNN | `92000` |
| `qwen-tts` | `0.1.1` |
| Transformers | `4.57.3` |
| Accelerate | `1.12.0` |
| NumPy / soundfile | `2.5.2` / `0.14.0` |
| Platform | Linux WSL2, kernel `6.6.114.1-microsoft-standard-WSL2` |
| GPU / capability | GeForce RTX 4090 / `sm_89` |
| Driver | `610.47` |
| PyTorch device | `cuda` |
| Dtype / attention | `bfloat16` / `eager` |
| Model preparation | 4.160 s; process start to ready 6.936 s |

The run used an isolated environment based on the existing Qwen lock. There
was another audio server resident on the GPU, so the `nvidia-smi` whole-device
reading is ambient context only. Peak VRAM below is process-attributed through
PyTorch's allocator.

## Reproduction

The model files must first pass the tracked manifest verification. The source
checkout was pinned to the commit above and installed editable without
re-resolving the Qwen runtime:

```sh
git clone https://github.com/andimarafioti/faster-qwen3-tts /tmp/faster-qwen3-tts
git -C /tmp/faster-qwen3-tts checkout a70afc0f81f7f5f8801c3227968f1102f43f211c
uv run python scripts/verify-models.py docs/model-manifest.json
uv venv /tmp/qwen-env --python .venv/bin/python
uv pip sync --python /tmp/qwen-env/bin/python services/audio/qwen-requirements.lock
uv pip install --python /tmp/qwen-env/bin/python --no-deps -e /tmp/faster-qwen3-tts

/tmp/qwen-env/bin/python scripts/faster-qwen3-tts-cuda-spike.py \
  --faster-repo /tmp/faster-qwen3-tts \
  --output-dir benchmarks/results/faster-qwen3-tts-cuda-spike-20260815T232500Z \
  --ttfa-repetitions 3
```

The runner verifies all 13 local Qwen asset hashes, records the source Git
identity, captures Python/PyTorch/CUDA versions, measures a cold graph-capture
request and warm requests, validates every yielded packet, writes PCM16LE/WAV
outputs, and records PyTorch allocator peaks plus RSS.

## Streaming and audio validity

**True chunked streaming: yes.** With `chunk_size=8`, the warm run yielded 13
non-empty packets before the generator completed. The first packet arrived at
257.1 ms and contained 15,360 samples, or 640 ms at 24 kHz. The final packet
contained 1,920 samples, or 80 ms. The concatenated result was 186,240 samples
and 7.76 s. This is incremental output before completion, not a full waveform
split after return. It is not yet the project's 20 ms transport framing; an
adapter would still need to rechunk these native packets.

The warm streaming output was validated as:

- signed PCM16LE, mono, 24,000 Hz;
- finite, non-empty float output within the PCM range before conversion;
- 186,240 samples, 7.76 s, and 372,480 PCM bytes;
- WAV reopened with matching header and payload;
- PCM SHA-256 `6a7bac4962bbfa91f7dcc0cfcb38585c3ed8f7588323bf9679caf9b4e66d585e`;
- WAV SHA-256 `22b20882739c2b521f0610ec9e94017276174c772034165196b30ae6d4a3472f`.

## Timing results

RTF in this document means **processing seconds / generated audio seconds**,
the same convention as QW-2. Values below 1.0 are faster than real time. The
reciprocal, audio seconds / processing seconds, is also recorded because the
upstream README labels that direction RTF.

| Observation | First audio | Total processing | Audio | Project RTF | Reciprocal |
|---|---:|---:|---:|---:|---:|
| Cold streaming, graph capture included | 8.119 s | 9.900 s | 6.48 s | 1.528 | 0.655x |
| Warm streaming, `chunk_size=8` | 257.1 ms | 2.112 s | 7.76 s | 0.272 | 3.674x |
| Warm buffered, complete waveform return | 1.763 s | 1.763 s | 7.76 s | 0.227 | 4.401x |

The warm first-packet sweep used three repetitions per setting:

| Codec steps per packet | Native audio in first packet | Mean TTFA | Std. dev. |
|---:|---:|---:|---:|
| 1 | 80 ms | 154.2 ms | 11.7 ms |
| 4 | 320 ms | 202.9 ms | 13.1 ms |
| 8 | 640 ms | 264.4 ms | 6.5 ms |
| 12 | 960 ms | 333.9 ms | 12.5 ms |

The README's RTX 4090 result reports roughly 5.5x real time and 154 to 156 ms
TTFA, with its comparison note describing `chunk_size=8`. This run did **not**
reproduce those numbers under the pinned WSL CUDA 13 / Torch 2.12.1 setup: the
comparable chunk-size-8 mean was 264.4 ms and the complete warm streaming
reciprocal was 3.674x. A 154.2 ms result was observed only with `chunk_size=1`,
which emits an 80 ms native packet and is not the README's chunk-size-8
comparison. The claim is therefore not treated as an acceptance target.

## Resource results

Whole-process peaks from the accepted run:

- Peak VRAM reserved: **2,778,726,400 bytes** (`2.588 GiB`), source
  `torch.cuda.max_memory_reserved()` across preparation and measured phases.
- Peak VRAM allocated: **2,599,023,104 bytes** (`2.421 GiB`).
- Peak RSS: **2,657,161,216 bytes** (`2.475 GiB`), maximum of the 10 ms
  `/proc/self/status` sampler and Linux `RUSAGE_SELF.ru_maxrss`.

The official QW-2 accepted run measured 2,533,359,616 bytes reserved,
2,359,540,736 bytes allocated, and 2,818,576,384 bytes RSS. The faster path
therefore used about 245 MiB more reserved VRAM and about 161 MiB less peak RSS
in these separate runs. Ambient `nvidia-smi` memory is not used for that
process comparison.

## Failures and deviations

- **Pinned runtime:** passed. CUDA was available, the device was `sm_89`, and no
  compatibility deviation was needed or tested.
- **Functional failures:** none in the accepted run. All streaming packets and
  buffered output passed the 24 kHz PCM checks.
- **Non-fatal warnings:** the environment had no `sox` executable; qwen-tts
  printed its optional SoX warning. The fast wrapper also printed the upstream
  `torch_dtype` deprecation warning and a sample-rate inference warning before
  defaulting to 24 kHz. The actual decoder rate and reopened WAV were 24 kHz.
- **Production integration:** not attempted. Cancellation, reset/close, 20 ms
  transport rechunking, co-resident serving, and listening quality remain
  unvalidated for this candidate.

## Comparison with existing evidence

| Candidate | Streaming contract | First audio | Complete processing | Project RTF |
|---|---|---:|---:|---:|
| faster-qwen3-tts, warm stream, chunk 8 | true generator chunks; 640 ms native first packet | 264.4 ms mean sweep | 2.112 s / 7.76 s audio | 0.272 |
| faster-qwen3-tts, warm buffered | no, full return | 1.763 s | 1.763 s / 7.76 s audio | 0.227 |
| Official QW-2, cold | no, full return | 29.584 s | 29.584 s / 8.88 s audio | 3.332 |
| Official QW-2, warm | no, full return | 27.874 s | 27.874 s / 8.88 s audio | 3.139 |
| Existing Kokoro CUDA technical-01 evidence | chunked production path | 279.8 ms | 312.0 ms | not restated in the supplied evidence |

The Kokoro figures are the prior project evidence supplied for the same
technical-01 prompt, not a rerun in this spike. Audio durations and a directly
matched RTF for that particular observation were not available in the retained
text, so none is fabricated here. The native Qwen packet sizes also make direct
TTFA comparisons directional rather than a complete matched production test.

## Decision

The faster Torch CUDA path is **locally feasible** on the pinned CUDA 13 / Torch
2.12.1 WSL RTX 4090 environment and materially improves on the official
complete-waveform Qwen path. It provides real incremental output and warm
throughput above real time, but its measured chunk-size-8 result is slower than
the upstream README claim and its first native packet is 640 ms. Do not replace
Kokoro or the official Qwen dependency from this spike. Any future adoption
requires the normal license/provenance review plus an adapter-level matched
benchmark, cancellation/cleanup tests, 20 ms framing, and listening review.
