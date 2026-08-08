# Fresh-session implementation plan

This is the single implementation authority. Product behavior comes from `artifacts/pm/index.md`; interaction semantics come from `artifacts/ux/index.md`; speech evidence comes from `artifacts/researcher/index.md`. If an implementation choice below conflicts with an older planning artifact, this plan governs implementation while those artifacts continue to govern product intent.

## System design (components + responsibilities)

### Current decisions

- Build one local-first web application for one user on Linux with an RTX 4090. It has three runtime boundaries: a browser UI, a loopback Node host, and a host-launched Python/CUDA audio sidecar. The host launches Pi as a separate stdio RPC subprocess.
- Use Node 22, pnpm 9, TypeScript 5, React + Vite, Fastify, Vitest, Playwright, and JSON Schema. Use Python 3.12, `uv`, PyTorch/CUDA, pytest, and NVIDIA NVML metrics. Pin exact package/model revisions and hashes in lockfiles/manifests.
- The Node host is the orchestration authority. It serves the built UI, owns session/cancellation state, runs the deterministic posture policy, starts/stops the audio sidecar and Pi, and retains no conversation history.
- Browser IndexedDB owns stable transcript/history, persona, consent acknowledgement, and benchmark-rating progress. Raw microphone audio is transient and is not persisted by default. Explicit benchmark exports are files the user chooses to create.
- Local STT/TTS are selected by bounded, reproducible RTX 4090 bake-offs before the integrated loop. Nemotron 3.5 ASR Streaming 0.6B is integrated first; Parakeet Unified EN 0.6B is the matched challenger. Kokoro ONNX is the first TTS baseline, followed by Qwen3-TTS 0.6B CustomVoice. Later TTS candidates are conditional.
- Cloud reasoning occurs only through an installed, authenticated Pi RPC child process. Pi owns its credentials. The app neither asks for an OpenAI API key nor reads/copies OAuth material.
- Local policy chooses exactly one posture (`riff | question | challenge | silence`) before cloud reasoning. Pi generates text only for the already-selected non-silence posture.

### Explicitly superseded decisions

- Superseded: treating Handy's `streaming: true` metadata or record-then-transcribe flow as proof of live partial ASR. Use native streaming paths and instrument actual partials.
- Superseded: selecting an ASR model from published or opaque scores. Select from the pinned, same-corpus 4090 harness.
- Superseded: Whisper as the default or automatic third candidate. It is only a harness sanity baseline when the defined trigger fires.
- Superseded: implementing Kokoro, Qwen3, Chatterbox, and Orpheus in parallel. Advance in the stated sequence and stop when gates are met.
- Superseded: browser-to-Pi or browser-to-CUDA direct connections. The browser talks only to the host; the host exclusively owns child processes.
- Superseded: any “fully local/private” claim. Speech is local, but selected transcript/persona/context is sent through Pi/Codex to a provider.
- Superseded: app-hosted/server history, accounts, sync, OAuth extraction, ordinary API-key billing, or silent metered/provider fallback.

### Repository layout

```text
apps/
  web/                 React UI, AudioWorklet, IndexedDB, accessibility flows
  host/                Fastify static server + loopback API/WS + orchestration
packages/
  contracts/           canonical JSON Schemas, generated TS types, fixtures
  policy/              deterministic eligibility/posture state machine
  test-fixtures/       synthetic audio, transcript, persona, failure fixtures
services/
  audio/               Python sidecar, STT/TTS adapters, VAD, device lifecycle
benchmarks/
  datasets/            manifests only; licensed/local media ignored by git
  harness/             reproducible runner, scoring, NVML/timing collection
  configs/             pinned candidate/runtime/chunk configurations
  results/             schema, README; run outputs ignored except small exemplars
scripts/                bootstrap, model verification, checks, dev orchestration
docs/                   privacy boundary, model/license manifest, runbooks
pnpm-workspace.yaml
package.json
pyproject.toml
uv.lock
```

Model weights, generated audio, raw benchmark recordings, local history, credentials, and `.env` files must be ignored. `docs/model-manifest.json` records model ID, upstream revision, runtime, precision, expected SHA-256, license URL, and acquisition command; it never embeds weights.

### Runtime/process boundaries and data flow

1. `pnpm dev` starts `apps/host`, which binds an OS-assigned port on `127.0.0.1` only and launches `services/audio` on a second OS-assigned loopback port with a per-process boot secret. The host serves the UI at its own origin.
2. After disclosure acknowledgement, the UI calls host bootstrap. The host sets a `HttpOnly; SameSite=Strict` session cookie and returns a 256-bit in-memory capability. Every mutation and WebSocket first message requires that capability plus an exact `Origin` match. Capabilities expire on stop, host restart, or 12 hours, whichever is earlier.
3. An `AudioWorklet` captures mono frames, resamples to 16 kHz, converts to signed PCM16, and sends numbered binary frames over the browser-host WebSocket. The host forwards them to the authenticated sidecar stream. Backpressure is bounded; overflow becomes a visible `audio_input_overrun` failure, never silent loss.
4. The sidecar runs VAD/endpointing and the selected streaming ASR, emitting partials, a stable final, revisions, timing, and failures. The host sends partial/final events to the browser. Only stable transcript turns may enter local history or reasoning.
5. On a stable final, the host's pure policy evaluates eligibility and chooses one posture. `silence` produces an inspectable local event and no Pi call. A non-silence posture causes the host to send the minimum bounded context, validated persona interpretation, chosen posture, and generation limits to Pi RPC.
6. Pi returns response text/events. The host validates length/shape, sends stable assistant text to the browser, and requests local TTS. Sidecar audio chunks are relayed to browser playback; the browser reports played sample offsets so history records spoken extent rather than merely generated text.
7. A possible barge-in first enters `echo_provisional`: the browser immediately ducks/pauses playback and keeps capturing, but the host does not advance the destructive cancellation epoch. Confirmation by VAD/echo evidence or the user advances the epoch once, emits `barge_in.confirmed`, and concurrently aborts Pi RPC, TTS, queued audio, and superseded ASR work. Rejection or timeout may resume only the same response under the safe-resume contract below. New input never waits on remote cancellation.
8. On every playback stop, including cancellation, the browser sends one idempotent terminal `playback.stopped` receipt with the playback ID, cancelled/output epoch, and final contiguous played-sample offset. This is the sole old-epoch exception: the host may accept it only to monotonically close delivered extent; it cannot revive output or state. The browser commits stable user turns, posture (including silence), assistant delivered extent, interruption/failure markers, and timestamps to IndexedDB. The host keeps only bounded in-memory context for the active session and clears it on stop.

