# ARC-014 — Move selected audio configuration to the audio service

## Rationale

Production audio imports selected configs from `benchmarks/` and its model manifest from `docs/`, and repeats common path/hash verification. Establish service ownership while preserving exact bytes and historical benchmark evidence.

## In scope

- `services/audio/src/runtime.py` config paths and common verifier extraction.
- New `services/audio/config/**` selected config files; model manifest move only if atomic and justified.
- Benchmark commands/config references/tests that consume the selected production configs.
- Acquisition/verification scripts and current docs path references needed by the move.
- Runtime/benchmark tests for identity/hash behavior.

## Out of scope

- Changing selected models/parameters/hashes, rebenchmarking, rewriting adapters, deleting historical candidate configs/results, broad split of `runtime.py` or `qwen3.py`.

## Prerequisites

- ARC-010 preferred.
- Baseline hashes of all moved configs/manifest recorded.
- `uv run pytest services/audio/tests benchmarks/harness/tests` green.

## Step-by-step changes

1. `git mv` the three selected configs to `services/audio/config/` without content edits:
   - Nemotron 320 ms;
   - Kokoro CUDA;
   - Qwen 1.7B optional model.
2. Decide manifest move as one atomic substep. If moving `docs/model-manifest.json`, use `git mv` to `services/audio/config/model-manifest.json` and update every current acquisition/runtime/benchmark/provenance link; historical ADR prose may state the former path as historical evidence. If too broad, leave a documented canonical manifest in place and move only selected configs.
3. Update runtime constants and expected hashes; hashes must remain identical for unchanged bytes.
4. Update benchmark CLI/docs/tests to consume service-owned selected configs. Candidate-only/superseded configs remain under benchmarks.
5. Extract a small service helper that:
   - resolves paths under repository root safely;
   - loads schema-versioned manifest once;
   - selects exactly one model entry;
   - verifies listed files/hashes.
6. Refactor three runtime `_verified_*` methods to call the helper, retaining their STT/Kokoro/Qwen-specific identity, latency, provider, language, sample-rate, and runtime checks.
7. Do not replace adapter-level runtime distribution/source verification; it checks a different trust boundary.
8. Update source-state/hash expectations intentionally and document why path-only source identity changed.

## Invariants

- Config/manifest bytes and selected values unchanged.
- Runtime still fails closed on config hash/path/model file drift.
- Optional Qwen failure never gates Kokoro.
- Historical accepted run directories/schemas are not rewritten.
- Production imports no `benchmarks/configs` path after completion.

## Acceptance criteria

- Service owns selected production config.
- Common verification duplication is reduced without a generic model plugin system.
- Full audio and benchmark tests pass.
- Model verifier succeeds in the local asset-equipped checkout; if assets unavailable, focused fake-manifest tests cover behavior and limitation is reported.

## Focused tests / commands

```bash
sha256sum services/audio/config/*
uv run pytest services/audio/tests/test_runtime.py services/audio/tests/tts/test_kokoro.py services/audio/tests/tts/test_qwen3.py
uv run pytest services/audio/tests
uv run pytest benchmarks/harness/tests
uv run ruff check services/audio/src services/audio/tests benchmarks/harness scripts
uv run python scripts/verify-models.py services/audio/config/model-manifest.json  # only if manifest moved
rg -n 'benchmarks/configs/(stt/nemotron-320ms|tts/kokoro-cuda|tts/qwen3-1.7b)|docs/model-manifest.json' services/audio/src scripts docs benchmarks
```

## Expected diff shape

Mostly moves/path updates plus one focused verifier module/tests and net deletion from runtime verification. No lockfile or model payload changes.

## Likely pitfalls

- Renaming `.yaml` to `.json` creates unnecessary history/content churn; extension can stay.
- Benchmark source IDs may include paths; update expected identity explicitly, never normalize accepted artifacts silently.
- Do not centralize candidate-specific runtime attestation into a weak generic dictionary checker.

## Parallel safety

Parallel-safe with web/TS tasks after ARC-010; sole owner of selected config/runtime verification files.
