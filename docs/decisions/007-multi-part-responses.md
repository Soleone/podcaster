# Decision 007 — Multi-part voice responses use a separate Pi research mode

**Status:** accepted and implemented — epic `ap6` (2026-08-10). Per PM direction (ARC-001), multi-part mode is default-off in production and is enabled only by explicit opt-in.
**Date:** 2026-08-10

## Decision

A multi-part assistant response has one parent `responseId` and ordered zero-based `partIndex` values. The fast acknowledgement is **part 0**, not a pre-response: it uses the existing 45-word, no-tool Pi request unchanged. Body parts are indices 1–7 and come from a second, separately owned Pi RPC child in `research` posture. Every part has its own TTS stream, `playbackId`, playback ledger, and agent recording item. Playback and interruption are response-scoped even though accounting is part-scoped.

The legacy single-part path is the degenerate case. It omits `partIndex` and `partId`, emits no `response.part_*` events, and preserves today's request, event payloads, one TTS stream, one playback ledger, storage shape, and UI behavior exactly. Multi-part behavior is enabled only by an explicit orchestrator option/feature gate.

This keeps low-latency acknowledgement independent of tool use and long generation while preserving one user-visible assistant response.

## System design (components + responsibilities)

### Part model

```ts
type ResponsePartRef = {
  responseId: UUID;       // parent identity; stable for the whole answer
  partIndex: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  partId?: UUID;          // optional opaque correlation ID, never the parent key
};
```

The canonical identity is `(responseId, partIndex)`. `partId` is an optional correlation value for logs/imports; ordering, grouping, storage, and replay must not depend on it. The first implementation may omit it. Child `responseId` values are rejected because they would force every interruption, persistence, and UI consumer to reconstruct parenthood.

For multi-part responses:

- Part 0 has `kind: "stall"`; parts 1–7 have `kind: "body"`.
- Maximum parts: **8 total**: one stall plus at most seven body parts.
- Stall limit: the existing **45 words**.
- Research body limit: **600 words** and **256 KiB UTF-8**, with a **180 s** request deadline.
- Body part limit: **90 words**, **4,096 characters**, and at most **3 sentences**. A single sentence over 90 words is invalid rather than split mid-sentence.
- The parent posture remains `riff | question | challenge`. The body continues that posture and must not repeat the stall. For `question`, the whole parent has one question-mark budget: if part 0 contains `?`, body parts may contain none.
- Deltas are cumulative within one part, not cumulative across the parent. Concatenating authoritative part finals in ascending index order with one space gives the parent text.

The stall is part 0 because it is spoken assistant content, must appear in the same bubble, must be interruptible with the body, and must be independently recordable. A separate pre-response would create a second lifecycle that later has to be merged everywhere.

### Stall-to-body handoff

1. The orchestrator creates the parent `responseId`, emits `response.part_started(kind=stall, partIndex=0)` and the part-aware reasoning events, then calls the existing `PiClient.request({... maxWords: 45})` path.
2. The stall uses the existing `ReasoningSpeechAssembler` and existing progressive `speech.begin/append/finish` behavior. Its prompt and spawn argv remain unchanged.
3. Only after part 0 validates and its TTS stream has been committed does the orchestrator emit `response.part_final` for part 0 and submit the body request to the research child. It does **not** wait for part 0 playback to finish. Research latency therefore overlaps stall synthesis/playback without competing with the acknowledgement request.
4. The body request includes the validated stall text and says to continue without restating it. A new `ResearchPartAssembler` withholds the incomplete trailing sentence, releases only sentence-complete cumulative previews, and deterministically groups safe sentences into indices 1–7 under the limits above. Model-authored delimiters are not trusted.
5. For every completed body part, the orchestrator emits the part lifecycle and reasoning events and starts TTS. Body reasoning generation is one ordered research stream in v1. TTS generation overlaps playback with a window of **two nonterminal streams**: the audible part and one prefetched successor. The coordinator accepts out-of-order ready results, but `playCursor` alone controls audible order.
6. The response completes only when research generation is terminal and every started part has an authoritative `playback.stopped` receipt. Full successful completion adds the concatenated parent text to bounded context once. Partial or interrupted responses do not enter context, preserving today's full-playback rule.

