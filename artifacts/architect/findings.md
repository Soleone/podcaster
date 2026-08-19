# Evidence and findings

Back to [index.md](index.md).

## Repository health baseline

### Size and hotspot signals

- **433 tracked files; 71,668 tracked lines** (`git ls-files | wc -l`; `git ls-files -z | xargs -0 wc -l`). This includes generated contracts, lockfiles, artifacts, and fixtures.
- Source/test LOC by primary area:

| Area | LOC |
|---|---:|
| `apps/host/src` | 3,745 |
| `apps/host/test` | 4,271 |
| `apps/web/src` | 12,534 |
| `apps/web/e2e` | 1,008 |
| `services/audio/src` | 5,799 |
| `services/audio/tests` | 3,318 |
| `benchmarks/harness` (including tests) | 6,359 |
| `scripts` Python/MJS | 4,423 |

- Highest production hotspots: `services/audio/src/runtime.py` 1,274 lines; `apps/web/src/App.tsx` 1,169; `apps/host/src/session/SessionOrchestrator.ts` 1,046; `services/audio/src/tts/qwen3.py` 1,350; `apps/host/src/sidecar/AudioClient.ts` 616; `apps/web/src/session/controller.ts` 491; `apps/web/src/session/websocket-transport.ts` 444; `apps/host/src/server/app.ts` 426.
- Churn over the latest 100 commits: `App.tsx` changed in 32 commits, `SettingsDialog.tsx` 26, `SessionScreen.tsx` 20, host `app.ts` 15, audio `runtime.py` 14, host `AudioClient.ts` 12, and `SessionOrchestrator.ts` 10. This corroborates the ownership hotspots rather than using file size alone.
- No relative-import cycles were found in `apps/web/src` or `apps/host/src` by a read-only graph scan.
- Exact tracked duplicates include all five benchmark result schema pairs and identical `apps/host/tsconfig.json` / `packages/policy/tsconfig.json`.

### Commands run and observed status

| Command | Result | Observation |
|---|---|---|
| `git status --short --branch` before/after validation | Passed | Clean `main`; validation generated/build outputs left no tracked diff |
| Four workspace `typecheck` scripts | Passed | Contracts, policy, host, web all green |
| `corepack pnpm --recursive --if-present test` | Passed | Contracts 1,274; policy 10; web 201; host 292 = **1,777 tests** |
| `uv run pytest services/audio/tests` | Passed | **223 tests** in 8.07s |
| `uv run pytest benchmarks/harness/tests` | Passed | **44 tests** in 37.01s |
| Configured `uv run ruff check ...` | Passed | No configured Ruff violations |
| `corepack pnpm build` | Passed with warning | Web main chunk **513.97 kB**, Vite >500 kB warning; host/contracts built |
| Both contract generators + `git diff --exit-code` on generated files | Passed | Current generated TS/Python outputs fresh |
| `bash scripts/check.sh` | Passed | But coverage is incomplete by inspection: 70 contract/security audio tests + 56 STT + 44 benchmark; no web units and no runtime/TTS/voice audio suites |
| `corepack pnpm test:dev-cleanup` | Passed | Tests `scripts/dev.mjs` process cleanup, not `dev-hmr.mjs` |
| `corepack pnpm test:e2e` | Passed | 24 Playwright tests, one worker, **2.1 minutes** |
| Direct `@app/policy` Node import after build | Passed | Node loaded source export |
| Direct `@app/contracts/settings` Node import after build | **Failed** | `ERR_MODULE_NOT_FOUND` for `src/settings/custom-voice.js` |
| Runtime validator probe with invalid `failure` payload | Probe passed | `CoreEvent=true`, `FailureEvent=false`, proving broad core contract |
| `uv run ruff format --check ...` (exploratory) | Failed | 39 files would be reformatted; formatting is not enforced |
| Host/web `tsc --noUnusedLocals --noUnusedParameters` (exploratory) | Failed | Found verified dead production symbols plus test-only cleanup; generated contract assertions also block global enablement |

### Audit limitations

