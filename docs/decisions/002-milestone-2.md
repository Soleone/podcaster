# Decision 002: Milestone 2 reproducible benchmark harness

**Status:** accepted — Milestone 2 gate passed 2026-08-07

## Decision

The T2.1 benchmark harness is accepted as the reproducible boundary for later RTX 4090 speech candidate measurements. It provides a deterministic synthetic/null adapter implementing `prepare`, `transcribe`/`synthesize`, `reset`, and `close`; schema-valid run, item, event, summary, and rating artifacts; fail-closed dataset/model verification; monotonic event and cancellation/failure evidence; truthful runtime/hardware metadata; and an executable blinded multi-run listening workflow.

This decision does not select, install, or implement an STT or TTS model. Candidate adapters, real speech latency/quality measurements, co-residency, and soak tests remain later milestones.

## Reproducibility evidence

Two final synthetic runs used seed 4090 and the exact command:

```sh
uv run python -m benchmarks.harness run --kind synthetic --config benchmarks/configs/common.yaml
```

- `a517e378-78f2-43c6-9d2c-7826effe5c8e`
- `e388e755-5491-427e-ad58-33857e5a8ca3`

Each validated with 6 measured items and 24 correlated monotonic events. Their normalized summaries were byte-identical. Warmups execute but are excluded from measured artifacts; two repetitions execute for every committed dataset source. The full two-run `listen` → `submit-ratings` → `reveal` workflow completed in comparison workspace `comparison-85a75b46-91c2-4e67-a1f3-e058ecf0674b` with per-sample ratings, trusted-view binding, immutable submission evidence, and consistent reveal timestamps.

Checksum mismatch tests failed closed for both datasets and models. `scripts/verify-models.py` was also exercised directly from the project root.

## Hardware evidence and unavailable checks

On the target WSL2 machine, `nvidia-smi` reported an NVIDIA GeForce RTX 4090, driver 610.47, 24,564 MiB total memory, and ambient machine usage. The final run records Linux/WSL2 machine metadata and the exact command. This proves metadata visibility only.

CUDA model execution was unavailable in T2.1: PyTorch was not installed, `nvcc` was unavailable, WSL exposed `/dev/dxg` rather than `/dev/nvidia*`, and no speech model was present. Candidate peak/steady VRAM therefore remains `null`, not a fabricated zero. No model latency, co-resident speech run, or 30-minute model soak was performed; those checks belong to Milestones 3 and 4.

## Validation evidence

Final commands passed:

- `uv sync --frozen`
- `uv run pytest benchmarks/harness/tests` — 21 passed
- two literal synthetic run commands and both `validate` commands
- two normalized summaries compared with `cmp` — identical
- dataset verification command
- executable multi-run blinded listening/submission/reveal workflow
- `pnpm check` — 408 contract tests, 29 Python service tests, 21 harness tests, 46 host tests, typechecks, Ruff, web build, and process cleanup passed

The workspace has no Git repository, so native diff, commit ID, dirty-worktree inspection, and staged-file checks were unavailable. The harness records a deterministic source manifest hash and marks the no-Git source state dirty.

## Independent review

Independent adversarial review covered correctness, security, reproducibility, hardware truthfulness, lifecycle failures, checksum verification, schema consistency, repetitions, fixture bytes, semantic validation, VRAM availability, multi-run blinding, per-sample ratings, comparison matching, reveal integrity, and trusted listening-view binding. Four fix/re-review rounds were completed. The final reviewer approved the gate with no actionable findings.

## Gate

Another maintainer can rerun the synthetic benchmark from `docs/benchmarking.md`, obtain schema-valid output with exact machine/command metadata, compare deterministic normalized seeded summaries, and execute the blinded rating lock/reveal flow. Milestone 2 passes. Stop here; do not begin STT/TTS adapters or later milestones under this decision.
