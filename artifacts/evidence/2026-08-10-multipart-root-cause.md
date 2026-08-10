## Summary

**Most probable root cause (confidence: medium-high):** The research Pi child process (`StdioPiResearchClient`) fails on its very first use during a session's first multi-part turn, producing a `reasoning_unavailable` error event that reaches the orchestrator's for-await loop and triggers `failMultiPart`. The most likely specific failure is a **provider-level error** (rate-limit 429, model unavailable, or authentication issue) when the research Pi's prompt is sent to `openai-codex/gpt-5.6-sol` — the same model just consumed by the stall Pi request ~0.5s earlier. On the second turn, the rate-limit window has passed, the research Pi child is re-spawned (its predecessor was killed by `failActive → terminateOwnedChild`), and the API request succeeds.

The 0.7s window between `tts.started` (07:30:03.605) and `response.failed` (07:30:04.302) is consistent with: the stall Pi request completing (~6.2s), the orchestrator entering the body-parts loop and calling `researchPi.requestBody()`, `ensureStarted()` spawning the child, sending the prompt, and receiving a near-immediate provider error response. The Pi RPC child reports this via `message_end` with `stopReason != "stop"` or `providerError` set, which `StdioPiResearchClient.handle()` (line 233) translates into `failActive`.

The single-part path never hits this because it only makes one Pi request per turn.

## Evidence

### 1. The two Pi clients use the same model, making rate-limit chaining plausible

- `apps/host/src/pi/PiClient.ts:8`: `export const PI_MODEL = "openai-codex/gpt-5.6-sol";`
- Both `StdioPiClient` (stall) and `StdioPiResearchClient` (research body) construct with this model.
- The stall Pi request runs first, consuming a rate-limit token. The research Pi request starts ~0.5s after the stall finishes (~6.2s from start), well within typical API rate-limit windows (per-second or per-10s).

### 2. The research Pi's error-to-`failMultiPart` chain is direct

- `apps/host/src/pi/PiResearchClient.ts:233`:
  ```typescript
  if (active.stopReason !== "stop" || active.providerError) this.failActive(new Error(active.providerError ?? "provider request failed"));
  ```
  Any non-`"stop"` stop reason or any `providerError` field on `message_end` → `failActive`.

- `apps/host/src/pi/PiResearchClient.ts:238-241`: `failActive` pushes `{ type: "error", ... }` to the event queue and terminates the child:
  ```typescript
  private failActive(error: Error): void {
    const active = this.active; if (!active) return;
    active.cutoff = true; active.queue.push(errorEvent(error)); active.queue.end(); this.finishActive(active, false);
    void this.terminateOwnedChild().catch(() => { this.closed = true; }).finally(active.release);
  }
  ```

- `apps/host/src/session/SessionOrchestrator.ts:525-527` (body parts for-await):
  ```typescript
  } else if (event.type === "error") {
    this.failMultiPart(state, Math.max(1, state.parts.length), "reasoning_unavailable");
    return;
  }
  ```

- `apps/host/src/session/SessionOrchestrator.ts:950` (`failMultiPart`):
  ```typescript
  private failMultiPart(state: MultiPartState, partIndex: number, reasonCode: ...): void {
    this.emit("response.failed", { turnId: state.turnId, responseId: state.responseId, reasonCode, partIndex });
    ...
  }
  ```

No other multi-part failure path can produce `response.failed` 0.7s after `tts.started` with this timing signature without leaving side-effects (like protocol failure entries or sidecar poisoning) that contradict the log.

### 3. Timing analysis

| Time (relative) | Event | Source |
|---|---|---|
| 0.000s | `reasoning.started` (stall Pi request begins) | `SessionOrchestrator.runMultiPartResponse:436` |
| 6.198s | `tts.started` (first stall TTS chunk ready on sidecar → browser receives) | `attachPartTts:556`, browser `controller.ts` |
| 6.895s | `response.failed` | `failMultiPart:950` → browser `controller.ts` |

The 0.697s gap between tts.started and response.failed is explained by:
1. Stall Pi final delta arrives (~0.1s)
2. `stallStream.finish()` sends `tts.commit` (~0.05s)
3. `response.part_final(0)` emitted (~0.01s)
4. `researchPi.requestBody()` lazy iterator starts → `beginRequest` → `ensureStarted()` → `start()` → `captureVersion()` → `spawn()` (~0.2-0.3s)
5. `send("prompt", { message })` RPC → Pi child receives prompt → sends to gpt-5.6-sol → provider returns error (~0.2-0.3s)
6. Pi child emits `message_end` with `stopReason != "stop"` → `failActive` → error event in for-await → `failMultiPart` (~0.01s)

Total: ~0.6-0.8s. Matches observed.

### 4. Host-side `response.failed` emission points — complete enumeration