### Ordered TTS and browser playback

`SpeechOutputPort.begin` becomes part-aware without replacing the legacy call:

```ts
begin({ sessionId, epoch, responseId, partIndex?, partId?, signal, onGeneratedSamples }): SpeechOutputStream
cancel({ responseId, partIndex? }): void // omitted partIndex cancels the parent
release({ responseId, partIndex? }): void
```

`AudioClient` keys `PendingTts` by `responseId:partIndex` when `partIndex` exists and by `responseId` otherwise. The same optional fields are echoed through `tts.open`, `tts.append`, `tts.commit`, `tts.cancel`, `tts.started`, `tts.ended`, and `tts.cancelled`. This allows two streams for one parent without inventing child response IDs. The current sidecar bound of two TTS workers becomes the prefetch window; a third stream is not opened until the oldest is remotely terminal.

Parallel output requires binary stream routing. Multi-part `tts.started` therefore carries sidecar `outputStreamId`. `apps/web/src/session/websocket-transport.ts` replaces its single `output` binding with a map keyed by the binary frame's uint32 `streamId`. The legacy event may omit `outputStreamId` and retains the current single-binding path.

The browser owns one `ResponsePlaybackQueue` per parent response. It owns one `AudioContext` and gain node, plus one existing-style `PlaybackLedger` per part/playback. PCM for future parts is accepted and buffered immediately. It is not scheduled until predecessor `tts.ended` proves the predecessor's final contiguous extent. At that point it reuses `scheduledUntil`/`nextStartTime` and schedules the successor at the predecessor's exact audio tail while that tail is still playing. It never waits for the predecessor's `playback.stopped` round trip. If successor PCM is late, scheduling uses `max(context.currentTime, nextStartTime)` and records an underrun; it never reorders parts.

Each part keeps local sample offsets beginning at zero and has its own `playbackId`. The host's existing `Map<playbackId, PlaybackLedger>` remains the accounting authority; an added `(responseId, partIndex) -> playbackId` map supplies grouping. Completion, progress, and terminal receipts remain independently idempotent by playback identity.

### Interruption across parts

The response, not the individual part, owns pause/resume/takeover.

- The **active part** is the lowest-index nonterminal part whose source is currently rendering. At a boundary it is the lowest scheduled nonterminal part; if nothing has been scheduled, it is the lowest buffered/expected part.
- On speech start, the browser suspends the response queue's shared `AudioContext`, silencing the current part and all scheduled successors together. The browser's `playback.paused` checkpoint identifies the authoritative active `partIndex`, `partId` if present, and `playbackId`; the host's earlier provisional event may omit part identity if it cannot know the exact boundary yet.
- The classifier receives finalized preceding-part text plus the current part's canonical prefix, and part-local `pausedSampleOffset/generatedSamples`. Queued future text is not described as delivered.
- `resume` resumes the one response queue and all still-valid queued parts. It creates no new response or continuation row.
- `accept`, Stop, supersession, and confirmed barge-in abort both Pi children for this parent, cancel every open/current/queued TTS part, and stop the browser queue. The current part reports its actual final played offset; scheduled or buffered successors report `cancelled` with offset 0 if none of their samples rendered.
- Takeover waits for terminal receipts from **all playback IDs known at the cancellation cutoff**, not only the active part. The existing **3,000 ms** provisional timeout is the bounded fallback. Late old-epoch receipts remain accounting-only and cannot revive the parent.
- A future-part failure cancels that part and all higher indices but lets already scheduled lower parts finish. `response.failed` identifies the failed part. A stall failure starts no research request and follows today's whole-response failure path.

