# ARC-013 — Extract the live web-session runtime

## Rationale

`App.tsx` owns routes/settings plus transport, controller, capture, recording, reconnect, and teardown through dozens of refs. Extract one concrete runtime owner after scope, protocol, Pi, storage, and dead-code seams settle. This is a move-first refactor, not a new state framework.

## In scope

- New `apps/web/src/session/live-runtime.ts` and focused unit test.
- Optional fake-only `live-runtime.fake.ts` for E2E instrumentation.
- `apps/web/src/App.tsx`: replace live resource refs/composition/teardown with runtime calls/subscription.
- Existing `SessionController`, transports, capture/playback, recorder/store only for narrow constructor interfaces needed by the owner; internal behavior unchanged.

## Out of scope

- Reducer rewrite, Redux/XState/context framework, route/settings UI redesign, storage schema change, recording algorithm change, multipart/custom voice deletion, generalized dependency container.

## Prerequisites

- ARC-001, ARC-002, ARC-005, ARC-008, ARC-009, ARC-011.
- All web unit/E2E tests green and current bundle measurement recorded.
- Sole ownership of `App.tsx` for the task.

## Required interface

```ts
interface LiveSessionRuntime {
  readonly sessionId: string;
  snapshot(): SessionViewState;
  cancelAssistant(): Promise<void>;
  pause(): Promise<boolean>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

interface LiveSessionRuntimeCallbacks {
  onView(state: SessionViewState): void;
  onTransportFailure(message: string): void;
  onRecordingChanged(): void;
}
```

A factory input may include session ID/seed/settings/capability/writer, real-or-fake dependencies, initial state, and callbacks. Do not expose internal refs.

## Step-by-step changes

1. Add unit tests around a fake transport/capture/recording store that specify start order, reconnect capture replacement, pause barrier, stop order, failed-start rollback, and idempotent dispose.
2. Move real composition from `App.tsx:271-377` into the runtime factory with the same order:
   - open recording store/recorder;
   - connect transport;
   - create controller/playback callbacks;
   - subscribe recording/controller/failure/reconnect;
   - send session/audio start;
   - start capture.
3. Move fake composition/instrumentation to a fake-only factory implementing the same runtime interface. Preserve `window.__podcasterTest` behavior without coupling production runtime to test stats.
4. Move teardown/reconnect ownership from App: capture generation, stream ID, subscriptions, controller, transport, recorder/store all become private runtime fields.
5. Runtime `pause()` delegates the durable controller barrier, then releases transport/capture/recording exactly once. Runtime `stop()` preserves terminal/storage ordering; App continues to own `/api/stop`, route state, and session row decisions only if those are outside runtime boundary.
6. Replace App refs with one `runtimeRef` plus state callbacks. App still owns writer, settings, capability acquisition, routes, elapsed display, catalog/custom voice/settings resources.
7. Keep start/resume failure rollback behavior and activity logging text semantically equivalent.
8. Dynamically import runtime on session start/active-session recovery if practical without complicating behavior. Re-measure; do not add manual chunk config.
9. Delete moved App code only after tests pass; do not leave forwarding duplicate functions.

## Invariants

- Exactly one live transport, capture, controller, recorder, and recording store per live session.
- Capture stops before transport release on failure/stop; pause persistence barrier remains authoritative.
- Reconnect never reuses capture sequence/stream ID.
- Frozen settings/session identity unchanged.
- Existing fake test API and all user behavior unchanged.

## Acceptance criteria

- App no longer directly owns transport/controller/capture/recorder/subscription refs.
- Runtime has focused unit coverage for lifecycle/rollback/idempotence.
- Full web/host E2E green.
- `App.tsx` responsibility is routes/settings/capability and is materially smaller.
- Main bundle measured; warning not suppressed. Expected direction is smaller eager entry.

## Focused tests / commands

```bash
corepack pnpm --filter @app/web typecheck
corepack pnpm --filter @app/web test -- live-runtime.test.ts controller.test.ts
corepack pnpm --filter @app/web test
corepack pnpm test --filter @app/host
corepack pnpm test:e2e
corepack pnpm --filter @app/web build
```

## Expected diff shape

Large move-heavy but behavior-neutral: new runtime/test files, substantial deletions from App, small constructor/interface edits. Net LOC should not increase materially. No dependencies, generated files, schemas, or DB migration.

## Likely pitfalls

- A hook is not the right owner for imperative processes if it recreates on renders; use a plain runtime object/factory and thin React subscription.
- Do not close App-owned writer/settings/custom store from the live runtime.
- Stop and pause have different durable semantics; do not merge into a single boolean cleanup method.
- Keep fake runtime behind the same interface rather than conditionals throughout production runtime.

## Parallel safety

Not parallel-safe. Sole owner of `App.tsx` and live session composition; execute after prerequisites.
