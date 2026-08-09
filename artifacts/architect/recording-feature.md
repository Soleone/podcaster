# Recording feature design

Additive feature on top of the master plan (`artifacts/architect/index.md`); does not alter the milestone sequence. Recording is **browser-local**: taps mic/playback PCM in the web app, persists per-turn items in IndexedDB, splices/exports locally. The host never retains raw audio (master plan boundary) — the only protocol deltas are one sidecar field and a VAD relay. Recording is explicit opt-in; no raw PCM is ever persisted (only MP3).

## 1. Design summary

1. **Taps.** `capture.ts` gains an optional `onAudio(streamId, sequence, sampleOffset, pcm16)` hook called per packed frame (recorder registers it only while recording is enabled). `playback.ts` gains an optional `onAudio(playbackId, sampleOffset, pcm16)` hook per `append()`. Both default no-op; no audio-graph changes.
2. **User items.** The sidecar already emits `vad.speech_start` `{captureStartSequence}`; add `captureEndSequence` to `vad.speech_end` = **inclusive last speech frame**. Host relays both VAD events to the browser (currently consumed host-side only). Recorder slices tapped frames `[captureStartSequence..captureEndSequence]` per `(streamId, utteranceId)` and commits at `speech_end`. `transcript.final` already carries `turnId === utteranceId` (`BrowserSession.final`), so the item links to its turn with no new mapping.
3. **Agent items.** Recorder buffers all appended TTS PCM per `playbackId` (full generated audio, keyed to `responseId`/`turnId` from `reasoning.started`, rate from `tts.started`). Finalized at `playback.stopped` with `finalPlayedSampleOffset` (= delivered samples, 24 kHz) and `reason`. **Interruption cut is applied at export, not capture**: decode the stored item, trim to `deliveredSamples` — byte/sample-exact as-heard. `tts_failed`/`reasoning_failed` produce no agent item; the splice simply omits it (transcript is already in the turns store).
4. **Storage format: per-turn MP3, 64 kbps, native rate (16/24 kHz), encoded at turn finalization in a Web Worker** with pinned pure-JS `@breezystack/lamejs` (ESM fork of lamejs; no WASM/native). ~8 KB/s vs 32–48 KB/s raw PCM. Decode at export is **browser-native** `AudioContext.decodeAudioData` (decodes MPEG-1/2 Layer III; no new dependency).
5. **Splice/export.** Order items by each turn's persisted `timelineSequence` (user item then agent item per turn; `recordSeq` tiebreak/fallback). Per item: decode → (agent, interrupted) trim at `deliveredSamples` → offline resample to 44.1 kHz (windowed-sinc) → concat with configurable inter-turn gap (default 300 ms) → final MP3 44.1 kHz mono 128 kbps → download. Live thinking/TTS latency never appears; the 300 ms gap is the only pause.
6. **Lifecycle.** Toggle persisted in `meta` (`recordingEnabled`); items survive refresh (IndexedDB). Toggle-off and `session.stop` finalize open slices (truncated user slice closes at last tapped frame; open agent buffer with no `playback.stopped` is dropped). UI surface (UX detail out of scope): toggle, status (off / items count), Export, Delete-recording.

**Rejected alternatives** (evaluated against sample-exact cut, storage, splice complexity, deps, compatibility):
- *MediaRecorder/Opus*: async start/stop and uncontrollable output rate make per-turn boundaries approximate — fails the exact-interruption-cut requirement; cannot be driven sample-accurately from the packer/playback schedule. Rejected.
- *Raw WAV/PCM per turn*: sample-exact and zero-encode, but violates the storage-efficiency requirement. Rejected.
- *Host-side slicing*: host would have to buffer user audio, violating "host retains no raw audio/history". Browser-side slicing with relayed VAD delimiters is the cleanest seam. Confirmed.

## 2. Riskiest seams (validated against the code)

