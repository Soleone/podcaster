# ARC-006 — Fix workspace package exports and build order

## Rationale

Contracts/policy package exports mix source and dist. A direct Node import of `@app/contracts/settings` fails after a successful build. Standardize runtime exports and make every documented clean build establish its prerequisites.

## In scope

- `packages/contracts/package.json`, `packages/policy/package.json`.
- Root/app package build/test scripts needed for clean order: `package.json`, `apps/web/package.json`, `apps/host/package.json`.
- `packages/contracts/tsconfig.build.json`, `packages/policy/tsconfig.json` only if dist layout/declarations require a small correction.
- `scripts/dev.mjs`, `scripts/dev-hmr.mjs`, `scripts/build-web-fake.mjs` only where they invoke builds without dependencies.
- A Node import smoke script/test if useful.

## Out of scope

- New monorepo tool, bundling packages, publishing to npm, changing package names, TypeScript upgrade, source reformat.

## Prerequisites

- Record current build/test commands.
- Use ignored dist deletion only as a validation step, never delete tracked source.

## Step-by-step changes

1. Point all runtime `import` export targets in contracts/policy to built `.js` under `dist`, including subpaths.
2. Point `types` to emitted `.d.ts` if clean typechecks/build order guarantee they exist; otherwise keep source type targets while runtime imports use dist. The final combination must work in Node and Vite.
3. Ensure policy build emits a usable `dist/index.js` and its export uses it.
4. Define one non-recursive package build per workspace. Arrange root/dev/fake/host-test commands to build dependencies before consumers without nested duplicate recursion.
5. Ensure web unit tests and Vite build can run from a clean checkout after the documented prerequisite command; if a package-local script is documented as standalone, it must establish contracts first.
6. Add a smoke check importing:
   - `@app/contracts`
   - `@app/contracts/binary`
   - `@app/contracts/settings`
   - `@app/contracts/validators`
   - `@app/policy`
   from a Node context after clean build.
7. Validate that production host runtime still resolves contracts/policy without Node relying on TypeScript stripping.

## Invariants

- No source package runtime export points to `.ts`.
- No build script calls itself transitively.
- Web Vite still resolves browser-safe settings/binary code; Node-only persona parser does not enter web.
- Lockfile/dependencies unchanged.

## Acceptance criteria

- With all ignored dist directories removed, root build succeeds once.
- Every export smoke import succeeds under Node 22.
- All typechecks and unit tests pass from the same clean-dist state.
- `pnpm dev` and fake web build use correct dependency order.

## Focused tests / commands

```bash
rm -rf apps/web/dist apps/host/dist packages/contracts/dist packages/policy/dist
corepack pnpm build
cd apps/host
node --input-type=module -e "await import('@app/contracts'); await import('@app/contracts/binary'); await import('@app/contracts/settings'); await import('@app/contracts/validators'); await import('@app/policy'); console.log('workspace imports ok')"
cd ../..
corepack pnpm --recursive --if-present test
corepack pnpm test:dev-cleanup
```

`rm -rf` above is limited to ignored build outputs; verify paths before running.

## Expected diff shape

Small/medium package-script/export diff, possibly a tiny smoke script. No source behavior or generated contract changes.

## Likely pitfalls

- Root build currently builds web before host-triggered contract build; changing exports without order breaks clean Vite builds.
- Keeping policy source export because Node 22 happened to load it leaves its build meaningless.
- Setting all type targets to dist can make editor/typecheck fail before build unless commands are explicit.

## Parallel safety

Parallel-safe with app/service tasks; coordinate with ARC-003 if both alter root/package scripts.
