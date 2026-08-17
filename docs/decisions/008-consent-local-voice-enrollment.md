# Decision 008: Consent and local-retention contract for Qwen voice enrollment

**Status:** Accepted (QW-9 implementation contract)
**Date:** 2026-08-17
**Scope:** Recording, storage, and playback of user reference audio for the
Qwen 0.6B Base voice-cloning route.

## Decision

Podcaster may record a short reference sample of the user's voice, keep it on
this device, and use it to synthesize speech with the locally pinned Qwen
`Qwen3-TTS-12Hz-0.6B-Base` voice-cloning route. This is allowed only under the
explicit consent contract below. The reference is user-enrolled; it is never
substituted for a stock `CustomVoice` speaker, and it is never uploaded to a
hosted service.

## Consent contract

The user must acknowledge, before any microphone access for enrollment, that:

1. **Identity:** the recording is a sample of their own voice.
2. **Purpose:** it will be used only to clone their voice for local speech
   synthesis when they select their custom voice.
3. **Retention:** copies of the reference live only in this browser's local
   storage and, transiently, in the local audio sidecar's memory for prompt
   extraction. The sidecar keeps only the extracted speaker embedding, never
   the raw recording.
4. **Deletion:** deleting the custom voice deletes the reference from browser
   storage immediately and from sidecar memory on the next cleanup.
5. **No upload:** reference bytes never leave the machine (browser to host to
   sidecar are local loopback connections only).

The consent copy is shown before recording and the user must check an explicit
box ("I consent to store this recording locally and use it for local
voice cloning only") before the microphone is requested. A saved voice is
unusable unless the box was checked for that save.

## Local-retention contract

- **Browser (source of truth):** each enrolled voice is one row in the
  `customVoices` IndexedDB object store (schema version 5) holding metadata and
  a WAV Blob of the reference. Names, hashes, and timestamps persist across
  reload. Nothing in the store is ever sent to a hosted service or logged.
- **Host:** the host only relays an enrollment request to the sidecar over its
  authenticated loopback WebSocket and holds no copy of the reference.
- **Sidecar (transient):** validates the reference, extracts a deterministic
  x-vector voice-clone prompt, and retains only the CPU prompt tensors keyed by
  voice id. Raw reference bytes are released after extraction. Prompts are
  bounded (at most `MAX_CUSTOM_VOICES`) and are dropped on delete, on adapters
  close, and never written to disk.
- **Sessions:** sessions receive only the voice id. The selected
  reference is used deterministically: the same reference bytes always map to
  the same voice id (`custom:<first 24 hex of sha256(wav-bytes)>`) and the
  same prompt.

## Recording format and quality gates (single source: `packages/contracts/schema/voice-enrollment.json` and `custom-voice.ts`)

| Gate | Value |
|---|---|
| Container | WAV, PCM16LE mono, one `data` chunk |
| Sample rate | 16 000 Hz only |
| Minimum duration | 3 000 ms |
| Maximum duration | 20 000 ms |
| Minimum signal RMS | 0.01 (float scale), must also have a peak ≥ 0.02 |
| Maximum signal peak | 0.98 (reject clipped/hot samples) |
| Max encoded bytes | 640 044 (44-byte header + 20 s at 32 000 B/s) |
| Max voices | 8 |
| Max total reference bytes | 4 MiB |
| Name limit | 64 UTF-8 bytes |

Rejections are actionable: `too_short`, `too_long`, `too_quiet`, `clipped`,
`decode_failed`, `mic_denied`, `mic_unavailable`, `mic_busy`, `limit_reached`.

## Microphone permission and error states

- `unrequested` → `requesting` (permission prompt) → `granted` | `denied`.
- `denied` shows the browser-level corrective copy and disables recording.
- `NotFoundError`/`OverconstrainedError` → `mic_unavailable`;
  `NotReadableError` → `mic_busy`; other errors → generic with retry.
- The mic stream is stopped as soon as a take ends or is discarded; the app
  session capture is never disturbed because enrollment uses its own
  `getUserMedia` context.

## Storage, deletion, and schema migration

- `customVoices` store is added by IndexedDB version 4 → 5. Version 4 rows are
  untouched (no backfill needed; the store is new).
- Save enforces per-voice byte cap, voice count cap, and total byte cap.
- Delete removes the row immediately and tells the sidecar to drop the prompt.
- Rename updates the row (same voice id, same reference) and re-announces the
  label to the sidecar.
- Switching the TTS backend away from Qwen hides custom voices from the picker
  without deleting them; switching back re-merges them after any required local
  re-enrollment (sidecar restart) has completed.

## Failure and restart behavior

- A sidecar restart loses its transient prompts; the browser re-pushes each
  stored reference the next time the Qwen catalog is seen without the voice
  id. Re-enrollment is idempotent (same hash, same voice id, no re-extraction).
- Enrollment is serialized (one at a time) and bounded by a hard timeout; a
  failed enrollment leaves the stored row untouched so it can be retried.

## Non-goals

- No cloud TTS, no hosted upload, no sharing of the reference.
- No transcript capture of the reference (the x-vector route needs none), so
  speech content is never stored as text.
- No use of a stock `CustomVoice` speaker to fake user enrollment.