- No live Pi/provider request was sent: that would cross the private/cloud boundary and was unnecessary to verify the static prompt/configuration defects.
- No real model load, five-minute GPU soak, listening comparison, or CUDA resource benchmark was rerun. Existing evidence and tests were inspected; actual model payloads were not audited byte-by-byte.
- No dependency installation, destructive command, vulnerability network scan, coverage-instrumented run, or manual browser/a11y session was performed.
- Untracked ignored models, local result runs, environments, caches, and build outputs were treated only as environment evidence. The tracked proxy wheel was inspected through its build source and manifest usage, not reverse engineered.

## Prioritized findings

### F-01 — Default multipart research violates the authoritative product boundary

- **Severity / priority:** Critical / Now
- **Confidence:** High, verified static composition and product conflict
- **Category:** Scope architecture, privacy, accidental complexity
- **Evidence:**
  - Authoritative PM requires concise spoken responses (`artifacts/pm/index.md:16,23`) and explicitly excludes search (`:32`).
  - `SessionOrchestrator.handleStableFinal` routes every eligible non-silence turn into multipart when configured (`apps/host/src/session/SessionOrchestrator.ts:289-291`).
  - `BrowserSession` enables multipart unless explicitly false (`apps/host/src/server/BrowserSession.ts:162-170`); `buildApp` likewise passes true by default (`apps/host/src/server/app.ts:408-413`). Production `main.ts` does not opt out.
  - The multipart path produces a stall plus up to seven 90-word parts (`ResearchPartAssembler.ts:40-45`) and a research child defaults to 600 words (`PiResearchClient.ts:15-18,82-100`).
  - Research enables `read,grep,find,ls` (`PiResearchClient.ts:164-169`) while the shared base system prompt says “Do not use tools or attempt to read files” (`packages/contracts/src/settings/system-prompt.ts:14-17`). The request prompt then says tools may be used (`PiResearchClient.ts:82-85`).
  - The explicit research-only files alone are 1,376 lines; multipart state/routing also permeates orchestrator, AudioClient, Python runtime, web transport/controller, storage, recording, schemas, and tests.
- **Why it matters:** Behavior is internally contradictory, can expose local filesystem content to a tool-enabled model under prompt injection, produces answers far beyond the companion posture contract, and is the largest source of cross-layer compatibility machinery.
- **Lean recommendation:** Execute ARC-001: make multipart explicit opt-in and production default-off. Keep readers/fields temporarily. Do **not** first extract a shared Pi RPC abstraction; deletion may remove the duplicate. After a release/data-compatibility checkpoint, decide whether to delete the research subsystem.
- **Expected payoff:** Restores product/privacy truth immediately; returns normal turns to the already-tested single-response path; makes later simplification mostly deletion.
- **Risk:** Current users may notice shorter, single-part replies. This is desired per authoritative PM but conflicts with accepted ADR 007.
- **Validation:** Host integration must show default composition never calls `requestBody`, emits no `response.part_*`, keeps `--no-tools` response behavior, and passes host/web/audio suites plus E2E.

### F-02 — Custom-voice productization is an explicit non-goal embedded across all layers

- **Severity / priority:** High / scope decision before further investment
- **Confidence:** High product conflict; data-retirement impact needs confirmation
- **Category:** Scope creep, maintenance cost
- **Evidence:**
  - PM explicitly excludes “custom-voice productization” (`artifacts/pm/index.md:33`).
  - Current UI/API/storage/runtime implement enrollment, upload/record, rename, restore, preview, delete, local retention, isolated Base cloning, and catalog reconciliation: `CustomVoiceSection.tsx`, `voice-enrollment/**`, `custom-voice-store.ts`, host `voice-enrollment.ts` and routes in `app.ts:267-322`, Python `voice_enrollment.py`, Qwen clone code in `qwen3.py`, and ADR 008.
  - Explicitly named custom-voice files total at least **1,456 lines**, excluding integration code in `App.tsx`, settings, schemas, Qwen adapter, and tests.
- **Why it matters:** The subsystem consumes a disproportionate share of current churn and lifecycle complexity. Refactoring it without a scope decision entrenches a non-goal; deleting it naively risks browser-local user data and deletion consent promises.
- **Lean recommendation:** Freeze new custom-voice work. Do not delete data/UI in the Now phase. Product/UX must either amend the PM or define data-safe retirement (retain listing/deletion until local records are gone). Continue to retain stock Qwen/Kokoro selection independently.
- **Expected payoff:** Prevents more sunk complexity and clarifies whether consolidation work is valuable.
- **Risk:** Premature deletion violates local-retention expectations. No implementation card is authorized until disposition is explicit.
- **Validation:** Decision must name stored-data treatment, supported delete path, session compatibility, and whether Qwen Base clone runtime can be removed.

