# Target architecture and remediation roadmap

Back to [index.md](index.md). Evidence is in [findings.md](findings.md); deletion/move confidence is in [cleanup-ledger.md](cleanup-ledger.md).

## Target module boundaries

### Canonical ownership

| Concept | Canonical owner | Consumers | Rule |
|---|---|---|---|
| Host/browser/sidecar wire shapes | `packages/contracts/schema/**` + generated artifacts | host, web, audio Python | No generic competing event bases at a trust boundary |
| Binary PCM frame | `packages/contracts/src/binary.ts` + Python framing parity tests | web, host, sidecar | Header/version/limits changed atomically |
| Editable persona source | `SessionSettingsSnapshot.persona` and parser under contracts | web settings, host policy, Pi prompt | One frozen source per session; parser defaults supply omitted policy fields |
| Deterministic posture policy | `packages/policy` | host orchestrator | No UI/provider logic in policy |
| Pi default model/config validation | contracts settings; host config resolver for executable | web settings, host readiness/session clients | Readiness probes selected validated settings |
| Conversation state | host `SessionOrchestrator` | BrowserSession adapter | Default single concise, no-tool response path |
| Browser protocol adaptation | host `BrowserSession`; web `WebSocketSessionTransport` | host/web runtime | Adapters validate/translate; they do not own product policy |
| Browser live resources | web `LiveSessionRuntime` | React App shell | Runtime owns transport/controller/capture/recording and teardown |
| Durable local DB schema/connection lifecycle | web `storage/schema.ts` and one app owner | typed store wrappers | Every handle has clear close/versionchange behavior |
| Selected audio runtime config | `services/audio/config/**` | audio runtime, benchmark commands | Benchmarks consume production selection; production never imports benchmark/docs paths |
| Candidate benchmark logic/results | `benchmarks/**` | researchers/scripts | Historical evidence does not become a production dependency |
| Current setup/commands | `README.md` | humans/agents | ADR/evidence files remain historical, README stays current |

### Dependency rules

1. `packages/contracts` has no application dependency and exposes buildable ESM exports.
2. `packages/policy` depends only on contract types and Node standard library.
3. `apps/web` depends on contracts, never host/service internals.
4. `apps/host` depends on contracts/policy and runtime ports, never web source. Serving `apps/web/dist` is a deployment relationship only.
5. `services/audio` depends on generated Python contracts and service-owned config, never `benchmarks` or `docs` at runtime.
6. `benchmarks` may depend on audio adapters and selected service config.
7. Test support can depend inward on production seams; production never imports test/benchmark support.
8. Optional/non-goal functionality may not be default-on without an authoritative product decision and a named data-retirement/compatibility policy.

## Concrete delete / merge / move / rename plan

### Delete now after verification

- Dead continuation presentation type/render/test-only fixture.
- Dead `capture.endpoint` reducer branch.
- Unused service transition table/function/tests.
- Unused settings aliases/helpers, `sidecarHealth`, `BuildOptions.researchPi`, `validReasoning`, `currentBinding`, unused cancellation exception classes, STT-only `synthesize` stubs.
- Unused UI primitives (`collapsible`, `scroll-area`, `switch`, `tooltip`) only after import search and build.
- Tracked `test-results/.last-run.json`; ignore transient Playwright outputs.

### Merge/consolidate after seam tasks

- `SessionEvent` / `StableEvent` / hand event types → generated `HostEvent` plus narrow persisted-event union.
- Duplicate persona runtime defaults → one editable session persona, with parser defaults.
- Custom/settings bootstrap effects → one resource initialization/cleanup effect.
- App transport/controller/capture/recording refs → `LiveSessionRuntime` owner.
- Benchmark schema publication copies → generator-owned mirror.
- Common model safe-path/manifest/file verification → audio service helper; retain modality checks.
- Later: duplicate Qwen acquirers → one manifest-driven acquisition command.
- Later: duplicate dev process-group mechanics → one tested helper.

### Move without semantic edits

