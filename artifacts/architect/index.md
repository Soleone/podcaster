# Architecture audit — Podcaster

- **Audit date:** 2026-08-19
- **Repository:** `/home/soleone/src/tries/2026-08-06-podcaster`
- **Scope:** all tracked application, service, benchmark, script, test, documentation, configuration, generated-contract, and recent-history surfaces. Generated/build/cache/model assets were considered only where they affect ownership, reproducibility, or validation.
**Authority used:** `artifacts/pm/index.md` is authoritative; `artifacts/ux/index.md` supplies the current UI data contract.

## Start here

1. Read this file for the verdict, current/target seams, and task order.
2. Read [findings.md](findings.md) for the evidence-backed findings, health baseline, duplication inventory, and over-engineering inventory.
3. Read [target-roadmap.md](target-roadmap.md) for the target architecture, sequencing, dependency graph, standards, rollback points, and cheap-model handoff template.
4. Read [cleanup-ledger.md](cleanup-ledger.md) before deleting or moving anything.
5. Give an implementation agent **one** linked task card, never the whole roadmap.

### Task cards

- [ARC-001 — Disable default multipart research](tasks/01-disable-default-multipart-research.md)
- [ARC-002 — Make the editable persona drive policy](tasks/02-use-editable-persona-for-policy.md)
- [ARC-003 — Make `pnpm check` authoritative](tasks/03-make-check-authoritative.md)
- [ARC-004 — Add a canonical host-event contract](tasks/04-add-canonical-host-event-contract.md)
- [ARC-005 — Adopt typed protocol boundaries](tasks/05-adopt-typed-protocol-boundaries.md)
- [ARC-006 — Fix workspace package exports and build order](tasks/06-fix-workspace-package-exports.md)
- [ARC-007 — Make Pi executable discovery portable](tasks/07-make-pi-discovery-portable.md)
- [ARC-008 — Probe the selected Pi settings](tasks/08-align-pi-readiness-with-settings.md)
- [ARC-009 — Fix IndexedDB resource ownership](tasks/09-fix-indexeddb-resource-ownership.md)
- [ARC-010 — Keep the sidecar event loop non-blocking](tasks/10-keep-sidecar-loop-nonblocking.md)
- [ARC-011 — Remove verified dead compatibility clutter](tasks/11-remove-dead-compatibility-clutter.md)
- [ARC-012 — Correct repository truth and generated hygiene](tasks/12-correct-docs-and-generated-hygiene.md)
- [ARC-013 — Extract the live web-session runtime](tasks/13-extract-live-session-runtime.md)
- [ARC-014 — Move selected audio configuration to the audio service](tasks/14-move-selected-audio-config.md)
- [ARC-015 — Share the Playwright server lifecycle](tasks/15-share-playwright-server-lifecycle.md)

## Executive verdict

**The repository is behaviorally well tested but architecturally overextended.** Its core loop—browser capture/playback, authenticated host, Pi RPC, loopback audio sidecar, local persistence—has sensible trust boundaries and unusually good race/security coverage. The main risk is not a need for a rewrite; it is that later features crossed the authoritative product boundary and then forced compatibility machinery through every layer.

Highest-leverage conclusions:

1. **Default multipart “research” is the wrong default architecture.** Every eligible turn takes the tool-enabled, up-to-600-word path (`SessionOrchestrator.ts:289-291,418-525`), while the authoritative PRD requires concise responses and explicitly excludes search (`artifacts/pm/index.md:16,23,32`). It also enables file-reading tools while the shared system prompt explicitly prohibits tools (`PODCASTER_SYSTEM_PROMPT`, `PiResearchClient.ts:168`). Disable it first; do not refactor its duplicate Pi client before deciding whether to delete it.
2. **There are two personas, and the user-owned one does not control posture.** `BrowserSession` uses `settings.persona` only as a Pi prompt append, while `SessionOrchestrator` silently parses `DEFAULT_PERSONA_MARKDOWN`. This contradicts the PRD’s single user-owned configuration controlling personality and posture tendencies (`artifacts/pm/index.md:19`). Passing the validated frozen settings persona into the orchestrator is a small, behavior-preserving correction for ordinary plain-text personas.
3. **The canonical event contract is not canonical.** `CoreEvent` validates an allowed type plus arbitrary object payload; a direct probe showed an invalid `failure` payload passes `CoreEvent` while failing `FailureEvent`. Host and web then use generic `{type:string,payload:Record}` types and the web maintains a 30-line hand validator. Add a generated `HostEvent` union and adopt it at trust boundaries.
4. **The advertised quality gate is incomplete.** `scripts/check.sh` omits all 201 web unit tests and most of the 223 audio tests, even though full suites pass. Fixing the gate gives safer cheap-model execution than adding more tests or tooling.
5. **Package and lifecycle seams need repair before large refactors.** `@app/contracts/settings` is exported from TypeScript source and fails under direct Node ESM after a successful build; `App.tsx` owns 30+ mutable states/refs and races two custom-voice store bootstraps; Pi readiness probes a fixed global client rather than selected settings. These are bounded, reversible fixes.