Every path that emits `response.failed` in `SessionOrchestrator`:

| Path | Location | ReasonCode | When |
|---|---|---|---|
| `runMultiPartResponse` — stall Pi error | `:447` (`failMultiPart(state, 0, "reasoning_unavailable")`) | `reasoning_unavailable` | Stall Pi request yields `{ type: "error" }` |
| `runMultiPartResponse` — stall text invalid | `:462` (`failMultiPart(state, 0, "reasoning_invalid")`) | `reasoning_invalid` | Stall text fails validation (words, question marks, prefix) |
| `runMultiPartResponse` — stall TTS start failed | `:432` (`failMultiPart(state, 0, "tts_failed")`) | `tts_failed` | `stallStream.started` promise rejects |
| `runMultiPartResponse` — stall TTS completion failed | `attachPartTts:574` (`failMultiPart(state, part.partIndex, "tts_failed")`) | `tts_failed` | `meta.completion` promise rejects |
| `runMultiPartResponse` — stall TTS completion invalid | `attachPartTts:571` | `tts_failed` | `generatedSamples <= 0` or not safe integer |
| `runMultiPartResponse` — research body error | `:527` (`failMultiPart(state, Math.max(1, state.parts.length), "reasoning_unavailable")`) | `reasoning_unavailable` | Research Pi yields `{ type: "error" }` |
| `runMultiPartResponse` — research body invalid | `:520` (`failMultiPart(state, Math.max(1, state.parts.length), "reasoning_invalid")`) | `reasoning_invalid` | Research body text fails part assembler validation |
| `runMultiPartResponse` — body part TTS start failed | `startBodyPart:596` | `tts_failed` | Body part `stream.started` rejects |
| `runMultiPartResponse` — body part TTS completion failed | `attachPartTts:574` | `tts_failed` | Body part `meta.completion` rejects |
| `runMultiPartResponse` — outer catch | `:536` (`failMultiPart(state, 0, "reasoning_unavailable")`) | `reasoning_unavailable` | Unhandled exception in entire multi-part flow |
| Single-part: `handleStableFinal` — Pi error | `:368` (`failResponse(active, "reasoning_unavailable")`) | `reasoning_unavailable` | Pi yields error event |
| Single-part: `handleStableFinal` — text invalid | `:388` (`failResponse(active, "reasoning_invalid")`) | `reasoning_invalid` | Assembler final validation fails or duplicate final |
| Single-part: `handleStableFinal` — TTS start failed | `:317` | `tts_failed` | `speechStream.started` rejects |
| Single-part: `handleStableFinal` — TTS completion failed/rejected | `:339-341` | `tts_failed` | `meta.completion` rejects |
| Single-part: `handleStableFinal` — outer catch | `:394` (`failResponse(active, "reasoning_unavailable")`) | `reasoning_unavailable` | Unhandled exception |

Of these, the one matching the 0.7s-timing and stateful-first-turn pattern is **research body error** (`:527`). All other paths either would fire before `tts.started` (stall text invalid, stall Pi error during generation), would leave sidecar-poisoning artifacts (TTS failures), or are single-part paths.

### 5. Why `tts_failed` is unlikely

For the stall TTS to fail and trigger `failMultiPart(state, 0, "tts_failed")`:
- The sidecar would need to emit `sidecar.failure` (poisoning the runtime), which would call `AudioClient.failAll()` rejecting ALL pending TTS. The session would continue to "listening" but the sidecar would be permanently poisoned — the next turn would also fail. The log shows the next turn succeeds, so this is ruled out.
- Alternatively, `tts.ended` with `generatedSamples <= 0` → `Kokoro produced no audio` → sidecar poison. Same contradiction.
- Protocol/connection failure: would produce `protocol failure` entries in the activity log. None appear.

### 6. Why browser-side protocol failure (H5) is ruled out

The browser log shows no `protocol failure` entries and no socket-close entries. The session transitions cleanly: `degraded` → `listening`. A browser protocol violation would close the WebSocket and produce "connection lost" entries.

## Alternative hypotheses (ranked)

### H1 (rank 1 — most probable): Research Pi provider error (rate limit / unavailable)

- **Evidence for:** Same model as stall Pi; rapid chained requests; classic rate-limit pattern; timing fits (0.7s after stall TTS starts is when research Pi prompt response arrives); stateful: rate-limit window expires between turns.
- **Evidence against:** Requires the API provider to enforce per-account rate limits tight enough to catch back-to-back requests ~6s apart. Without a live host log showing the specific reasonCode, we can't confirm this is rate-limit vs. a different provider error.

### H2 (rank 2): Research Pi child process crashes on first spawn

