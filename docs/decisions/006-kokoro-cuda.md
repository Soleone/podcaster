# Decision 006 — Kokoro on CUDA: provider swap and re-benchmark

**Date:** 2026-08-09
**Milestone:** 6 (TTS performance track; task KOK-1, P0)
**Outcome:** **Move Kokoro TTS from pinned CPUExecutionProvider fp32 to CUDAExecutionProvider on the RTX 4090. The 750 ms TTFA gate now passes.**

## Scope and authority

This task swaps the Kokoro runtime contract to the GPU build, re-benchmarks with the existing harness, and records the numbers truthfully. fp16 model conversion is explicitly out of scope (deferred). The accepted CPU baseline from Decision 004 / run `72d369ad` remains the historical reference; the pinned contract now is the CUDA candidate `kokoro-82m-onnx-fp32-af-heart-cuda-v1`.

## Contract change

- Runtime: `onnxruntime==1.22.1` (CPU) → `onnxruntime-gpu==1.22.0` (CUDA 12 build; **1.22.1 has no GPU wheel** — verified against PyPI, the closest on the 1.22 line is 1.22.0).
- Provider: `CPUExecutionProvider` → `CUDAExecutionProvider` (fp32 unchanged).
- Dependency resolution: onnxruntime-gpu is a separate package name, and installing both wheels races for the `onnxruntime/` module files with the CPU wheel winning (verified empirically). The project vendors a pure-metadata proxy wheel `vendor/onnxruntime-1.22.0-py3-none-any.whl` named `onnxruntime` that depends on `onnxruntime-gpu[cuda,cudnn]==1.22.0` plus `nvidia-cublas-cu12==12.1.3.1` (cuBLAS is required at load time but declared by no ORT extra). No CPU wheel enters the graph. Regenerated deterministically by `scripts/build-ort-proxy-wheel.py`.
- CUDA 12 runtime libraries are pip-installed (nvidia-cuda-runtime/cublas/cudnn/nvrtc/cufft/curand/nvjitlink cu12), matching the sibling project's pattern. ORT's provider library has no RPATH, so `services/audio/src/tts/kokoro.py` now preloads them with `ctypes.RTLD_GLOBAL` in dependency order (`preload_cuda_runtime()`), self-contained and fail-closed.
- Provider verification: ORT appends CPU as an automatic fallback EP, so the fail-closed check now asserts the configured provider is the active **primary** EP (`get_providers()[0] == provider`) instead of exact list equality.
- ORT one-time session warnings suppressed (`log_severity_level = 3`) so the sidecar's captured stderr stays clean; the single benign ScatterND runtime note fires once per process.
- Updated: `pyproject.toml` (pin + `[tool.uv.sources]` wheel mapping + uv.lock), `kokoro.py` (PROVIDER, RUNTIME_CONTRACT, verifier, preload), `benchmarks/configs/tts/kokoro-cuda.yaml` (new candidate id), `docs/model-manifest.json` (runtime/provider), harness tests pointed at the CUDA config. Model files and SHA-256s unchanged (`scripts/verify-models.py` passes: 3 model files).

## Evidence

### 24-prompt harness run (CUDA)

- Run: `benchmarks/results/2026-08-09T192653088Z-source-38f3e-cfe860f8` (id `cfe860f8`)
- Validated: 24/24 items, 72 events, zero failures, zero drops, zero output-chunk drops
- Machine: RTX 4090 (driver 610.47, WSL2, CUDA 13 UMD), Kokoro on CUDAExecutionProvider

| Metric | CPU baseline (T4.1, `72d369ad`) | CUDA (`cfe860f8`) | Δ |
|---|---|---|---|
| TTFA p50 | 848.51 ms | 239.75 ms | 3.5x faster |
| TTFA p95 | 1582.17 ms | 366.27 ms | 4.3x faster |
| TTFA p99 | 2139.74 ms | 448.00 ms | 4.8x faster |
| RTF p50 | 0.2062 | 0.0649 | 3.2x faster |
| RTF p95 | 0.2499 | 0.0931 | 2.7x faster |
| RTF p99 | 0.2859 | 0.1244 | 2.3x faster |
| Peak RSS (whole process) | 921,186,304 B | 1,938,325,504 B | +1.0 GB |
| Audio | 113.39 s | 113.39 s | identical prompts |

### Gate

| Requirement | Evidence | Result |
|---|---|---|
| p95 TTFA ≤ 750 ms | **366.27 ms** | **Pass** (was 1582.17 ms, an accepted exception) |
| p95 RTF ≤ 0.70 | 0.0931 | Pass (margin 7.5x) |
| Valid local PCM output | 24/24 checksummed items | Pass |
| No drops | 0 dropped frames/output chunks | Pass |

### Real cancellation probe (attached to run `cfe860f8`)

- Outcome: cancelled after the first 480-sample (20 ms) chunk; elapsed 0.997 s (CPU baseline 1.824 s)
- Accepted late chunks: zero; surviving workers pre/post close: zero; backend poisoned: false

### VRAM (nvidia-smi deltas during synthesis)

- ORT CUDA context + model at prepare: ~0.9 GB; peak during long synthesis: ~2.5 GB above idle. The 4090 has 24 GB (idle baseline drifts upward in WSL as the driver retains cached memory outside process attribution; no compute process was attributed). Co-residency note: Nemotron STT runs on CPU in this build, so Kokoro's ~2.5 GB peak is the only GPU consumer alongside the desktop.

## Validation

- `uv run pytest services/audio/tests benchmarks/harness/tests -q` — 175 passed
- `pnpm check` — all validations passed (contracts regeneration, typechecks, python suites, ruff, host tests, dev-cleanup)
- `uv run python scripts/verify-models.py docs/model-manifest.json` — 3 model files verified
- `harness validate` + `normalize` on the CUDA run — valid, recomputable

## Residual risks and follow-ups

- **fp16 model conversion** deferred (would cut VRAM and likely improve RTF further; needs a converted model + new manifest entry).
- **ORT arena is unbounded** — peak ~2.5 GB VRAM during synthesis; a `session.gpu_memory_limit` cap is a cheap follow-up if VRAM budget tightens.
- The CPU config `benchmarks/configs/tts/kokoro.yaml` is superseded (harness now rejects it: provider mismatch vs manifest, fail-closed by design). Historical numbers live in Decision 004 and run `72d369ad`.
- The venv now carries ~2.5 GB of pip nvidia cu12 libraries (runtime requirement of the GPU build; documented in the proxy-wheel script).

## Decision

Use `kokoro-82m-onnx-fp32-af-heart-cuda-v1` as the pinned Kokoro contract. The 750 ms TTFA gate is met on the RTX 4090; first-audio latency, throughput, and co-residency all improve materially over the CPU baseline. Keep fp16 and the ORT memory cap as follow-ups, not blockers.
