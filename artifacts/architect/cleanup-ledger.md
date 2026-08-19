# Cleanup ledger

Back to [index.md](index.md). This ledger is evidence, not permission to batch-delete. Execute only the named task card and its prerequisites.

Confidence: **High** = repository-wide reference/emitter search plus type/build evidence; **Medium** = behavior/history suggests action but compatibility/product confirmation remains; **Low** = investigate only.

## Delete

| File/symbol | Action | Confidence | Prerequisite / note |
|---|---|---:|---|
| `test-results/.last-run.json` | Untrack; ignore `test-results/` and `playwright-report/` | High | ARC-012; transient Playwright output, current E2E recreates it |
| `ConversationItem` continuation variant (`conversation.ts:7`) | Delete | High | ARC-011; no producer, reducer/tests assert zero markers |
| Continuation render branch (`conversation-item.tsx:106`) | Delete | High | Same task; update pure render test |
| `capture.endpoint` reducer branch (`state.ts:40`) | Delete | High | No emitter, schema, command, or fixture |
| `SERVICE_STATE_TRANSITIONS`, `canTransitionServiceState` and transition-only tests | Delete | High | No production caller |
| `reconcileTtsSettings` alias (`settings-model.ts:176-177`) | Delete | High | No caller |
| `speedCapabilityForCatalog` (`settings-model.ts:195-197`) | Delete | High | No caller |
| `sidecarHealth` (`apps/host/src/sidecar/process.ts:89-97`) | Delete | High | No caller; retain `sidecarSnapshot` |
| `BuildOptions.researchPi` (`apps/host/src/server/app.ts:28`) | Delete | High | No runtime read; tests already pass explicit factory |
| `validReasoning` and unused `PiEvent` import (`SessionOrchestrator.ts:4,151-158`) | Delete | High | Confirm no new typed-boundary use first |
| `WebSocketSessionTransport.currentBinding` (`websocket-transport.ts:336-339`) | Delete | High | no-unused and search confirmed |
| `SttCancelled`, `TtsCancelled` | Delete | High | No imports/usages |
| STT adapter `synthesize` stubs | Delete | High | Generic benchmark protocol is not used for selected STT runners |
| `components/ui/collapsible.tsx` | Delete | High | Zero imports |
| `components/ui/scroll-area.tsx` | Delete | High | Zero imports; also unused React import |
| `components/ui/switch.tsx` | Delete | High | Zero imports |
| `components/ui/tooltip.tsx` | Delete | High | Zero imports |
| Old `artifacts/architect/recording-feature.md` | Remove as superseded architecture artifact | High | This audit replaces architect entry point; history remains in git |

## Merge / consolidate

| Current surfaces | Target owner | Confidence | When |
|---|---|---:|---|
| Host `SessionEvent`, web `StableEvent`, web `Envelope` trust-boundary use, `CoreEvent` broad validator | Generated `HostEvent` + `BrowserCommand` + narrow persisted union | High | ARC-004/005 |
| `DEFAULT_PERSONA_MARKDOWN` runtime fallback and `settings.persona` | Frozen `SessionSettingsSnapshot.persona` parsed and appended | High | ARC-002; default fixture may remain for parser tests |
| Two App custom-voice bootstrap effects | One settings/custom-resource bootstrap and cleanup effect | High | ARC-009 |
| App transport/controller/capture/recording refs and teardown | `LiveSessionRuntime` | High design, Medium implementation risk | ARC-013 after prerequisites |
| Five benchmark result schema copies | Contracts schemas copied/generated to publication path | High | ARC-012 or generator substep after ARC-003 |
| Host/browser WAV writers | Browser-safe contracts utility | Medium | Later, after ARC-006 |
| Web voice-enrollment and audio float→PCM16 | `apps/web/src/audio/pcm.ts` | High | Later small cleanup |
| Host duplicate UUIDv7 functions | Host utility or injected event factory | Medium | After ARC-005; avoid cross-runtime abstraction |
| Qwen CustomVoice/Base acquisition scripts | One manifest-driven acquirer | High | Later after ARC-014 |
| Dev process-group functions in `dev.mjs` / `dev-hmr.mjs` | `scripts/process-group.mjs` | High | Later; add cleanup tests for both launchers |
| Runtime `_verified_stt_config/_verified_tts_config/_verified_qwen_config` common path/hash work | Audio service config verifier | High | ARC-014; keep modality rules separate |
| Benchmark/runtime cancellation token mechanics | Production audio cancellation utility used by benchmark | Medium | Later; first delete unused exception classes |
| Python test fakes imported from sibling test modules | `services/audio/tests/support.py` | Medium | Only when touching those tests |

## Move / rename

