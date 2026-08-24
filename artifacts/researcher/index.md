## Decision this research informs
Whether the reported preparation failure and delayed conversational acknowledgement are explained by current behavior, and whether the system presently guarantees no microphone capture before an explicit live-begin action.

## Findings (each: claim — evidence/source — confidence)
- **High — preparation intentionally starts the live session, not a pre-live-only phase.** `BrowserSession.start()` launches `runPlanning()` without awaiting it, connects audio, then emits planning at **5%** with `phase: 'ready'` (`apps/host/src/server/BrowserSession.ts:350-421`). Web transport explicitly resolves the start handshake when the host goes live while planning continues (`apps/web/src/session/websocket-transport.ts:211-228`). This exactly explains a session that looks started/listening during preparation. — Tests: `websocket-transport.test.ts` “resolves the start handshake…”; integration planning tests. — **High**
- **High — microphone permission/capture begins automatically after the user invokes session start with preparation; there is no separate “begin live” gate.** After `startSession()`/`activate()`, `LiveSessionRuntime` calls `BrowserCapture.start()`, which immediately calls `getUserMedia`, connects the source to an AudioWorklet, invokes the recording callback, and queues frames (`apps/web/src/session/live-runtime.ts:240-304`; `apps/web/src/audio/capture.ts:30-96`). It does this while planning is still in flight. Browser-to-host PCM is held until `audio.start` resolves, and the host rejects binary before `audio.start` (`live-runtime.ts:275-303`; `BrowserSession.ts:240-247`), but local capture/recording starts first. Thus ambient speech cannot reach host VAD before `audio.start`, but it **can be acquired and passed to local recording before that acknowledgement**; it is not gated on preparation completing. — Tests: `capture.test.ts`, `live-runtime.test.ts` only establish start order, not this privacy boundary. — **High**
- **High — the observed 5% is a static “live behind preparation” marker, not actual work progress.** Planning emits 0%, then 20% before consuming the iterator, 65% only on first textual delta, and 100% only terminally. Independently, after audio connection it emits 5%/“running behind live conversation,” which can be the last state displayed (`BrowserSession.ts:401-421,448-505`). Tool activity is displayed but does not advance progress. A tool call or model that yields no text therefore remains at 5% for up to the deadline. — **High**
- **High — the likely timeout mechanism is a 120-second end-to-end research deadline, consistent with the report’s 1–2 minutes.** `requestPlan` uses `PLANNING_DEADLINE_MS = 120_000`; its timer fails the active RPC; `runPlanning()` maps any error/empty notes to the exact safe-continuation message observed (`apps/host/src/pi/PiResearchClient.ts:19-27,240-372`; `BrowserSession.ts:483-505`). The plan prompt permits up to three external read-only calls and waits for a final note, so a slow Pi startup/model/tool call/no-final response is sufficient. The UI intentionally suppresses provider detail, preventing diagnosis from the screen. — **High**
- **Medium — retry/cancel protocol exists but the current live planning card exposes neither control.** Transport defines `cancelPlanning()`/`retryPlanning()` and host handles `planning.cancel`/`planning.retry` (`apps/web/src/session/websocket-transport.ts:497-529`; `BrowserSession.ts:259-266,511-521`); `PlanningStatusCard` accepts only planning state and renders no button (`apps/web/src/session/SessionScreen.tsx:405-455`). A failure says “retry later,” but a normal user cannot trigger retry from this card. — **High**
- **High — multipart intent is stall-first, then researched body, one assistant conversation row.** `MultiPartResponse` emits part 0 (`stall`), runs a no-tool ≤45-word Pi hook, emits final, then starts the research request and converts released text into body parts 1–7 (`apps/host/src/session/MultiPartResponse.ts:80-324,510-600`; `PiClient.ts:28-33`). Web state groups deltas/finals by `responseId` and `partIndex`; `joinAssistantParts` renders them as one row separated by blank lines (`apps/web/src/session/state.ts:160-260`; `conversation.ts:20-44`). — Tests: `session-orchestrator-multipart.test.ts`, `state.test.ts`, `websocket-transport.test.ts`. — **High**
- **High — stall-first is implemented but is not a hard prompt-to-audio latency guarantee.** The stall Pi request can take the normal response client deadline (60s), and only begins TTS after a valid sentence chunk/final; invalid/failed stalls fail the response (`PiClient.ts:15-16`; `MultiPartResponse.ts:155-239`). The body request begins only after the stall is finalized, allows up to three tool calls, and has a 180s deadline (`PiResearchClient.ts:19-28,152-154`; `MultiPartResponse.ts:270-324`). So it may offer a quick acknowledgement, but current code has no independently generated immediate acknowledgement, no maximum first-audio SLA, and no forced interruption of a still-running tool call before the stall exists. — **High**
- **High — interruption is strong once output is playing, but not equivalent to interrupting arbitrary tool work immediately.** VAD speech during playback pauses TTS into provisional barge-in; stable transcript gets a bounded classifier (2.5s) and can advance epoch/abort all multipart streams; explicit “Stop speaking” also cancels active turn (`SessionOrchestrator.ts:620-863,880-1018,1084-1100`; `MultiPartResponse.ts:622-641`). Before playback (including stall/body reasoning and a tool call), speech start intentionally does not cancel; it waits for a stable final to avoid noise false positives (`SessionOrchestrator.ts:655-674`). — Tests: `controller.test.ts`, `session-orchestrator.test.ts`, `cancellation-races.test.ts`. — **High**
- **Medium — timing calculations are instrumentation/telemetry only, not a mitigation.** Cold priors: stall first delta 1.5s, full stall 4s, body first part 8s, TTFA 1s, 2.5 words/s. The adaptive formula yields `ceil((8+1+1.5)*2.5)=27` words at cold start (bounded 20–45); D2 rechecks every 500ms but only emits `budget.mitigation`, never adds/extends audio (`apps/host/src/session/RuntimeBudget.ts:16-44,163-204`; `MultiPartResponse.ts:359-417`). The project document itself labels most values estimates and identifies short stalls/no bridge as the failure case (`docs/latency-budget.md:1-103`). — **High**

