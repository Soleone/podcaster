## System design (components + responsibilities)

### 1. Make preparation a real pre-live phase

Use one explicit host lifecycle, owned by `BrowserSession`:

```text
new
  -> preparing              session.open(planning)
  -> prelive                ready | failed | cancelled | no plan
  -> starting_live          explicit session.begin(stream contract)
  -> live                   audio engine open; browser capture may start
  -> stopped
```

- Replace overloaded `session.start` with `session.open`. It freezes settings/persona, creates the session-owned Pi clients, and optionally runs preparation; it does **not** create `AudioClient`, `SessionOrchestrator`, microphone capture, or a recorder.
- Add `session.begin` as the only initial transition to live. It is valid only from `prelive`, creates/connects `AudioClient` and `SessionOrchestrator`, opens the capture stream, then acknowledges readiness. Keep `audio.start` only for live reconnect attachment.
- `apps/web/src/session/live-runtime.ts` becomes a two-phase `SessionRuntime`: `open()` composes transport/controller and waits for preparation; `beginLive()` is called only by the explicit UI action, opens the recorder, sends `session.begin`, and then starts `BrowserCapture`. On any begin failure, stop recorder/capture and close the host stream, leaving the session pre-live and retryable.
- Keep the local session row `draft` during preparation. Call `StableTurnWriter.beginSession()` only after `beginLive()` succeeds, so elapsed active time and “active session” recovery remain truthful. Planning `session.state` events may update the draft’s planning snapshot.
- Web view state adds `mode: 'preparing' | 'prelive' | 'starting_live' | 'live' | 'paused' | 'stopped'` and `capture: 'off' | 'starting' | 'on' | 'failed'`. Preparation/ready/failure UI must say **Microphone off**. Exact presentation is UX-owned; required actions are Cancel while running, Retry after terminal failure/cancel, and Begin live (or Begin without preparation) only as an explicit action.
- A no-preparation “Start session” click may execute `session.open` then `beginLive` in the same click; this remains an explicit start. “Prepare” executes only `session.open` and never requests microphone permission.

### 2. Replace fabricated planning percentage with an attempt state machine

`BrowserSession` owns exactly one `PlanningAttempt`:

```ts
interface PlanningAttempt {
  attempt: number;
  state: 'running' | 'ready' | 'failed' | 'cancelled';
  stage?: 'starting' | 'researching' | 'finalizing';
  reasonCode?: 'timeout' | 'provider_unavailable' | 'invalid_result' | 'interrupted';
  deadlineMs: number;
  controller: AbortController;
}
```

- Remove `progress` from new wire/view writes and delete the 5/20/65 pseudo-percent milestones. Show an indeterminate indicator, factual stage, and elapsed time.
- Emit `starting` before Pi acquisition, `researching` when the request is dispatched/tool work occurs, and `finalizing` on first valid text delta. Emit one terminal state.
- One deadline owner: `BrowserSession` passes the same deadline to `PiResearchClient` and aborts the attempt timer. Initial bounded defaults: light 30s/at most 1 tool, standard 60s/at most 2, deep 120s/at most 3. These are safe starting bounds, not progress predictions.
- Cancel is idempotent and terminal. Retry is accepted only pre-live after a terminal state, increments `attempt`, and ignores all stale callbacks by attempt identity. Begin-without-preparation cancels and awaits the terminal cancellation before `session.begin`.
- Provider details remain private; the bounded `reasonCode` drives coherent copy/actions. A stale persisted `running` attempt found after reload is normalized to `failed/interrupted`, never resumed implicitly.

### 3. Collapse multipart output to one response, one text stream, one playback

Replace `MultiPartResponse` with a small `LongResponsePipeline` used by the existing `SessionOrchestrator` active-response lifecycle:

- One `responseId`, `AbortController`, `reasoning.started`, progressive speech stream, playback ledger, `reasoning.final`, and terminal outcome per user turn.
- For the tool-capable research path only, append one fixed, neutral, sentence-complete acknowledgement (for example, “Let me think that through.”; final copy is writer/UX-owned) immediately to the same speech stream. It must not claim a search occurred. Pass that exact acknowledgement to `requestBody` so the body does not restart or repeat it.
- Start body research immediately after appending the acknowledgement. Convert research deltas into validated, sentence-complete chunks and append them to the **same** speech stream. Emit cumulative `reasoning.delta` checkpoints and exactly one cumulative `reasoning.final`; call `finish()` once.
- Normal concise/no-tool responses keep the existing single-stream path and do not gain an acknowledgement.
- A stable non-empty user final supersedes active reasoning/tool work before posture selection; VAD alone still does not cancel. Playback barge-in keeps the existing immediate local pause/classification behavior. Explicit Stop aborts immediately.
- Bound Pi abort settlement separately from the request deadline (target 2s). If Pi/tool work does not settle, terminate that session-owned research child, release ownership, and lazily restart it for the next turn. The cancelled epoch rejects every late delta/tool/TTS callback.
- Persist cumulative sentence checkpoints so an acknowledgement already generated is not lost if interrupted. Add a stored response lifecycle (`generating | completed | interrupted | failed`); `response.cancelled` is an explicit host event carrying response/turn identity and reason. One reducer upsert by `responseId` owns the visible row.