### Process security boundaries

- All HTTP/WS listeners bind explicitly to `127.0.0.1`, reject `Host` values other than the actual loopback origin, set no permissive CORS headers, and reject missing/mismatched `Origin`. Tests verify IPv6/`0.0.0.0` are not listeners. A random port is preferred over a fixed well-known port.
- A hostile web page can target loopback services. Exact origin, strict cookie, in-memory capability, one-use WebSocket authentication, content-type checks, request-size limits, and no query-string secrets are mandatory. Sidecar requests additionally require the host-only boot secret and reject browser origins.
- The host starts Pi via an argv array (no shell), communicates over stdio RPC, pins/validates the executable path and supported version, scrubs app logs, and never reads Pi credential/token files or environment values. Authentication/sign-in is delegated to Pi's supported flow.
- No OAuth extraction, copying, logging, exporting, or app persistence is permitted. No ordinary OpenAI key field exists. On unavailable/auth/rate-limit errors, the only options are retry/sign-in or explicit transcript-only continuation; there is no metered or alternate-provider fallback.
- The disclosure precedes microphone permission and states exactly what context leaves the device. Provider terms/retention links must be verified immediately before a pilot; implementation text must not promise provider deletion.
- IndexedDB is vulnerable to same-origin compromise and browser eviction. Apply a strict CSP, no third-party scripts, dependency review, schema validation, export/delete controls, and clear disclosure. Local deletion does not claim cloud deletion. Raw audio and child-process payloads must not appear in normal logs, crash reports, or benchmark output unless the user explicitly runs a named recording mode.

## Key decisions & tradeoffs

- **Node host rather than an Electron shell:** meets the web requirement and keeps Pi/process privileges out of the browser. It requires a local launcher and careful loopback CSRF defenses; those defenses are part of the first vertical slice.
- **Python audio sidecar rather than Node CUDA bindings:** model ecosystems and profiling are materially better in Python. The cost is one internal protocol and lifecycle boundary, controlled through versioned schemas and a host-only boot secret.
- **Browser-owned history rather than SQLite in the host:** directly satisfies local, user-owned web storage and avoids an app-hosted history store. It accepts browser eviction and same-origin risks, which are disclosed and covered by export/delete tests.
- **JSON Schema as protocol source of truth:** both TypeScript and Python validate identical envelopes. Binary PCM avoids base64 overhead. Schema generation is checked for a clean diff.
- **One host WebSocket for session control/audio:** simplifies ordering and cancellation. A bounded queue and epochs prevent head-of-line work from reviving cancelled output.
- **Native model streaming, not a record-then-run wrapper:** more integration work, but observable partials and state reset are core product requirements.
- **No container in the first slice:** direct pinned Node/Python environments make CUDA/device diagnosis simpler on the target machine. Add packaging only after feasibility; deployment planning is out of scope.

### Deterministic response-policy/posture contract

The policy lives in `packages/policy`, runs in the host before Pi, and is a versioned pure function:

```ts
decide(input: PolicyInput): PolicyDecision
// PolicyDecision = { policyVersion, eligible, posture, reasonCodes, inputDigest }
// posture is exactly "riff" | "question" | "challenge" | "silence"
```

`PolicyInput` contains only stable transcript text, local turn counters/timing, interruption state, bounded conversation metadata, and validated persona tendencies. Given identical normalized input and policy/persona versions, output is byte-identical. No wall-clock, network, model output, or unseeded randomness is allowed. Weighted ties use `SHA-256(policyVersion + personaDigest + sessionSeed + turnId)`; `sessionSeed` is stored in the local session record for replay.

The exact v1 thresholds, budgets, cooldowns, and weights below are **experimental configuration**, not settled product policy. They must be versioned, replayable, and frozen only for a declared calibration run:

1. Ineligible/empty, below 4 lexical words, unfinished by endpointer, cooldown after an interruption, or persona `invitation_only` without an explicit invitation → `silence` with a reason code.
2. Otherwise enforce a configurable response budget (initial default at most 2 spoken responses per 5 eligible user turns); exhausted budget → `silence`.
3. `challenge` is eligible only when persona explicitly enables it, at least two stable user turns exist, and challenge cooldown (initial default 3 eligible turns) has elapsed.
4. Select among allowed non-silence postures by persona weights using the stable digest; initial default weights are riff 50, question 35, challenge 15. Silence is controlled by eligibility/budget, not generated by Pi.

Pi receives `{posture, transcript, boundedContext, personaInterpretation, maxWords: 45}` and must return `{text}` only. The host rejects empty, over-limit, multi-question output for `question`, or obvious protocol violations; it records `reasoning_invalid` and remains silent rather than changing posture. Cloud output cannot revise policy, eligibility, posture, or persona. Policy study records include the input digest, version, eligible flag, posture, reason codes, interruption, and timing—not hidden chain of thought.

## Interfaces / contracts (the seams between tasks)

### Canonical envelopes

All JSON events use `{protocolVersion: 1, sessionId, epoch, eventId, type, monotonicMs, payload}` and reject unknown protocol versions. IDs are UUIDv7; `eventId` is unique. `epoch` increments on every interruption, stop, or superseding utterance. Consumers ignore older epochs idempotently.

Core event types:

- Browser → host: `session.start`, `audio.start`, `audio.stop`, `turn.cancel`, `barge_in.confirm|reject`, `playback.progress`, `playback.stopped`, `session.stop`, `readiness.check`.
- Host → browser: `readiness.snapshot`, `session.state`, `transcript.partial`, `transcript.final`, `policy.decision`, `barge_in.provisional|confirmed|rejected|timed_out`, `reasoning.delta|final`, `tts.started|ended`, `failure`.
- Host ↔ sidecar: `stream.open|reset|close`, `stt.partial|final`, `tts.request|cancel|ended`, `vad.speech_start|speech_end`, `sidecar.failure`.

Binary audio frame v1 is little-endian: 1-byte version, 1-byte channel (`1=input_pcm`, `2=output_pcm`), 2-byte header length, 4-byte stream ID, 4-byte sequence, 8-byte capture/production monotonic microseconds, then PCM16 mono payload. The negotiated sample rate is 16,000 Hz input; output sample rate is declared in `tts.started`. Frames above the negotiated size are rejected.

`playback.stopped` is terminal and idempotent by `(sessionId, playbackId, cancelledEpoch)`, with payload `{playbackId, cancelledEpoch, finalPlayedSampleOffset, reason}`; `cancelledEpoch` names the output epoch being terminally closed even when the reason is completion or explicit stop. The offset is the exclusive end of the contiguous samples actually rendered, bounded by generated samples. It may equal or exceed prior progress but never reduce delivered extent. After an epoch change, consumers suppress every old-epoch event except this receipt, which may update only delivered-extent/interruption accounting and must not trigger playback, lifecycle transitions, Pi/TTS work, or context reuse.

Barge-in uses two phases. `barge_in.provisional` immediately ducks/pauses local output to silence while capture continues; it retains the current epoch and response identity. Within an experimental, fake-clock-configurable timeout (initial default 800 ms), confirmed non-echo speech or `barge_in.confirm` emits `barge_in.confirmed`, advances the epoch exactly once, and destructively cancels Pi/TTS/output. `barge_in.reject` or timeout emits `rejected`/`timed_out`; automatic resume is permitted only if no stable user transcript, confirmed barge-in, Stop/Esc, response-invalidating session transition, or newer output epoch occurred, the same buffered response remains available, and echo confidence has recovered below the configured threshold. Otherwise remain listening with the response interrupted; user confirmation may resume only under the same guards. Threshold and timeout are experimental hardware-calibrated config, not hard-coded product facts.

`packages/contracts/schema/` owns `protocol-envelope.json`, `events/*.json`, `persona.json`, `history-export.json`, and benchmark schemas. `pnpm contracts:generate` writes TS types under `packages/contracts/src/generated/`; `uv run python scripts/generate_contracts.py` writes Pydantic models under `services/audio/src/generated/`. CI fails if generation changes tracked files.

### Pi adapter contract

`apps/host/src/pi/PiClient.ts` exposes `probe(): PiReadiness`, `request(input, AbortSignal): AsyncIterable<PiEvent>`, and `shutdown(): Promise<void>`. `PiReadiness` is only `ready | login_required | unavailable | incompatible | rate_limited`, with safe detail and corrective action. The adapter maps the pinned Pi RPC protocol into app events; no other module imports Pi-specific message types. Cancellation must close/abort the RPC request, suppress late output by epoch, and never delay local playback silence.

Because exact installed Pi RPC auth and cancellation semantics are not assumed, the spike must capture a sanitized transcript and an executable contract fixture before this adapter is accepted. If supported cancellation cannot be demonstrated, the host may terminate and restart only its own Pi child; it must not kill unrelated Pi processes.

### Persona and history contracts

Persona v1 is non-executable UTF-8 Markdown with optional single YAML front matter block restricted to:

```yaml
version: 1
name: string                    # <= 80 chars
invitation_only: boolean
posture_weights: { riff: 0..100, question: 0..100, challenge: 0..100 }
challenge_enabled: boolean
interests: [string]             # <= 20, each <= 80 chars
```

Body text is <=16 KiB and is treated as preference prose, never commands. Unknown front-matter keys and HTML/script are errors; missing optional keys use supported defaults; weights not summing to 100 are errors. Warnings cover long body and all-zero challenge. Validation returns severity, line/range, code, message, and an interpretation. Last valid content remains on failed import/save.

IndexedDB `podcaster-local-v1` stores `settings`, `personas`, `sessions`, and `turns`; upgrades are transactional. History export is versioned JSON containing session metadata, stable turns, posture decisions, delivered extent, failures, and persona digest—not raw audio, capability tokens, Pi payload internals, or credentials.

### Benchmark artifacts and reproducibility

Each run directory is `benchmarks/results/<UTC>-<git-or-source-id>-<run-id>/` and contains:

- `run.json`: schema version; run ID/kind; UTC start/end; git/source ID; dirty flag; machine OS/kernel; CPU/RAM/GPU; driver/CUDA/cuDNN; Node/Python/runtime versions; model manifest entries and hashes; config/dataset IDs; seed; command; warmups/repetitions; status.
- `items.jsonl`: one record per candidate/item with candidate/config IDs, source/prompt ID, randomized blind label, attempt, status/failure, transcript or generated-audio relative path, reference normalization version, and metrics.
- `events.jsonl`: monotonic timing events (`audio_received`, `speech_start`, `partial`, `revision`, `endpoint`, `final`, `tts_requested`, `first_audio`, `cancel_requested`, `silence_observed`) with sequence and epoch.
- `summary.json`: counts plus p50/p95/p99, WER/CER, partial revision count/churn, endpoint-to-final, first-partial latency, RTF, TTS time-to-first-audio, underruns/drops, peak/steady VRAM, failures and 30-minute soak outcome.
- `ratings.jsonl`: blinded assessor/session ID, randomized order, prompt/sample labels, 1–5 naturalness/intelligibility/listenability, preference/tie, optional note, replay count, submitted/revealed timestamps. Candidate mapping is separately sealed until submission.
- `README.md`: exact rerun command, dataset acquisition/checksum instructions, deviations, and known failures.