`barge_in.*` and `interruption.decision` remain parent-scoped through `responseId`; optional part fields report where interruption occurred. The decision action always applies to the parent and all remaining parts.

### Recording and persistence

Every TTS part produces one `StoredRecordingItem` with `role: "agent"`, the parent `responseId`, its own `playbackId`, and nullable `partIndex/partId`. Part 0 is a separate recording item. Pause/resume updates the same item. Trim, delete, and export operate on the item boundary, so a user can trim/export one part without rewriting adjacent audio.

IndexedDB moves to version **5** and adds `responseParts`, keyed by `sessionId:responseId:partIndex`, with indexes on `sessionId`, `turnId`, `responseId`, `playbackId`, and `partIndex`. It stores part kind, text, playback accounting, and terminal state. `StoredTurn.responseId` remains the parent; for multipart responses its scalar `assistantText` may be a materialized ordered join for compatibility, while scalar `playbackId` is null. `responseParts` is authoritative. Existing version-3 rows require no data rewrite and are read as legacy single-part responses.

`recordingItems` adds nullable `partIndex` and `partId` plus an index on `[responseId, partIndex]`. `recordSeq` follows audible part order, not completion order.

### UI presentation

The web UI renders exactly one assistant conversation row per parent `responseId`. Inside its existing bubble:

- each finalized part is a paragraph in index order;
- the currently streaming part reuses the existing dim tentative-to-solid transition;
- a subtle paragraph boundary separates parts; there are no separate assistant bubbles or continuation markers;
- the bubble's aggregate playback badge is `preparing`, `playing`, `paused`, `completed`, or `interrupted` for the whole parent;
- takeover retains finalized parts, removes an unfinalized tentative suffix, and marks the parent interrupted;
- reload reconstructs the same row from `responseParts`; legacy rows use today's scalar fields.

No source/tool trace or hidden reasoning is rendered or spoken. Tool output influences only validated body text.

## Key decisions & tradeoffs

- **Separate Pi processes, not a mode switch in one child.** Pi RPC has one active lifecycle and serialized ownership. Separate children prevent tool work and a 180-second body deadline from delaying or corrupting the no-tool stall.
- **Part 0 is the stall.** This gives recording, interruption, storage, and UI one model. It costs part-aware events on the acknowledgement in multi-part mode.
- **Parent plus index, not child response IDs.** Ordering and grouping are explicit and stable. An optional `partId` remains available for external correlation without becoming required state.
- **Read-only research tool allowlist.** The research child argv is `--mode rpc --no-session --tools read,grep,find,ls --no-extensions --no-skills --no-prompt-templates --no-context-files --no-approve --model <pinned>`. Omitting `--no-tools` and supplying `--tools` enables only those four built-ins; `bash`, `edit`, and `write` remain unavailable. This is less capable than arbitrary shell/web research but avoids voice-prompt-driven code execution or writes.
- **Deterministic local parting.** Sentence-based local segmentation avoids trusting model delimiters and keeps schema/accounting bounds enforceable. It may produce uneven part lengths.
- **Two-stream prefetch.** It matches the current sidecar replacement bound and limits memory. More concurrency adds little because browser playback remains serial.
- **Shared browser scheduler, separate ledgers.** A single `AudioContext` permits sample-contiguous scheduling; per-part ledgers preserve interruption, recording, and export granularity.

## Interfaces / contracts (the seams between tasks)

### Canonical schema changes

All new properties use `additionalProperties: false` like the existing schemas.

1. Add `events/response-part-started.json` for `response.part_started` and `events/response-part-final.json` for `response.part_final`.
   - Required payload: `turnId` UUID, `responseId` UUID, `partIndex` integer, `kind` enum `stall | body`.
   - Optional: `partId` UUID.
   - `oneOf` enforces `stall` with index exactly 0, or `body` with index 1–7.
   - `response.part_started` is emitted immediately before that part's `reasoning.started`.
   - `response.part_final` is emitted immediately after validated `reasoning.final` and local `speechStream.finish()`. Failure/cancellation emits no part final; `response.failed` supplies the terminal reason.

