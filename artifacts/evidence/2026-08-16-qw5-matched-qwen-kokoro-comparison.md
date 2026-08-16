# QW-5 matched Qwen versus Kokoro comparison

**Date:** 2026-08-16  
**Task:** QW-5 / `hx1`  
**Primary result:** accepted matched runs for Qwen CUDA versus Kokoro CPU on the same 24 prompts.  
**Optional result:** accepted GPU-versus-GPU rerun using Kokoro CUDA.

## Scope and labels

Both candidates used `tts-prompts-v1`, 24 project-authored English prompts, the
same exact-text and 24 kHz signed PCM16 mono contract, fixed gain 0.9, speed 1.0,
and 20 ms transport chunks. TTFA is measured from the harness request boundary to
the first accepted 480-sample chunk. RTF is harness request-to-return processing
seconds divided by generated audio seconds. The first request after preparation
is reported as `cold`; it is excluded from the warm item aggregates.

The primary production-shape interpretation is **Nemotron STT on CPU plus Qwen TTS
on GPU**. These runs are TTS-only. Nemotron was not loaded, the two services were
not run together, and no GPU co-residency measurement was made. The host reported
an RTX 4090, but this evidence does not make a universal RTX 4090 performance or
co-residency claim.

## Accepted primary artifacts

All three runs were validated after completion with `items=24`, `events=75`, and
`ratings=0`. The two primary runs share source snapshot `source-a1f39f0188cd950f`.
The worktree was dirty because the benchmark changes were being reviewed; each
run retains its source manifest and hashes.

| Candidate | Run directory | Run ID | Run SHA-256 | Summary SHA-256 |
|---|---|---|---|---|
| Kokoro CPU | `benchmarks/results/2026-08-16T203220298Z-source-a1f39-96e9a47e` | `96e9a47e-8cc2-4182-ade3-3fac3f4b4d9f` | `77f77e3d160b4985f69d260387d1d80af30f6fc7b85e036d8b969f71e76e20a7` | `2de5c4de974fcea0cb066a7ab46afdacb9cfd5e587d0ca3cb639207aaf765d58` |
| Qwen CUDA | `benchmarks/results/2026-08-16T203304482Z-source-a1f39-ed93b67e` | `ed93b67e-0fb2-42f3-8227-ee1d36b3720a` | `cdae684eca97b90973e2b8645b2e82bb62695f002801c60c33798fc801eca376` | `ebd8d1ca5af7f5c48511a3c63e522163cad42a245a696357f0e7e95d51d5ce79` |

The full hashes are in the local run directories. The matched comparison projection
is `benchmarks/results/comparison-hx1-cpu-qwen-20260816/comparison.json` with SHA-256
`772a116329b24007ee14681b12ccdf07e486004c7c438254d89875e6e539f9cd`.

## Primary measurements

Times are milliseconds or seconds. RTF below 1.0 is faster than realtime under the
project convention. RSS is the maximum process RSS over prepare, cold, and measured
synthesis windows. Qwen VRAM is the process-attributed PyTorch reserved allocator
peak. `null` is intentional, not zero.

| Metric | Kokoro CPU | Qwen CUDA |
|---|---:|---:|
| Provider / device | `CPUExecutionProvider` | `CUDA`, `cuda:0` |
| Prepare | 1.348 s | 6.761 s |
| Cold TTFA | 432.8 ms | 8,772.4 ms |
| Cold processing / RTF | 0.437 s / 0.320 | 9.532 s / 3.310 |
| Warm TTFA p50 / p95 | 978.2 / 1,750.6 ms | 298.7 / 330.8 ms |
| Warm RTF p50 / p95 | 0.243 / 0.282 | 0.309 / 0.345 |
| Peak RSS, run | 944,943,104 B | 2,658,410,496 B |
| Peak VRAM, run | `null` | 2,589,982,720 B reserved |
| Passed / failed prompts | 24 / 0 | 24 / 0 |
| Failure list | empty | empty |

Qwen's warm first accepted 20 ms chunk arrived substantially sooner than Kokoro
CPU in this run, while Kokoro CPU had the lower warm RTF. Qwen's cold request and
prepare phase were much slower because the first request includes the cold faster-
Qwen graph/runtime work. Generated durations are model outputs and differ between
candidates, so total generated seconds are not treated as a quality comparison.

