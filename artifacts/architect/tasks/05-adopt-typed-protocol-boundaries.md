# ARC-005 — Adopt typed protocol boundaries

## Rationale

After HostEvent exists, replace generic host/web wire event bases with generated unions. Keep persistence’s locally generated playback receipts explicit rather than pretending every local event is host output.

## In scope

- `apps/host/src/session/SessionOrchestrator.ts`: event type/helper typing.
- `apps/host/src/server/BrowserSession.ts`: host event creation and typed BrowserCommand switch.
- `apps/web/src/session/transport.ts`, `websocket-transport.ts`, `controller.ts`, `state.ts`, `fake-transport.ts`, `envelope.ts` as needed.
- `apps/web/src/storage/stable-turn-writer.ts`: event union type only; persistence logic behavior unchanged.
- Focused host/web/contract tests.

## Out of scope

- Schema changes beyond defects exposed by adoption; App runtime extraction; removing multipart/custom fields; changing reducer/storage behavior; bundling Ajv in web.

## Prerequisites

- ARC-004 merged and generated HostEvent available.
- ARC-001 merged preferred.
- Contract files frozen during this task.

## Step-by-step changes

1. Define clear aliases from generated contracts:
   - host/web transport inbound: `HostEvent`;
   - browser host commands: `BrowserCommand`;
   - storage input: `HostEvent | PlaybackProgressEvent | PlaybackPausedEvent | PlaybackStoppedEvent` (include another local schema only if current persistence actually writes it).
2. Type `SessionOrchestrator.emit` generically by event `type` and `Extract<HostEvent,{type:T}>['payload']`; fix call sites rather than casting payloads.
3. Type `BrowserSession.event/send` as HostEvent. Retain UUID/time generation behavior.
4. After `CONTRACT_VALIDATORS.BrowserCommand`, cast once to generated `BrowserCommand` and switch on the discriminant. Remove `as never` payload calls by giving orchestrator/AudioClient methods exact generated payload-derived types or local named interfaces.
5. Export the browser runtime validator as `isStrictHostEvent(value): value is HostEvent`. Keep its fail-closed state/identity checks separate from schema shape validation.
6. Add parity tests that run all canonical valid/invalid host fixtures through both canonical validator and browser validator. Browser validator may be stricter for sequence/state only after an event is admitted; shape parity must match.
7. Change `SessionTransport.onEvent` and fake transport to HostEvent.
8. Replace `StableEvent` generic interface with the explicit persisted union/type alias. Ensure `createEnvelope` can construct browser playback command events without becoming an unconstrained public generic.
9. Make `SessionController.degrade` construct a schema-valid FailureEvent (`code`, `detail`, `correctiveAction`, `recoverable`) before reducing/persisting.
10. Delete casts/defensive `typeof` checks only where discriminated types prove them redundant; do not churn all reducer code if checks are useful for local resilience.

## Invariants

- Wire bytes and protocol version unchanged.
- Browser continues to reject wrong session/epoch/identity/sequence even when schema-valid.
- Storage idempotency/accounting semantics unchanged.
- Local failure persistence stores a stable code, not `unknown_failure` due missing payload.
- No Ajv dependency enters web bundle.

## Acceptance criteria

- No generic `type:string; payload:Record<string,unknown>` is used for host↔browser events.
- `as never` command dispatch casts are removed.
- Canonical/browser fixture parity tests pass.
- Invalid host payload still closes browser transport with the existing application code.
- Host/web typechecks and all unit/E2E tests pass.

## Focused tests / commands

```bash
corepack pnpm --filter @app/contracts typecheck
corepack pnpm --filter @app/host typecheck
corepack pnpm --filter @app/web typecheck
corepack pnpm test --filter @app/contracts
corepack pnpm test --filter @app/host -- browser-conversation.test.ts host-security.test.ts
corepack pnpm --filter @app/web test -- websocket-transport.test.ts controller.test.ts state.test.ts stable-turn-writer.test.ts
corepack pnpm test:e2e
```

## Expected diff shape

Medium type-focused diff across named host/web protocol files and tests; little/no runtime control-flow change; no lockfile.

## Likely pitfalls

- HostEvent does not include browser-generated playback commands; do not force them in.
- Ajv’s `ValidateFunction` is not automatically a typed guard; one controlled cast after successful validation is acceptable.
- Some `BargeInEvent` branches share a payload schema; generated narrowing may be coarser. Add local extracts only where needed, not a second event hierarchy.
- Removing runtime identity checks because types compile would weaken an untrusted boundary.

## Parallel safety

Not parallel-safe with ARC-011 or ARC-013. Own the listed protocol files exclusively.