2. Add optional `partIndex` (integer 0–7) and `partId` (UUID) to `reasoning-started.json`, `reasoning-delta.json`, `reasoning-final.json`, `tts-started.json`, `tts-ended.json`, and `response-failed.json`.
   - `dependentRequired: { partId: [partIndex] }` rejects an ungroupable `partId`.
   - In multipart mode these events always include `partIndex`; in legacy mode both are absent.
   - Existing `reasoning.delta.text` remains cumulative for one part and bounded to 4,096 characters.

3. Add optional `outputStreamId` to `tts-started.json`, integer 0–4,294,967,295. A schema `if` requiring `partIndex` then requires `outputStreamId`; legacy events may omit both. Add the same part fields to the TTS variants in `sidecar-message.json`, with the sidecar required to echo them unchanged.

4. Add optional `partIndex`, `partId`, and `playbackId` to `barge-in.json`; add optional `partIndex` and `partId` to `interruption-decision.json` and `playback-paused.json`. Apply the same 0–7 bound and `partId -> partIndex` dependency. Because these payloads have no structural multipart discriminator, the schemas keep the fields optional; the host/controller runtime validator requires `partIndex` whenever the referenced active response is multipart and verifies that it maps to `playbackId`. `playback.progress` and `playback.stopped` remain unchanged because `playbackId` already resolves the part.

5. Add `response.part_started` and `response.part_final` to `core-events.json`. Keep protocol version 1 because every change to an existing event is additive and optional for the single-part path.

6. Run `pnpm contracts:generate` and `uv run python scripts/generate_contracts.py`. Generation remains mechanical: `generate.mjs` emits TypeScript fields from the schema and the Python generator embeds the same canonical schemas. Update hand-written browser payload validation in `apps/web/src/session/websocket-transport.ts`; generated validators alone do not replace it.

### Pi client contract

The existing `PiClient`, `PiRequestInput`, `promptFor`, `handle(text_delta)`, 45-word enforcement, request deadline, and stall child `start()` argv do not change. Add a separate injected `PiResearchClient` and implementation with:

```ts
requestBody(input: {
  posture: PiPosture;
  transcript: string;             // <=16 KiB UTF-8
  boundedContext: string;         // <=16 KiB UTF-8
  personaInterpretation: string;  // <=8 KiB UTF-8
  stallText: string;              // <=4,096 chars
  maxWords: 600; maxPartWords: 90; maxParts: 7;
}, signal: AbortSignal): AsyncIterable<PiEvent>
```

The research client uses its own child, ownership lock, active lifecycle, queue, cutoff, abort, settlement, process-group cleanup, probe classification, and pinned model checks. Its response guard is 600 words/256 KiB and deadline 180 seconds. It captures only assistant `text_delta`; tool lifecycle/results are neither emitted nor spoken. Cancellation establishes the local cutoff before RPC `abort`, exactly as the current client does.

The stall path remains byte-for-byte: the same `promptFor`, exact `maxWords: 45`, current 64 KiB response bound, 60-second request deadline, and argv containing `--no-tools`. Research is started only after validated part 0 commit.

## Task breakdown (path, boundary, interface, done-criteria, dependencies, parallel-safe?)

Implementation order is fixed by the shared seams below.

1. **Decision gate — `docs/decisions/007-multi-part-responses.md`.** Boundary: this document only. Done: accepted decisions, hard limits, contracts, sequencing, interruption, recording, UI, tests, and deferrals are present. Dependency: none. Parallel-safe: no; all implementation is gated on it.