### F-03 — The editable persona does not drive posture policy

- **Severity / priority:** High / Now
- **Confidence:** High, verified
- **Category:** Concept ownership, correctness
- **Evidence:**
  - PM requires one user-owned AGENTS.md-like configuration controlling personality, interests, and posture tendencies (`artifacts/pm/index.md:19`).
  - Browser freezes `settings.persona`; host uses it to create Pi prompt appends (`BrowserSession.ts:139-151`).
  - `SessionOrchestrator` instead parses `options.personaSource ?? DEFAULT_PERSONA_MARKDOWN` (`SessionOrchestrator.ts:194-198`), and BrowserSession never supplies `personaSource` (`:162-172`).
  - Two Oliver defaults exist: structured `DEFAULT_PERSONA_MARKDOWN` (`packages/contracts/src/persona/defaults.ts:3-30`) and plain editable `DEFAULT_AGENT_PERSONA` (`packages/contracts/src/settings/persona.ts:7-17`).
- **Why it matters:** The settings UI implies user ownership but posture weights/invitation/challenge behavior are silently fixed. Two digests/defaults can drift.
- **Lean recommendation:** ARC-002 passes validated frozen `settings.persona` to the orchestrator. `parsePersona` already accepts plain text and applies supported structured defaults, so existing ordinary personas remain valid.
- **Expected payoff:** One canonical persona source; product promise becomes true; hidden default coupling disappears.
- **Risk:** New-session policy digest/selection may change. Existing frozen session settings must remain immutable.
- **Validation:** Integration with front matter (`invitation_only` or zero challenge weight) must visibly alter policy; plain text remains accepted; session isolation tests remain green.

### F-04 — The server→browser event contract accepts arbitrary payloads

- **Severity / priority:** High / Now–Next
- **Confidence:** High, directly executed
- **Category:** Generated contracts, weak module boundary
- **Evidence:**
  - `core-events.json:5-67` combines only `ProtocolEnvelope` and a type enum; it does not reference specialized payload schemas.
  - Generated `CoreEvent` is `{ type: enum; payload: Record<string, unknown> }` (`generated/contracts.ts:13`).
  - Executed probe: a `failure` with only `{detail}` returned `CoreEvent true` and `FailureEvent false`.
  - Host defines generic `SessionEvent` (`SessionOrchestrator.ts:12`) and generic `emit(type:string,payload:Record)` (`:1042-1045`).
  - Web defines another generic `StableEvent` (`stable-turn-writer.ts:3-10`) and a hand-maintained validator (`websocket-transport.ts:389-443`). VAD events have no dedicated host-event schemas.
  - `SessionController.degrade` creates a schema-invalid partial failure event (`controller.ts:386-389`) and persists it under the same conceptual type.
- **Why it matters:** Schema/type generation cannot catch host payload drift; browser validation is a competing canonical implementation; storage accepts synthetic malformed protocol events; cheap models must reason about stringly payloads.
- **Lean recommendation:** ARC-004 creates generated `HostEvent` plus VAD schemas. ARC-005 adopts generated unions at host/web boundaries, separates host input from locally persisted playback events, and makes local failure events schema-valid. Keep browser validator temporarily but cross-check every fixture against canonical validators.
- **Expected payoff:** Compile-time narrowing, one owner, fewer casts/heuristics, safer protocol changes.
- **Risk:** Type adoption may expose latent mismatches. Freeze schemas while ARC-005 lands.
- **Validation:** Invalid specialized payload must fail `HostEvent`; valid fixtures pass generated JS/Python and browser validator; all contract/host/web tests pass.

### F-05 — `pnpm check` is not the repository’s actual quality gate

- **Severity / priority:** High / Now
- **Confidence:** High, command and script inspected
- **Category:** Test/tooling coverage
- **Evidence:**
  - `scripts/check.sh:35-45` runs contracts/policy tests, selected audio contract/security tests, STT tests, benchmark tests, typechecks, and Ruff.
  - It does not run `@app/web test` (201 passing tests) or full `services/audio/tests` (223 passing; the check runs 126 selected audio tests). It omits runtime, multipart, voice enrollment, Kokoro, Qwen, and custom voice suites.
  - Host tests build the web app but do not execute web unit tests (`apps/host/package.json:7`).
  - Freshness hashes cover only generated TS contracts and Python contracts (`check.sh:9-17`), not generated TS required-key assertions or Python `__init__.py`.
