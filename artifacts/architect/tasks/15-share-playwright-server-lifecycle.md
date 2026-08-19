# ARC-015 — Share the Playwright server lifecycle

## Rationale

Ten spec files independently build/start/stop a server; 24 passing tests take 2.1 minutes with one worker. Share a fake-services server while keeping the one real-readiness suite isolated and preserving browser-context storage isolation.

## In scope

- `playwright.config.ts` projects/global setup/webServer configuration.
- `apps/web/e2e/support/dev-server.ts`.
- E2E spec `beforeAll/afterAll` boilerplate and origin lookup.
- A cleanup/failure test if needed.

## Out of scope

- Product E2E behavior, parallel workers, browser installation, CI, dev process-group helper extraction, test selector rewrites, fake service implementation changes.

## Prerequisites

- ARC-003.
- Baseline `pnpm test:e2e`: 24 passed, ~2.1m.
- Understand that `readiness.spec.ts` uses the real build while the other nine files use `fake-services`.

## Step-by-step changes

1. Define two Playwright projects or equivalent fixtures:
   - `fake-services`: all fake spec files, one shared server built in fake mode;
   - `real-readiness`: only `readiness.spec.ts`, separately built/started real mode.
2. Prefer Playwright `webServer`/project configuration when it can supply each project’s baseURL. If two project-specific servers are awkward, use one tested global fixture that starts each mode once and exports origins. Do not retain per-spec process ownership.
3. Update specs to use `baseURL`/fixture origin and remove repeated `DevServer` variables/hooks.
4. Keep one browser context per test (Playwright default), so IndexedDB/localStorage remain isolated even though the HTTP server is shared.
5. Ensure server output/startup failure is surfaced with captured stderr and a bounded timeout.
6. Ensure teardown kills the entire owned process group/descendants. Reuse existing `scripts/dev.mjs` cleanup; do not use broad `pkill`.
7. Run all tests twice and compare counts. Record total runtime/server start count.

## Invariants

- 24 tests and their real/fake mode assignments unchanged.
- No state leaks across tests; each context sees fresh browser storage.
- Workers remain 1 until tests prove parallel-safe.
- Server crash fails affected tests and cleanup leaves no descendant.

## Acceptance criteria

- Fake server starts once for the fake project, not once per file.
- Real readiness remains isolated.
- All 24 tests pass twice.
- Runtime is materially lower or, at minimum, build/start count is reduced without flakiness.
- `git status` stays clean because test results are ignored by ARC-012.

## Focused tests / commands

```bash
time corepack pnpm test:e2e
time corepack pnpm test:e2e
corepack pnpm test:dev-cleanup
git status --short
```

Optionally instrument startup count in the fixture test; remove temporary diagnostics before final diff.

## Expected diff shape

Medium test-tooling refactor: config/support plus removal of identical hooks/imports in ten specs. No product source, dependencies, or selectors changed.

## Likely pitfalls

- A single server cannot serve both real and fake builds from one dist directory concurrently; use sequential projects or distinct output/process lifetimes.
- Shared browser **server** does not imply shared browser **context**; do not set context reuse.
- Playwright project matching must prevent each spec from running twice.
- `reuseExistingServer` can attach to an unrelated process; keep false for deterministic local tests.

## Parallel safety

Parallel-safe with product source tasks if it exclusively owns Playwright/e2e files. Do not overlap ARC-012’s E2E hook cleanup until file ownership is assigned.