### 4. Delete multipart-only machinery

- Delete `apps/host/src/session/MultiPartResponse.ts` and `apps/host/src/session/RuntimeBudget.ts`; replace `ResearchPartAssembler` with a sentence-chunk assembler that has total word/byte bounds but no indices or playback semantics.
- Remove `response.part_started`, `response.part_final`, `budget.mitigation`, and active-path `partIndex/partId` from contracts, host/web transport validation, `AudioClient`, sidecar TTS messages, controller playback groups, conversation state, and tests.
- Delete predicted handoff/stall formulas and the timing-tab claims they feed. Retain raw monotonic milestones/logs and test measured durations directly; do not present ETA as mitigation.
- New recordings always store one agent item per playback with `partIndex: null`. Keep the nullable IndexedDB field and legacy export/grouping read path so existing recordings remain usable; do not migrate or rewrite old audio.

## Key decisions & tradeoffs

- **Explicit protocol gate, not a UI-only guard.** `session.begin` makes pre-live capture impossible even if a UI caller regresses. It costs one small contract transition but removes ambiguity from `session.start`/`audio.start` overloading.
- **Indeterminate factual progress over invented percentages.** Users lose a percent bar but gain accurate stage, elapsed, cancellation, failure category, and retry.
- **Deterministic neutral acknowledgement over a second LLM call.** This gives bounded generation latency, starts the body sooner, and cannot contradict the body. It is used only on the long/tool path.
- **One progressive TTS stream over prefetched parts.** This removes cross-part ordering, duplicate final/persistence, multiple playback ledgers, trim identities, and handoff predictions. A long tool can still create silence after the acknowledgement; the UI truthfully shows tool activity and remains interruptible rather than pretending an ETA can prevent it.
- **Persist sentence checkpoints.** This adds a few bounded IndexedDB writes but makes interruption/reload lifecycle truthful. Coalesce to acknowledgement plus each released sentence group; never persist token deltas.
- **Backward-compatible reads, simplified new writes.** Legacy `partIndex` recording rows remain exportable, but no new runtime branch depends on them.

## Interfaces / contracts (the seams between tasks)

### Browser ↔ host

```ts
type SessionOpen = {
  type: 'session.open';
  payload: { sessionSeed: string; reasoningMode: ReasoningMode; settings: SessionSettings; planning?: PlanningRequest };
};
type SessionBegin = {
  type: 'session.begin';
  payload: { streamId: number; sampleRate: 16000; channels: 1; frameSamples: 320 };
};

type PlanningState = {
  status: 'planning' | 'ready' | 'failed' | 'cancelled';
  attempt: number;
  stage?: 'starting' | 'researching' | 'finalizing';
  deadlineMs?: number;
  reasonCode?: 'timeout' | 'provider_unavailable' | 'invalid_result' | 'interrupted';
  topic?: string;
  depth?: PlanningDepth;
  detail?: string;
  notes?: string;
};
```

`session.state.phase` adds `preparing`, `prelive`, and `starting_live`. It must never report `listening` before successful `session.begin`. Remove new writes of planning `progress`; tolerate the old optional field only in local archive reads.

### Web runtime

```ts
interface SessionRuntime {
  snapshot(): SessionViewState;
  beginLive(): Promise<void>;       // mutexed, retryable while prelive
  cancelPlanning(): Promise<void>;
  retryPlanning(): Promise<void>;
  stop(): Promise<void>;
}
```

`beginLive()` is the sole caller of recorder start and `BrowserCapture.start()`. `getUserMedia`, `onCaptureAudio`, and `sendCapture` are impossible before it.

### Response lifecycle

```text
reasoning.started
reasoning.delta*        cumulative, sentence-complete checkpoint
reasoning.final         exactly once, cumulative complete text
response.cancelled | response.failed | playback.stopped(completed)
```