**Do not rewrite the application.** Disable or freeze non-goal behavior, establish one contract owner, repair resource/build seams, and only then extract the web live-runtime coordinator. Keep the heavily tested playback, interruption, security, audio-adapter, and benchmark internals unless a task explicitly names them.

## System design (components + responsibilities)

### Current architecture map

| Area | Current responsibility | Runtime/build dependency direction | Audit verdict |
|---|---|---|---|
| `apps/web` | React UI, readiness, session composition, capture/playback, WebSocket protocol checks, IndexedDB persistence, MP3 recording/export, settings and custom voices | Browser → host HTTP/WS; imports `@app/contracts/settings` and `/binary` | Sound feature modules underneath an oversized `App.tsx`; manual wire typing and fragmented DB ownership |
| `apps/host` | Fastify static/API/WS server, cookie+capability auth, browser session registry, turn orchestration, Pi children, sidecar client | Host → contracts, policy, Python sidecar, Pi executable; serves built web | Trust boundary is strong; `app.ts`, `SessionOrchestrator`, `AudioClient`, and duplicated Pi clients are hotspots |
| `services/audio` | Authenticated loopback WebSocket server, selected STT/TTS composition, model verification, streaming/cancellation, optional Qwen isolation and voice enrollment | Python sidecar → generated Python contracts; currently also → `benchmarks/configs` and `docs/model-manifest.json` | Process isolation is justified; production ownership leaks into benchmark/docs paths and one sync wait can block asyncio |
| `packages/contracts` | JSON Schemas, generated TS/Python contract source, binary frame codec, browser-safe settings/persona semantics | Canonical schemas → generated TS and embedded Python schemas | Correct package to own shared concepts; event union and package exports are incomplete/inconsistent |
| `packages/policy` | Deterministic posture selection | Policy → contracts persona type | Small and cohesive; keep separate |
| `benchmarks/harness` | Reproducible synthetic/STT/TTS runs, validation, comparison, blinded ratings | Benchmark → audio adapters and benchmark schemas | Long but evidence-sensitive; avoid speculative cleanup |
| `scripts` / `spikes` | Dev process ownership, acquisition, contract generation, real-stack retries, historical feasibility probes | Scripts → workspace tools/harness/services | Several useful tools; duplicated acquirers/process helpers and stale machine-specific fixture metadata |
| `docs` / `artifacts/evidence` | Accepted decisions, reproducibility instructions, retained experiment evidence | Documentation only, except production currently reads model manifest | README/build document are materially stale; duplicate ADR number 007 |

### Current runtime flow

1. `pnpm dev` runs `scripts/dev-hmr.mjs`, builds the host (and contracts), launches `apps/host/dist/server/main.js`, then Vite.
2. Host `main.ts` starts the Python sidecar, creates a fixed default Pi readiness client, builds Fastify, and binds loopback.
3. Browser bootstraps a cookie/capability over HTTP, opens authenticated WS, sends a frozen session settings snapshot, starts binary PCM capture, and persists stable events before acknowledging final turns.
4. Host `BrowserSession` validates browser commands, bridges PCM to `AudioClient`, and feeds sidecar STT events into `SessionOrchestrator`.
5. The orchestrator selects posture, currently chooses multipart research by default, streams Pi text into sidecar TTS, and emits host events/audio to the browser.
6. Browser `WebSocketSessionTransport` hand-validates events, `SessionController` serializes state/storage/playback effects, and recording/store modules persist local data.

### Current generated/manual interfaces

- Canonical JSON Schemas: `packages/contracts/schema/**`.
- Generated TS: `packages/contracts/src/generated/contracts.ts`; generated compile assertions: `packages/contracts/test/types-required.generated.compile.ts`.
- Generated Python embedded schemas/Pydantic wrappers: `services/audio/src/generated/contracts.py` and `__init__.py`.
- Manually duplicated runtime interfaces: host `SessionEvent`, web `StableEvent`/`Envelope`, web `isStrictHostEvent`, settings validators, Python custom-voice constants.
- Manually mirrored benchmark schemas: `packages/contracts/schema/benchmarks/*.json` → `benchmarks/results/schema/*.json` (currently byte-identical, guarded only by a test).