## Prior art & competitive landscape
None. This was a repository-behavior investigation; external market research would not resolve the reported failure.

## Current-system reality (what actually exists today)
1. Start with preparation persists/activates the session, starts host audio warmup, and begins browser microphone capture while planning runs out of band.
2. Planning has only coarse milestone progress (0/20/65/100) plus a later 5% live marker; 120s timeout is fail-soft and the exact public message is intentionally generic.
3. Conversation replies use a parent response ID: stall part 0 is generated first; research body text becomes bounded parts, pre-synthesized and queued sequentially in browser playback (`apps/web/src/session/controller.ts:200-253`).
4. Current “quick response” is an LLM-generated/TTS stall, not deterministic acknowledgement audio/text. Tool activity is observable in the UI but not an interruption control.

## Constraints discovered (technical, legal, operational)
- Privacy constraint: `getUserMedia` access is browser-visible/permission-controlled, but application-level capture begins as part of Start+Preparation. No code evidence supports a promise that preparation alone is microphone-free.
- Host must receive `audio.start` and matching stream ID before accepting PCM, which prevents accidental pre-start host ingestion but not pre-ack local capture/recording.
- Planning/provider errors are deliberately redacted on wire; activity metadata excludes tool results. Useful for privacy, but operational root cause is unavailable without host logs.
- Planning and body permits external tool latency (three calls) and each uses an end-to-end deadline, so timing varies materially with Pi/tool availability.

## Implications for scope
- Treat a “prepare without listening/recording until Begin” expectation as inconsistent with verified behavior, not a copy-only concern. Severity: **high privacy/trust risk** if UI implies that promise.
- Treat 5% as an ambiguous/static status, not a meaningful progress signal. Severity: **high diagnosability issue** for the reported incident.
- Treat stall-first as best-effort responsiveness rather than a distractible-tool guarantee; latency-budget events do not alter output. Severity: **medium interaction risk**.
- A retry affordance is not presently reachable from the planning status card despite backend support. Severity: **medium recovery gap**.

## Still unknown (ranked, with how to resolve each)
1. **Root cause of this specific timeout — high impact.** Could be Pi process startup, model/provider stall, or one of up to three tools; UI redaction means source is unknowable from the report. Resolve with timestamped host `[research]`/Pi RPC logs for the incident, retaining only sanitized call lifecycle.
2. **Whether the user’s “explicitly begin” means clicking the current Start action or expects a later separate action — high impact.** Code supports only the former. Resolve with a short UX confirmation against the actual start flow.
3. **Actual first-stall/body/tool timing under production backend — medium impact.** Current priors are estimates; tests use immediate fakes. Resolve with representative latency capture of `response.part_started`, first PCM, tool activity and playback terminals.
4. **Whether local recording storage was enabled during the reported session — medium impact.** Capture callback always feeds recorder, but persistence depends on recorder/store settings. Resolve by inspecting that session’s local recording metadata; no incident data was supplied.

## Acceptance report
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete severity-rated findings cite BrowserSession, LiveSessionRuntime, BrowserCapture, MultiPartResponse, RuntimeBudget, UI state, and focused tests."
    }
  ],
  "changedFiles": ["artifacts/researcher/index.md"],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "corepack pnpm exec vitest run apps/web/src/audio/capture.test.ts apps/web/src/session/live-runtime.test.ts apps/web/src/session/websocket-transport.test.ts apps/host/test/session/session-orchestrator-multipart.test.ts apps/host/test/pi/pi-research-client.test.ts apps/host/test/integration/browser-conversation.test.ts",
      "result": "passed",
      "summary": "6 files, 116 tests passed."
    }
  ],
  "validationOutput": ["Focused read-only test suite passed; no production code changed."],
  "residualRisks": [
    "Specific incident cause cannot be assigned without host/Pi/tool timing logs.",
    "Focused tests do not assert a user-facing no-capture-before-separate-begin privacy contract or UI retry/cancel buttons."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added researcher evidence brief only.",
  "reviewFindings": [
    "high: apps/web/src/session/live-runtime.ts:240-304 and apps/web/src/audio/capture.ts:30-96 — Start with preparation acquires and locally processes microphone audio while preparation continues; no separate begin gate.",
    "high: apps/host/src/server/BrowserSession.ts:401-421,448-505 — 5% is a static behind-live marker and planning can remain there until 120-second timeout with no textual delta.",
    "medium: apps/web/src/session/SessionScreen.tsx:405-455 — planning cancel/retry protocol exists but the status card offers neither control.",
    "medium: apps/host/src/session/RuntimeBudget.ts:163-204 — timing budget observes/logs risk but does not insert a bridge or otherwise guarantee quick acknowledgement."
  ],
  "manualNotes": "Verified facts are separated from incident hypotheses in the brief."
}
```