- Selected STT/Kokoro/Qwen runtime configs from `benchmarks/configs/**` to `services/audio/config/**`.
- Runtime model manifest from `docs/model-manifest.json` to `services/audio/config/model-manifest.json` only if all acquisition/verification/docs consumers move atomically. Preserve file content/hashes and use `git mv`.
- Live session composition/teardown code from `App.tsx` to `apps/web/src/session/live-runtime.ts`; fake instrumentation to `apps/web/src/session/live-runtime.fake.ts` or equivalent fake-only module.

### Rename for truth

- Renumber later duplicate ADRs: keep multipart as Decision 007 (2026-08-10), rename 2026-08-16 TTS selection to 008 and consent/enrollment to 009; update headings/comments/links only.
- Rename broad event catalogue only if needed after `HostEvent` exists; do not silently repurpose `CoreEvent` and break historical fixtures.

### Retain

- Host auth/session isolation, sidecar loopback auth, process isolation, deterministic policy package, progressive TTS assembler for the single path, cancellation/playback ledgers, stable storage transactions, recording accounting, model-runtime attestation, benchmark recomputation/legacy checks, and security/race tests.

### Investigate or block

- Full removal of research/multipart code: blocked until ARC-001 has shipped and local wire/storage compatibility policy is set.
- Full removal of custom-voice enrollment/clone data: blocked on PM amendment or data-safe retirement decision.
- Audio recording product ownership: retain until scope decision.

## Sequenced remediation roadmap

### Phase 0 — Freeze accidental scope and preserve baseline

**Goal:** stop adding architecture to non-goal paths; establish reproducible green baseline.

1. Run/record current typechecks, full TS/audio/benchmark suites, build, and E2E (baseline in findings).
2. Land **ARC-001** default-off multipart research.
3. Freeze new custom-voice features pending disposition; no code deletion yet.
4. Land **ARC-003** so every following cheap-model task uses an honest gate.

- **Checkpoint:** default eligible turn uses only no-tool `PiClient`, emits no part events, full gate green.
- **Rollback:** revert ARC-001’s explicit-opt-in composition; compatibility code still exists.

### Phase 1 — Restore product/configuration truth

1. **ARC-002** makes the editable frozen persona canonical.
2. **ARC-007** resolves Pi executable/default portably.
3. **ARC-008** aligns readiness with selected Pi settings.
4. **ARC-012** updates README/current docs only after actual behavior lands.

- **Checkpoint:** a custom structured persona changes policy; readiness tuple equals session tuple; fresh-machine instructions name Pi requirement/config.
- **Rollback:** each task is independently revertible; do not combine persona/readiness/doc changes in one commit.

### Phase 2 — Freeze shared contracts and package seams

1. **ARC-004** adds `HostEvent` schemas/types/fixtures without app adoption.
2. **ARC-006** fixes dist exports/build order (parallel with ARC-004 if file ownership is respected).
3. **ARC-005** adopts the generated event seam in host/web/storage.
4. **ARC-011** removes dead code exposed by no-unused checks.

- **Checkpoint:** invalid failure fails HostEvent; direct Node imports all package subpaths; no generic host/web protocol event type remains at the trust boundary.
- **Rollback:** ARC-004 is additive; ARC-005 can revert without schema loss.

### Phase 3 — Repair runtime lifecycle/safety

1. **ARC-009** fixes IndexedDB handle/version-change ownership.
2. **ARC-010** moves sidecar blocking admission off the event loop.
3. **ARC-015** shares Playwright server lifecycle.

- **Checkpoint:** DB upgrade/reopen test passes; sidecar loop advances during saturated admission; all 24 E2E tests pass with fewer server starts.
- **Rollback:** retain previous store wrappers/server call under one commit each; no data schema version bump required.

### Phase 4 — Extract hotspots after their seams stabilize

1. **ARC-013** extracts `LiveSessionRuntime` from App with move-first semantics.
2. **ARC-014** moves selected audio config and common verifier.

- **Checkpoint:** App owns routes/settings only; live-runtime unit tests own resource order; observed web entry size is no worse and preferably under warning; production audio imports no benchmark/docs path.
- **Rollback:** preserve public interfaces and move code back; no behavior/data migration in these tasks.

### Phase 5 — Conditional deletion, not yet authorized

After one release/checkpoint with multipart default-off:

- If research remains outside scope, delete `PiResearchClient`, `ResearchPartAssembler`, multipart orchestrator branches/tests first. Keep tolerant readers/optional fields for a defined compatibility window. In later independent tasks, simplify host/audio/web multi-output scheduling. Do not combine all layers.
- If custom voice remains outside scope, UX/product defines a local-data retirement path. Remove enrollment first while retaining list/delete; remove clone runtime only after data compatibility expires.
- If either feature is reauthorized, write a new ADR/PM amendment with privacy, length, tool, data, and test contracts before refactoring it.

## Compact task index

### Now

| ID | Task | Risk | Relative effort | Why now |
|---|---|---:|---:|---|
| ARC-001 | Disable default multipart research | Medium | S | Restores authoritative scope/privacy and avoids refactoring deletion candidate |
| ARC-002 | Editable persona drives policy | Medium | S | Fixes a direct product contract violation |
| ARC-003 | Authoritative check | Low | S | Makes later cheap-model work safe |
| ARC-004 | Canonical HostEvent contract | Low–Medium | M | Freezes shared interface before adoption |
| ARC-006 | Package exports/build order | Medium | M | Clean-build/package seam is currently broken |
| ARC-009 | IndexedDB ownership | Medium | M | Prevents resource leaks/blocked future migrations |
| ARC-010 | Non-blocking sidecar loop | Medium | S | Removes a concrete concurrency hazard |

### Next

| ID | Task | Risk | Relative effort | Dependency |
|---|---|---:|---:|---|
| ARC-005 | Adopt typed protocol boundaries | Medium–High | M | ARC-004 |
| ARC-007 | Portable Pi discovery | Medium | S–M | ARC-006 preferred |
| ARC-008 | Settings-aware Pi readiness | Medium–High | M | ARC-007 |
| ARC-011 | Dead compatibility cleanup | Low | S–M | ARC-004/005 preferred |
| ARC-012 | Repository truth/hygiene | Low | S | ARC-001/003 outcomes |
| ARC-015 | Shared Playwright server | Medium | M | ARC-003 |

### Later

| ID | Task | Risk | Relative effort | Dependency |
|---|---|---:|---:|---|
| ARC-013 | Extract live session runtime | High | L | 001,002,005,008,009,011 |
| ARC-014 | Move selected audio config/verifier | Medium | M | ARC-010 preferred |
| — | Manifest-driven Qwen acquisition | Low–Medium | M | ARC-014 |
| — | Shared dev process-group helper + both-launcher tests | Medium | M | ARC-015 patterns |
| — | Small shared WAV/PCM/host UUID helpers | Low | S | After package exports stabilize |

### Do Not Do

| Change | Reason |
|---|---|
| Re-enable research merely because its tests pass | Product/privacy contradiction is unresolved; tests verify mechanics, not authorization |
| Delete custom-voice data/UI immediately | Existing local references require a retention/deletion decision |
| Big-bang remove multipart across contracts/host/audio/web/storage | Compatibility and rollback become unreviewable |
| Rewrite React state with Redux/XState or replace Fastify/websockets | No evidence those ecosystems are the root issue |
| Replace JSON Schema generator wholesale | Current cross-language generation works; fix missing HostEvent seam |
| Add provider/plugin abstraction | Provider portability is an explicit non-goal |
| Reformat the whole repository or raise Vite chunk limit | High churn/hides observed problems |
| Split giant benchmark/Qwen files only for line count | Evidence/runtime invariants require responsibility-driven changes and focused tests |

## Dependency graph

```text
ARC-001 ──> ARC-002 ────────────────┐
   │                                │
   └────────────> ARC-012            │
                                    v
ARC-004 ──> ARC-005 ──> ARC-011 ──> ARC-013
                         ^           ^
ARC-006 ──> ARC-007 ──> ARC-008 ─────┤
                                    │
ARC-009 ─────────────────────────────┘

ARC-003 ──> every implementation task
   └─────> ARC-015

ARC-010 ──> ARC-014
```

### Parallel execution table

