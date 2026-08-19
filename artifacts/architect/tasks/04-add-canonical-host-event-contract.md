# ARC-004 — Add a canonical host-event contract

## Rationale

`CoreEvent` permits arbitrary payload objects and VAD host events lack dedicated schemas. Add an explicit host→browser union before changing consumers. This task is additive contract work only.

## In scope

- New `packages/contracts/schema/events/host-event.json`.
- New VAD host event schemas under `packages/contracts/schema/events/` (one file per event or one well-named union).
- `packages/contracts/fixtures/valid|invalid/` focused HostEvent/VAD fixtures.
- `packages/contracts/scripts/generate.mjs` only if oneOf/ref generation needs a bounded fix.
- Generated TS/Python outputs and contract tests.

## Out of scope

- Host/web consumer typing, browser validator edits, protocol version bump, removal/repurposing of `CoreEvent`, or multipart field removal.

## Prerequisites

- Clean generated tree; ARC-003 is preferred.
- Inventory all host-emitted event names from `SessionOrchestrator.emit`, `BrowserSession.event`, and local protocol docs.

## Step-by-step changes

1. Add strict schemas for host `vad.speech_start` and `vad.speech_end`, matching current browser checks and sidecar payload semantics. Host stream ID accepts current UUIDv4 sidecar IDs; utterance/event/session IDs keep their existing UUID constraints.
2. Add `HostEvent` as `oneOf` references to every host→browser specialized event schema:
   - session state; VAD; transcript partial/final; policy decision;
   - barge-in and interruption decision;
   - reasoning started/delta/final; response part started/final; response failed;
   - TTS started/ended; failure.
3. Do not include browser commands (`audio.start`, playback receipts, etc.) or sidecar-only messages.
4. Ensure generated TS `HostEvent` is a discriminated union rather than `{payload:Record}`. If generator changes are required, keep them generic only to correct `$ref`/`oneOf`; add generator tests.
5. Add valid and invalid fixtures, including the executed regression: `type:'failure'` with only `{detail}` must fail HostEvent.
6. Extend contract tests so every valid host fixture passes its specialized validator and HostEvent, and invalid fixtures fail both where applicable.
7. Generate TS/Python outputs and commit all generated changes.

## Invariants

- Protocol version remains 1 and existing valid fixtures stay valid.
- `CoreEvent` behavior is not silently changed; adoption happens in ARC-005.
- No Ajv/browser bundle change.
- Multipart optional fields remain for compatibility.

## Acceptance criteria

- Generated TS exports a useful `HostEvent` discriminated union.
- Generated Python exports/validates HostEvent.
- Invalid specialized payloads cannot pass HostEvent.
- VAD events have canonical schemas and fixture coverage.
- Generators are deterministic and leave a clean second run.

## Focused tests / commands

```bash
corepack pnpm contracts:generate
uv run python scripts/generate_contracts.py
corepack pnpm --filter @app/contracts typecheck
corepack pnpm test --filter @app/contracts
uv run pytest services/audio/tests/test_contracts.py
corepack pnpm contracts:generate
uv run python scripts/generate_contracts.py
git diff --exit-code -- packages/contracts/src/generated packages/contracts/test/types-required.generated.compile.ts services/audio/src/generated
```

## Expected diff shape

Additive schema/fixture files plus deterministic generated TS/Python changes and focused contract tests. No app/service runtime edits.

## Likely pitfalls

- Referencing `sidecar-message.json` VAD variants would couple host envelopes to sidecar message envelopes; create dedicated host event schemas.
- A `oneOf` containing overlapping broad schemas can reject valid events or remain non-discriminated; all branches need distinct `type` constraints.
- Do not add all `CoreEvent` enum names blindly; many are commands, not host output.

## Parallel safety

Parallel-safe with non-contract tasks. Exclusive ownership of contracts schemas/generator/generated files; ARC-005 must wait.