2. **Contracts — `packages/contracts/schema/events/**`, `packages/contracts/schema/events/sidecar-message.json`, generated TS/Python contracts, contract fixtures/tests, browser hand validator.** Boundary: additive part identity and lifecycle only. Done: legacy fixtures validate unchanged; multipart fixtures validate; missing/out-of-range indices, body index 0, stall index >0, partId without index, and multipart TTS without outputStreamId fail; both generators produce clean checked-in output. Dependency: 1. Parallel-safe: no; freezes shared interfaces.

3. **Pi clients — `apps/host/src/pi/**`, `apps/host/test/pi/**`.** Boundary: add separately owned research client and body bounds; do not edit stall prompt/spawn/request enforcement. Done: argv tests prove stall still contains `--no-tools` and is byte-identical, research contains the exact read-only allowlist and no write/shell tools; concurrent stall/research children do not share lifecycle; 600-word, 256-KiB, 180-second, cancellation, tool-event suppression, and child cleanup tests pass. Dependency: 2. Parallel-safe: yes with 5 and 7 after contracts freeze.

4. **Orchestrator and part assembler — `apps/host/src/session/**`, `apps/host/test/session/session-orchestrator.test.ts`.** Boundary: parent/part state, stall handoff, deterministic body partitioning, two-stream TTS prefetch, and parent completion. Done: event ordering is `part_started -> reasoning.started -> delta* -> reasoning.final -> part_final`; research begins only after stall commit; parts may become ready out of order but TTS release/play cursor is ascending; max limits fail closed; body failure preserves completed lower parts; all existing orchestrator tests stay green. Dependency: 2, 3, 5 interfaces. Parallel-safe: no once implementation starts.

5. **Speech output and ordered playback — `apps/host/src/sidecar/AudioClient.ts`, sidecar TTS runtime/tests, `apps/web/src/session/websocket-transport.ts`, `apps/web/src/audio/**`, controller/tests.** Boundary: composite pending identity, outputStreamId routing, two-stream queue, shared scheduler, per-part ledger. Done: current plus next may synthesize concurrently; a third waits; interleaved binary streams route by uint32 stream ID; a three-part fake schedules each successor at the predecessor tail with no artificial gap and reports three terminal receipts; missing successor audio records an underrun without reordering; legacy single playback tests stay green. Dependency: 2. Parallel-safe: yes with 3 and storage scaffolding in 7 after interface freeze.

6. **Response-scoped interruption — host orchestrator/server and web controller interruption tests.** Boundary: authoritative active-part checkpoint and aggregate resume/cancel. Done: barge-in during part 0, middle part, exact boundary, and prefetched future part pauses one response queue; resume continues in order; accept cancels active plus all queued parts; takeover waits for all known receipts or 3,000 ms; queued receipts report zero delivered; duplicate/late old-epoch receipts only update accounting; existing interruption regression tests stay green. Dependency: 4, 5. Parallel-safe: no.

7. **Recording and stable persistence — `apps/web/src/storage/**`, recording capture/export/trim code and tests.** Boundary: DB v4 `responseParts` plus one agent recording item per part. Done: v3 migration preserves rows; multipart text/playback reloads in order; three parts produce three recording items with one parent and distinct indices/playback IDs; trimming/exporting one does not alter neighbors; interrupted current and zero-delivered queued items persist correct extents. Dependency: 2 and playback identity from 5. Parallel-safe: storage schema can begin with 3; final accounting waits for 5/6.

8. **UI — `apps/web/src/session/state.ts`, `conversation.ts`, `SessionScreen.tsx`, conversation components and tests.** Boundary: one parent bubble with ordered part paragraphs and aggregate playback state. Done: part 0 appears first and solidifies independently; body deltas dim/solidify per part; out-of-order arrivals never reorder display; interruption removes only tentative suffix and leaves one interrupted bubble; reload matches live view; all legacy single-part, resume-marker, scroll-anchor, keyboard, and live-region tests stay green. Dependency: 2, 5, 7. Parallel-safe: reducer work may overlap 6 after contracts freeze.