1. **`captureEndSequence` semantics/off-by-one.** VAD consumes one 320-sample/20 ms frame per capture frame (`EndpointerConfig.frame_ms=20`, `CAPTURE_BYTES` invariant in `runtime.accept_audio`). `speech_end` fires on the 60th silent frame; last speech frame = `frame.sequence − speech_end_frames`. Formula in runtime: `captureEndSequence = max(0, frame.sequence − (config.speech_end_frames * config.frame_ms) // 20)` (generalizes if `frame_ms` ever shrinks). Existing `test_runtime.py` frame scripts (e.g. `endpoint_sequence = 4 + speech_end_frames`) make the exact value assertable.
2. **VAD relay is atomic with the browser strict validator.** `isStrictHostEvent` in `websocket-transport.ts` returns `false` for unknown types → `protocolFailure()` kills the session. Relaying VAD events **and** adding the two validator cases **and** transport pass-through must land in one task (R1) or the app breaks mid-change.
3. **Interruption cut must be exact (as-heard).** Store the *full* generated agent PCM (encoded), never a pre-cut copy; cut at export by decoding and trimming at `finalPlayedSampleOffset` (native 24 kHz sample index into the decoded buffer — exact). `interrupted := terminalReason !== 'completed'`. `deliveredSamples` is monotonic-max across reordered progress/terminal receipts (existing ledger semantics).

## 3. Interfaces / contracts delta

### 3.1 Protocol (sidecar → host)
`vad.speech_end` payload gains **required** `captureEndSequence` (integer ≥ 0, inclusive last speech frame). `vad.speech_start` unchanged.

### 3.2 Protocol (host → browser, new relay)
Canonical envelope (`{protocolVersion:1, sessionId, epoch, eventId, type, monotonicMs, payload}`):
- `vad.speech_start` payload: exact keys `{streamId: uuid, utteranceId: uuid, captureStartSequence: int≥0}`
- `vad.speech_end` payload: exact keys `{streamId, utteranceId, captureStartSequence, captureEndSequence: int≥0}`
Epoch = current orchestrator epoch. No new browser→host events; recording is browser-local.

### 3.3 Schema/code changes
- `packages/contracts/schema/events/sidecar-message.json`: add `captureEndSequence` (required) to the `vad.speech_start|speech_end` oneOf branch. `core-events.json` enum already lists both types — no change. Regenerate `packages/contracts/src/generated/contracts.ts` (`pnpm contracts:generate`) and `services/audio/src/generated/contracts.py` (`uv run python scripts/generate_contracts.py`); clean diff enforced by `pnpm check`.
- `services/audio/src/runtime.py`: emit `captureEndSequence` per formula above.
- `apps/host/src/sidecar/AudioClient.ts`: `VadEvent` gains `captureEndSequence`; `speechEnd()` validates it.
- `apps/host/src/server/BrowserSession.ts`: in `speechStart`/`speechEnd`, after existing handling, `this.send(event(this.sessionId, epoch, 'vad.speech_start|speech_end', payload))`.
- `apps/web/src/session/websocket-transport.ts`: two new `isStrictHostEvent` cases (exact key sets above); events flow to listeners via the existing loop. `stable-turn-writer.ts` needs **no change** (unknown types are safely ignored).

### 3.4 Storage (IndexedDB `podcaster-local-v1`)
Version 2 → 3: new store `recordingItems` (`keyPath: 'itemId'`; indexes `sessionId`, `turnId`, `playbackId`, `recordSeq`); `meta` key `recordingEnabled` (bool). Existing v2 migration logic preserved.

`StoredRecordingItem`:
```ts
{
  itemId: string;            // uuidV7
  sessionId: string;
  recordSeq: number;         // recorder-monotonic per session; splice tiebreak
  role: 'user' | 'agent';
  turnId: string | null;     // user: backfilled from transcript.final (utteranceId); agent: from reasoning.started
  responseId: string | null; // agent
  playbackId: string | null; // agent
  outputEpoch: number | null;
  sampleRate: 16000 | 24000; // native
  sampleCount: number;       // source PCM samples (pre-encode)
  interrupted: boolean;
  deliveredSamples: number | null;      // agent only, native-rate, clamp to decoded length at export
  terminalReason: 'completed'|'cancelled'|'stopped'|'failed'|null;
  captureStartSequence: number | null;  // user
  captureEndSequence: number | null;    // user
  truncated: boolean;       // closed without speech_end (toggle-off/session.stop)
  durationMs: number;
  createdAt: string;
  monotonicMs: number;
  data: Blob;               // MP3 bytes
}
```
Ordering at export comes from the existing `turns.timelineSequence` join; items store no timeline copy.