### Target architecture

```text
web AppShell/routes/settings
        |
        v
web LiveSessionRuntime (owns transport/controller/capture/recording handles)
        |
        +--> LocalDatabase owner --> typed stores
        +--> HostEvent / BrowserCommand generated contracts
        |
        v
host Fastify/auth/session registry
        |
        v
BrowserSession (protocol adapter) --> SessionOrchestrator (single concise response)
        |                                  |
        v                                  v
AudioClient ---------------------------> PiClient (no tools)
        |
        v
Python SidecarServer --> SelectedAudioRuntime --> STT/TTS adapters

benchmarks -------------------------------> audio adapters + service-owned selected config
contracts schemas --> generated TS/Python; no hand-owned competing event model
```

Target dependency rules:

- Web and host depend on generated contract types; neither invents a competing protocol event base type.
- Host owns auth/session composition; orchestrator owns conversation state; `AudioClient` owns sidecar wire mechanics; none owns UI/storage presentation.
- The web app owns exactly one live-session runtime object and one database lifecycle; React renders snapshots and dispatches commands.
- Audio service owns selected production model config and manifest loading; benchmarks consume that config, never the reverse.
- Default conversation uses one no-tool Pi client and one concise response. Multipart/file-reading research remains disabled unless a future product/security decision explicitly reauthorizes it.
- User-editable `settings.persona` is the sole persona source for both policy interpretation and Pi prompt append.

## Key decisions & tradeoffs

| Decision | Why | Tradeoff |
|---|---|---|
| Disable multipart research before deleting it | Immediate alignment with authoritative scope and privacy; one boolean rollback | Dormant compatibility code remains temporarily |
| Freeze custom-voice expansion; do not immediately delete local data paths | It is an explicit PRD non-goal, but users may already have browser-local references needing deletion/recovery | Leaves 1,456+ explicit LOC until product/UX approve data-safe retirement |
| Keep JSON Schema generation | Cross-language validation is earning its cost | Improve the event union and generated-output gate rather than replacing the generator wholesale |
| Generate types but keep a small browser runtime validator initially | Avoids bundling Ajv into the browser entry | Hand validator remains temporarily, but parity tests make drift visible |
| Repair package `dist` exports and build prerequisites | Common ESM workspace behavior; direct imports become truthful | Fresh build/test commands must build contracts first |
| Extract `LiveSessionRuntime` only after scope/contract/lifecycle fixes | Prevents moving unstable accidental complexity into a new abstraction | `App.tsx` remains large for the first checkpoints |
| Keep sidecar process isolation and duplicate validation at trust boundaries | Python dependency conflict and untrusted wire data justify them | Some repetition is intentionally retained |
| No formatting-only or framework rewrite | Low payoff and high review noise | Inconsistent historical style remains until touched organically |

## Interfaces / contracts (the seams between tasks)

### Contract seam C1 — Host events

`HostEvent` will be a generated discriminated union of host→browser events, including dedicated VAD schemas. Runtime validation remains strict. Invalid specialized payloads must not pass a broad “core” validator.

### Contract seam C2 — Browser commands and persisted events

`BrowserCommand` remains the browser→host union. Web storage accepts only:

```ts
type PersistedSessionEvent = HostEvent | PlaybackProgressEvent | PlaybackPausedEvent | PlaybackStoppedEvent;
```

Local degradation events must use a schema-valid `FailureEvent` payload, not a partial object masquerading as a wire event.

### Contract seam C3 — Persona

`SessionSettingsSnapshot.persona` is frozen at session start. Host applies the same string to:

- `parsePersona(settings.persona)` for policy fields/digest; plain text remains valid and receives supported defaults.
- `composePersonaAppend(settings.persona)` for Pi personality.

No hidden second runtime default may override it.

### Contract seam C4 — Pi configuration/readiness

A host-owned Pi configuration resolver supplies a canonical executable path plus `DEFAULT_PI_MODEL`. Readiness is keyed by the browser-selected, validated `PiSettings`; session response/classifier clients use the same model/thinking tuple. Readiness child ownership is host-scoped and shut down on app close.

### Contract seam C5 — Web live runtime

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