Final gate command set: `pnpm contracts:generate`, `uv run python scripts/generate_contracts.py`, focused contract/host/web/Python tests, then `pnpm check`, `pnpm test`, and `uv run pytest services/audio/tests -q`. Add one fake-service E2E with stall plus three body parts, prefetched contiguous playback, middle-part resume, and middle-part takeover.

## Implementation status

Implemented end-to-end on 2026-08-10 and gated behind `SessionOrchestratorOptions.multiPartEnabled` (with a configured `researchPi`); the single-part path is byte-for-byte unchanged when the gate is off.

- Contracts: `response.part_started` / `response.part_final` schemas; optional `partIndex`/`partId` on reasoning, tts, response.failed, barge-in, interruption, playback.paused; `outputStreamId` on `tts.started` with a conditional requirement when `partIndex` is present. Generated TS (`pnpm contracts:generate`) and Python (`uv run python scripts/generate_contracts.py`) contracts regenerated; fixtures and constraint tests added on both sides.
- Pi research client: `apps/host/src/pi/PiResearchClient.ts` spawns a second owned RPC child with `--tools read,grep,find,ls` (no write/shell tools, no `--no-tools`), 600-word / 256 KiB response bound, 180 s deadline, local-cutoff cancellation, and process-group cleanup. The stall path (`--no-tools`, 45 words, 60 s) is untouched.
- ResearchPartAssembler: deterministic sentence-based parting into body indices 1-7 under 90 words / 3 sentences / 4096 chars per part; invalid single oversized sentences and part-count overflow fail closed.
- Orchestrator: `runMultiPartResponse` emits stall (part 0) via the existing 45-word request, then body parts from the research child; parts may become ready out of order but are released/played in ascending index; each part gets its own TTS stream, playback ledger, and `tts.started/ended`; `response.part_started -> reasoning.started -> delta* -> reasoning.final -> response.part_final` ordering; research failure attributes to the failed body part and preserves the completed stall; parent text joins finalized parts into context once on full completion.
- AudioClient: composite `responseId:partIndex` pending identity, part-aware `begin/append/finish/cancel/release`, parent-scoped cancel, per-part `tts.open/append/commit/cancel/started/ended/cancelled` echoing part fields.
- Web transport: multi-output binding keyed by `outputStreamId` (legacy single-output path retained), part-aware strict event validation, interleaved binary routing, parent identity across parts.
- Web controller: per-response playback groups with sequential part playback (queued parts become audible when their predecessor reports a terminal receipt); `response.failed` and interruption stop the whole group; audio routes by playbackId.
- Web UI: one assistant bubble per response with per-part paragraphs (part boundary styling, dim-to-solid per part); state reducer accumulates parts.
- Recording: one `StoredRecordingItem` per part (role agent) with nullable `partIndex`, populated from `tts.started`.

Validation: contracts 1199 + policy 10 + host 240 + web 116 TS tests, 175 Python tests, and `pnpm check` all pass. The new host tests (`session-orchestrator-multipart.test.ts`, `research-part-assembler.test.ts`, `pi-research-client.test.ts`) cover stall-then-body ordering, per-part TTS, parent context completion, research failure attribution, parent-scoped interruption, and research argv safety.

## Evidence

The design follows the existing implementation rather than replacing its proven single-response path:

- `apps/host/src/pi/PiClient.ts:24,91,189` fixes `maxWords` at 45, enforces it, and spawns with `--no-tools`; `handle()` also rejects more than 45 words. A separate child is the only way to retain that path unchanged while enabling tools and larger output.
- `apps/host/src/session/SessionOrchestrator.ts:22,59,155,312` has one response, one speech stream, one active playback identity, and a playback map already keyed by `playbackId`. The parent/part coordinator extends those seams without changing legacy behavior.
- `apps/host/src/session/ReasoningSpeechAssembler.ts:10,141` embeds the 45-word invariant. A separate body assembler avoids weakening stall validation.
- `apps/host/src/sidecar/AudioClient.ts:8,69,143,324` keys pending TTS by response ID and buffers at most 64 chunks before release. Composite part identity and a bounded prefetch queue are required for concurrent streams.
- `apps/web/src/audio/playback.ts:27-29,67-80` already has contiguous-offset buffering and `nextStartTime`; moving those mechanics to a response queue is smaller than introducing a second playback protocol.
- `apps/web/src/session/controller.ts:39` and `apps/web/src/session/websocket-transport.ts:22` each hold one active output. Both must become part-aware before parallel TTS can be safe.
- `apps/web/src/storage/schema.ts:32,99-104` and `recording-store.ts:13` currently model one response/playback per turn/recording. A normalized part store and recording part fields are required for per-part trim/export.
- `apps/host/test/session/session-orchestrator.test.ts` has 40+ regression cases covering progressive reasoning, cancellation, barge-in, terminal receipts, failure, and context commit. It remains the mandatory legacy regression surface.

### Review findings

- **blocker:** `apps/web/src/session/websocket-transport.ts:22` has one output binding; releasing interleaved part PCM without `outputStreamId` mapping can misattribute audio. Contract/task 2 and playback/task 5 resolve this before orchestration.
- **major:** `apps/host/src/sidecar/AudioClient.ts:69,143` keys pending TTS by parent response ID, so a second part currently collides as a duplicate. Composite identity is mandatory.
- **major:** `apps/host/src/session/SessionOrchestrator.ts:59` stores one playback/text lifecycle, so interruption cannot safely aggregate queued parts without an explicit parent coordinator.
- **moderate:** `apps/web/src/storage/schema.ts:32` has scalar assistant/playback fields; using them for multiple parts would lose playback and recording granularity.
- **no blocker:** current per-playback ledgers and browser contiguous scheduling are reusable; no new audio wire format is required.

## Risks & assumptions

- Research tools are intentionally limited to Pi's read-only built-ins. Network browsing, arbitrary shell commands, write tools, extensions, citations, and source presentation require a later security/product decision.
- Two-stream prefetch removes host/event round-trip gaps but cannot guarantee gap-free speech if research or TTS is slower than playback. Tests must distinguish an artificial scheduling gap from a real generation underrun.
- Body bounds increase provider usage and latency. There is no alternate provider or metered fallback; research auth/rate-limit failure leaves the completed stall intact and ends the body cleanly.
- The sidecar's two-worker behavior is assumed to remain valid for one current plus one prefetched stream. Its existing replacement-race tests must be extended before increasing the bound.
- Tool calls may lengthen periods with no text delta. The 180-second deadline and immediate parent cancellation are the bounds; the UI continues to show the completed stall rather than an indefinite tentative body.
- Protocol version 1 is safe only while legacy consumers can accept omitted part fields and new event types are deployed atomically with the host/web contract set.

## Out of scope / deferred

- Replacing or re-prompting the 45-word stall path.
- More than eight parts, more than 600 body words, or more than two concurrent TTS streams.
- Parallel Pi body workers; v1 has one research stream and parallelizes only TTS synthesis/prefetch.
- Dynamic model/provider selection, ordinary API keys, metered fallback, or cross-provider failover.
- Arbitrary shell/edit/write tools, web browsing, extension discovery, citations, or a visible tool trace.
- Model-authored part indices/delimiters, speculative audio before text validation, or out-of-order playback.
- A second assistant bubble per part, continuation separators, per-part replay controls, or editing/regenerating one part.
- Cross-session research jobs, background completion after Stop/takeover, or resuming a response after reload.
- Changing the binary audio frame layout or combining all parts under one playback ledger/recording item.

## Open questions

None block implementation. Any request for network research, citations, larger bounds, more concurrency, or a different part presentation requires a new decision rather than an implementation-time choice.
