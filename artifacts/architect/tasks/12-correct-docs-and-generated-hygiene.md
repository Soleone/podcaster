# ARC-012 — Correct repository truth and generated hygiene

## Rationale

README/build docs contradict current code, ADR numbers collide, a fixture stores one developer’s absolute path, Playwright output is tracked, and publication/generated ownership is incomplete. Correct current truth without rewriting historical evidence.

## In scope

- `README.md`, `docs/build-performance.md`.
- ADR file names/headings/links for duplicate 007 and current statuses.
- `packages/contracts/src/settings/custom-voice.ts` ADR link comment.
- `.gitignore`, tracked `test-results/.last-run.json` removal.
- `scripts/fixtures/build-multiturn-audio.py`, its JSON metadata, and a focused metadata/hash check if added.
- Contract generator/check script only for generator-owned benchmark schema publication copies, coordinated with ARC-003/004.

## Out of scope

- Changing accepted decision conclusions, deleting evidence/spikes/raw audio, making performance promises, product UI/copy, source architecture changes.

## Prerequisites

- ARC-001 and ARC-003 outcomes known.
- ARC-006 if documented build commands change.
- Re-run current build and test counts rather than copying audit numbers blindly.

## Step-by-step changes

1. Rewrite README title/current capability summary and setup prerequisites. State Linux/Node/Python/uv/pnpm, local speech model requirements, optional Qwen runtime, Pi executable/config/auth boundary, HMR vs build-first commands, and current validation commands. Remove Milestone 0 claims that microphone/Pi/history are absent.
2. Update `docs/build-performance.md` to label old numbers historical or replace with a dated current measurement. Correct `pnpm dev` to `dev-hmr.mjs`; record observed chunk warning honestly. Do not raise warning limit.
3. Preserve 2026-08-10 multipart as Decision 007. `git mv` later 2026-08-16 TTS selection to 008 and consent/enrollment to 009; update headings/current comments/links. Do not alter decision bodies except status notes needed to say multipart is default-off per PM.
4. Ignore `test-results/` and `playwright-report/`; remove tracked `.last-run.json`. Run E2E and prove git remains clean.
5. Change multi-turn fixture generator metadata sources to repository-relative paths or stable source IDs. Add raw SHA-256/byte length to metadata; update committed JSON without regenerating audio unless source bytes are available and output hash is proven unchanged.
6. Make contracts schemas the owner of benchmark publication schemas: generator copies exact bytes to `benchmarks/results/schema`; freshness gate covers copies. Preserve byte identity.
7. Link current docs rather than duplicating detailed benchmark instructions already in `docs/benchmarking.md`.

## Invariants

- Historical evidence/accepted measurements remain intact and clearly dated.
- No model/audio download required for normal docs validation.
- Raw fixture bytes remain unchanged unless explicitly verified.
- README makes no fully-local/privacy claim.

## Acceptance criteria

- README matches actual scripts/runtime.
- Unique ADR numbers and valid internal links.
- No `/home/soleone` in tracked operational fixture metadata/docs (historical evidence paths may be retained only if clearly quoted as history; prefer removal where nonessential).
- Playwright leaves clean git status.
- Benchmark schema copies regenerate deterministically and remain byte-identical.

## Focused tests / commands

```bash
corepack pnpm build
bash scripts/check.sh
corepack pnpm test:e2e
git status --short
rg -n '/home/soleone|Milestone 0 readiness skeleton|scripts/dev\.mjs' README.md docs scripts/fixtures
diff -q packages/contracts/schema/benchmarks/event.json benchmarks/results/schema/event.json
# repeat for all five benchmark schemas or use the existing test
uv run pytest benchmarks/harness/tests/test_harness.py -k tracked_result_schemas
```

## Expected diff shape

Documentation/rename/delete-heavy; one fixture JSON/script edit; `.gitignore`; generator publication copies. No product behavior or lockfile changes.

## Likely pitfalls

- Renumbering without updating `custom-voice.ts` and links leaves another contradiction.
- Current build performance is a sample, not a permanent gate.
- `git mv` preserves ADR history; copying/deleting does not.
- Do not regenerate the raw fixture from different decoder/library bytes without hash review.

## Parallel safety

Parallel-safe after behavior/build tasks settle; sole ownership of README/docs/gitignore/generator publication paths.
