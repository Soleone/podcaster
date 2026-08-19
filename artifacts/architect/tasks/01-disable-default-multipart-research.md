# ARC-001 — Disable default multipart research

## Rationale

The authoritative PM requires concise responses and excludes search, while production composition currently enables the tool-backed multipart path unless explicitly false. This task changes only the default producer behavior; it deliberately retains wire/storage readers and research code for rollback/compatibility.

## In scope

- `apps/host/src/server/app.ts`: `BuildOptions.multiPartEnabled`, BrowserSession construction.
- `apps/host/src/server/BrowserSession.ts`: `BrowserSessionOptions.multiPartEnabled`, `SessionOrchestrator` construction.
- `apps/host/test/integration/browser-conversation.test.ts`: add/default-path coverage; reuse existing fakes.
- If needed, one focused assertion in `apps/host/test/session/session-orchestrator.test.ts` proving the single path remains unchanged.

## Out of scope

- Deleting `PiResearchClient`, `ResearchPartAssembler`, multipart schemas, sidecar/web support, tests of explicit opt-in, or persisted part fields.
- Custom voice, recording, UI changes, prompt rewrites, or a new feature flag framework.

## Prerequisites

- Clean git status.
- Baseline: `corepack pnpm test --filter @app/host -- browser-conversation.test.ts`.

## Step-by-step changes

1. Change host composition semantics from inverted default (`!== false`) to explicit opt-in (`=== true`) at the single outer composition boundary.
2. Pass the resulting boolean unchanged through `BrowserSession`; do not re-default it to true in the inner constructor.
3. Keep `SessionOrchestrator`’s explicit `multiPartEnabled` option and research client wiring so existing opt-in tests remain valid.
4. Add an integration test using a fake research client that records `requestBody` calls. Build the app **without** `multiPartEnabled`, submit an eligible stable turn, and assert:
   - research client receives zero calls;
   - no `response.part_started` / `response.part_final` events occur;
   - the normal `reasoning.started/final` and single `tts.started` identity are used.
5. Retain an explicit `multiPartEnabled: true` test proving the existing path is still available for rollback during the compatibility window.

## Invariants

- No protocol/schema/storage shape changes.
- Normal single-response text remains bounded to 45 words and uses the no-tool `PiClient` path.
- Transcript-only and silence decisions remain unchanged.
- Explicit opt-in still exercises current multipart behavior.

## Acceptance criteria

- Default production `main.ts` composition is single-part without adding an option there.
- No double-negative/default-on boolean remains between `buildApp` and `SessionOrchestrator`.
- Focused default and explicit-opt-in integration tests pass.
- Full host and web suites pass.

## Focused tests / commands

```bash
git status --short
corepack pnpm --filter @app/host typecheck
corepack pnpm test --filter @app/host -- browser-conversation.test.ts
corepack pnpm test --filter @app/host
corepack pnpm --filter @app/web test
```

Run `pnpm check` after ARC-003 exists; before then run the commands above plus `uv run pytest services/audio/tests/test_runtime_multipart.py` to confirm compatibility is untouched.

## Expected diff shape

Small: two default/boolean composition edits and one focused integration test. No generated files, lockfiles, Python, or web source changes.

## Likely pitfalls

- Removing the research client factory/object now broadens the task and complicates rollback.
- Updating only `app.ts` while BrowserSession re-defaults undefined to true leaves direct construction wrong.
- A test that passes `multiPartEnabled:false` does not prove the default; omit the property in the default test.

## Parallel safety

Parallel-safe with ARC-003/004/006/009/010. Not safe with ARC-002 or ARC-008 because they touch the same host composition/test surfaces.