Audio corpora and generated WAVs stay ignored; manifests/checksums and small synthetic fixtures are tracked. STT uses the same 50+ utterance 16-kHz mono English set across candidates, covering names, numbers, noise, pauses, and accents; same VAD/endpointer and matched precision are required. TTS uses at least 20 fixed prompts covering short questions, challenges, punctuation, names/numbers, and prosody. Listening uses randomized A/B labels, headphones, fixed gain, no identity/metrics until ratings lock, at least 3 listeners, and reports paired preference with raw counts (no unsupported significance claim). Failed samples stay visible.

## Task breakdown (each: path, boundary, interface, done-criteria, dependencies, parallel-safe?)

Work milestone by milestone. Do not begin a later milestone until the current gate is recorded in `docs/decisions/`. Within a milestone, only tasks explicitly marked parallel-safe may overlap.

### Milestone 0 — Runnable secure skeleton

**T0.1 Workspace and contracts**
- Scope/owned paths: root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `pyproject.toml`, `uv.lock`, `.gitignore`, `packages/contracts/**`, `scripts/generate_contracts.py`, `scripts/check.sh`.
- Interface: canonical envelopes/binary framing and generated TS/Python types defined above.
- Dependencies: none. Parallel-safe: no; it establishes shared seams.
- Completion: clean installs; schema fixtures pass in TS and Python; generated files are reproducible; ignored sensitive/large artifacts are verified.
- Run: `corepack pnpm install --frozen-lockfile`; `uv sync --frozen`; `pnpm contracts:generate && uv run python scripts/generate_contracts.py`; `pnpm test --filter @app/contracts`; `uv run pytest services/audio/tests/test_contracts.py`; `pnpm check`.

**T0.2 Loopback host, sidecar stub, and web readiness shell**
- Scope/owned paths: `apps/host/src/server/**`, `apps/host/src/sidecar/**`, `apps/host/test/security/**`, `services/audio/src/server.py`, `services/audio/tests/test_server_security.py`, `apps/web/src/readiness/**`, `apps/web/src/main.tsx`, `scripts/dev.mjs`.
- Interface: bootstrap capability, exact-origin enforcement, authenticated host-sidecar health, readiness snapshot. Sidecar is a stub only; no model integration.
- Dependencies: T0.1. Parallel-safe: web UI and sidecar internals may overlap after host endpoint fixtures are frozen.
- Completion: one command opens a usable readiness page; no capture occurs before acknowledgement; host and sidecar listen only on loopback; malicious/missing origin, token, oversized body, and direct browser-sidecar calls fail; CSP contains no third-party source.
- Run: `pnpm dev`; `curl` readiness smoke from the printed origin; `pnpm test --filter @app/host`; `uv run pytest services/audio/tests/test_server_security.py`; `pnpm exec playwright test readiness.spec.ts`; `ss -ltnp | grep -E 'node|python'` (manual: only `127.0.0.1`).

**Milestone 0 gate:** Fresh-machine instructions produce a readiness UI and stub sidecar; automated loopback/origin/capability tests pass; no credentials/audio/history are logged. Keep runnable via `pnpm dev`.

### Milestone 1 — Pi RPC auth/cancel spike

**T1.1 Probe exact Pi RPC contract**
- Scope/owned paths: `spikes/pi-rpc/README.md`, `spikes/pi-rpc/probe.ts`, sanitized `spikes/pi-rpc/fixtures/*.json`, `docs/decisions/001-pi-rpc.md`. Do not edit production adapter yet.
- Interface: establish executable/version discovery, authenticated readiness states, one bounded request, streaming event mapping, request cancellation, process shutdown/restart, rate-limit/auth errors. Record exact Pi version and sanitized protocol fields.
- Dependencies: T0.1. Parallel-safe: no.
- Completion: under the user's existing Pi authentication, a non-metered-fallback probe succeeds; cancellation is requested mid-stream, no later content is accepted, and child cleanup is demonstrated. Logs contain no token/cookie/auth header. If login is required, supported Pi sign-in is documented without credential extraction.
- Run: `pnpm tsx spikes/pi-rpc/probe.ts probe`; `pnpm tsx spikes/pi-rpc/probe.ts request`; `pnpm tsx spikes/pi-rpc/probe.ts cancel`; `rg -n -i 'authorization|bearer|oauth|api[_-]?key|token' spikes/pi-rpc --glob '!README.md'` and manually inspect any schema field names.

**T1.2 Production Pi boundary with fake RPC tests**
- Scope/owned paths: `apps/host/src/pi/**`, `apps/host/test/pi/**`, `apps/host/test/fixtures/fake-pi.ts`, relevant `packages/contracts/schema/events/*reasoning*`.
- Interface: `PiClient` contract above; host owns only the spawned child; AbortSignal and epoch suppression.
- Dependencies: T1.1 decision. Parallel-safe: no.
- Completion: readiness/auth/rate-limit/incompatible mappings work; cancellation races before first token, mid-stream, after final, and simultaneous stop are deterministic; fake child leak test passes; no alternate provider/API-key code path exists.
- Run: `pnpm test --filter @app/host -- pi`; `pnpm exec vitest run apps/host/test/pi/cancellation-races.test.ts`; `pnpm check`.

**Milestone 1 gate:** Go only if supported Pi auth works without app credential access and cancellation either aborts the request or safely restarts only the owned child. Kill/pivot if truthful disclosure or non-metered-fallback behavior cannot be established.

### Milestone 2 — Reproducible RTX 4090 harness