- **Why it matters:** A cheap implementation model can report `pnpm check` green after breaking central web/runtime behavior. Additional tests are lower leverage than running existing ones.
- **Lean recommendation:** ARC-003 replaces selected audio commands with full audio tests, adds web units, and checks every generated output. Keep GPU/e2e out of the fast gate; expose them as explicit commands.
- **Expected payoff:** 400+ already-written tests become enforceable with small script changes.
- **Risk:** Check runtime increases modestly; parallel resource use must stay bounded.
- **Validation:** Intentionally filtered test counts appear; command fails when a generated secondary output is stale; `pnpm check` remains deterministic.

### F-06 — Workspace package exports are inconsistent and one is broken under Node ESM

- **Severity / priority:** High / Now–Next
- **Confidence:** High, directly executed
- **Category:** Package boundary, build tooling
- **Evidence:**
  - Contracts root imports built JS, but `/binary`, `/settings`, `/validators` export source `.ts` (`packages/contracts/package.json:6-10`). Policy exports source (`packages/policy/package.json:6`).
  - After successful build, direct `@app/contracts/settings` import failed because source `index.ts` imports `./custom-voice.js`, which does not exist beside source; built files exist under `dist`.
  - Policy import happened to work under Node 22 type stripping, despite its `build` output being ignored.
  - Root build runs web before host/contracts (`package.json:14`); web currently succeeds only because Vite resolves source exports.
- **Why it matters:** Package contracts are environment-dependent; clean builds and non-Vite consumers are brittle; policy build is misleading.
- **Lean recommendation:** ARC-006 exports runtime paths from `dist`, sets build order explicitly, and verifies a clean-dist build and direct Node imports. Keep source type paths only if they do not make clean typechecks depend on built artifacts.
- **Expected payoff:** Truthful private packages, common ecosystem behavior, reproducible clean builds.
- **Risk:** Tests/build commands must build dependencies first; avoid cyclic script recursion.
- **Validation:** Delete ignored `dist` directories, run documented build/test, import every export subpath from Node.

### F-07 — Pi install/readiness truth is tied to one machine and ignores selected settings

- **Severity / priority:** High / Next
- **Confidence:** High
- **Category:** Configuration, runtime truth
- **Evidence:**
  - `PI_EXECUTABLE` is absolute `/home/soleone/.../pi` (`PiClient.ts:6`); README calls setup “fresh-machine” but does not install/configure Pi (`README.md:3-13`).
  - `PI_MODEL` duplicates `DEFAULT_PI_MODEL` (`PiClient.ts:7`; `settings/pi.ts:5`).
  - Main creates one fixed `StdioPiClient` (`main.ts:4-6`). `buildApp` readiness probes only `options.pi` (`app.ts:105-136`).
  - Browser readiness posts the selected TTS model but not `settingsModel.pi` (`App.tsx:143-153`).
  - Actual response/research/classifier clients use per-session selected Pi settings (`app.ts:45-47`; `BrowserSession.ts:146-170`).
- **Why it matters:** Readiness can be green for the default model while the selected session model is unavailable, or permanently unavailable on any different home directory. Recent service-status UI therefore reports a false boundary.
- **Lean recommendation:** ARC-007 adds explicit env/PATH resolution and imports the canonical default model. ARC-008 adds a host-owned settings-keyed readiness probe and posts validated Pi settings from web.
- **Expected payoff:** Portable setup and truthful readiness/session agreement.
- **Risk:** Child caching/shutdown must not leak Pi processes; selected model changes need safe swap semantics.
- **Validation:** tests with two model/thinking tuples prove probe keying and shutdown; invalid executable fails closed with actionable detail.

### F-08 — `App.tsx` is a resource coordinator disguised as a component

