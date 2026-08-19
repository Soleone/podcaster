# ARC-010 — Keep the sidecar event loop non-blocking

## Rationale

`SelectedAudioRuntime.open_tts` can wait on a threading fence for up to ten seconds. `SidecarServer` calls it synchronously from its asyncio receive loop. Preserve the tested fence but run the potentially blocking admission outside the event loop.

## In scope

- `services/audio/src/server.py`: `tts.open` dispatch.
- `services/audio/tests/test_server_security.py` or a new focused server concurrency test.
- `services/audio/tests/test_runtime_multipart.py` only if an assertion needs clarification; runtime behavior should not change.

## Out of scope

- Rewriting `SelectedAudioRuntime`, changing admission count/timeouts, deleting multipart, host AudioClient queue changes, converting all runtime methods to async.

## Prerequisites

- Baseline full audio tests.

## Step-by-step changes

1. Identify only dispatch operations that can intentionally block on worker fences. For this task, offload `runtime.open_tts` via `asyncio.to_thread`; do not blanket-offload cheap state transitions.
2. Pass positional/keyword arguments exactly, preserving part/voice/speed/tone/language values.
3. Await the thread result before processing the next message on that connection, retaining per-connection command order.
4. Ensure connection cancellation/close does not leave an unobserved task exception. The runtime timeout remains the bound.
5. Add a focused test with a fake runtime whose `open_tts` blocks on an event. While it blocks, schedule an event-loop heartbeat (or a second authorized health/server action) and prove it completes; then release and verify command order.
6. Retain existing direct runtime fence tests unchanged.

## Invariants

- At most two retained TTS streams and replacement fencing unchanged.
- No later append/commit from the same connection overtakes open.
- Sidecar failure sanitization and close codes unchanged.
- Event loop stays responsive under saturated admission.

## Acceptance criteria

- Focused test fails against old synchronous dispatch and passes after change.
- Full audio suite and Ruff pass.
- No new executor lifecycle object/dependency.

## Focused tests / commands

```bash
uv run pytest services/audio/tests/test_server_security.py services/audio/tests/test_runtime_multipart.py
uv run pytest services/audio/tests
uv run ruff check services/audio/src/server.py services/audio/tests
```

## Expected diff shape

Very small server dispatch change plus one focused concurrency test. No runtime/config/generated files.

## Likely pitfalls

- Fire-and-forget `to_thread` would reorder append/commit; it must be awaited.
- Offloading all runtime calls adds needless races and overhead.
- A test that calls runtime directly does not verify the asyncio loop defect.

## Parallel safety

Parallel-safe with TypeScript tasks. Coordinate with ARC-014 if both edit Python server/runtime tests; preferably land this first.
