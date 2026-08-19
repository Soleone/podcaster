# ARC-008 — Probe the selected Pi settings

## Rationale

Readiness probes one fixed global Pi client, while sessions create clients from user-selected model/thinking settings. Make readiness truthful and give probe children explicit ownership.

## In scope

- `apps/web/src/App.tsx`: readiness request body only (until ARC-013).
- `apps/web/src/services/service-status.ts` types/tests if request/response needs model identity.
- `apps/host/src/server/app.ts`: readiness body validation, probe cache/ownership, app close.
- `apps/host/src/server/main.ts`: remove fixed probe client ownership if replaced.
- Pi readiness helper/module and focused host/web tests.

## Out of scope

- UI layout/copy redesign, provider portability, session response semantics, Pi executable discovery (ARC-007), general cache framework.

## Prerequisites

- ARC-007.
- ARC-001/002 should land first to avoid host composition conflicts.

## Step-by-step changes

1. Browser sends the current validated `settingsModelRef.current.pi` alongside TTS selection in `/api/readiness`.
2. Host validates the Pi settings with shared contracts; invalid input gets a bounded 4xx response, not fallback to a different model.
3. Replace `BuildOptions.pi` fixed-client coupling with a narrow settings-keyed probe owner/factory. One host-owned object may retain only the current `(model,thinkingLevel)` client/result/in-flight probe.
4. On key change, safely shut down the prior probe child before/while replacing it; serialize swaps to prevent leaked children.
5. Keep existing probe TTL, shared in-flight request, and two-confirmation downgrade behavior **per key**. A ready result from one key must never carry to another.
6. Close the current probe client on Fastify close. Main no longer separately owns/shuts a redundant fixed client.
7. Return probed model/thinking identity in readiness only if useful to assert/display truth; use a typed field and do not expose executable/auth paths.
8. Add tests with two fake settings tuples and clients: verify factory inputs, cache isolation, downgrade reset, and exactly-once shutdown.

## Invariants

- Readiness never silently probes a different model than the next new session.
- No prompt/persona text is involved in readiness.
- Probe remains asynchronous to browser polling and does not create a child every four seconds.
- Session-owned response/classifier clients remain isolated from host-scoped probe client.

## Acceptance criteria

- Browser request includes selected Pi settings.
- Host test proves model A ready cannot make model B appear ready.
- Switching settings retires A; app close retires B.
- Existing transient readiness stability tests remain green.

## Focused tests / commands

```bash
corepack pnpm --filter @app/host typecheck
corepack pnpm --filter @app/web typecheck
corepack pnpm test --filter @app/host -- voice-preview-route.test.ts session-isolation.test.ts pi-client.test.ts
corepack pnpm --filter @app/web test -- service-status.test.ts settings-model.test.ts
corepack pnpm test:e2e -- apps/web/e2e/auto-readiness.spec.ts apps/web/e2e/settings.spec.ts
```

## Expected diff shape

Medium host readiness ownership change, one browser request field, focused fakes/tests. No schema generation unless the readiness HTTP response is deliberately added to contracts (do not expand task casually).

## Likely pitfalls

- Reusing `probeValue`/downgrade count across keys preserves the bug.
- Creating/shutting a probe child per poll is slow and can race provider auth.
- Passing session persona into readiness leaks scope and makes cache keys unstable.
- Main/app double shutdown must be removed cleanly.

## Parallel safety

Not parallel-safe with ARC-001/002/007/013. Safe with contracts/package/Python tasks once App request lines are reserved.