- **Severity / priority:** High / Next after seam fixes
- **Confidence:** High
- **Category:** Weak module boundary, lifecycle coupling, bundle regression
- **Evidence:**
  - `App.tsx` is 1,169 lines and changed in 32 of the last 100 commits.
  - Lines `78-136` maintain 15 React states and more than 25 refs for session, transport, capture, recording, settings, custom voice, clocks, and callbacks.
  - It composes fake/real runtimes (`:206-377`), recovers sessions (`:397-454`), starts/rolls back (`:485-572`), pauses/stops (`:589-745`), polls recordings, reconciles catalogs/custom voices (`:793-915`), owns settings storage (`:917-989`), and renders routes.
  - Web entry now bundles session runtime imports eagerly through App; build produced a 513.97 kB main chunk and warning, contradicting `docs/build-performance.md:47-58` (376.08 kB/no warning).
  - Exploratory no-unused check found `composeFakeSession`’s `settings` parameter unused (`App.tsx:206`).
- **Why it matters:** Changes to one lifecycle cross unrelated settings/routes; stale closure/resource races are hard to review; fake test wiring is in production App; lazy UI routes do not defer runtime modules.
- **Lean recommendation:** First land ARC-001/002/005/008/009/011. Then ARC-013 extracts one `LiveSessionRuntime` owner without changing reducers/transports/stores internally. App retains routes/settings and subscribes to snapshots.
- **Expected payoff:** Smaller blast radius, explicit teardown API, testable lifecycle, lower eager bundle.
- **Risk:** High if attempted before seams settle; use move-first, behavior-preserving diff and full E2E.
- **Validation:** unit lifecycle tests plus all web units/E2E; no duplicate capture/store/Pi session; bundle warning recorded, not hidden by limit change.

### F-09 — IndexedDB ownership can race and future upgrades can block

- **Severity / priority:** High / Now–Next
- **Confidence:** High static lifecycle defect
- **Category:** Resource ownership, storage extensibility
- **Evidence:**
  - Every store opens its own connection through `openPodcasterDatabase` (`schema.ts:75-140`); no `db.onversionchange` closes stale handles.
  - `SettingsStore` has no `close` method (`settings-store.ts:105-142`).
  - Two mount effects independently open/load `CustomVoiceStore` (`App.tsx:938-970` and `:972-989`). Both use `ref.current ?? await open()`, allowing concurrent opens before either assigns; one handle can be overwritten/leaked.
  - App, SessionIndex, StoppedSession, recording export, and live recording open additional connections. Current `onblocked` simply rejects (`schema.ts:139`).
- **Why it matters:** React StrictMode/races can leak connections; a future DB version can be blocked by the application’s own old handles or another tab, making migrations fail.
- **Lean recommendation:** ARC-009 adds version-change close, close symmetry, and one custom/settings bootstrap effect. Do not introduce a generic repository framework yet.
- **Expected payoff:** Safe migrations, deterministic cleanup, fewer App races.
- **Risk:** Closing a shared handle accidentally if ownership remains ambiguous; keep each wrapper’s ownership explicit.
- **Validation:** fake-indexeddb test triggers versionchange/reopen; StrictMode E2E/mocked test observes one open per owner; existing migration tests pass.

### F-10 — A synchronous admission wait can block the Python asyncio server

- **Severity / priority:** High / Next
- **Confidence:** High by call-path inspection
- **Category:** Concurrency safety, brittle coupling
- **Evidence:**
  - `SelectedAudioRuntime.open_tts` waits on a `threading.Event` for up to 10 seconds when two TTS streams are retained (`runtime.py:619-673`).
  - `SidecarServer._handler` calls it synchronously in the asyncio message loop (`server.py:250-261`).
  - Host `AudioClient` already queues a third stream and sends no wire command until a slot frees (`AudioClient.ts:241-252,296-308`), so normal coordinated clients avoid the wait; malformed/other clients can still stall health and all connections.
- **Why it matters:** A defensive bound must not freeze the event loop it protects. Cancellation/health messages cannot be processed while blocked.
- **Lean recommendation:** ARC-010 dispatches this potentially blocking call with `asyncio.to_thread` while retaining runtime fences and tests. Do not redesign runtime state in this task.
- **Expected payoff:** Sidecar remains responsive under saturation with minimal code change.
- **Risk:** Stream close can race an in-flight open; preserve per-connection message serialization and add focused tests.
- **Validation:** while saturated open waits in a thread, event-loop heartbeat/health coroutine advances; existing replacement fence tests pass.

### F-11 — Production audio configuration is owned by benchmark/docs paths and verification is repeated