- **Evidence for:** The `child.once("exit")` → `childFailed` → `failActive` chain fires for ANY child exit. If `--tools read,grep,find,ls` initialization has a transient failure (resource unavailable, lock contention, model warmup), the child could exit before completing the prompt RPC. Stateful: second spawn succeeds (resource now available).
- **Evidence against:** Same Pi binary, same credentials as stall client which succeeded. The `--tools` flags shouldn't cause a crash. The `captureVersion` call before spawn also succeeds (or else timing would be different).

### H3 (rank 3): Stall TTS completion failure from short-text edge case

- **Evidence for:** Theoretically possible if Kokoro produces zero samples for very short text.
- **Evidence against:** Would poison the sidecar (contradicts second-turn success). The stall text would need to be such that Kokoro produces exactly zero audio — extremely unlikely for any reasonable acknowledgment text. No protocol-failure or sidecar-failure entries in browser log.

### H4 (rank 4 — least likely): ReasoningSpeechAssembler validation failure mid-stream

- **Evidence for:** If the stall text violates the 45-word limit, question-mark posture, or forbidden-prefix rules, `isValidChunk` would stop emitting chunks, and `final()` would throw `InvalidResponseError`.
- **Evidence against:** This would fire BEFORE `stallStream.finish()`, which is BEFORE the body-parts loop. The timing would be at ~6.2s (when stall Pi completes), not 0.7s later. Also the generated text from gpt-5.6-sol for a simple acknowledgment is extremely unlikely to violate these rules. And this wouldn't be stateful (second turn's text would have the same issue).

## Stateful first-turn-fails explanation

The state lives in two places:

1. **`StdioPiResearchClient` child lifecycle** (`apps/host/src/pi/PiResearchClient.ts`):
   - First turn: `ensureStarted()` → `start()` → `captureVersion()` + `spawn()`. Child spawns, prompt sent, provider returns error. `failActive` pushes error event AND calls `terminateOwnedChild()` (line 252-259: SIGTERM → wait 100ms → SIGKILL). The child is killed. `this.child` is cleared. `this.active` is cleared.
   - Second turn: `ensureStarted()` finds `this.child === undefined` and `this.closed === false`, so calls `start()` again. Fresh child spawns, fresh prompt sent, this time the provider accepts it (rate-limit window passed, or transient issue resolved).

2. **`StdioPiClient` (stall) child lifecycle** (`apps/host/src/pi/PiClient.ts`):
   - The stall Pi child is NOT killed by `failMultiPart`/`cancelMultiPart`. Only `controller.abort()` is called, which triggers `cancelActive` → `send("abort")` RPC. The stall Pi child survives the abort and is reused on the second turn (`this.child.exitCode === null` → `ensureStarted()` returns immediately).

This asymmetry is key: the stall Pi child is long-lived and reused across turns; the research Pi child is ephemeral — killed on first failure, re-spawned on next use. If the failure is transient (rate limit, provider hiccup, child startup race), the re-spawn on the second turn naturally succeeds.

**Additionally:** On the very first turn of a fresh session, the `StdioPiClient` (stall) child ALSO spawns for the first time. This spawn succeeds (stall Pi generates text). But this "warms up" the Pi binary / filesystem caches, so the research Pi child's `captureVersion` and `spawn` are slightly faster. The research child might then hit a different cold-start issue specific to the `--tools` path.

## Recommended fix

**Primary fix — add retry with backoff for research Pi provider errors:**

In `apps/host/src/pi/PiResearchClient.ts`, in `beginRequest` (around line 120-136), add a single retry with a 2-5s backoff before calling `failActive` for provider-classified errors (rate limits, temporary unavailability):

```typescript
// In beginRequest, after catch, before failActive:
} catch (error) {
  if (this.active?.queue === queue) {
    // If the error looks like a transient provider issue, retry once.
    const classification = classify(error);
    if (classification === "rate_limited" || classification === "unavailable") {
      await new Promise(resolve => setTimeout(resolve, 3_000));
      // Re-check signal before retry
      if (signal.aborted || isCancelled()) { queue.end(); release(); return; }
      try {
        await this.ensureStarted();
        const promptResponse = this.send("prompt", { message }, this.requestDeadlineMs);
        await promptResponse; // Continue normal flow
        return;
      } catch {
        // fall through to failActive
      }
    }
    this.failActive(error instanceof Error ? error : new Error("Pi research request failed"));
  }
}
```

**Note:** `StdioPiResearchClient` doesn't have a `classify` function like `StdioPiClient` does. The research client's `errorEvent()` always maps to `"unavailable"`. You'd need to add a similar classifier or inspect the error message for rate-limit patterns.

**Secondary mitigation — log the reasonCode on the host:**

In `apps/host/src/session/SessionOrchestrator.ts`, in `failMultiPart` (line ~950), add structured logging of the `reasonCode` and `partIndex` so production logs capture the exact failure path:

```typescript
log("session", `multipart fail reason=${reasonCode} partIndex=${partIndex} responseId=${state.responseId}`);
```

This would make the current bug immediately diagnosable from host logs alone.

**Tertiary — add Stall Pi child reuse awareness:**

The stall Pi child and research Pi child both use `PI_MODEL` to the same provider. Consider adding a small delay (~1s) between the stall completing and the research body starting, or merging both into a single Pi child with different tool configurations, to avoid rapid-fire chained API requests.

## Tests to add

1. **`apps/host/test/session/session-orchestrator-multipart.test.ts`:** Add a test case where the research Pi yields an error event — verify that `response.failed` is emitted with `reasonCode: "reasoning_unavailable"` and `partIndex >= 1`, the multi-part state is cleaned up, and the orchestrator returns to `listening`.

2. **`apps/host/test/pi/pi-research-client.test.ts`:** Add a test case where the Pi returns `message_end` with `stopReason: "rate_limit"` (or `errorMessage` set) — verify the iterator yields an error event with `state: "unavailable"`.

3. **`apps/host/test/session/session-orchestrator-multipart.test.ts`:** Add a test for the exact first-turn → second-turn sequence: first turn has research Pi error, orchestrator emits `response.failed` and returns to `listening`; second turn with fresh research Pi succeeds normally.

4. **`apps/host/test/session/session-orchestrator-multipart.test.ts`:** Add a test for stall TTS completion arriving before body parts begin — verify `tts.ended` with `partIndex: 0` doesn't interfere with body part TTS setup.

## Open questions

1. **What is the exact `reasonCode` on the `response.failed` event?** If the live host log could be captured with the `reasonCode` field, it would immediately narrow the failure to one of the three paths (`reasoning_unavailable`, `reasoning_invalid`, `tts_failed`). Currently the browser-side activity log does not include this field.

2. **What is the specific provider error?** Is it a 429 rate limit, a 503 temporary unavailability, an authentication issue, or something else? The Pi child's stderr might contain the raw provider response. Capturing Pi stderr on first-turn failure would be definitive.

3. **Does the issue reproduce with a single Pi child serving both stall and research?** If both stages shared a single Pi RPC child (with tools enabled throughout), the race between two rapid API requests would be eliminated.

4. **Is there a Pi version-specific startup race?** The research child spawn includes `captureVersion` (a short-lived `pi --version` subprocess). If the Pi binary has a cold-start filesystem-lock or config-initialization step, the research child might observe it while the stall child doesn't (because the stall child already warmed it). Testing with a warm Pi binary (pre-invoked with `--version`) before session start would rule this out.

5. **Does the stall `tts.ended` arriving before research child spawn introduce any race?** The orchestrator doesn't await the stall TTS completion before starting the body parts. While the code appears correct (the for-await loop is synchronous with respect to the orchestrator's async flow, and TTS completion handlers use `isCurrentMultiPart` guards), a specific timing could expose a latent bug. This should be explicitly tested.

---
## Addendum (parent review, 2026-08-10)

The investigation above concluded "research Pi provider error," but a closer read of the browser activity log refutes that:

- The web transport logs every received `response.part_final` as `part stall N final` (websocket-transport.ts:102). The log has no `part stall 0 final`.
- The web transport logs the first binary audio frame of a part as `part N first audio` (websocket-transport.ts:192). The log has no `part 0 first audio` either.

Both absences mean the stall (part 0) never completed: the host never emitted `response.part_final(0)` (which it only does after the stall request finishes and validates), and no stall audio ever reached the browser. The research body cannot start before `response.part_final(0)`, so the failure is in the STALL PHASE, not the research phase.

Timing reconstruction: `tts.started` (+6.2s) proves stall deltas were streaming and at least one sentence chunk was appended to the stall TTS stream (the sidecar emits tts.started when the first chunk is queued). The failure +0.7s later, before any audio chunk finished synthesizing, matches the stall Pi request either (a) erroring near the end of generation (provider error / rate limit / client-side 45-word bound exceeded in PiClient.handle), or (b) completing with text that failed final validation. Both go through failMultiPart → cancelMultiPart → speech.cancel, which cancelled the sidecar TTS worker before its first chunk completed, so no audio was ever heard. "Next turn works" is generation-dependent (a different question yields a compliant ≤45-word stall), not a session-state artifact.

Recommended fix (implemented by builder): stall fail-soft — when the stall request errors or its text fails validation but valid ≤45-word sentence chunks were already streamed to the stall TTS, keep that streamed prefix as the stall (emit reasoning.final(0)/part_final(0) with it, finish the TTS stream) and continue to the research body instead of failing the whole response; fail only when nothing was streamed. Plus host + browser logging of the response.failed reasonCode/partIndex so the exact path is diagnosable next time.