**T2.1 Harness, schemas, fixtures, and listening workflow**
- Scope/owned paths: `benchmarks/harness/**`, `benchmarks/configs/common.yaml`, `benchmarks/datasets/*.manifest.json`, `benchmarks/results/schema/**`, `packages/test-fixtures/audio/**`, `docs/benchmarking.md`, `scripts/verify-models.py`.
- Interface: run artifacts and human workflow defined above; adapter protocol is `prepare(config)`, `transcribe(stream, cancel)` or `synthesize(text, cancel)`, `reset()`, `close()`.
- Dependencies: T0.1. Parallel-safe: after schemas freeze, CLI and synthetic fixtures may overlap.
- Completion: a deterministic synthetic/null candidate creates schema-valid artifacts twice with the same seed; NVML sampling, timing clock, failures, randomization/reveal lock, and cancellation events are tested; dataset/model checksum mismatch fails closed.
- Run: `uv run pytest benchmarks/harness/tests`; `uv run python -m benchmarks.harness run --kind synthetic --config benchmarks/configs/common.yaml`; `uv run python -m benchmarks.harness validate <run-dir>`; compare two normalized seeded summaries.

**Milestone 2 gate:** Another maintainer can rerun the synthetic benchmark from README and obtain schema-valid output; target-machine metadata and exact commands are present.

### Milestone 3 — STT bake-off and selection

**T3.1 Nemotron native streaming adapter**
- Scope/owned paths: `services/audio/src/stt/base.py`, `services/audio/src/stt/nemotron.py`, `services/audio/src/vad/**`, `benchmarks/configs/stt/nemotron*.yaml`, `services/audio/tests/stt/test_nemotron_state.py`, model entry in `docs/model-manifest.json`.
- Interface: shared benchmark adapter; partial/final events; per-stream cache reset; common VAD/endpointer.
- Dependencies: T2.1. Parallel-safe: no; establishes STT adapter semantics.
- Completion: native cache-aware chunks (80/160/320/560 ms as supported), observable revisions, endpoint finalization, reset/cancel isolation, and pinned revision/hash. No Handy record-then-run route.
- Run: `uv run pytest services/audio/tests/stt/test_nemotron_state.py`; `uv run python -m benchmarks.harness run --kind stt --candidate nemotron --dataset <local-manifest>`; 30-minute soak command from `docs/benchmarking.md`.

**T3.2 Parakeet Unified matched challenger and decision**
- Scope/owned paths: `services/audio/src/stt/parakeet.py`, `benchmarks/configs/stt/parakeet*.yaml`, `services/audio/tests/stt/test_parakeet_state.py`, `docs/decisions/002-stt-selection.md`, model manifest entry.
- Interface: identical adapter, corpus, VAD/endpointer, precision, and output schema. Buffered left/right context is explicit in config.
- Dependencies: T3.1. Parallel-safe: adapter implementation can begin after base freezes; final run/decision cannot.
- Completion: matched 320/560 ms comparison plus relevant lower-latency configurations; decision cites run IDs and raw failures. Run Whisper large-v3-turbo only if both candidates' normalized WER is implausibly poor (>20% on clean reference speech), scoring is disputed, or neither sustains realtime; label it `baseline_only`.
- Run: `uv run pytest services/audio/tests/stt`; `uv run python -m benchmarks.harness run --kind stt --candidate parakeet --dataset <same-manifest>`; `uv run python -m benchmarks.harness compare --runs <nemotron-run> <parakeet-run>`; `uv run python -m benchmarks.harness validate <each-run>`.

**STT gate:** Candidate must have p95 RTF ≤0.70, p95 speech-start-to-first-partial ≤500 ms at selected config, p95 endpoint-to-final ≤800 ms, zero dropped frames/unrecoverable resets in the 30-minute soak, and peak VRAM recorded. Prefer Nemotron initially. Reverse to Unified if it has ≥10% relative lower WER with no more than 20% worse p95 speech-to-first-stable-text or peak VRAM and zero drops, or if Nemotron reset/state correctness fails. If neither passes, stop and record kill/pivot; do not integrate Whisper by default.

### Milestone 4 — Staged TTS bake-off and selection

**T4.1 Kokoro baseline**
- Scope/owned paths: `services/audio/src/tts/base.py`, `services/audio/src/tts/kokoro.py`, `benchmarks/configs/tts/kokoro.yaml`, `services/audio/tests/tts/test_kokoro.py`, model manifest entry.
- Interface: chunked PCM output, declared sample rate, first-audio/end events, cancel/reset; fixed prompt set and ratings schema.
- Dependencies: T2.1. Parallel-safe: yes with T3 tasks, but do not compete for benchmark GPU runs.
- Completion: machine run, cancel tests, 30-minute synthesis/playback soak, and blinded listening baseline are valid. A failed item remains in results.
- Run: `uv run pytest services/audio/tests/tts/test_kokoro.py`; `uv run python -m benchmarks.harness run --kind tts --candidate kokoro --prompts <manifest>`; `uv run python -m benchmarks.harness listen --run <run-id>`; validate after ratings lock.

**T4.2 Qwen3-TTS 0.6B comparison and decision**
- Scope/owned paths: `services/audio/src/tts/qwen3.py`, `benchmarks/configs/tts/qwen3-0.6b.yaml`, `services/audio/tests/tts/test_qwen3.py`, `docs/decisions/003-tts-selection.md`, model manifest entry.
- Interface: same adapter/prompts/gain/listeners as Kokoro; supported stock voice only, not custom-voice productization.
- Dependencies: T4.1. Parallel-safe: no for selection.
- Completion: matched blinded A/B with ≥3 listeners and ≥20 prompts; identity/metrics hidden until locked; machine and co-resident selected-STT VRAM/latency run recorded.
- Run: `uv run pytest services/audio/tests/tts`; `uv run python -m benchmarks.harness run --kind tts --candidate qwen3-0.6b --prompts <same-manifest>`; `uv run python -m benchmarks.harness listen --runs <kokoro-run> <qwen-run>`; compare/validate commands.

**TTS gate:** A usable candidate requires p95 time-to-first-audio ≤750 ms, p95 RTF ≤0.70, zero severe failures/underruns in a 30-minute soak, and median intelligibility and naturalness ≥3.5/5. Select Qwen if it passes and receives ≥60% paired non-tie preference over Kokoro; otherwise select Kokoro if it passes. Only if neither meets all gates may a new decision activate one bounded Chatterbox Turbo test, then Orpheus only if Chatterbox also fails. Do not scaffold those adapters beforehand. If no candidate passes, continue no further than a text-only diagnostic slice and record kill/pivot.