### 3.5 New modules (`apps/web/src/recording/`, plus `apps/web/src/storage/recording-store.ts`)
- `recorder.ts` — `RecordingRecorder`; owns enabled flag, open user slices `Map<utteranceId, {streamId, startSeq, frames: Int16Array[]}>`, agent buffers `Map<playbackId, {responseId, turnId, sampleRate, frames[]}>`; methods `onCaptureAudio`, `onPlaybackAudio`, `onSessionEvent`, `start()`, `stop(finalize: boolean)`. Injected deps: `store`, `encode: EncodeMp3`, `now`.
- `encode.ts` — pure `encodeMp3(pcm16: Int16Array, sampleRate, bitrateKbps): Uint8Array` (lamejs `Mp3Encoder(1, rate, bitrate)` + `encodeBuffer` + `flush`); also `export interface DecodeMp3 = (bytes: Uint8Array) => Promise<{sampleRate: number, channelData: Float32Array}>`.
- `encoder.worker.ts` + `encoder-client.ts` — Vite module worker wrapping `encodeMp3`; client `EncodeMp3` promise impl. Worker handles both per-turn and final-export encodes.
- `resample.ts` — `offlineResample(channelData: Float32Array, fromRate, toRate): Float32Array` (windowed-sinc, ~64 taps).
- `splice.ts` — `buildRecording(sessionId, deps): Promise<Blob>`; deps: store, turns, `decode: DecodeMp3` (real impl = `decodeAudioData`), `resample`, `encode: EncodeMp3`.
- `export.ts` — download trigger (`podcaster-<sessionId-prefix>-<yyyy-mm-dd>.mp3`) + `deleteSessionRecording(sessionId)`.
- `RecordingControls.tsx` — toggle (persists `recordingEnabled`), status line (off / N items), Export (disabled when 0 items), Delete.
- Wiring: `RecordingRecorder` subscribes to the same `transport.onEvent` stream the controller uses; `App`/controller passes the hooks into capture start and `BrowserPlayback` construction.

Constants: `PER_TURN_KBPS = 64`, `FINAL_SAMPLE_RATE = 44100`, `FINAL_KBPS = 128`, `EXPORT_GAP_MS = 300` (configurable).

## 4. Task breakdown

### R1 — Protocol delta + VAD relay (one atomic seam)
- **Paths:** `packages/contracts/schema/events/sidecar-message.json`, `services/audio/src/runtime.py`, `services/audio/src/generated/contracts.py` (generated), `packages/contracts/src/generated/contracts.ts` (generated), `apps/host/src/sidecar/AudioClient.ts`, `apps/host/src/server/BrowserSession.ts`, `apps/web/src/session/websocket-transport.ts` + its test, `services/audio/tests/test_runtime.py`.
- **Boundary:** schema → generated types → sidecar emission → host types → host relay → browser validation. Must land together (seam 2 above).
- **Done-criteria:** `vad.speech_end` carries `captureEndSequence`; relay emits both VAD events with exact payloads; browser validator accepts them and forwards; existing tests pass; generated contracts are committed (clean diff).
- **Tests:** runtime pytest asserting `captureEndSequence == frame.sequence − speech_end_frames` on the existing scripted frame sequences; AudioClient speechEnd validation; BrowserSession relay (fake sidecar → assert WS message); transport validator cases.
- **Dependencies:** none. **Parallel-safe:** no.
- **Commands:** `corepack pnpm contracts:generate && uv run python scripts/generate_contracts.py`; `uv run pytest services/audio/tests/test_runtime.py`; `pnpm test --filter @app/host`; `pnpm exec vitest run apps/web/src/session/websocket-transport.test.ts`; `pnpm check`.