- **Severity / priority:** Medium / Next
- **Confidence:** High
- **Category:** Dependency direction, duplication
- **Evidence:**
  - Production constants point to `benchmarks/configs/stt/nemotron-320ms.yaml`, `benchmarks/configs/tts/kokoro-cuda.yaml`, `benchmarks/configs/tts/qwen3-1.7b.yaml`, and `docs/model-manifest.json` (`runtime.py:31-41`).
  - Production hardcodes hashes of those benchmark files, then implements three similar `_verified_*_config` methods (`runtime.py:1086-1215`).
  - Benchmark `tts_runner._verified_tts_config` is another 140-line verifier (`benchmarks/harness/tts_runner.py:195-334`); adapters also verify distribution/source.
- **Why it matters:** Documentation/benchmark edits can break production startup; ownership direction is inverted; model identity rules are hard to change safely across copies.
- **Lean recommendation:** ARC-014 moves selected runtime inputs under `services/audio/config/`, points benchmark commands to them, and extracts only common manifest/file verification. Preserve modality-specific and adapter runtime attestations.
- **Expected payoff:** Clear owner and smaller runtime hotspot; fewer hash rules to update.
- **Risk:** Historical benchmark reproducibility depends on exact paths/content. Move with git history, update commands/ADRs, do not rewrite accepted result artifacts.
- **Validation:** hashes unchanged, model verifier and runtime tests pass, benchmark source-state expectations updated intentionally.

### F-12 — Repository truth and accepted-decision numbering are stale

- **Severity / priority:** Medium / Now–Next
- **Confidence:** High
- **Category:** Documentation/tooling consistency
- **Evidence:**
  - README title and line `26` claim a Milestone 0 skeleton that does not request microphone, connect Pi, or retain history; current code does all of these.
  - `docs/build-performance.md:3` says `pnpm dev` runs `scripts/dev.mjs`; package script uses `dev-hmr.mjs` (`package.json:16`). Its 376 kB/no-warning measurement is false today; observed 513.97 kB warning.
  - Two files are Decision 007: multipart (2026-08-10) and TTS selection (2026-08-16); consent is Decision 008.
  - `scripts/fixtures/multi-turn-utterances.json` stores absolute `/home/soleone/...` source paths generated by `build-multiturn-audio.py:41`.
  - `test-results/.last-run.json` is tracked Playwright output and not ignored.
  - Generator freshness ignores two generated files; benchmark schema copies are maintained manually.
- **Why it matters:** Fresh agents follow false setup/validation guidance and modify the wrong workflow; machine paths and generated outputs create needless churn.
- **Lean recommendation:** ARC-012 updates only current truth, renumbers later ADRs without rewriting decisions, stores relative fixture provenance, ignores/removes transient test results, and documents generated owners.
- **Expected payoff:** Durable handoff and fewer false investigations.
- **Risk:** ADR links/comments must be updated atomically; do not alter historical conclusions.
- **Validation:** documented commands run; no absolute repository path remains; link scan and git status clean after Playwright.

### F-13 — Verified dead code and premature surfaces obscure live behavior

- **Severity / priority:** Medium / Next
- **Confidence:** High for named entries
- **Category:** Dead code, unnecessary abstraction
- **Evidence:**
  - Dead conversation variant/render path: `ConversationItem.kind='continuation'` (`conversation.ts:7`) and branch (`conversation-item.tsx:106`) have no producer; tests assert none.
  - Dead reducer event `capture.endpoint` (`state.ts:40`) has no emitter/schema.
  - Unused service transition state machine (`service-status.ts:17-31`) is tested but never called.
  - Unused settings aliases/helpers (`settings-model.ts:176-177,195-197`), `sidecarHealth` (`process.ts:89-97`), `BuildOptions.researchPi` (`app.ts:28`), `validReasoning` and `PiEvent` import (`SessionOrchestrator.ts:4,151-158`), `currentBinding` (`websocket-transport.ts:336-339`), `SttCancelled`/`TtsCancelled`, and STT-only `synthesize` stubs.
  - Unused UI primitives: `collapsible.tsx`, `scroll-area.tsx`, `switch.tsx`, `tooltip.tsx` have no consumers.