| Parallel wave | Safe tasks | Exclusions |
|---|---|---|
| Wave A | ARC-001, ARC-003, ARC-004, ARC-006, ARC-009, ARC-010 | ARC-001 and ARC-009 owners must avoid `App.tsx` overlap; ARC-004 solely owns contracts |
| Wave B | ARC-002, ARC-007, ARC-015 | ARC-002 cannot overlap host composition work from ARC-001; ARC-007 cannot overlap ARC-008 |
| Wave C | ARC-005, ARC-008, ARC-012, ARC-014 | ARC-005 solely owns event typing; ARC-008 owns readiness/App request lines |
| Wave D | ARC-011 | Run after typing exposes dead paths |
| Wave E | ARC-013 | Sole owner of `App.tsx` and live session composition |

## Recommended repository standards and guardrails

Only standards tied to observed failures are recommended.

1. **One current gate:** `pnpm check` runs generation freshness, all TS typechecks/unit tests, all model-free audio tests, benchmark tests, Ruff, and build. E2E and real model soak remain explicit named commands.
2. **Generated ownership:** every generated path has a header where possible, one generator command, and freshness comparison. Publication copies are generated, not hand-copied.
3. **Typed wire boundaries:** no `type:string/payload:Record` crosses host↔browser; use generated unions. Manual runtime validators have canonical fixture parity tests.
4. **Clean-build import smoke:** remove ignored `dist`, build, and direct-import every workspace export subpath. This directly prevents the observed source/dist break.
5. **Resource ownership:** every object that opens DB/socket/process/audio context has `close`/`dispose`; owner calls it once; IndexedDB handles close on `versionchange`.
6. **No default-on non-goals:** optional behavior is explicit opt-in at one composition root, not inverted `!== false` defaults across layers.
7. **No-unused production code:** after ARC-011, enable `noUnusedLocals/noUnusedParameters` for application source via source-only tsconfigs or fix the small test/generator exceptions. Do not block on generated assertion aliases.
8. **Python style incrementally:** keep Ruff check. Run `ruff format` only on new/touched bounded files until a separately reviewed formatting baseline exists; do not create a 39-file formatting diff inside feature work.
9. **Fast model-free CI:** once ARC-003 is stable, CI runs frozen install + `pnpm check` on Linux. Do not download models or require GPU. Add E2E only if its shared server keeps runtime acceptable.
10. **ADR uniqueness/current README:** decision numbers unique; ADR conclusions historical; README commands/current capabilities authoritative and validated.
11. **File-size review trigger, not limit:** changes to `App.tsx`, orchestrator, audio runtime, or files over ~500 lines must state which responsibility stays/moves. Do not split mechanically.
12. **No new compatibility path without removal condition:** additive legacy fields/wrappers must name owner, test, and retirement checkpoint.

Not recommended now: CODEOWNERS for a solo repository, a generic architecture test framework, coverage percentage gates, a provider plugin API, or GPU CI.

## Rollback discipline

- One task card per branch/commit.
- Behavior-changing flags first, deletion later.
- Additive schema before consumer adoption.
- Moves separate from semantic changes.
- No DB version bump in lifecycle cleanup; data migrations get dedicated cards.
- Every task reports exact command output and `git status`; a green subset does not replace `pnpm check`.
- If a task cannot meet its invariants, revert that task rather than broadening scope.

## Final handoff prompt for a cheaper implementation model

Copy this template and replace the placeholders with **one** task card:

```text
Implement exactly architecture task <ARC-ID> from:
  artifacts/architect/tasks/<task-file>.md

Read only:
- that task card,
- the interfaces it explicitly links in artifacts/architect/index.md,
- the exact in-scope source/tests named by the card.

Rules:
1. Do not implement adjacent roadmap items, rename unrelated symbols, reformat untouched files, add generic abstractions, or change product behavior outside the card.
2. Start by running the card's baseline/focused command and checking `git status`.
3. Follow the listed steps and invariants in order. If an invariant conflicts with current code, stop and report the exact path/line; do not invent a new architecture.
4. Add/update only the focused tests required by the card.
5. Run every focused command in the card, then `pnpm check` when requested. Do not claim unrun tests.
6. Inspect the final diff for out-of-scope files, generated outputs, lockfile changes, and staged files.
7. Report:
   - task ID and status,
   - changed files,
   - behavior preserved/changed,
   - commands with pass/fail and concise counts,
   - generated files changed,
   - residual risks or blockers,
   - `git status --short` and diff summary.

If blocked, return the smallest safe partial result or no diff. Never broaden scope to “finish” the roadmap.
```
