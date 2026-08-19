# ARC-011 — Remove verified dead compatibility clutter

## Rationale

Repository search and exploratory no-unused checks identified concrete dead producers/branches/helpers/components. Delete them in one behavior-neutral cleanup after protocol typing settles; do not use this task for general refactoring.

## In scope

Only the high-confidence “Delete” rows in `artifacts/architect/cleanup-ledger.md`, excluding tracked test results/docs (ARC-012). Expected files include:

- Web conversation/state/service/settings/transport files and their focused tests.
- Four unused UI primitive files.
- Host `process.ts`, `app.ts`, `SessionOrchestrator.ts` dead exports/options/imports.
- Python base/STT dead exceptions/stubs and focused tests/imports if any.

## Out of scope

- Multipart producer/reader deletion, research client deletion, custom voice deletion, App extraction, formatting changes, dependency removal unless a deleted UI file is the sole package consumer (current inventory says it is not).

## Prerequisites

- ARC-004/005 preferred so event typing has already used or rejected candidate symbols.
- Run repository-wide `rg` immediately before each deletion.

## Step-by-step changes

1. Delete continuation `ConversationItem` variant, render branch, and test-only marker fixture. Preserve UX requirement of zero markers and interruption persistence.
2. Delete `capture.endpoint` reducer branch.
3. Delete unused service-state transition table/function and only tests that exclusively test them; retain labels/aggregation used by UI.
4. Delete unused settings aliases/helpers and `currentBinding`.
5. Delete four zero-import UI primitive files.
6. Delete host `sidecarHealth`, unused `BuildOptions.researchPi`, `validReasoning`, and unused imports. Update tests that pass the ignored `researchPi` option while retaining `createResearchClient` for explicit multipart compatibility.
7. Delete unused Python cancellation exception classes and STT-only `synthesize` methods; do not change benchmark-specific protocols/runners.
8. Run no-unused checks for host/web source. Fix only newly confirmed unused production imports/parameters; do not clean every test in unrelated files unless needed to enable a source-only guardrail.
9. Inspect dependency manifest; remove no package unless `pnpm why`/search proves zero remaining use.

## Invariants

- No event/state behavior changes.
- Explicit multipart compatibility still passes.
- Service status UI output unchanged.
- No source formatting outside touched lines.

## Acceptance criteria

- Every deleted symbol/file has zero repository consumers before deletion.
- Full typecheck/tests/build pass.
- Web conversation tests still assert no continuation markers.
- Source-only no-unused scan no longer reports named production entries.

## Focused tests / commands

```bash
rg -n "continuation|capture\.endpoint|canTransitionServiceState|reconcileTtsSettings|speedCapabilityForCatalog|sidecarHealth|validReasoning|currentBinding|SttCancelled|TtsCancelled" apps packages services benchmarks
corepack pnpm --filter @app/host typecheck
corepack pnpm --filter @app/web typecheck
corepack pnpm test --filter @app/host
corepack pnpm --filter @app/web test
uv run pytest services/audio/tests benchmarks/harness/tests
corepack pnpm build
```

## Expected diff shape

Deletion-heavy, small net-negative diff across named files/tests; four files removed; no generated or lockfile changes.

## Likely pitfalls

- Text “continuation” is also a valid storage concept; delete only UI marker variant, not `continuationState` persistence.
- `BuildOptions.researchPi` is dead, but `createResearchClient` is still used by explicit compatibility tests.
- Generated compile assertion aliases are intentionally unused; do not modify generator in this task.

## Parallel safety

Not safe with ARC-005 or ARC-013. Can run after them as a dedicated cleanup commit.