- **Why it matters:** Cheap models infer behavior and extension points from dead symbols; tests can preserve abstractions no product uses.
- **Lean recommendation:** ARC-011 deletes only entries proven by import/emitter search and no-unused checks. Do not combine with behavior refactors.
- **Expected payoff:** Lower cognitive surface and establishes a safe no-unused baseline.
- **Risk:** Some exported private-package symbols may be used by external ad hoc scripts; repository is private and search found none, but keep each deletion independently revertible.
- **Validation:** full typecheck/tests/build/E2E; `rg` confirms no references; no new aliases.

### F-14 — Test/dev tooling repeats expensive lifecycle work and lacks enforcement

- **Severity / priority:** Medium / Later
- **Confidence:** High
- **Category:** Test performance, standards
- **Evidence:**
  - Each of ten E2E spec files starts/stops its own `scripts/dev.mjs` server (`apps/web/e2e/support/dev-server.ts:5-21` and per-file `beforeAll/afterAll`), rebuilding web/host repeatedly. Full E2E passed but took 2.1 minutes for only 24 tests.
  - `scripts/dev.mjs:9-68` and `dev-hmr.mjs:14-100` duplicate process-group lifecycle logic. Cleanup tests exercise only `dev.mjs` (`dev-cleanup.test.mjs:31-33`).
  - No `.github/workflows`, ESLint/Biome/Prettier config, `.editorconfig`, or Python format gate. Exploratory Ruff format would rewrite 39 files; no-unused checks found live dead code.
- **Why it matters:** Slow tests discourage running them; untested duplicated cleanup can diverge; lack of a minimal automated gate lets generated/package issues recur.
- **Lean recommendation:** ARC-015 shares one fake-service server for the fake project and keeps the real readiness test isolated. Later extract process-group helper and test both launchers. Add CI only for the fast, model-free gate once ARC-003 is complete; do not require GPU/model downloads.
- **Expected payoff:** Faster feedback and lower lifecycle drift.
- **Risk:** Shared server tests must keep browser contexts/storage isolated. Formatting enforcement must not introduce an enormous formatting-only diff.
- **Validation:** same 24 tests, materially lower setup count/time, forced server crash still fails tests and cleanup leaves no descendants.

## Explicit duplication inventory

| Duplication | Locations | Harmful or acceptable? | Decision |
|---|---|---|---|
| Pi RPC queue/framing/process/cancellation | `PiClient.ts` and `PiResearchClient.ts` share most of ~250 lines | Harmful today, but research is a deletion candidate | **Do not consolidate before ARC-001/product checkpoint.** If research survives, extract one transport; otherwise delete it |
| Persona defaults/concepts | `persona/defaults.ts` vs `settings/persona.ts`; Browser/Orchestrator split | Harmful conceptual duplication | One editable settings persona; structured defaults supplied by parser |
| Host event model | schemas, generic host `SessionEvent`, generic web `StableEvent`, web validator | Harmful competing owner | Generated `HostEvent`, typed boundary, validator parity |
| Benchmark schema files | five byte-identical pairs under contracts/results | Harmful manual mirror | Generate/copy publication mirror from contracts and check all outputs |
| Settings validation | contracts validators, `SettingsStore` normalizers, host model parser, AudioClient catalog checks | Mixed | Consolidate same-trust persistence helpers; retain host/sidecar revalidation across trust boundaries |
| Custom voice constants/validation | TS settings, JSON Schema, host route, Python validator, browser store | Mostly acceptable defense-in-depth; numeric drift risk harmful | Keep validation on each trust boundary; add parity tests/generated constants, stop hardcoded `3000/20000` in store |
| WAV encoding | host `sidecar/wav.ts`, web `voice-enrollment/wav.ts`; `WAV_HEADER_BYTES` also contracts/Python | Harmful small duplicate; cross-language header repetition acceptable | Later move browser/Node PCM16 WAV writer to browser-safe contracts; Python decoder retains own format validation |
| Float→PCM16 | `audio/pcm.ts` and `voice-enrollment/wav.ts` | Harmful | Reuse `audio/pcm.ts` |
| UUIDv7 | host BrowserSession, host orchestrator, web envelope, Python runtime | Host pair harmful; cross-runtime repetition acceptable | Share host helper; keep browser/Python implementations with fixture parity |
| Model acquisition | two Qwen acquisition scripts are near-identical; Kokoro shares digest/temp pattern | Harmful | Later one manifest-driven acquirer; keep model descriptors/data separate |
| Model/source verification | audio runtime, TTS adapters, benchmark harness, historical spikes | Mixed | Centralize safe path/file hash; retain adapter runtime attestation and historical spike self-containment |
| Cancellation token | benchmark `CancelToken`, audio runtime `CancellationToken`; unused base exceptions | Harmful small duplicate | Later put production token under audio service and let benchmark depend on it, or delete unused exceptions first |
| STT adapter implementation | Nemotron/Parakeet counted/partial lifecycle is similar | Acceptable candidate-specific repetition | Do not genericize until a third selected STT exists; lifecycle details differ materially |
| TTS adapters | Kokoro/Qwen worker queues and lifecycle methods | Acceptable candidate-specific repetition | Keep separate; share only trivial verified helpers when touched |
| Dev process groups | `dev.mjs` and `dev-hmr.mjs` | Harmful; HMR path untested | Later shared helper plus both-path cleanup tests |
| Test fakes | audio tests import fakes from sibling test modules; host tests repeat fake clients | Mildly harmful | Move only broadly reused Python fakes to `tests/support.py`; avoid a generic mock framework |
| Docs | README, build-performance, ADRs, evidence artifacts | Historical repetition is acceptable; stale current docs harmful | README is current truth; ADRs immutable except status/number/link corrections; evidence remains historical |