### Milestone 5 — Safe integrated conversation loop

**T5.1 Default persona interpretation, policy, and orchestrator state machine**
- Scope/owned paths: `packages/contracts/src/persona/**`, `packages/policy/**`, `apps/host/src/session/**`, `apps/host/test/session/**`, persona/policy/barge-in/playback event schemas.
- Interface: persona v1 parser returns either validated interpretation + digest or structured errors; the supported default is always valid. Pure policy, two-phase barge-in, terminal playback receipt, and epoch contracts are as defined above; Pi and selected sidecar adapters are injected.
- Dependencies: T1.2, STT selection, TTS selection. Parallel-safe: parser/policy unit work may overlap T5.2 after schemas and default-persona fixture freeze.
- Completion: every session has a validated default interpretation before policy runs; malformed persona input cannot reach host policy/Pi. Exactly one decision occurs per eligible final; silence never calls Pi/TTS; stale events cannot cross epochs except the accounting-only terminal receipt; stop/receipts are idempotent; invalid Pi output fails silent; bounded context and 45-word limit are enforced. Provisional echo suppression never advances epoch; confirmation advances it once.
- Run: persona parser unit/fuzz tests and default interpretation fixture; `pnpm test --filter @app/policy`; `pnpm test --filter @app/host -- session`; property/fuzz interleavings; fake-clock cancellation/echo race suite.

**T5.2 Browser capture/playback, active-session UI, and minimal stable-turn persistence**
- Scope/owned paths: `apps/web/src/audio/**`, `apps/web/src/session/**`, `apps/web/src/storage/schema.ts`, `apps/web/src/storage/stable-turn-writer.ts`, focused storage tests, `apps/web/e2e/session*.spec.ts`, `apps/web/public/audio-worklet.js`.
- Interface: audio binary frames, dominant UX states, progress/terminal playback receipts, provisional confirmation events, and a minimal IndexedDB writer for stable user turns plus policy posture, assistant delivered extent, interruption/failure, and timestamps. No history browsing/export/delete or persona editing/import here.
- Dependencies: T0.2 and frozen T5.1 schemas/default persona. Parallel-safe: yes as above.
- Completion: acknowledgement precedes microphone enable; partials do not persist or flood live regions; stable local work survives refresh/failure; silence is visibly intentional; keyboard controls work. Possible echo immediately silences/ducks without destructive cancel; Yes confirms, No rejects; timeout resumes only under every safe-resume guard. Every stop emits one retry-safe terminal receipt and unspoken output is never marked delivered.
- Run: `pnpm test --filter @app/web`; fake IndexedDB writer/idempotency/quota tests; `pnpm exec playwright test session.spec.ts session-a11y.spec.ts`; fake-clock provisional confirm/reject/timeout tests; manual headphones/mic echo matrix.

**T5.3 Selected model integration and end-to-end soak**
- Scope/owned paths: `services/audio/src/runtime.py`, `apps/host/src/sidecar/AudioClient.ts`, `scripts/dev.mjs`, `tests/e2e/conversation/**`, `docs/runbooks/session.md`.
- Interface: only selected STT/TTS behind shared protocol; no benchmark-only candidates loaded in normal sessions.
- Dependencies: T5.1, T5.2. Parallel-safe: no.
- Completion: start → partial/final → persisted stable turn → policy → silence or Pi → TTS → playback → listening; barge-in during deciding/Pi/TTS/playback; provisional echo confirm/reject/timeout and safe/non-safe resume; stop from every state; Pi unavailable offers explicit transcript-only mode; TTS failure gives labeled text-only response; selected models sustain a 30-minute session without dropped audio.
- Run: `pnpm test:e2e`; `pnpm exec playwright test --project=fake-services`; reordered `playback.progress`/cancel/`playback.stopped` tests (duplicate, delayed, old epoch, progress both before and after receipt); provisional-to-confirm versus timeout/Stop/new-final race tests; `pnpm session:soak --minutes 30 --record-metrics`; manual real Pi + 4090 matrix.

**Integrated gate:** median cancel-request-to-browser-silence and p95 must be reported; both must be ≤300 ms, with zero stale audible chunks after confirmed epoch change. Provisional silence latency is reported separately. Delivered extent must remain correct under reordered progress/cancel/terminal receipts. No severe unrecoverable audio failure occurs in 30 minutes. Endpoint-to-first-audio p50 ≤2.5 s and p95 ≤5 s (local speech and Pi wait reported separately). Failures preserve stable local work and expose a corrective action. Do not calibrate posture policy until this gate passes.

### Milestone 6 — Bounded experimental policy calibration gate

**T6.1 Freeze and run one bounded calibration protocol**
- Scope/owned paths: `packages/policy/config/v1.experimental.json`, `benchmarks/results/schema/policy-calibration.json`, `docs/studies/policy-calibration-protocol.md`, `docs/decisions/004-policy-calibration.md`.
- Interface: replayable policy decision/exposure records only; no hidden reasoning and no new product surface. Exact weights, budgets, cooldowns, echo threshold, and provisional timeout remain experimental config.
- Dependencies: passed T5 integrated gate. Parallel-safe: no; configuration and protocol freeze precede exposure.
- Completion: before collection, the protocol declares the target population and recruitment boundary, finite sample size plus stopping rule, unit of analysis, treatment/control assignment, and what counts as treatment exposure. It names one primary descriptive outcome and safety/interaction guardrails, records exclusions/deviations, and forbids changing config mid-run. Run only the minimum bounded calibration needed to choose one frozen prototype config; report raw counts/distributions and uncertainty plainly, without significance, generalization, or causal claims the design cannot support. The decision either freezes one config for later prototype measurement or stops/pivots; no T7 expansion starts without it.
- Run: schema validation; deterministic replay against declared fixtures; protocol completeness check; calibration artifact validation and decision review.