| Current | Target | Confidence | Guard |
|---|---|---:|---|
| `benchmarks/configs/stt/nemotron-320ms.yaml` | `services/audio/config/nemotron-320ms.json` (extension may remain `.yaml` to minimize churn) | High ownership | Preserve bytes/hash; update benchmark commands |
| `benchmarks/configs/tts/kokoro-cuda.yaml` | `services/audio/config/kokoro-cuda.yaml` | High ownership | Preserve bytes/hash |
| `benchmarks/configs/tts/qwen3-1.7b.yaml` | `services/audio/config/qwen3-1.7b.yaml` | High ownership | Preserve bytes/hash |
| `docs/model-manifest.json` | `services/audio/config/model-manifest.json` | Medium | Move only if all evidence/acquisition links are updated; historical ADR text can retain old path as historical statement |
| Live runtime blocks in `App.tsx:206-377,485-745` | `apps/web/src/session/live-runtime.ts` | High design | Move-first; no reducer/store rewrite |
| Fake runtime/test API in `App.tsx:45-71,206-269,467-483` | fake-only live-runtime module | High | Ensure fake mode is dynamically imported or tree-shaken |
| `docs/decisions/007-tts-selection.md` | `008-tts-selection.md`, heading Decision 008 | High | Multipart 007 predates it |
| `docs/decisions/008-consent-local-voice-enrollment.md` | `009-consent-local-voice-enrollment.md`, heading/comments Decision 009 | High | Update `custom-voice.ts:8` reference |

## Retain

| File/symbol | Confidence | Rationale |
|---|---:|---|
| `packages/policy` package | High | Cohesive deterministic policy boundary with small API/tests |
| JSON Schemas + TS/Python generation | High | Cross-language trust boundary earns generation cost; add missing HostEvent rather than replace |
| `ReasoningSpeechAssembler` | High | Progressive sentence-safe single response path; substantial focused tests |
| `InterruptionIntentClassifier` heuristics/model classifier | High | Complex but central barge-in behavior with 84 focused tests; do not genericize |
| Host/browser playback and interruption ledgers | High | Independent async streams require explicit accounting/race guards |
| Cookie + capability + Origin/Host auth | High | Deliberate local security boundary, strongly tested |
| Qwen isolated subprocess protocol | High while Qwen/custom clone retained | Real dependency conflict between Transformers runtimes |
| Per-boundary custom voice validation | High while subsystem retained | Browser/host/sidecar are separate trust boundaries; share constants, not trust |
| `RecordingStore`, `StableTurnWriter` transactions/receipts | High | Durable local behavior and delivered-audio accounting |
| Large benchmark validators and accepted legacy hash allowlist | High | Historical reproducibility; split only with evidence-preserving tests |
| Historical spikes and evidence artifacts | Medium–High | Self-contained decision evidence; do not import into production |
| Vendored ORT proxy wheel + deterministic builder | High | Solves package-name conflict documented in `pyproject.toml`; small metadata artifact |
| Test race/security suites | High | High maintenance value; do not delete for line-count reduction |

## Conditional deletion after explicit checkpoint

| Surface | Confidence that it is outside target | Blocker | Safe order |
|---|---:|---|---|
| `PiResearchClient.ts` and tests | High under authoritative PM | One release with ARC-001 default-off; product reauthorization decision | Delete research client after orchestrator no longer references it |
| `ResearchPartAssembler.ts` and tests | High under authoritative PM | Same | Delete with host research orchestration task |
| Multipart branches/state in `SessionOrchestrator` | High under authoritative PM | Compatibility/recording policy | Remove producer first, then tests specific to production generation |
| Host `AudioClient` two-stream admission queue | Medium–High after no multipart producer | Voice preview uses separate client/stream; verify no other producer | Simplify host side first; keep sidecar defensive bound |
| Web multipart playback groups/maps | Medium after no live producer | Existing persisted/read-only recordings and fake tests | Retain recording `partIndex`; simplify live scheduler separately |
| Multipart optional schema fields/events | Medium | Compatibility window/protocol deployment | Remove last, with protocol version decision if needed |
| Custom enrollment/rename/upload UI/API | High product non-goal | PM amendment vs retirement UX; existing local data | Stop new enrollment first, retain list/delete |
| Qwen Base clone backend/runtime assets | High if custom voices retired | No stored/session custom voice use | Remove after data path expires; retain stock Qwen CustomVoice backend if selected |

## Investigate only

| Surface | Confidence | Question / evidence needed |
|---|---:|---|
| MP3 recording/trim/export subsystem | Low for deletion | Is it intended product scope or prototype study tooling? Keep until PM decision |
| `CoreEvent` future role | Medium | Retain as event-name catalogue or replace references with HostEvent/BrowserCommand/SidecarMessage; do not repurpose silently |
| `DEFAULT_PERSONA_MARKDOWN` after ARC-002 | Medium | It may remain valuable as golden parser/default fixture even when no longer runtime fallback |
| Python type checking | Low immediate payoff | Assess after runtime config extraction; current dynamic ML APIs may make strict checker maintenance expensive |
| CI provider/workflow | Medium | Repository hosting assumptions unknown; add only model-free fast check |
| Bundle split beyond live-runtime extraction | Low before measurement | Re-measure after ARC-013; do not add manual chunks preemptively |
| `spikes/pi-rpc/process-group.ts` | Medium | Host test imports it despite spike location; either move tested utility into host/scripts or keep as accepted spike fixture |
| `scripts/fixtures/multi-turn-utterances.raw` | Medium | Keep licensed real-stack fixture if reproducibility requires it; add hash/relative provenance rather than delete blindly |