## Explicit over-engineering inventory

### Complexity not earning its current keep

1. **Multipart research coordinator and compatibility stack:** separate Pi child, two assemblers, parent/part state, two-stream host queue, sidecar fences, output stream maps, queued browser playback, part-aware recording/schema fields. It is technically well tested but serves an authoritative non-goal/default contradiction.
2. **Custom-voice productization:** consent copy, recorder/upload, browser blobs, restore synchronization, model-scoped catalogs, isolated clone backend, CRUD relay. It serves an explicit non-goal pending disposition.
3. **Unused service-state transition machine:** state transition table/function/tests with no caller.
4. **Dead compatibility presentation:** continuation marker type/render/tests after UX removed its producer.
5. **Aliases/helpers with no consumers:** TTS reconciliation alias, speed helper, sidecar health wrapper, research BuildOption, unused UI primitives.
6. **Generic benchmark adapter surface:** STT adapters implement impossible `synthesize` stubs solely because an old generic protocol contains both methods; selected STT/TTS runners already use specific APIs.
7. **Configuration surfaces without truthful composition:** editable Pi model plus fixed readiness client; optional research fields/default-on booleans in multiple constructors.
8. **App-level coordinator:** not over-abstraction but accidental complexity concentrated in React state/refs instead of one runtime owner.

### Under-engineered areas where consolidation would be unsafe

- **Barge-in/playback state:** host and browser state machines are complex because they linearize independent VAD, TTS, playback, persistence, reconnect, and cancellation streams. Do not replace them with a generic event bus or one global state machine.
- **Sidecar process isolation:** Qwen’s Transformers/runtime conflict with Nemotron justifies an isolated interpreter and explicit worker protocol.
- **Trust-boundary validation:** browser→host, host→sidecar, and sidecar model-input validation should remain repeated even after constants/types are shared.
- **Benchmark validation/history:** the large runner contains exact legacy artifact allowlists and fail-closed recomputation. Split by responsibility only when changing it; do not “simplify” accepted historical checks.
- **Local persistence accounting:** applied-event dedupe and terminal playback receipts protect durable delivered extents. Keep transactional semantics; improve types/ownership, not data integrity away.
- **Host auth:** HttpOnly cookie plus in-memory capability and Origin/Host checks are deliberate defense-in-depth, not unnecessary abstraction.

## Attractive changes that should not be attempted

- No React framework/state-library migration, monorepo tool migration, Python web-framework swap, or schema-generator replacement.
- No big-bang deletion of multipart/custom-voice fields and persisted data in the same commit that disables new production behavior.
- No generic “provider abstraction”; the PM explicitly excludes provider portability.
- No generic plugin system for speech backends; two selected candidates do not justify it.
- No global formatting-only rewrite or chunk-warning suppression. Fix ownership/eager imports; keep performance evidence honest.
- No removal of security, cancellation-race, or benchmark legacy tests merely to reduce test size.
- No moving all schemas into TypeScript or all settings into JSON Schema; current browser-safe semantics and cross-language schemas have different jobs.