**Milestone 6 gate:** The predeclared protocol and bounded results are attached to the decision. Proceed only with one frozen, versioned experimental config and no unresolved barge-in/stable-write regression. Calibration is not the prototype success study and does not establish population-level effectiveness.

### Milestone 7 — Local history and persona expansion

**T7.1 History browse/export/delete over the stable-turn store**
- Scope/owned paths: remaining `apps/web/src/storage/**`, `apps/web/src/history/**`, `apps/web/e2e/history.spec.ts`, history schemas/fixtures.
- Interface: extend the T5 `podcaster-local-v1` store transactionally; preserve the stable-turn writer and export contract above.
- Dependencies: passed T6 gate and T5 stable-writer contract. Parallel-safe: yes with T7.2 after schemas freeze.
- Completion: transactional migration; newest-first detail; interrupted/spoken extent/posture/failures; one/all export and delete; write/delete failure does not falsify UI; no raw audio, capability, credential, or hidden Pi payload in DB/export.
- Run: storage migration tests with fake IndexedDB; `pnpm exec playwright test history.spec.ts`; schema-validate exports; privacy grep/assertion tests.

**T7.2 Persona editor/import over the validated parser**
- Scope/owned paths: `apps/web/src/persona/**`, editor/import fixtures, `apps/web/e2e/persona.spec.ts`; modify `packages/contracts/src/persona/**` or `packages/policy/src/persona.ts` only for defects against the frozen T5 contract.
- Interface: use the T5 persona v1 parser, validated interpretation, and digest; host receives no raw or invalid persona.
- Dependencies: passed T6 gate and T5 parser contract. Parallel-safe: yes with T7.1.
- Completion: default display, preview-before-import, line/range validation, warning acknowledgement, last-valid rollback, unsupported key/script rejection, unsaved changes protection, and no self-edit path.
- Run: parser regression/fuzz tests; `pnpm exec playwright test persona.spec.ts`; policy replay with default and imported persona fixtures.

**Milestone 7 gate:** export is schema-valid; delete removes scoped IndexedDB records; failed import/save retains the last valid persona; privacy assertions pass. The app remains runnable with missing/evicted history.

### Milestone 8 — Hardening and prototype gate

**T8.1 Failure, privacy, accessibility, and race hardening**
- Scope/owned paths: `tests/security/**`, `tests/e2e/failures/**`, `tests/e2e/accessibility/**`, `docs/privacy.md`, `docs/runbooks/**`, dependency/config updates only where findings require them.
- Interface: UX failure mapping and security boundaries in this plan.
- Dependencies: T5–T7. Parallel-safe: security, accessibility, and soak investigations may overlap but fixes require ownership coordination.
- Completion: auth expiry, rate limit, child crash, GPU OOM, mic loss, provisional echo ambiguity, storage quota/eviction, malformed frames/events, cancellation storms, and reordered old-epoch terminal receipts have safe outcomes; provider disclosure/link is verified for pilot date; dependency/license inventory is reviewed; logs/exports contain no forbidden data.
- Run: `pnpm check`; `uv run pytest`; `pnpm test:e2e`; `pnpm exec playwright test --grep @a11y`; `pnpm audit --prod`; pinned Python dependency audit; `scripts/privacy-assertions.sh`; 30-minute real-hardware soak.

**T8.2 Frozen-policy prototype measurement**
- Scope/owned paths: frozen `packages/policy/config/v1.experimental.json`, `benchmarks/results/schema/policy-study.json`, `docs/studies/policy-protocol.md`, `docs/decisions/005-prototype-go-no-go.md`. No marketing or deployment work.
- Interface: immutable policy decision/exposure records and blinded always-respond comparison; no chain of thought.
- Dependencies: T8.1 and passed T6 calibration gate. Parallel-safe: no.
- Completion: protocol separately predeclares population, sample/stopping rule, unit of analysis, assignment, treatment exposure, primary outcome, and guardrails before collection; configuration stays frozen; report raw denominators, missingness, and descriptive results without unsupported statistical claims.
- Run: schema validation and policy replay command documented by task; full checks above.

**Prototype go/no-go:** Apply the PRD thresholds only to the predeclared prototype study: go if ≥70% prefer the calibrated policy to always-respond, <20% responses are premature/disruptive, barge-in and 30-minute speech guardrails pass, and privacy/auth disclosure remains truthful. Kill/pivot at 35% disruptive, failed reliable barge-in, unsustainable local speech, or untruthful provider boundary. Values between thresholds require one bounded policy iteration decision, not feature expansion; do not imply statistical significance or broader generalization.

## Test strategy

- **Unit:** schema validators/generators, binary framing, persona parsing, policy determinism/replay, context truncation, IndexedDB migrations, model adapter reset, timing aggregation, rating blinding, and export redaction.
- **Integration with fakes:** browser-host WebSocket, host-sidecar authentication, fake Pi streams, process crashes, old-epoch suppression with the accounting-only receipt exception, queue overflow, minimal stable-turn persistence, and storage failures. Contract fixtures are consumed by both languages.
- **Cancellation/race:** cancel before/after endpoint, before Pi request, before first token, mid-token stream, after Pi final, before/during TTS chunks, during playback, concurrent Stop/Esc/barge-in, late child output, repeated cancel, and child restart. Reorder progress, epoch advance, and terminal receipt; duplicate/delay each and send progress after the terminal receipt. Cover provisional echo confirm/reject/timeout racing Stop, stable final, playback completion, and a second provisional event. Assert immediate provisional silence, no epoch advance before confirmation, exactly one advance after confirmation, guarded resume only, no revived old-epoch output, receipt idempotence, and monotonic accurate delivered extent.
- **Failure states:** missing model, checksum failure, CUDA OOM, sidecar death, Pi login expiry/rate limit/incompatible version, malformed output, microphone denial/disconnect, provisional echo ambiguity, browser refresh, IndexedDB quota/eviction, export write failure, and host restart.
- **Security/privacy:** bind-address inspection; hostile/missing origin; stolen cookie without capability; replayed capability; direct sidecar call; oversized/malformed frames; CSP; no shell invocation; dependency audit; logs, IndexedDB, exports, benchmark artifacts, and process environment inspected for raw audio, credential/token patterns, and undisclosed cloud fallback.
- **Hardware/manual:** pinned RTX 4090 cold/warm benchmark, co-resident STT/TTS VRAM, headphones and speaker echo, mic reconnect, 30-minute soak, blinded TTS listening, and Pi auth handoff. Manual runs record operator, exact command, run ID, hardware/software manifest, outcome, and deviations.
- **Accessibility:** Playwright + axe as a floor, plus keyboard-only and screen-reader checks for status announcements, focus recovery, partial transcript quietness, non-color semantics, reduced motion, and playback controls.
- **Continuous checks:** `pnpm check`, TS/Python tests, schema regeneration clean check, fake-service E2E, secret/privacy scan. GPU and live-Pi suites are explicit opt-in jobs and must attach run IDs rather than pretending to run in ordinary CI.

