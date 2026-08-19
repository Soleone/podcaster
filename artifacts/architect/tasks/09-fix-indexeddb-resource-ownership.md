# ARC-009 — Fix IndexedDB resource ownership

## Rationale

The web app can race two custom-voice store opens, SettingsStore cannot close, and database connections do not close on `versionchange`. Fix concrete lifecycle defects without introducing a repository framework or schema migration.

## In scope

- `apps/web/src/storage/schema.ts` and schema tests.
- `apps/web/src/settings/settings-store.ts` and tests.
- `apps/web/src/App.tsx` settings/custom-store initialization and unmount cleanup only.
- `CustomVoiceStore`/`StableTurnWriter` close semantics only if consistency requires tiny changes.

## Out of scope

- DB version bump, data shape migration, merging all stores into one class, App runtime extraction, settings UI behavior, custom-voice product disposition.

## Prerequisites

- Clean fake-indexeddb tests.
- Reserve `App.tsx` ownership; do not overlap ARC-013/008.

## Step-by-step changes

1. In `openPodcasterDatabase`, set `db.onversionchange = () => db.close()` before resolving the connection. Keep `onblocked` fail-closed behavior.
2. Add idempotent `close()` to `SettingsStore` matching other store wrappers.
3. Merge App’s settings/custom-voice mount work into one initialization effect/promise so `CustomVoiceStore.open()` cannot run concurrently in two effects.
4. Preserve the existing settings-ready barrier used by active-session recovery.
5. On cancellation/unmount, close every handle opened by that effect; do not close a handle now owned by a newer effect generation.
6. Ensure the long-lived `StableTurnWriter` is closed on actual App unmount, while not closing it during normal route changes.
7. Add focused tests:
   - opened DB closes on versionchange and a higher-version open is not blocked;
   - SettingsStore close is safe/idempotent;
   - App/resource helper (extract a tiny helper only if needed) opens custom store once under StrictMode-like setup/cleanup.

## Invariants

- `PODCASTER_DB_VERSION` and object stores unchanged.
- Existing data and migration tests remain byte/shape compatible.
- Settings failure still falls back to in-memory defaults.
- Custom voice list loads once and remains available to existing UI.

## Acceptance criteria

- One App effect owns settings/custom store handles.
- All store wrappers opened long-term have a close path.
- Versionchange test proves no self-blocked upgrade.
- Web units and settings/custom voice E2E pass.

## Focused tests / commands

```bash
corepack pnpm --filter @app/web typecheck
corepack pnpm --filter @app/web test -- schema.test.ts settings-store.test.ts custom-voice-store.test.ts
corepack pnpm --filter @app/web test
corepack pnpm test:e2e -- apps/web/e2e/settings.spec.ts apps/web/e2e/settings-backend.spec.ts apps/web/e2e/routes.spec.ts
```

## Expected diff shape

Small/medium lifecycle diff in schema/store/App effects and focused tests. No generated files, DB version, or lockfile changes.

## Likely pitfalls

- Both existing effects use `ref.current ?? await open`; checking before await does not prevent a race.
- StrictMode cleanup can close a handle assigned by a later effect unless generation/identity is checked.
- `onblocked` alone does not release old connections; `versionchange` does.
- Do not turn store methods into a broad dependency-injection rewrite.

## Parallel safety

Not safe with ARC-008 or ARC-013 due App overlap. Parallel-safe with host contracts/package/Python tasks.