### R2 — Recording store, taps, and recorder (user + agent items)
- **Paths:** `apps/web/src/storage/schema.ts` (v3 + `recordingItems` + meta flag), `apps/web/src/storage/recording-store.ts`, `apps/web/src/audio/capture.ts` (onAudio hook), `apps/web/src/audio/playback.ts` (onAudio hook), `apps/web/src/recording/recorder.ts`, tests: `apps/web/src/recording/recorder.test.ts`, `apps/web/src/storage/schema.test.ts`.
- **Boundary:** consumes R1 events; produces items via injected `EncodeMp3` (R3 provides the real impl; tests use a fake). No splicing here.
- **Interface:** `EncodeMp3 = (pcm16: Int16Array, sampleRate: 16000|24000, bitrateKbps: number) => Promise<Uint8Array>`.
- **Done-criteria:** fake-clock/event tests: user slice exact `[startSeq..endSeq]` boundaries, turnId backfill from `transcript.final`, agent item buffered full PCM and finalized at `playback.stopped` with `deliveredSamples`/`interrupted`, truncated close on toggle-off/session.stop, no item for `tts_failed`, persistence via store, no-op when disabled.
- **Dependencies:** R1. **Parallel-safe:** yes with R3 (no file overlap; seam = `EncodeMp3`).
- **Commands:** `pnpm exec vitest run apps/web/src/recording/recorder.test.ts apps/web/src/storage/schema.test.ts`; `pnpm test --filter @app/web`; `pnpm check`.

### R3 — MP3 encoder (lamejs, worker)
- **Paths:** `apps/web/package.json` (pin `@breezystack/lamejs`), `apps/web/src/recording/encode.ts`, `apps/web/src/recording/encoder.worker.ts`, `apps/web/src/recording/encoder-client.ts`, `apps/web/src/recording/encode.test.ts`.
- **Boundary:** pure encode + worker plumbing; no recorder/splice logic.
- **Done-criteria:** `encodeMp3` returns valid MP3 (ID3/frame header present) for 16/24/44.1 kHz mono; worker client resolves/rejects; deterministic length for fixed input.
- **Dependencies:** none (can precede R1). **Parallel-safe:** yes.
- **Commands:** `pnpm exec vitest run apps/web/src/recording/encode.test.ts`; `pnpm check`.

### R4 — Splice, export, and minimal UI
- **Paths:** `apps/web/src/recording/resample.ts` + test, `apps/web/src/recording/splice.ts` + test, `apps/web/src/recording/export.ts`, `apps/web/src/recording/RecordingControls.tsx`, wiring in `apps/web/src/App.tsx`/session setup, `apps/web/e2e/recording.spec.ts`.
- **Boundary:** reads persisted items + turns; produces the final MP3 Blob; delete control.
- **Done-criteria (unit, injected fakes for decode/resample/encode):** ordering = turns `timelineSequence` (user before agent per turn, `recordSeq` fallback); interrupted agent trimmed at `deliveredSamples` (clamped to decoded length); 300 ms gap inserted between items; 16k/24k → 44.1k resample calls; `tts_failed` turns skipped; empty recording → no export. Resample tone/RMS test. E2E (fake-services): toggle → status reflects items → export triggers download → delete clears.
- **Dependencies:** R2, R3. **Parallel-safe:** no.
- **Commands:** `pnpm exec vitest run apps/web/src/recording/splice.test.ts apps/web/src/recording/resample.test.ts`; `pnpm test --filter @app/web`; `pnpm exec playwright test recording.spec.ts`; `pnpm check`.

## 5. Decision-doc flag

No milestone gate applies; recommend **no** `docs/decisions/` file — this artifact plus tests are the record. If a reviewer requires one, use `docs/decisions/005-recording.md` and note that the master plan reserves `005` for the future prototype go/no-go (renumber that later doc to `006`). The builder should **not** write a decision doc unless the parent explicitly requests it.

## 6. Risks & assumptions

- `decodeAudioData` on MPEG-2 Layer III (16/24 kHz) MP3: standard in Chromium/Firefox/Safari; verify once in the R4 e2e. Residual: double lossy encode (64 → decode → 128 kbps) — acceptable for speech/podcast content; flagged, not a blocker.
- Refresh mid-utterance drops that utterance's tail (recorder state is in-memory); all persisted items survive refresh.
- Long exports: decode memory transient (~90 MB PCM for 15 min mono) and encode CPU — encode runs in the worker; UI shows an exporting state.
- IndexedDB eviction applies to recording items exactly as to existing history (already disclosed by the master plan).
- Recording opt-in is the only path that writes audio-derived data to IndexedDB; items are MP3, never raw PCM; no PCM in logs.