It owns `SessionTransport`, `SessionController`, `BrowserCapture`, `RecordingRecorder`, `RecordingStore`, reconnect subscriptions, and teardown ordering. `App.tsx` owns routes/settings/capability acquisition and never mutates those handles individually.

### Contract seam C6 — Audio configuration

Service-owned selected configs and model manifest are immutable inputs to `SelectedAudioRuntime`. Benchmark commands point at them. Shared verification helpers verify safe path, model entry, revision, and file hashes; modality-specific checks stay next to STT/TTS adapters.

## Task breakdown (each: path, boundary, interface, done-criteria, dependencies, parallel-safe?)

The compact index and dependency graph are in [target-roadmap.md](target-roadmap.md#compact-task-index). Every task’s exact files, steps, invariants, commands, diff shape, and pitfalls are in its linked card above.

| ID | Boundary | Depends on | Parallel-safe? |
|---|---|---|---|
| ARC-001 | Host composition default only; retain compatibility | None | Yes, except ARC-002/008 touch nearby host composition |
| ARC-002 | Frozen settings persona → policy + Pi | ARC-001 preferred | No with ARC-001 |
| ARC-003 | Validation scripts only | None | Yes |
| ARC-004 | Schemas/generator/contract fixtures only | None | Yes; exclusive ownership of contracts files |
| ARC-005 | Host/web event types and validators | ARC-004 | No with ARC-011/013 |
| ARC-006 | Package exports/build order | None | Yes; coordinate with ARC-003 if package scripts change |
| ARC-007 | Pi executable/default config | ARC-006 preferred | Yes, except ARC-008 touches Pi composition |
| ARC-008 | Settings-aware readiness client ownership | ARC-007 | No with ARC-001/002 |
| ARC-009 | IndexedDB handles and App bootstrap effects | None | No with ARC-013 |
| ARC-010 | Python server dispatch only | None | Yes |
| ARC-011 | Proven-dead symbols/files | ARC-004/005 preferred | No with ARC-005/013 |
| ARC-012 | README/ADR/ignore/generated hygiene | ARC-001/003 outcomes | Yes after those land |
| ARC-013 | Web runtime extraction | ARC-001,002,005,008,009,011 | No; sole owner of `App.tsx` |
| ARC-014 | Audio config ownership/verifier | ARC-010 preferred | Yes after ARC-010 |
| ARC-015 | Playwright server lifecycle | ARC-003 | Yes; sole owner of e2e config/support |

## Risks & assumptions

- **Verified, not speculative:** all critical/high findings cite current code or executed commands. Findings labelled “scope decision” rely on the authoritative PM versus later ADRs and are called out openly.
- Disabling multipart changes current default behavior but restores the authoritative concise, no-search product contract. Rollback is one opt-in boolean while compatibility remains.
- Passing the editable persona to policy changes digest/selection for new sessions; frozen existing session settings remain the boundary. Tests must pin this intentionally.
- Existing browser-local custom voices and multipart recordings may exist. Do not delete stores, deletion UI, or compatibility fields without a data-retirement decision.
- Full real Pi/provider calls, real five-minute GPU soak, and manual accessibility/browser checks were not run during this read-only audit. Unit/integration/e2e/build validation was comprehensive and green.
- No CI currently enforces checks. The roadmap does not assume a GPU CI runner.

## Open questions

1. **Product/architecture conflict:** accepted `docs/decisions/007-multi-part-responses.md` enables tool-backed long answers, but the later authoritative PM excludes search and requires concise responses. This audit follows the PM and recommends default-off now. Reauthorization would require a new product/privacy/security decision, not merely toggling it back on.
2. **Custom voice:** `docs/decisions/008-consent-local-voice-enrollment.md` and current code productize enrollment, while the PM explicitly excludes custom-voice productization. Freeze expansion; UX/product must choose data-safe retirement versus a PM amendment before deletion.
3. **Recording:** rich MP3 recording/trim/export is implemented but is not clearly named in MVP scope. Keep it for now; confirm ownership before further feature work.
4. What Pi installation/version discovery contract should fresh-machine setup support? Safe fallback: explicit `PODCASTER_PI_EXECUTABLE` plus PATH discovery and fail-closed readiness.
5. How long must readers retain multipart fields and browser-local custom-voice data? No telemetry/migration policy exists.
6. Is Linux the only supported dev/runtime OS? Process-group scripts and CUDA paths assume it; current README says Linux.

No Staffed effort/tier escalation is required: the immediate remediation path is safe despite the product decisions above, and unresolved deletions are explicitly blocked rather than guessed.