Invariants: one row and one playback per `responseId`; event order is monotonic within the session controller queue; only the current `(epoch,responseId)` may mutate output; terminal state is idempotent and immutable. `StableTurnWriter` replaces `assistantText` from cumulative checkpoints—it never concatenates by arrival order.

## Task breakdown (each: path, boundary, interface, done-criteria, dependencies, parallel-safe?)

**Path:** one vertical implementation; no separate task file.

**Boundary:** contracts, host session/preparation lifecycle, web runtime/state/actions, single-stream long response, and associated persistence/recording compatibility. Do not redesign general session IA, speech models, posture policy, or legacy recording export.

**Interface:** the contracts above.

**Dependencies:** implement in this order:

1. Update contract schemas/types/fixtures and state-machine unit tests (`packages/contracts/**`).
2. Gate host preparation/live construction and implement attempt identity/deadline semantics (`BrowserSession.ts`, `PiResearchClient.ts`).
3. Split web open/begin transactions, defer capture/recording/activation, and expose pre-live actions/state (`live-runtime.ts`, `transport.ts`, `websocket-transport.ts`, `App.tsx`, draft/session surfaces).
4. Replace multipart host output with one progressive stream and bounded Pi abort settlement (`SessionOrchestrator.ts`, new sentence assembler); then remove multipart/budget host code.
5. Simplify web transport/controller/reducer/persistence to one response/playback and cumulative checkpoints; retain legacy recording reads.
6. Regenerate contracts, run the focused matrix below, then full typecheck/test/build.

**Done-criteria / test matrix:**

| Area | Required cases |
|---|---|
| Pre-live privacy | Prepare never calls `getUserMedia`, recorder start, `AudioClient`, orchestrator start, `session.begin`, or binary send; ambient worklet input cannot create a transcript. |
| Explicit begin | Ready/failed/cancelled preparation stays `capture=off`; only Begin transitions `starting_live → live`; direct no-plan Start performs open+begin from the same explicit click. |
| Begin rollback | Host begin failure, permission denial, recorder failure, activation failure, duplicate click, stop/disconnect, and reconnect leave no leaked capture/stream/recorder and permit a coherent retry or stop. |
| Planning truth | Factual stage ordering, elapsed display without percent, light/standard/deep bounds, timeout reason, provider failure, invalid/empty final, cancel race, retry attempt increment, stale-attempt suppression, and stale persisted-running normalization. |
| Recovery actions | Cancel visible only while running; Retry only terminal/pre-live; Begin without preparation cancels first; no retry can inject notes after live begins. |
| Single response | Research turn produces one response ID, one `reasoning.started/final`, one speech open/finish, one playback ID, one row, and ordered ack+body text with no `partIndex` or duplicate persistence. |
| Long-tool interruption | Stable speech before first TTS, during a tool, during acknowledgement, and during body all abort the old epoch; explicit Stop is immediate; Pi abort settles/recycles within the bound; late tool/text/TTS events are ignored. |
| Failure/cancel | Body error/timeout/invalid final after acknowledgement, TTS failure, cancellation before TTS start, and cancellation after checkpoint each yield one immutable terminal lifecycle and truthful retained/interrupted text. |
| Playback/barge-in | Existing ≤300ms local pause path, resume, accepted takeover, repeated interruptions, terminal receipt idempotence, and no queued-successor overlap regression. |
| Persistence/legacy | Reload during generation, after completion, after interruption, and after failure yields one row; new recording is one item; old multipart recording rows still group/export in order. |
| Timing | Assert actual injected-clock durations for open→ack checkpoint, open→TTS start, and cancel→abort settlement; no ETA/percentage/budget event remains user-visible. |

**Parallel-safe?** No. The wire contract and lifecycle semantics are shared across every phase; land sequentially in one branch. Test additions within a phase may be written alongside that phase, but builders must not independently change the same schemas/reducers.

## Risks & assumptions

