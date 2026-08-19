# ARC-003 — Make `pnpm check` authoritative

## Rationale

The repository already has strong tests, but `scripts/check.sh` omits all web units and most audio runtime/TTS/voice tests. The fastest safety improvement is to run the tests that exist and verify every generated output.

## In scope

- `scripts/check.sh`.
- `package.json` only if an explicit `test:fast`/`test:full` naming improvement is necessary; prefer no script proliferation.
- A small shell/MJS test only if needed to prove generated freshness coverage.
- README command text belongs to ARC-012, not this task.

## Out of scope

- Playwright, real Pi calls, model acquisition/load, GPU soak, coverage thresholds, CI provider setup, formatter/linter installation.

## Prerequisites

- Clean generated outputs.
- Baseline: `bash scripts/check.sh` passes.

## Step-by-step changes

1. Add `corepack pnpm --filter @app/web test` to the parallel model-free jobs.
2. Replace fragmented audio pytest jobs with one `uv run pytest services/audio/tests`, unless measured peak resource contention requires two **complete, non-overlapping** groups. Do not omit runtime/TTS/voice files.
3. Retain benchmark tests, all four typechecks, contracts/policy tests, Ruff, host tests, dev cleanup, and ignore checks.
4. Extend generation freshness to all outputs:
   - `packages/contracts/src/generated/contracts.ts`
   - `packages/contracts/test/types-required.generated.compile.ts`
   - `services/audio/src/generated/contracts.py`
   - `services/audio/src/generated/__init__.py`
   - benchmark publication schema copies once generator ownership is added.
5. Make failure identify the stale path(s), not only “contracts were stale.” Hash-before/after is acceptable; do not rely on global `git diff` because callers may have legitimate unrelated edits.
6. Keep host test after parallel jobs because it rebuilds contracts/web and is the highest-resource TS task.
7. Measure and record runtime once; do not optimize by silently removing suites.

## Invariants

- Gate remains model-free and network-free after dependencies are installed.
- No test runs against generated files before freshness completes.
- A dirty unrelated working file does not make freshness fail.
- Any command failure produces non-zero status even when parallel siblings pass.

## Acceptance criteria

- Output shows 201 web tests and 223 audio tests (counts may grow, must not shrink by filtering).
- Mutating each secondary generated output in a temporary copy or controlled test makes freshness fail with its path.
- Restored clean tree passes `pnpm check` and leaves no diff.

## Focused tests / commands

```bash
bash scripts/check.sh
git status --short
git diff --check
```

For a freshness test, do not leave product files modified: copy hashes, append a newline to one generated secondary output, assert check fails at freshness, then restore it exactly before the final run.

## Expected diff shape

Small shell diff, optionally one focused script test. No dependency or lockfile changes.

## Likely pitfalls

- Running full audio tests concurrently with benchmark tests is currently safe in the audit, but avoid real model initialization; tests use fakes.
- `run_parallel` reports only final status; preserve non-zero aggregation and visible command output.
- Using `git diff --exit-code` globally breaks normal development on intentional edits.

## Parallel safety

Parallel-safe with source tasks if it owns only `scripts/check.sh`. Coordinate with ARC-006 only if either changes root package scripts.