## Risks & assumptions

- Exact Pi RPC version/auth/cancel semantics are unknown until Milestone 1; this is intentionally before product integration. Residual provider quota/terms/model availability cannot be controlled by the app.
- RTX 4090 latency, VRAM, partial stability, echo behavior, and selected-model co-residency remain measured risks. Published/H100/Handy claims do not close them.
- Browser IndexedDB can be evicted and is accessible to same-origin compromise. Export and CSP reduce but do not eliminate this risk; users must be told.
- Deterministic heuristic posture selection is inspectable but may not be helpful. The policy study, strict challenge eligibility, concise output, and kill thresholds bound harm; do not add opaque cloud posture selection to improve scores.
- Native model licenses, conversion rights, and redistribution terms require review against pinned revisions before any distribution. Initial local acquisition avoids silently redistributing weights.
- Browser audio scheduling and acoustic echo cancellation vary by device. The 4090 target does not guarantee microphone/speaker behavior; uncertain echo defaults to duck/confirm, never continued speech over the user.
- A local malicious process and a fully compromised same-origin page remain outside what loopback tokens alone can defeat. Minimize privileges/data lifetime and state this honestly.

## Open questions

None block starting Milestone 0. Resolve only at named gates:

1. Exact supported Pi RPC executable/version, auth handoff, cancellation, and provider disclosure URL — Milestone 1 and pilot hardening.
2. Selected STT/runtime/chunk/precision and selected TTS/voice — Milestones 3 and 4 measurements.
3. Echo ambiguity threshold and provisional timeout — measured in Milestone 5, then treated as experimental config at the Milestone 6 gate.
4. Which experimental posture configuration, if any, merits frozen prototype measurement — bounded Milestone 6 calibration; preference is evaluated only in Milestone 8.

### Plan status

Revised to address independent review of old-epoch delivery accounting, provisional echo handling, T5 persona/storage prerequisites, and bounded policy calibration ordering.

### Fresh-session kickoff prompt

```text
Read artifacts/architect/index.md as the implementation authority, then read artifacts/pm/index.md, artifacts/ux/index.md, and artifacts/researcher/index.md for intent/evidence. Inspect the workspace and use pi-tasks (sq backend; run `sq prime` only if direct CLI guidance is needed) to create/track the plan tasks under `pi_tasks`. Begin only the first incomplete milestone and do not start later milestones or conditional speech candidates. Keep the app runnable, run every completion command available for the current task, record unavailable hardware/manual checks honestly, and stop for the milestone gate/review with changed files, test evidence, commands, and residual risks.
```

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Only artifacts/architect/index.md was revised: it now defines the accounting-only old-epoch terminal receipt, two-phase echo handling, T5 persona/storage prerequisites, and a bounded calibration gate before later feature expansion."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "The revised contracts name payload fields, state transitions, timeout/resume guards, task paths/dependencies, completion gates, and reordered/race test cases sufficient for independent review."
    }
  ],
  "changedFiles": [
    "artifacts/architect/index.md"
  ],
  "testsAddedOrUpdated": [
    "Plan requires reordered playback.progress/cancel/playback.stopped tests covering duplicate, delayed, and old-epoch receipts.",
    "Plan requires fake-clock provisional echo confirm/reject/timeout races against Stop, stable final, playback completion, and repeated provisional events.",
    "Plan moves persona parser/fuzz/default-fixture and minimal IndexedDB stable-writer/idempotency/quota tests into T5."
  ],
  "commandsRun": [
    {
      "command": "python3 structural token/heading validation for artifacts/architect/index.md",
      "result": "passed",
      "summary": "All required architecture headings and requested contract/calibration tokens are present."
    },
    {
      "command": "find artifacts/architect -maxdepth 2 -type f -print; conditional git diff/staging check",
      "result": "passed",
      "summary": "index.md is the sole architect artifact; the workspace has no .git directory or staging area."
    }
  ],
  "validationOutput": [
    "Required headings missing: none.",
    "Found terminal receipt, cancelledEpoch, provisional/confirmed barge-in, T5 stable persistence, and predeclared calibration fields.",
    "artifacts/architect/index.md is the only file under artifacts/architect."
  ],
  "residualRisks": [
    "Echo threshold and provisional timeout remain experimental until T5 hardware measurement and the bounded T6 calibration gate.",
    "No implementation tests were run because this revision changes only the architecture plan and the workspace contains no application code or Git repository."
  ],
  "noStagedFiles": true,
  "diffSummary": "Resolved independent review findings while preserving a dependency-ordered plan: safe old-epoch accounting, non-destructive provisional echo suppression, T5 prerequisite persistence/persona work, and predeclared bounded calibration before expansion.",
  "reviewFindings": [
    "no blockers; focused independent review completed and confirmed all four material findings resolved"
  ],
  "manualNotes": "This revision addresses the four independent review findings without adding implementation code, providers, speech candidates, or unrelated scope."
}
```
