# ARC-007 — Make Pi executable discovery portable

## Rationale

The default Pi path is tied to `/home/soleone`, and the model default is duplicated. Introduce one fail-closed resolver without shell execution or a broad configuration system.

## In scope

- New small host module, e.g. `apps/host/src/pi/config.ts`.
- `apps/host/src/pi/PiClient.ts` and `PiResearchClient.ts` constructor defaults as long as research compatibility remains.
- `apps/host/src/server/main.ts` composition if resolution is startup-owned.
- Pi tests for env/PATH/canonical path behavior.

## Out of scope

- Settings-aware readiness caching (ARC-008), Pi installation, version re-pinning, provider portability, API keys, shell `which`, UI changes.

## Prerequisites

- ARC-006 preferred.
- Confirm current supported OS remains Linux; resolver can use portable Node path/file APIs.

## Step-by-step changes

1. Import `DEFAULT_PI_MODEL` from `@app/contracts`; remove duplicate model literal as canonical default. Preserve exported `PI_MODEL` alias only if tests/consumers require it, otherwise update references.
2. Implement deterministic executable resolution:
   - if `PODCASTER_PI_EXECUTABLE` is set, require an absolute path, real file, executable, and canonical path;
   - otherwise scan `PATH` entries for `pi` with Node filesystem APIs (no shell), choose first executable, resolve canonical path;
   - on absence, return/throw a sanitized configuration error mapped to unavailable readiness.
3. Resolve once at the host/client composition boundary, not on every delta/request.
4. Keep `StdioPiClient`’s final pre-spawn checks (defense-in-depth) but avoid contradictory duplicate rules.
5. Ensure safe environment handling remains unchanged and no credential/token variables are added.
6. Add tests using temporary executable files and controlled env/PATH; cover explicit path, PATH discovery, noncanonical/relative/absent failure.

## Invariants

- `spawn` remains `shell:false` with canonical executable.
- No API key/provider fallback path.
- Error messages do not expose env contents or credentials.
- Explicit executable option in tests still overrides resolver as currently intended.

## Acceptance criteria

- No `/home/soleone` path remains in production source.
- Default model literal has one canonical owner in contracts.
- Fresh host without Pi starts far enough to report actionable unavailable readiness rather than crashing for path resolution, unless existing startup contract intentionally requires fail-fast and tests document it.
- Pi client/cancellation/security tests pass.

## Focused tests / commands

```bash
corepack pnpm --filter @app/host typecheck
corepack pnpm test --filter @app/host -- pi-client.test.ts pi-research-client.test.ts cancellation-races.test.ts host-security.test.ts
corepack pnpm test --filter @app/host
rg -n '/home/soleone|openai-codex/gpt-5.6-sol' apps/host/src packages/contracts/src/settings/pi.ts
```

The final `rg` should show the model only in the canonical settings owner/comments and no home path.

## Expected diff shape

One small config module, constructor/composition edits, focused tests. No dependencies/lockfile.

## Likely pitfalls

- Calling external `which` reintroduces shell/PATH ambiguity.
- Resolving symlinks after checking equality can reject common package-manager shims; define and test the intended canonical final path.
- Do not make Pi absence prevent transcript-only/audio readiness unless existing product contract explicitly requires it.

## Parallel safety

Not safe with ARC-008. Safe with contract/web/storage/Python tasks.