RSS and VRAM are not whole-device `nvidia-smi` claims. The Qwen run's prepare-
inclusive RSS peak was 2,658,410,496 bytes; its measured synthesis-window RSS peak
was 2,314,256,384 bytes. The CPU run has no candidate VRAM allocation to report.

## Optional GPU-versus-GPU rerun

KOK-1's CUDA config was rerun against the same Qwen CUDA run. This is a separate
comparison, not a replacement for the primary CPU fallback comparison. The
Kokoro CUDA run is `benchmarks/results/2026-08-16T203428666Z-source-a1f39-c0814701`
(run ID `c0814701-0400-4396-99f5-d061e1f6aad5`), with run SHA-256
`cf26262d0128aecb3068d94bc32339aa3c37eabe1393cebe95823789d3a91175` and summary
SHA-256 `c61cb5ee521da5bd00e73d33ac6ce1473e9f47c49b89f078c6cd065c325e05f4`.

| Metric | Kokoro CUDA | Qwen CUDA |
|---|---:|---:|
| Provider / device | `CUDAExecutionProvider` | `CUDA`, `cuda:0` |
| Prepare | 1.356 s | 6.761 s |
| Cold TTFA | 695.6 ms | 8,772.4 ms |
| Warm TTFA p50 / p95 | 208.1 / 357.3 ms | 298.7 / 330.8 ms |
| Warm RTF p50 / p95 | 0.058 / 0.076 | 0.309 / 0.345 |
| Peak RSS, run | 1,865,293,824 B | 2,658,410,496 B |
| Peak VRAM, run | `null` | 2,589,982,720 B reserved |
| Passed / failed prompts | 24 / 0 | 24 / 0 |

Kokoro CUDA VRAM remains `null`: its ONNX Runtime CUDA allocator is not exposed as
a process-attributed counter by this harness. The run does not turn ambient device
memory into a candidate peak. The optional comparison projection is
`benchmarks/results/comparison-hx1-gpu-qwen-20260816/comparison.json` with SHA-256
`e7568ca0094bf0ca09b475cb56ee5c4af4cd33aa19864b7232527e0ddc2fd649`.

## Machine and runtime context

The runs were separate WSL2 processes on host `chuck`, Linux kernel
`6.6.114.1-microsoft-standard-WSL2`, with the host-reported GPU
`NVIDIA GeForce RTX 4090`, driver `610.47`, and 16,720,674,816 bytes RAM. Ambient
whole-device memory before the runs was approximately 6,960 MiB for the CPU and
Qwen runs and 6,897 MiB for the optional Kokoro CUDA run. Those ambient readings
are retained only as context and are not used in the reported candidate peaks.

Qwen used `faster-qwen3-tts==0.3.2` at commit
`a70afc0f81f7f5f8801c3227968f1102f43f211c`, PyTorch `2.12.1+cu130`, bfloat16,
eager attention, and the pinned CustomVoice revision
`85e237c12c027371202489a0ec509ded67b5e4b5`. Kokoro CPU used `onnxruntime==1.22.1`
and the pinned Kokoro runtime/model revisions. The optional Kokoro CUDA run used
the pinned ONNX Runtime GPU 1.22.0 proxy configuration.

## Reproduction

```sh
cpu_run=$(/tmp/kokoro-cpu-env/bin/python -m benchmarks.harness run --kind tts \
  --candidate kokoro --config benchmarks/configs/tts/kokoro.yaml \
  --prompts benchmarks/datasets/tts-prompts-v1.manifest.json | tail -1)
qwen_run=$(/tmp/qwen-env/bin/python -m benchmarks.harness run --kind tts \
  --candidate qwen3-0.6b --config benchmarks/configs/tts/qwen3-0.6b.yaml \
  --prompts benchmarks/datasets/tts-prompts-v1.manifest.json | tail -1)
/tmp/kokoro-cpu-env/bin/python -m benchmarks.harness validate "$cpu_run"
/tmp/qwen-env/bin/python -m benchmarks.harness validate "$qwen_run"
.venv/bin/python -m benchmarks.harness compare --runs "$cpu_run" "$qwen_run"
```

The optional rerun substitutes `benchmarks/configs/tts/kokoro-cuda.yaml` for the
CPU config. No listening preference or production selection is claimed by this
measurement task; those remain separate gates.
