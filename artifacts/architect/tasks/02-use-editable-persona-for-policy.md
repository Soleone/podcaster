# ARC-002 — Make the editable persona drive policy

## Rationale

The frozen `SessionSettingsSnapshot.persona` currently affects only the Pi prompt. Posture policy silently parses a separate built-in persona. `parsePersona` already supports plain text with safe default policy fields, so the smallest correction is to pass the same validated frozen source to the orchestrator.

## In scope

- `apps/host/src/server/BrowserSession.ts`: session start and orchestrator options.
- `apps/host/src/session/SessionOrchestrator.ts`: persona option/error wording only if needed.
- `apps/host/test/integration/browser-conversation.test.ts` and/or `session-isolation.test.ts`: one wire-level behavior test.
- `apps/host/test/session/session-orchestrator.test.ts`: focused parser/policy input assertion if required.

## Out of scope

- Settings UI redesign, schema changes, autonomous persona edits, deleting parser fixtures/defaults, or changing policy selection math.
- Rewriting persona format; plain text remains valid and optional front matter remains the existing parser contract.

## Prerequisites

- ARC-001 preferred so tests exercise the single-response default.
- Baseline: `corepack pnpm test --filter @app/host -- session-orchestrator.test.ts`.

## Step-by-step changes

1. In validated `BrowserSession.start`, pass `settings.persona` as `personaSource` when constructing `SessionOrchestrator`.
2. Keep `composePersonaAppend(settings.persona)` unchanged so Pi and policy share the exact frozen source.
3. Update `PersonaValidationError` wording from “default persona” to “session persona” if the current message remains misleading.
4. Add a test with a persona containing existing supported front matter, e.g. `invitation_only: true`, and an ordinary non-invitation transcript. Prove the host emits `policy.decision` with `silence/invitation_required` and does not call the response Pi.
5. Add/retain a plain-text persona test showing no front matter is accepted and receives supported default weights. Do not assert random posture; capture the policy input or assert it reaches a non-validation result.
6. Confirm session isolation: two sessions with different persona sources do not share interpretation/digest.

## Invariants

- Session settings remain frozen for the session lifetime.
- Existing plain text personas remain valid.
- Persona text is never logged.
- `composePersonaAppend` security guard remains intact.
- Policy algorithm and supported parser defaults do not change.

## Acceptance criteria

- Production BrowserSession has one persona source for policy and Pi.
- Structured user front matter changes posture eligibility in an integration test.
- Plain text retains current supported defaults.
- Invalid persona source fails before Pi/audio response work with sanitized protocol behavior.

## Focused tests / commands

```bash
corepack pnpm --filter @app/host typecheck
corepack pnpm test --filter @app/contracts -- persona.test.ts
corepack pnpm test --filter @app/policy
corepack pnpm test --filter @app/host -- session-orchestrator.test.ts browser-conversation.test.ts session-isolation.test.ts
corepack pnpm test --filter @app/host
```

## Expected diff shape

Small: one option passed at composition, one error string, focused tests. No generated contracts or UI changes.

## Likely pitfalls

- Passing the composed prompt append into `parsePersona` would parse wrapper/security text; pass raw `settings.persona`.
- Deleting `DEFAULT_PERSONA_MARKDOWN` in this task may break golden parser tests and is unnecessary.
- Testing only `SessionOrchestrator` misses the current bug, which is BrowserSession composition.

## Parallel safety

Not safe with ARC-001/008 due to shared BrowserSession/app integration tests. Safe with contract/package/Python tasks.