- **High — current privacy/trust defect:** `apps/host/src/server/BrowserSession.ts:350-421` deliberately runs preparation behind live setup, while `apps/web/src/session/live-runtime.ts:240-304` and `apps/web/src/audio/capture.ts:30-96` acquire/process microphone audio before planning completes. The protocol gate above is required; copy alone is insufficient.
- **High — current progress is not work completion:** `BrowserSession.ts:401-421,448-505` can leave a static 5% state until timeout. Removing percent is safer than trying to estimate opaque provider/tool completion.
- **High — current persistence is arrival-order fragile:** `apps/web/src/storage/stable-turn-writer.ts:508-515` concatenates multipart finals, and `apps/web/src/session/state.ts:160-260` assumes append order. Duplicate/out-of-order events can create incoherent text. Cumulative replacement plus one final removes this class.
- **High — current cancellation can hold the research client for the full request deadline:** `apps/host/src/pi/PiResearchClient.ts:372-405` uses `active.deadlineMs` for abort settlement. A short separate abort bound and subprocess recycle are needed for real distractibility.
- **Medium — generated stall and body are separate lifecycle trees:** `apps/host/src/session/MultiPartResponse.ts:80-324,429-641` creates multiple streams, ledgers, finals, and completion gates; web/controller/recording then reconstruct one message. The one-stream design deliberately gives up body-part prefetch and per-part recording trim.
- **Medium — existing timing “mitigation” does not mitigate:** `apps/host/src/session/RuntimeBudget.ts` predicts handoffs but only emits telemetry. Deletion avoids misleading precision; representative latency measurement remains operational work.
- Assumption: the sidecar’s existing progressive single-stream TTS begins from sentence appends before `finish()`; the current concise-response path depends on the same behavior and must be covered by integration tests.
- Assumption: a neutral fixed acknowledgement is acceptable only for tool-capable long responses and is not considered a second posture/message.

## Open questions

1. The specific reported preparation timeout (Pi startup, provider, or tool) cannot be resolved from code or sanitized UI events; obtain incident host/Pi lifecycle timestamps. It does not change the gating/state-machine fix.
2. Production latency data is insufficient to attest that 30/60/120 seconds and 1/2/3 tools are the optimal depth bounds. Start there because they are bounded and materially improve light preparation; revise from measured p95 attempt/tool timings.
3. Final acknowledgement wording cannot be selected from code. It must remain short, neutral, and non-committal; architecture does not require generated wording.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Severity-rated review findings cite BrowserSession.ts, live-runtime.ts, capture.ts, stable-turn-writer.ts, state.ts, PiResearchClient.ts, MultiPartResponse.ts, and RuntimeBudget.ts; the design includes residual risks and a concrete test matrix."
    }
  ],
  "changedFiles": [
    "artifacts/architect/index.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "source inspection (research/PM/UX artifacts plus targeted host, web, contract, persistence, recording, and test files)",
      "result": "passed",
      "summary": "Verified the preparation/capture order, static planning percentages, multipart lifecycle, persistence append behavior, and abort-settlement ownership."
    },
    {
      "command": "python artifact assertion",
      "result": "failed",
      "summary": "Python is not installed; reran the same structural assertion with Node."
    },
    {
      "command": "node artifact heading/acceptance assertion; git diff --check; staged-file check",
      "result": "passed",
      "summary": "Required headings and acceptance block are present; diff hygiene passed and no files are staged."
    }
  ],
  "validationOutput": [
    "Architecture defines explicit pre-live/live and planning-attempt state machines, one concurrency owner per operation, end-to-end contract changes, deletion opportunities, ordered implementation, and a failure/race/legacy test matrix."
  ],
  "residualRisks": [
    "Production planning and tool latency has not been measured, so initial depth deadlines require p95 validation.",
    "The exact incident timeout source is unavailable without sanitized host/Pi lifecycle logs.",
    "Single-stream progressive acknowledgement latency depends on existing sidecar append-before-finish behavior and must be integration-tested."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added the smallest dependable cross-cut architecture: explicit pre-live gating, truthful attempt-based planning, and deletion of multipart output in favor of one interruptible progressive response stream.",
  "reviewFindings": [
    "blocker: apps/web/src/session/live-runtime.ts:240-304 and apps/web/src/audio/capture.ts:30-96 - preparation composition starts microphone acquisition and local recording callbacks without a separate live-begin gate.",
    "major: apps/host/src/server/BrowserSession.ts:350-421,448-505 - preparation runs behind live setup and exposes static pseudo-progress that can remain at 5% until timeout.",
    "major: apps/web/src/storage/stable-turn-writer.ts:508-515 and apps/web/src/session/state.ts:160-260 - multipart assistant text is reconstructed by arrival-order append, making ordering/duplication/persistence unnecessarily fragile.",
    "major: apps/host/src/pi/PiResearchClient.ts:372-405 - cancellation settlement inherits the full research deadline, so interrupted tool work can retain client ownership far too long.",
    "moderate: apps/host/src/session/RuntimeBudget.ts - timing formulas report projected gaps but do not change output behavior, creating complexity without a responsiveness guarantee."
  ],
  "manualNotes": "No feature code was modified."
}
```
